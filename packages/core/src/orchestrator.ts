import { randomUUID } from "node:crypto";
import type {
  BotRuntime,
  Capabilities,
  ContextDetail,
  ModelOption,
  NormalizedEvent,
  Quota,
  SessionInfo,
  SessionOptions,
  SessionSettings,
  SourceKind,
  ToolCall,
  ToolDecision,
} from "@roster/adapter-api";
import type { AttachmentRef, AttachmentStore } from "./attachments.js";
import { composeDelivery, type Ask } from "./delivery.js";
import { t, type Key, type ParamsFor } from "./i18n/index.js";
import type { ParamValue } from "./i18n/translate.js";
import type { CoreEvent, Quote } from "./log.js";
import { findMentions } from "./mentions.js";
import { notificationOf, type Waiting } from "./notify.js";
import type { Registry } from "./registry.js";
import type { Sources } from "./sources.js";
import { cropQuote, isTier, TIERS, titleFrom, UNTITLED } from "./store.js";
import type { BotRow, ConversationRow, DirKind, MemberRow, MemberSettings, Mode, Store, Tier } from "./store.js";

export type Broadcast = (msg: { kind: string; [k: string]: unknown }) => void;

/** A tier covers everything at or below it. */
const TIER_RANK = { read: 0, write: 1, execute: 2 } as const;

/**
 * Bot-initiated turns allowed per human message. Leader mode loops until the
 * leader stops mentioning anyone; this is the brake for a leader that never
 * does, since N bots each holding context is N times the spend.
 */
const RELAY_BRAKE = 24;

/** How long an aborted backend gets to end its turn before core ends it. */
const ABORT_GRACE_MS = 15_000;

/** Plan usage moves slowly, and a read without a live session spawns a backend process. */
const QUOTA_MAX_AGE_MS = 60_000;
/** A turn has just spent some, so it is worth asking again sooner. */
const QUOTA_AFTER_TURN_MS = 20_000;
/**
 * Past its reset a window is a fresh one, so what was read while it still stood
 * counts usage that no longer exists. A reset already behind the read itself is
 * the backend's own answer and stays cached, or every look would re-read.
 */
const outOfDate = (entry: QuotaRead): boolean =>
  entry.value?.windows.some((w) => w.resetsAt !== undefined && w.resetsAt > entry.at && w.resetsAt <= Date.now()) ===
  true;

const sameInfo = (a: SessionInfo, b: SessionInfo) => JSON.stringify(a) === JSON.stringify(b);

/** What a session switches between when its backend has no permission modes of its own and the gate goes by tier. */
const tierModes = (): SessionOptions["modes"] =>
  TIERS.map((tier) => ({ id: tier, label: t(`tier.${tier}`), description: t(`tier.${tier}.description`) }));

/** The picks a session's options still offer; the rest belonged to what it ran before. */
function stillOffered(settings: MemberSettings, options: SessionOptions): MemberSettings {
  return {
    ...(settings.model && options.models.some((m) => m.id === settings.model) ? { model: settings.model } : {}),
    ...(settings.effort && options.efforts.some((e) => e.id === settings.effort) ? { effort: settings.effort } : {}),
    ...(settings.mode && options.modes.some((m) => m.id === settings.mode) ? { mode: settings.mode } : {}),
    ...(settings.fast !== undefined && options.fast?.available !== false ? { fast: settings.fast } : {}),
  };
}

export type PresenceState = "starting" | "thinking" | "writing" | "tool" | "waiting_permission" | "waiting_lock" | "compacting";

export interface Presence {
  conversationId: string;
  memberId: string;
  state: PresenceState;
  detail?: string;
  /** the turn being worked on, so the transcript knows which one is still being written */
  turnId?: string;
  /** when that turn began, epoch ms: members speaking at once are shown in this order */
  since?: number;
}

type Reason = "done" | "aborted" | "error";

interface Live {
  memberId: string;
  conversationId: string;
  runtime: BotRuntime | null;
  starting: Promise<BotRuntime> | null;
  running: boolean;
  turnId: string | null;
  /** when the running turn began */
  since: number;
  /** deltas are not rows; the finalized text is written when the turn ends */
  buffer: string;
  /** the thinking still coming in, written whole once anything else happens in the turn */
  thought: { id: string; at: number; startedAt: number; text: string } | null;
  asks: Set<Ask>;
  /** asks that arrived mid-turn; together they become the next turn */
  queued: Set<Ask>;
  aborted: boolean;
  errored: boolean;
  /** removed or released: late events from its backend are dropped */
  gone: boolean;
  presence: Presence | null;
  /** the backend's latest report of what it runs with */
  session: SessionInfo | null;
  /** the executor the running session was started on; set with runtime */
  executor: string | null;
}

interface QuotaRead {
  /** when the last read settled, whether or not it succeeded; 0 before any has */
  at: number;
  value: Quota | null;
  reading: boolean;
}

interface Group {
  /** leader mode: dispatched members the leader is still waiting to hear from */
  awaiting: Set<string>;
  relays: number;
  /** stop was pressed: nothing chains off the turns still winding down */
  halted: boolean;
  /** some member has been running since the conversation was last idle */
  busy: boolean;
  failed: boolean;
  /** what went wrong, so the notification the failure ends in can say it */
  error: { name: string; message: string } | null;
  /** talking is concurrent, writing is not */
  lease: { holder: string | null; queue: Array<{ memberId: string; grant: (ok: boolean) => void }> };
}

interface Pending {
  conversationId: string;
  memberId: string;
  call: ToolCall;
  resolve: (d: ToolDecision) => void;
}

export class Orchestrator {
  #lives = new Map<string, Live>();
  #groups = new Map<string, Group>();
  #pending = new Map<string, Pending>();
  #models: { at: number; value: Record<string, ModelOption[]> } | null = null;
  /** plan usage per executor: two executors may well be two accounts */
  #quotas = new Map<string, QuotaRead>();

  constructor(
    private store: Store,
    private broadcast: Broadcast,
    private registry: Registry,
    private sources: Sources,
    /** without one, attachments are recorded but never handed to a member */
    private attachments?: AttachmentStore,
  ) {}

  /**
   * Readable without starting anything, so the UI can degrade before a turn
   * runs. One set per executor: its source settles the channel, and the
   * channel settles what it can do.
   */
  capabilities(): Record<string, Capabilities> {
    return Object.fromEntries(this.registry.entries().map(([id, e]) => [id, e.capabilities]));
  }

  /** Every live executor under the name people gave it; one that cannot run says why. */
  executors(): Array<{
    id: string;
    type: string;
    label: string;
    source_kind: SourceKind;
    provider_id: string | null;
    model: string | null;
    problem: string | null;
  }> {
    return this.store.listExecutors().map((e) => ({
      id: e.id,
      type: e.type,
      label: e.name,
      source_kind: e.source_kind,
      provider_id: e.provider_id,
      model: e.model,
      problem: this.registry.entry(e.id) ? null : (this.registry.problem(e.id) ?? t("error.agent.unbuildable")),
    }));
  }

  /**
   * Takes a registry rebuilt after executors or providers were edited. Live
   * sessions keep the runtime they started with; the next start picks up the new
   * setup, and members show as stale where it matters.
   */
  useRegistry(next: Registry): void {
    this.registry = next;
    this.#models = null;
    this.#quotas.clear();
  }

  /** Every model each executor could run. */
  async models(): Promise<Record<string, ModelOption[]>> {
    if (this.#models && Date.now() - this.#models.at < 5 * 60_000) return this.#models.value;
    const entries = await Promise.all(
      this.registry.ids().map(async (id) => [id, await this.sources.models(id).catch(() => [])] as const),
    );
    this.#models = { at: Date.now(), value: Object.fromEntries(entries) };
    return this.#models.value;
  }

  presence(): Presence[] {
    return [...this.#lives.values()].flatMap((l) => (l.presence ? [l.presence] : []));
  }

  /**
   * What each active member runs with -- its session's own report once there is
   * one, the backend's preview before that -- and the plan usage of each backend
   * present. Usage older than a minute is re-read in the background and pushed.
   */
  async status(conversationId: string): Promise<{
    sessions: Record<string, SessionInfo>;
    options: Record<string, SessionOptions>;
    quota: Record<string, Quota | null>;
  }> {
    const members = this.store.activeMembers(conversationId);
    const executors = [...new Set(members.map((m) => m.spec.executor_id))];
    const sessions: Record<string, SessionInfo> = {};
    // by member: two members on one executor can run on different sources
    const options: Record<string, SessionOptions> = {};
    await Promise.all(
      members.map(async (m) => {
        const info = this.#shown(m, this.#lives.get(m.id)?.session ?? (await this.#resting(m)));
        if (Object.keys(info).length > 0) sessions[m.id] = info;
        const o = await this.#optionsFor(m).catch(() => null);
        if (o) options[m.id] = o;
      }),
    );
    const quota: Record<string, Quota | null> = {};
    for (const id of executors) {
      this.#refreshQuota(id, QUOTA_MAX_AGE_MS);
      const read = this.#quotas.get(id);
      if (read && read.at > 0) quota[id] = read.value;
    }
    return { sessions, options, quota };
  }

  /**
   * Switches what one member's session runs with, in this conversation only. A
   * live session switches in place; otherwise the pick waits for its next start.
   * Only what the executor's own options offer can be picked: its source is not
   * a session's to change. A tier picked as the mode is the gate's alone and
   * holds from the session's next tool call.
   */
  async configure(conversationId: string, memberId: string, patch: MemberSettings): Promise<void> {
    const member = this.#memberOf(conversationId, memberId);
    const options = await this.#optionsFor(member);
    if (!options) throw new Error(t("error.configure.unsupported"));
    if (patch.model !== undefined && !options.models.some((m) => m.id === patch.model)) {
      throw new Error(t("error.configure.unknownModel", { model: patch.model }));
    }
    if (patch.effort !== undefined && !options.efforts.some((e) => e.id === patch.effort)) {
      throw new Error(t("error.configure.unknownEffort", { effort: patch.effort }));
    }
    if (patch.mode !== undefined && !options.modes.some((m) => m.id === patch.mode)) {
      throw new Error(t("error.configure.unknownMode", { mode: patch.mode }));
    }
    if (patch.fast && options.fast?.available === false) {
      throw new Error(t("error.configure.fastUnavailable"));
    }

    const live = this.#lives.get(memberId);
    const { model, effort, mode, fast } = patch;
    // a backend without modes of its own never hears of one: there the mode is a tier
    const tier = this.#ownModes(member) ? undefined : mode;
    const settings: MemberSettings = {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(mode !== undefined && tier === undefined ? { mode } : {}),
      ...(fast !== undefined ? { fast } : {}),
    };
    if (tier === undefined || Object.keys(settings).length > 0) {
      // the session reports what actually took, which the push then carries
      if (live?.runtime?.configure) await live.runtime.configure(settings);
      this.store.setSettings(memberId, { ...member.settings, ...settings });
      if (live && !live.runtime?.configure) live.session = null;
    }
    if (tier !== undefined) this.store.setSettings(memberId, { ...this.#memberOf(conversationId, memberId).settings, mode: tier });
    // a session that switched in place pushed its own report, which says nothing of a tier
    if (tier !== undefined || !live?.runtime?.configure) await this.#announce(conversationId, memberId);
  }

  /** A bot's tier is read live, so every session that has not picked its own shows the new one. */
  tierChanged(botId: string): void {
    for (const m of this.store.membersOf(botId)) {
      if (this.#ownModes(m) || isTier(m.settings.mode)) continue;
      void this.#announce(m.conversation_id, m.id).catch(() => {});
    }
  }

  /**
   * Frees a member's context by having its backend summarize the history. It is
   * held like a turn, so a message sent meanwhile queues behind it; it writes
   * nothing to the transcript, because there is nothing for anyone to read.
   */
  async compact(conversationId: string, memberId: string): Promise<void> {
    const member = this.#memberOf(conversationId, memberId);
    const options = await this.#optionsFor(member).catch(() => null);
    if (!options?.compact) throw new Error(t("error.compact.unsupported"));
    const live = this.#live(conversationId, memberId);
    if (live.gone) throw new Error(t("error.member.left"));
    if (live.running) throw new Error(t("error.compact.busy"));

    const turnId = randomUUID();
    Object.assign(live, { running: true, asks: new Set(), turnId, buffer: "", thought: null, aborted: false, errored: false });
    this.#setPresence(live, "compacting");
    this.#sync(conversationId);
    setImmediate(() => {
      void (async () => {
        const runtime = await this.#ensure(live);
        if (!live.running || live.turnId !== turnId) return;
        if (!runtime.compact) throw new Error(t("error.compact.unsupported"));
        // completion arrives as the backend's turn.end, which finishes this like any turn
        await runtime.compact();
      })().catch((err: unknown) => this.#fail(live, turnId, err));
    });
  }

  /** Everything a member's context holds. Counting it needs the session, so one is started if none is running. */
  async contextDetail(conversationId: string, memberId: string): Promise<ContextDetail> {
    this.#memberOf(conversationId, memberId);
    const live = this.#live(conversationId, memberId);
    if (live.gone) throw new Error(t("error.member.left"));
    const runtime = await this.#ensure(live);
    if (!runtime.contextDetail) throw new Error(t("error.context.unsupported"));
    return runtime.contextDetail();
  }

  #memberOf(conversationId: string, memberId: string): MemberRow {
    const member = this.store.getMember(memberId);
    if (!member || member.conversation_id !== conversationId || member.left_at !== null) {
      throw new Error(t("error.member.notFound"));
    }
    return member;
  }

  /** Text mid-stream right now, so reopening a conversation does not start blank. */
  streams(conversationId: string): Record<string, string> {
    return Object.fromEntries(
      this.#livesOf(conversationId)
        .filter((l) => l.running && l.buffer)
        .map((l) => [l.memberId, l.buffer]),
    );
  }

  /** Thinking mid-stream right now, by thought, for the same reason. */
  thoughts(conversationId: string): Record<string, string> {
    return Object.fromEntries(
      this.#livesOf(conversationId).flatMap((l) => (l.running && l.thought ? [[l.thought.id, l.thought.text]] : [])),
    );
  }

  // ---- the human side ----

  async send(
    conversationId: string,
    text: string,
    attachments: readonly AttachmentRef[] = [],
    quote?: Quote,
  ): Promise<void> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error(t("error.conversation.notFound"));
    const members = this.store.activeMembers(conversationId);
    const mentioned = findMentions(text, this.#named(members));

    this.#append(conversationId, null, null, {
      type: "human.text",
      display: "message",
      text,
      mentions: mentioned.ids,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      ...(quote ? { quote: { ...quote, text: cropQuote(quote.text) } } : {}),
    });

    // the first thing asked is what the conversation is about; an untouched
    // default title carries no information
    if (UNTITLED.test(conv.title)) {
      // a file name is taken whole: its dot is not the end of a sentence
      const name = attachments[0]?.name ?? "";
      const title = text ? titleFrom(text) : name.length > 28 ? `${name.slice(0, 28)}…` : name;
      if (title) this.store.rename(conversationId, title);
    }

    const g = this.#group(conversationId);
    g.halted = false;
    g.relays = 0;
    this.store.setAttention(conversationId, "none");
    // writing in it is reading it, a mark set by hand included
    this.store.setUnread(conversationId, false);

    if (members.length === 0) this.#notice(conversationId, "notice.noMembers");
    for (const [memberId, ask] of this.#route(conv, members, mentioned)) {
      this.#ask(conversationId, memberId, ask);
    }
    this.#sync(conversationId);
  }

  /** Who speaks next is the only question a mode answers. */
  #route(
    conv: ConversationRow,
    members: MemberRow[],
    mentioned: { ids: string[]; all: boolean },
  ): Array<[string, Ask]> {
    if (members.length === 0) return [];
    const leader = this.#leaderOf(conv, members);
    const role = (id: string): Ask =>
      conv.mode === "discussion" ? "discuss" : conv.mode === "leader" && id === leader?.id ? "lead" : "mention";

    if (mentioned.all) return members.map((m) => [m.id, role(m.id)]);
    if (mentioned.ids.length > 0) return mentioned.ids.map((id) => [id, role(id)]);
    if (conv.mode === "leader" && leader) return [[leader.id, "lead"]];
    if (conv.mode === "discussion") return members.map((m) => [m.id, "discuss"]);
    // human-led with no address: whoever you were just talking to
    const last = this.store.lastSpeaker(conv.id);
    return [[(members.find((m) => m.id === last) ?? members[0]!).id, "reply"]];
  }

  async abort(conversationId: string): Promise<boolean> {
    const g = this.#group(conversationId);
    g.halted = true;
    g.awaiting.clear();
    const lives = this.#livesOf(conversationId);
    for (const l of lives) l.queued.clear();
    this.#denyPending((p) => p.conversationId === conversationId, t("deny.stopped"));
    for (const w of g.lease.queue.splice(0)) w.grant(false);

    const running = lives.filter((l) => l.running);
    await Promise.all(
      running.map(async (l) => {
        const turnId = l.turnId;
        l.aborted = true;
        await l.runtime?.abort().catch(() => {});
        // a backend that never ends its turn must not leave the member stuck
        setTimeout(() => {
          if (!l.running || l.turnId !== turnId) return;
          this.#drop(l);
          this.#finish(l, "aborted");
        }, ABORT_GRACE_MS).unref();
      }),
    );
    this.#sync(conversationId);
    return running.length > 0;
  }

  resolvePermission(conversationId: string, requestId: string, allow: boolean): boolean {
    const p = this.#pending.get(requestId);
    if (!p || p.conversationId !== conversationId) return false;
    this.#pending.delete(requestId);
    p.resolve(allow ? { action: "allow" } : { action: "deny", reason: t("deny.byUser") });
    this.#sync(conversationId);
    return true;
  }

  // ---- membership and rules ----

  addMember(conversationId: string, botId: string): MemberRow {
    if (!this.store.getConversation(conversationId)) throw new Error(t("error.conversation.notFound"));
    const bot = this.store.getBot(botId);
    if (!bot || bot.archived_at !== null) throw new Error(t("error.bot.notInContacts"));
    if (this.store.activeMembers(conversationId).some((m) => m.bot_id === botId)) {
      throw new Error(t("error.member.alreadyIn", { name: bot.name }));
    }
    const member = this.store.addMember(conversationId, botId);
    this.#notice(conversationId, "notice.joined", { name: bot.name });
    this.#pushConversations();
    return member;
  }

  async removeMember(conversationId: string, memberId: string): Promise<void> {
    const member = this.store.getMember(memberId);
    if (!member || member.conversation_id !== conversationId || member.left_at !== null) {
      throw new Error(t("error.member.notFound"));
    }
    const conv = this.store.getConversation(conversationId)!;
    const leaderBefore = this.#leaderOf(conv, this.store.activeMembers(conversationId));
    const name = this.#name(member);
    this.store.leaveMember(memberId);
    const live = this.#lives.get(memberId);
    if (live) await this.#retire(live);
    this.#notice(conversationId, "notice.removed", { name });

    const rest = this.store.activeMembers(conversationId);
    if (conv.mode === "leader" && leaderBefore?.id === memberId && rest[0]) {
      this.store.setMode(conversationId, "leader", rest[0].id);
      this.#notice(conversationId, "notice.leader", { name: this.#name(rest[0]) });
    }
    // a leader waiting on this member's report would otherwise wait forever
    const g = this.#group(conversationId);
    if (g.awaiting.delete(memberId) && g.awaiting.size === 0) {
      const leader = this.#leaderOf(this.store.getConversation(conversationId)!, rest);
      if (leader) this.#relay(conversationId, leader.id, "reports");
    }
    this.#sync(conversationId);
  }

  setMode(conversationId: string, mode: Mode, leaderMemberId?: string): void {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error(t("error.conversation.notFound"));
    const members = this.store.activeMembers(conversationId);
    if (leaderMemberId && !members.some((m) => m.id === leaderMemberId)) {
      throw new Error(t("error.leader.notMember"));
    }
    const before = this.#leaderOf(conv, members);
    this.store.setMode(conversationId, mode, leaderMemberId ?? (mode === "leader" ? before?.id : null));
    const leader = this.#leaderOf(this.store.getConversation(conversationId)!, members);

    if (mode !== conv.mode) {
      if (mode === "leader" && leader) this.#notice(conversationId, "notice.mode.leaderWith", { name: this.#name(leader) });
      else this.#notice(conversationId, `notice.mode.${mode}`);
    } else if (mode === "leader" && leader && leader.id !== before?.id) {
      this.#notice(conversationId, "notice.leader", { name: this.#name(leader) });
    }
    // handoffs belong to the rules they were made under
    this.#group(conversationId).awaiting.clear();
    this.#pushConversations();
  }

  /** Adopts the bot's edited preset; the member restarts from the shared transcript. */
  async syncMember(conversationId: string, memberId: string): Promise<void> {
    const member = this.store.getMember(memberId);
    if (!member || member.conversation_id !== conversationId || member.left_at !== null) {
      throw new Error(t("error.member.notFound"));
    }
    const live = this.#lives.get(memberId);
    if (live?.running) throw new Error(t("error.sync.busy"));
    const picked = member.settings;
    this.store.refreshSpec(memberId);
    if (live) this.#forget(live);
    // picks the new setup still offers carry over; the rest belonged to the old one
    const refreshed = this.store.getMember(memberId);
    if (refreshed && Object.keys(picked).length > 0) {
      const options = await this.#optionsFor(refreshed).catch(() => null);
      const kept = options ? stillOffered(picked, options) : {};
      if (Object.keys(kept).length > 0) this.store.setSettings(memberId, kept);
    }
    this.#notice(conversationId, "notice.synced", { name: this.#name(member) });
    this.#pushConversations();
    this.#announceResting(conversationId, memberId);
  }

  /**
   * Moves the conversation. Every backend session is bound to the directory it
   * was opened in, so each member starts a fresh one there on its next turn and
   * reads the transcript again; nothing may be mid-turn. Returns false when the
   * conversation already works there.
   */
  async setDirectory(conversationId: string, path: string, kind: DirKind): Promise<boolean> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error(t("error.conversation.notFound"));
    // a direct chat is one bot in its own chat space; there is no other place for it
    if (conv.shape === "direct" && conv.dir_kind === "chat") throw new Error(t("error.directory.direct"));
    if (conv.repo_path === path && conv.dir_kind === kind) return false;
    const lives = this.#livesOf(conversationId);
    // a session still starting would come up in the old directory
    if (lives.some((l) => l.running || l.queued.size > 0 || l.starting)) throw new Error(t("error.directory.busy"));
    this.store.setDirectory(conversationId, path, kind);
    for (const live of lives) this.#forget(live);
    // handoffs were made for work in the old directory
    this.#group(conversationId).awaiting.clear();
    if (kind === "chat") this.#notice(conversationId, "notice.directory.chat", { path });
    else this.#notice(conversationId, "notice.directory", { path });
    this.#pushConversations();
    for (const m of this.store.activeMembers(conversationId)) this.#announceResting(conversationId, m.id);
    return true;
  }

  /** Forgets the runtime and what it reported; the next turn opens a new session. */
  #forget(live: Live): void {
    this.#drop(live);
    live.session = null;
  }

  /** The old session's report no longer holds; shows what the member will run with until a turn restates it. */
  #announceResting(conversationId: string, memberId: string): void {
    const member = this.store.getMember(memberId);
    if (!member) return;
    void this.#resting(member).then((info) => {
      if (this.#lives.get(memberId)?.session) return;
      this.broadcast({ kind: "session", conversationId, memberId, info: this.#shown(this.store.getMember(memberId) ?? member, info) });
    });
  }

  /** Pushes what a member's session shows now: its own report while it has one, else the preview. */
  async #announce(conversationId: string, memberId: string): Promise<void> {
    const member = this.store.getMember(memberId);
    if (!member) return;
    const info = this.#lives.get(memberId)?.session ?? (await this.#resting(member));
    // read again: a tier picked while the preview was being made is the one to show
    this.broadcast({ kind: "session", conversationId, memberId, info: this.#shown(this.store.getMember(memberId) ?? member, info) });
  }

  /**
   * Archiving or deleting means you are done with it; holding backend sessions
   * open would keep subprocesses and their context alive for nothing. Resume
   * tokens are already stored, so unarchiving picks up where it left off.
   */
  async release(conversationId: string): Promise<void> {
    this.#denyPending((p) => p.conversationId === conversationId, t("deny.closed"));
    const g = this.#groups.get(conversationId);
    if (g) for (const w of g.lease.queue.splice(0)) w.grant(false);
    this.#groups.delete(conversationId);
    await Promise.all(
      this.#livesOf(conversationId).map(async (l) => {
        l.gone = true;
        l.queued.clear();
        this.#lives.delete(l.memberId);
        this.#setPresence(l, null);
        const runtime = l.runtime;
        l.runtime = null;
        await runtime?.dispose().catch(() => {});
      }),
    );
    // nothing is running any more; an unarchived conversation must not come back spinning
    if (this.store.getConversation(conversationId)) this.store.setRunState(conversationId, "idle");
  }

  async disposeAll(): Promise<void> {
    this.#denyPending(() => true, t("deny.quitting"));
    const lives = [...this.#lives.values()];
    this.#lives.clear();
    await Promise.all(
      lives.map(async (l) => {
        l.gone = true;
        await l.runtime?.dispose().catch(() => {});
      }),
    );
  }

  // ---- turns ----

  #live(conversationId: string, memberId: string): Live {
    let live = this.#lives.get(memberId);
    if (!live) {
      live = {
        memberId,
        conversationId,
        runtime: null,
        starting: null,
        running: false,
        turnId: null,
        since: 0,
        buffer: "",
        thought: null,
        asks: new Set(),
        queued: new Set(),
        aborted: false,
        errored: false,
        gone: false,
        presence: null,
        session: null,
        executor: null,
      };
      this.#lives.set(memberId, live);
    }
    return live;
  }

  #ask(conversationId: string, memberId: string, ask: Ask): void {
    const live = this.#live(conversationId, memberId);
    if (live.gone) return;
    if (live.running) live.queued.add(ask);
    else this.#begin(live, new Set([ask]));
  }

  /** Marks the member running synchronously, so a second ask in the same tick queues. */
  #begin(live: Live, asks: Set<Ask>): void {
    const g = this.#group(live.conversationId);
    if (!g.busy) {
      g.busy = true;
      g.failed = false;
      g.error = null;
    }
    const turnId = randomUUID();
    Object.assign(live, { running: true, asks, turnId, since: Date.now(), buffer: "", thought: null, aborted: false, errored: false });
    this.#setPresence(live, live.runtime ? "thinking" : "starting");
    // off the current stack: this can be called from inside a backend's own
    // event dispatch, which is still unwinding the turn that just ended
    setImmediate(() => {
      void this.#execute(live, turnId).catch((err: unknown) => this.#fail(live, turnId, err));
    });
  }

  async #execute(live: Live, turnId: string): Promise<void> {
    let runtime = await this.#ensure(live);
    if (!live.running || live.turnId !== turnId) return;
    const member = this.store.getMember(live.memberId);
    const conv = this.store.getConversation(live.conversationId);
    if (live.aborted || live.gone || !member || !conv || member.left_at !== null) {
      return this.#finish(live, "aborted");
    }

    const members = this.store.activeMembers(conv.id);
    const { items, upTo } = this.store.backlog(member);
    const store = this.attachments;
    const delivery = composeDelivery({
      // alone, a member reads the person's words as they are; the conversation's shape is only how the window draws it
      shape: members.length > 1 ? "group" : "direct",
      title: conv.title,
      mode: conv.mode,
      selfId: member.id,
      leaderId: this.#leaderOf(conv, members)?.id ?? null,
      members: members.map((m) => ({
        id: m.id,
        name: this.#name(m),
        title: this.store.getBot(m.bot_id)?.title ?? null,
      })),
      names: new Map(this.store.members(conv.id).map((m) => [m.id, m.bot.name])),
      items: items.map((i) => (i.attachments && store ? { ...i, files: store.deliver(conv.id, i.attachments) } : i)),
      asks: live.asks,
      fresh: member.delivered_seq === 0,
    });
    if (!delivery) return this.#finish(live, "done");
    this.store.setDelivered(member.id, upTo);
    this.#setPresence(live, "thinking");

    try {
      await runtime.send(delivery.text, undefined, delivery.attachments);
    } catch {
      // a backend process can die between turns; one fresh start resumes it
      this.#drop(live);
      runtime = await this.#ensure(live);
      if (!live.running || live.turnId !== turnId || live.aborted) return this.#finish(live, "aborted");
      await runtime.send(delivery.text, undefined, delivery.attachments);
    }
  }

  #ensure(live: Live): Promise<BotRuntime> {
    if (live.runtime) return Promise.resolve(live.runtime);
    live.starting ??= this.#start(live).finally(() => {
      live.starting = null;
    });
    return live.starting;
  }

  async #start(live: Live): Promise<BotRuntime> {
    const member = this.store.getMember(live.memberId);
    const conv = this.store.getConversation(live.conversationId);
    if (!member || !conv) throw new Error(t("error.member.gone"));
    const executor = this.registry.get(member.spec.executor_id);
    if (!executor) throw new Error(this.registry.problem(member.spec.executor_id) ?? t("error.agent.deleted"));
    const settings = this.#effective(member);

    // the registry is rebuilt on every settings change, so an endpoint edited since the last turn is already in here, key included
    const runtime = executor.create();
    // a replaced runtime can still emit while it winds down; only the current one speaks
    runtime.subscribe((e) => {
      if (live.runtime === runtime) this.#onEvent(live, e);
    });
    try {
      await runtime.start({
        cwd: conv.worktree_path,
        systemPrompt: member.spec.system_prompt ?? undefined,
        ...settings,
        resumeToken: member.resume_token ?? undefined,
        onToolCall: (call) => this.#gate(live, call),
        onPermission: (call) => this.#backendAsks(live, call),
      });
    } catch (err) {
      await runtime.dispose().catch(() => {});
      throw err;
    }
    if (live.gone) {
      await runtime.dispose().catch(() => {});
      throw new Error(t("error.member.left"));
    }
    live.runtime = runtime;
    live.executor = executor.id;
    // the token only exists once the backend has opened its session
    if (runtime.resumeToken) this.store.setResumeToken(member.id, runtime.resumeToken);
    return runtime;
  }

  #onEvent(live: Live, e: NormalizedEvent): void {
    if (live.gone) return;
    // a thought is over once the turn does anything else; a readout of the session is not the turn doing something
    if (e.type !== "assistant.thinking" && e.type !== "session.info" && e.type !== "cost") this.#settle(live);
    switch (e.type) {
      case "assistant.text":
        if (e.final) break;
        live.buffer += e.delta;
        this.#setPresence(live, "writing");
        this.#delta(live, e.delta);
        return;
      case "assistant.thinking":
        this.#think(live, e.delta);
        this.#setPresence(live, "thinking");
        return;
      case "tool.start":
        // text before and after a tool round becomes one reply; keep the paragraphs apart
        if (live.buffer.trim() && !live.buffer.endsWith("\n\n")) {
          const gap = live.buffer.endsWith("\n") ? "\n" : "\n\n";
          live.buffer += gap;
          this.#delta(live, gap);
        }
        this.#setPresence(live, "tool", e.call.name);
        this.#event(live, { ...e, at: this.#written(live) });
        return;
      case "tool.end":
        this.#setPresence(live, "thinking");
        break;
      case "error":
        live.errored = true;
        break;
      case "session.info": {
        // restated every turn; only a change is news
        if (live.session && sameInfo(live.session, e.info)) return;
        live.session = e.info;
        this.store.setReport(live.memberId, e.info);
        // a mode the session moved into by itself -- leaving Plan once its plan is approved -- is where it now is
        const member = this.store.getMember(live.memberId);
        if (member && this.#ownModes(member) && e.info.mode && e.info.mode !== this.#effective(member).mode) {
          this.store.setSettings(member.id, { ...member.settings, mode: e.info.mode });
        }
        const info = member ? this.#shown(member, e.info) : e.info;
        this.broadcast({ kind: "session", conversationId: live.conversationId, memberId: live.memberId, info });
        return;
      }
      case "turn.end":
        this.#event(live, e);
        this.#finish(live, e.reason);
        return;
      default:
        break;
    }
    this.#event(live, e);
  }

  #fail(live: Live, turnId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#event(live, { type: "error", display: "message", message });
    this.#group(live.conversationId).error = { name: this.#nameOf(live.memberId), message };
    this.#drop(live);
    if (live.running && live.turnId === turnId) {
      live.errored = true;
      this.#finish(live, "error");
    }
  }

  #finish(live: Live, reason: Reason): void {
    if (!live.running) return;
    this.#settle(live);
    const text = this.#flush(live);
    this.#releaseLease(live);
    const token = live.runtime?.resumeToken;
    if (token && !live.gone && this.store.getResumeToken(live.memberId) !== token) {
      this.store.setResumeToken(live.memberId, token);
    }
    const asks = live.asks;
    const g = this.#group(live.conversationId);
    if (live.errored || reason === "error") g.failed = true;
    Object.assign(live, { running: false, asks: new Set(), turnId: null });
    this.#setPresence(live, null);

    if (live.queued.size > 0 && !g.halted && !live.gone) {
      const next = live.queued;
      live.queued = new Set();
      this.#begin(live, next);
    }
    if (!live.gone) this.#chain(live, asks, reason, text);
    this.#sync(live.conversationId);
    if (live.runtime && live.executor) this.#refreshQuota(live.executor, QUOTA_AFTER_TURN_MS);
  }

  /** How much of its reply the turn has written, counted the way #flush will store it. */
  #written(live: Live): number {
    return live.buffer.trimStart().length;
  }

  /** Turns the accumulated deltas into the one row that represents what was said. */
  #flush(live: Live): string {
    const text = live.buffer.trim();
    live.buffer = "";
    if (text) this.#event(live, { type: "assistant.text", display: "message", delta: text, final: true });
    return text;
  }

  /** Streams thinking as it comes; the thought gets its row in the steps card with its first words. */
  #think(live: Live, delta: string): void {
    // a backend that hides its thinking still sends the blocks, with nothing in them
    if (!live.running || (!live.thought && !delta.trim())) return;
    if (!live.thought) {
      live.thought = { id: randomUUID(), at: this.#written(live), startedAt: Date.now(), text: "" };
      const { id, at, startedAt } = live.thought;
      this.#event(live, { type: "assistant.thinking", display: "fold", id, at, startedAt, delta: "" });
    }
    live.thought.text += delta;
    this.broadcast({
      kind: "thinking",
      conversationId: live.conversationId,
      memberId: live.memberId,
      id: live.thought.id,
      text: delta,
    });
  }

  /** Writes the thought that just ended, whole: its words to the log, its end to the steps card. */
  #settle(live: Live): void {
    const thought = live.thought;
    if (!thought) return;
    live.thought = null;
    const { text, ...rest } = thought;
    this.#event(live, { type: "assistant.thinking", display: "fold", ...rest, delta: text.trim(), final: true });
  }

  /** Leader mode's loop: the leader dispatches with @, reports come back, it decides again. */
  #chain(live: Live, asks: Set<Ask>, reason: Reason, text: string): void {
    const g = this.#group(live.conversationId);
    const conv = this.store.getConversation(live.conversationId);
    if (g.halted || !conv || conv.mode !== "leader") return;
    const members = this.store.activeMembers(conv.id);
    const leader = this.#leaderOf(conv, members);
    if (!leader) return;

    if (asks.has("dispatch") && g.awaiting.delete(live.memberId)) {
      if (!text) {
        const why = reason === "done" ? "empty" : reason;
        this.#notice(conv.id, `notice.noReport.${why}`, { name: this.#nameOf(live.memberId) });
      }
      if (g.awaiting.size === 0 && leader.id !== live.memberId) this.#relay(conv.id, leader.id, "reports");
    }

    const leading = asks.has("lead") || asks.has("reports");
    if (live.memberId === leader.id && leading && reason === "done" && text) {
      const others = members.filter((m) => m.id !== leader.id);
      const hit = findMentions(text, this.#named(others));
      for (const id of hit.all ? others.map((m) => m.id) : hit.ids) {
        g.awaiting.add(id);
        if (!this.#relay(conv.id, id, "dispatch")) break;
      }
    }
  }

  /** A bot-initiated ask, counted against the brake. */
  #relay(conversationId: string, memberId: string, ask: Ask): boolean {
    const g = this.#group(conversationId);
    if (g.halted) return false;
    if (++g.relays > RELAY_BRAKE) {
      g.halted = true;
      g.awaiting.clear();
      this.#notice(conversationId, "notice.relayBrake", { count: RELAY_BRAKE });
      return false;
    }
    this.#ask(conversationId, memberId, ask);
    return true;
  }

  // ---- the gate ----

  /**
   * The single choke point: permission and the write lease both run here,
   * because the interception is already happening. May block for as long as a
   * human takes.
   */
  async #gate(live: Live, call: ToolCall): Promise<ToolDecision> {
    if (live.gone || live.aborted) return { action: "deny", reason: t("deny.halted"), terminate: true };
    // a backend can ask about a call before announcing it; the thinking that led to it is over either way
    this.#settle(live);
    const conv = this.store.getConversation(live.conversationId);
    const member = this.store.getMember(live.memberId);
    const bot = member && this.store.getBot(member.bot_id);
    if (!conv || !member || !bot) return { action: "deny", reason: t("deny.memberGone"), terminate: true };

    // A backend with permission modes of its own decides by the mode picked for
    // the session, the way it would outside Roster. Discussion is talk only, so
    // there anything past reading goes through the human for every backend.
    const ownModes = this.registry.get(member.spec.executor_id)?.capabilities.permissionModes === true;
    const deferring = ownModes && conv.mode !== "discussion";
    // the live tier, not the join-time snapshot: lowering it must take effect now
    const tier: Tier = conv.mode === "discussion" ? "read" : this.#tierOf(member, bot);
    if (!deferring && TIER_RANK[call.effect] > TIER_RANK[tier]) {
      const decision = await this.#askHuman(live, call);
      this.#event(live, { type: "permission.decision", display: "card", id: call.id, decision });
      if (decision.action === "deny") {
        this.#setPresence(live, "thinking");
        return decision;
      }
    }
    // taken before the backend decides: two writers must not both be let through
    if (call.effect !== "read" && !(await this.#acquire(live))) {
      return { action: "deny", reason: t("deny.halted"), terminate: true };
    }
    this.#setPresence(live, "tool", call.name);
    return deferring ? { action: "defer" } : { action: "allow" };
  }

  /** The session's own mode wants a human for a call the gate deferred; the gate already holds the lease. */
  async #backendAsks(live: Live, call: ToolCall): Promise<ToolDecision> {
    if (live.gone || live.aborted) return { action: "deny", reason: t("deny.halted"), terminate: true };
    const decision = await this.#askHuman(live, call);
    this.#event(live, { type: "permission.decision", display: "card", id: call.id, decision });
    if (decision.action === "deny") this.#setPresence(live, "thinking");
    else this.#setPresence(live, "tool", call.name);
    return decision;
  }

  #askHuman(live: Live, call: ToolCall): Promise<ToolDecision> {
    this.#event(live, { type: "permission.request", display: "card", call, at: this.#written(live) });
    this.#setPresence(live, "waiting_permission", call.name);
    const decided = new Promise<ToolDecision>((resolve) =>
      this.#pending.set(call.id, { conversationId: live.conversationId, memberId: live.memberId, call, resolve }),
    );
    this.#sync(live.conversationId);
    return decided;
  }

  #denyPending(match: (p: Pending) => boolean, reason: string): void {
    for (const [id, p] of this.#pending) {
      if (!match(p)) continue;
      this.#pending.delete(id);
      p.resolve({ action: "deny", reason, terminate: true });
    }
  }

  /**
   * The lease is held for the rest of the turn, not per call -- per-call leases
   * would interleave two bots' edits inside one logical change.
   */
  #acquire(live: Live): Promise<boolean> {
    const { lease } = this.#group(live.conversationId);
    if (lease.holder === null || lease.holder === live.memberId) {
      lease.holder = live.memberId;
      return Promise.resolve(true);
    }
    this.#setPresence(live, "waiting_lock", this.#nameOf(lease.holder));
    return new Promise((grant) => lease.queue.push({ memberId: live.memberId, grant }));
  }

  #releaseLease(live: Live): void {
    const { lease } = this.#group(live.conversationId);
    for (const w of lease.queue.filter((w) => w.memberId === live.memberId)) w.grant(false);
    lease.queue = lease.queue.filter((w) => w.memberId !== live.memberId);
    if (lease.holder !== live.memberId) return;
    const next = lease.queue.shift();
    lease.holder = next?.memberId ?? null;
    next?.grant(true);
  }

  // ---- session status ----

  /**
   * What a member's session starts with: its own picks over the join-time spec --
   * not the bot as since edited -- then the executor's default model, and, for a
   * mode nobody picked, the one its tier names. A backend without modes of its
   * own gets none: what was picked there is a tier, which only the gate reads.
   */
  #effective(m: MemberRow): SessionSettings {
    const tier = this.store.getBot(m.bot_id)?.permission_tier ?? "read";
    const model = m.settings.model ?? m.spec.model ?? this.store.getExecutor(m.spec.executor_id)?.model ?? undefined;
    const mode = this.#ownModes(m) ? (m.settings.mode ?? this.registry.get(m.spec.executor_id)?.modeForTier?.(tier)) : undefined;
    return {
      ...(model ? { model } : {}),
      ...(m.settings.effort ? { effort: m.settings.effort } : {}),
      ...(mode ? { mode } : {}),
      ...(m.settings.fast !== undefined ? { fast: m.settings.fast } : {}),
    };
  }

  /** A member with no live session: the backend's preview of its settings, and the context its last session left. */
  async #resting(m: MemberRow): Promise<SessionInfo> {
    const executor = this.registry.get(m.spec.executor_id);
    const preview = (await executor?.sessionInfo?.(this.#effective(m)).catch(() => null)) ?? null;
    return { ...preview, ...(m.report?.context ? { context: m.report.context } : {}) };
  }

  /**
   * What a member's session can be switched to: its executor's own options,
   * nothing from any other source. Without permission modes of its own the gate
   * goes by tier, so the tiers are the modes offered.
   */
  async #optionsFor(m: MemberRow): Promise<SessionOptions | null> {
    const executor = this.registry.get(m.spec.executor_id);
    if (!executor) return null;
    const own = executor.sessionOptions ? await executor.sessionOptions().catch(() => null) : null;
    if (executor.capabilities.permissionModes) return own;
    return { models: [], efforts: [], compact: false, ...own, modes: tierModes() };
  }

  /** The backend approves by permission modes of its own; without them the gate goes by tier. */
  #ownModes(m: MemberRow): boolean {
    return this.registry.get(m.spec.executor_id)?.capabilities.permissionModes === true;
  }

  /** What the gate lets a session do unasked: the tier picked for it, which only a backend without modes offers, else its bot's. */
  #tierOf(m: MemberRow, bot: BotRow): Tier {
    return !this.#ownModes(m) && isTier(m.settings.mode) ? m.settings.mode : bot.permission_tier;
  }

  /** Without modes of its own, the mode a session shows is the tier it is gated by. */
  #shown(m: MemberRow, info: SessionInfo): SessionInfo {
    const bot = this.store.getBot(m.bot_id);
    if (!bot || !this.registry.get(m.spec.executor_id) || this.#ownModes(m)) return info;
    return { ...info, mode: this.#tierOf(m, bot) };
  }

  /** Re-reads an executor's plan usage once the last read is older than maxAgeMs, and pushes it if it moved. */
  #refreshQuota(id: string, maxAgeMs: number): void {
    // a live session answers without spawning anything
    const live = [...this.#lives.values()].find((l) => !l.gone && l.executor === id && l.runtime?.quota);
    const executor = this.registry.get(id);
    const read = live?.runtime?.quota?.bind(live.runtime) ?? executor?.quota?.bind(executor);
    if (!read) return;
    const entry = this.#quotas.get(id) ?? { at: 0, value: null, reading: false };
    this.#quotas.set(id, entry);
    if (entry.reading || (Date.now() - entry.at < maxAgeMs && !outOfDate(entry))) return;
    entry.reading = true;
    void read()
      .then((value) => {
        const moved = entry.at === 0 || JSON.stringify(value) !== JSON.stringify(entry.value);
        entry.value = value;
        if (moved) this.broadcast({ kind: "quota", executor: id, quota: value });
      })
      // a failed read keeps the last good value and waits out the same interval before trying again
      .catch(() => {})
      .finally(() => {
        entry.at = Date.now();
        entry.reading = false;
      });
  }

  // ---- plumbing ----

  /** Stops a member for good: its turn, its prompts, its backend session. */
  async #retire(live: Live): Promise<void> {
    live.queued.clear();
    this.#denyPending((p) => p.memberId === live.memberId, t("deny.removed"));
    if (live.running) this.#finish(live, "aborted");
    live.gone = true;
    this.#lives.delete(live.memberId);
    const runtime = live.runtime;
    live.runtime = null;
    await runtime?.abort().catch(() => {});
    await runtime?.dispose().catch(() => {});
  }

  /** Forgets the runtime; the next turn starts a new one from the resume token. */
  #drop(live: Live): void {
    const runtime = live.runtime;
    live.runtime = null;
    void runtime?.dispose().catch(() => {});
  }

  #sync(conversationId: string): void {
    const conv = this.store.getConversation(conversationId);
    if (!conv) return;
    const g = this.#group(conversationId);
    const running = this.#livesOf(conversationId).some((l) => l.running || l.queued.size > 0);
    this.store.setRunState(conversationId, running ? "running" : "idle");
    const asking = [...this.#pending.values()].find((p) => p.conversationId === conversationId);
    if (asking) {
      this.#attend(conv, { reason: "waiting_permission", name: this.#nameOf(asking.memberId), call: asking.call });
    } else if (!running && g.busy) {
      g.busy = false;
      const failure = g.failed ? (g.error ?? { message: t("notify.failed") }) : null;
      this.#attend(conv, failure ? { reason: "error", ...failure } : { reason: "waiting_input" });
    } else if (conv.attention === "waiting_permission") {
      this.store.setAttention(conversationId, "none");
    }
    this.#pushConversations();
  }

  /**
   * What a conversation waits for, and -- only as it starts waiting -- the one
   * notification its clients show. Already waiting for the same thing is not
   * news: a second approval request while one is up adds no second interruption.
   */
  #attend(conv: ConversationRow, waiting: Waiting): void {
    const news = conv.attention !== waiting.reason;
    this.store.setAttention(conv.id, waiting.reason);
    if (news) this.broadcast({ kind: "notify", notification: notificationOf(conv, waiting) });
  }

  #group(conversationId: string): Group {
    let g = this.#groups.get(conversationId);
    if (!g) {
      g = {
        awaiting: new Set(),
        relays: 0,
        halted: false,
        busy: false,
        failed: false,
        error: null,
        lease: { holder: null, queue: [] },
      };
      this.#groups.set(conversationId, g);
    }
    return g;
  }

  #livesOf(conversationId: string): Live[] {
    return [...this.#lives.values()].filter((l) => l.conversationId === conversationId && !l.gone);
  }

  #leaderOf(conv: ConversationRow, members: MemberRow[]): MemberRow | undefined {
    return members.find((m) => m.id === conv.leader_member_id) ?? members[0];
  }

  /** The live name, since that is what people type after @. */
  #name(m: MemberRow): string {
    return this.store.getBot(m.bot_id)?.name ?? m.spec.name;
  }

  #nameOf(memberId: string): string {
    const m = this.store.getMember(memberId);
    return m ? this.#name(m) : t("member.someone");
  }

  #named(members: MemberRow[]) {
    return members.map((m) => ({ id: m.id, name: this.#name(m) }));
  }

  #setPresence(live: Live, state: PresenceState | null, detail?: string): void {
    const turnId = state && live.turnId ? live.turnId : undefined;
    const p = live.presence;
    if (p?.state === (state ?? undefined) && p?.detail === detail && p?.turnId === turnId) return;
    const extra = { ...(detail ? { detail } : {}), ...(turnId ? { turnId, since: live.since } : {}) };
    live.presence = state ? { conversationId: live.conversationId, memberId: live.memberId, state, ...extra } : null;
    this.broadcast({
      kind: "presence",
      conversationId: live.conversationId,
      memberId: live.memberId,
      state: state ?? "idle",
      ...extra,
    });
  }

  #delta(live: Live, text: string): void {
    // deltas go to the wire only
    this.broadcast({ kind: "delta", conversationId: live.conversationId, memberId: live.memberId, text });
  }

  #event(live: Live, e: CoreEvent): void {
    this.#append(live.conversationId, live.memberId, live.turnId, e);
  }

  /** Written as its key, so a transcript reads in whatever language it is opened in, and to whichever bot catches up on it. */
  #notice<K extends Extract<Key, `notice.${string}`>>(conversationId: string, key: K, ...params: ParamsFor<K>): void {
    const [values] = params;
    const notice = values ? { key, params: values as Record<string, ParamValue> } : { key };
    this.#append(conversationId, null, null, { type: "system.notice", display: "message", text: t(key, ...params), notice });
  }

  #append(conversationId: string, memberId: string | null, turnId: string | null, e: CoreEvent): void {
    // a conversation deleted mid-turn still gets late events from its backend
    if (!this.store.getConversation(conversationId)) return;
    const { touched } = this.store.append(conversationId, memberId, turnId, e);
    for (const m of touched) this.broadcast({ kind: "message", conversationId, message: m });
  }

  #pushConversations(): void {
    this.broadcast({ kind: "conversations", conversations: this.store.listConversations() });
  }
}
