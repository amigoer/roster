import { randomUUID } from "node:crypto";
import type {
  BotRuntime,
  Capabilities,
  ContextDetail,
  ModelSource,
  NormalizedEvent,
  Quota,
  SessionInfo,
  SessionOptions,
  SessionSettings,
  SourceKind,
  Sources as SourceShape,
  ToolCall,
  ToolDecision,
} from "@roster/adapter-api";
import type { AttachmentRef, AttachmentStore } from "./attachments.js";
import { composeDelivery, MODE_LABEL, type Ask } from "./delivery.js";
import type { CoreEvent } from "./log.js";
import { findMentions } from "./mentions.js";
import type { Registry } from "./registry.js";
import { kindOf, type ModelGroup, type Sources } from "./sources.js";
import { titleFrom, UNTITLED } from "./store.js";
import type { ConversationRow, MemberRow, MemberSettings, Mode, Store, Tier } from "./store.js";

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

export type PresenceState = "starting" | "thinking" | "tool" | "waiting_permission" | "waiting_lock" | "compacting";

export interface Presence {
  conversationId: string;
  memberId: string;
  state: PresenceState;
  detail?: string;
}

type Reason = "done" | "aborted" | "error";

interface Live {
  memberId: string;
  conversationId: string;
  runtime: BotRuntime | null;
  starting: Promise<BotRuntime> | null;
  running: boolean;
  turnId: string | null;
  /** deltas are not rows; the finalized text is written when the turn ends */
  buffer: string;
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
  /** talking is concurrent, writing is not */
  lease: { holder: string | null; queue: Array<{ memberId: string; grant: (ok: boolean) => void }> };
}

interface Pending {
  conversationId: string;
  memberId: string;
  resolve: (d: ToolDecision) => void;
}

export class Orchestrator {
  #lives = new Map<string, Live>();
  #groups = new Map<string, Group>();
  #pending = new Map<string, Pending>();
  #models: { at: number; value: Record<string, ModelGroup[]> } | null = null;
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
   * runs. Per model source, because the channels differ: the same executor
   * driven over ACP for its own sign-in cannot do what it does over an SDK.
   */
  capabilities(): Record<string, Partial<Record<SourceKind, Capabilities>>> {
    return Object.fromEntries(
      this.registry.entries().map(([id, e]) => [
        id,
        {
          ...(e.sources.own ? { own: e.capabilities("own") } : {}),
          ...(e.sources.apis.length > 0 ? { endpoint: e.capabilities("endpoint") } : {}),
        },
      ]),
    );
  }

  /** What bots can run on, under the names people gave them. */
  executors(): Array<{ id: string; type: string; label: string; sources: SourceShape }> {
    return this.registry.entries().map(([id, e]) => ({ id, type: e.type, label: e.label, sources: e.sources }));
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

  /** Every model each executor could run, grouped by where it comes from. */
  async models(): Promise<Record<string, ModelGroup[]>> {
    if (this.#models && Date.now() - this.#models.at < 5 * 60_000) return this.#models.value;
    const entries = await Promise.all(
      this.registry.ids().map(async (id) => [id, await this.sources.groups(id).catch(() => [])] as const),
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
        const info = this.#lives.get(m.id)?.session ?? (await this.#resting(m));
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
   * A model from another source is another backend session: the old context
   * cannot follow, so the member starts over from the shared transcript.
   */
  async configure(conversationId: string, memberId: string, patch: MemberSettings): Promise<void> {
    const member = this.#memberOf(conversationId, memberId);
    const current = this.#effective(member).sourceId;
    const next = patch.source !== undefined ? patch.source : current;
    if (next !== current) {
      const group = (await this.sources.groups(member.spec.executor_id)).find((g) => g.source === next);
      if (!group) throw new Error("这个执行器用不了这个模型来源");
      if (patch.model !== undefined && !group.models.some((m) => m.id === patch.model)) {
        throw new Error(`不认识的模型：${patch.model}`);
      }
      const live = this.#lives.get(memberId);
      if (live?.running) throw new Error("它正在干活，等这一轮结束再换模型来源");
      // effort and mode belonged to the old source's option set; only the model comes along
      this.store.restartSession(memberId, { source: next, ...(patch.model !== undefined ? { model: patch.model } : {}) });
      if (live) {
        this.#drop(live);
        live.session = null;
      }
      this.#notice(conversationId, `${this.#name(member)} 换了模型来源，重新开了一个会话`);
      this.#pushConversations();
      const info = await this.#resting(this.store.getMember(memberId)!);
      this.broadcast({ kind: "session", conversationId, memberId, info });
      return;
    }
    const options = await this.#optionsFor(member);
    if (!options) throw new Error("这个执行器不支持在会话里切换");
    if (patch.model !== undefined && !options.models.some((m) => m.id === patch.model && m.source === current)) {
      throw new Error(`不认识的模型：${patch.model}`);
    }
    if (patch.effort !== undefined && !options.efforts.some((e) => e.id === patch.effort)) {
      throw new Error(`不认识的思考级别：${patch.effort}`);
    }
    if (patch.mode !== undefined && !options.modes.some((m) => m.id === patch.mode)) {
      throw new Error(`不认识的模式：${patch.mode}`);
    }
    if (patch.fast && options.fast?.available === false) {
      throw new Error("这个账号现在用不了 fast mode");
    }

    const live = this.#lives.get(memberId);
    const { source: _source, ...settings } = patch;
    // the session reports what actually took, which the push then carries
    if (live?.runtime?.configure) await live.runtime.configure(settings);
    this.store.setSettings(memberId, { ...member.settings, ...settings });
    if (live?.runtime?.configure) return;

    if (live) live.session = null;
    const info = await this.#resting(this.store.getMember(memberId)!);
    this.broadcast({ kind: "session", conversationId, memberId, info });
  }

  /**
   * Frees a member's context by having its backend summarize the history. It is
   * held like a turn, so a message sent meanwhile queues behind it; it writes
   * nothing to the transcript, because there is nothing for anyone to read.
   */
  async compact(conversationId: string, memberId: string): Promise<void> {
    const member = this.#memberOf(conversationId, memberId);
    const options = await this.#optionsFor(member).catch(() => null);
    if (!options?.compact) throw new Error("这个执行器不能压缩上下文");
    const live = this.#live(conversationId, memberId);
    if (live.gone) throw new Error("成员已离开");
    if (live.running) throw new Error("正在回复，等这一轮结束再压缩");

    const turnId = randomUUID();
    Object.assign(live, { running: true, asks: new Set(), turnId, buffer: "", aborted: false, errored: false });
    this.#setPresence(live, "compacting");
    this.#sync(conversationId);
    setImmediate(() => {
      void (async () => {
        const runtime = await this.#ensure(live);
        if (!live.running || live.turnId !== turnId) return;
        if (!runtime.compact) throw new Error("这个执行器不能压缩上下文");
        // completion arrives as the backend's turn.end, which finishes this like any turn
        await runtime.compact();
      })().catch((err: unknown) => this.#fail(live, turnId, err));
    });
  }

  /** Everything a member's context holds. Counting it needs the session, so one is started if none is running. */
  async contextDetail(conversationId: string, memberId: string): Promise<ContextDetail> {
    this.#memberOf(conversationId, memberId);
    const live = this.#live(conversationId, memberId);
    if (live.gone) throw new Error("成员已离开");
    const runtime = await this.#ensure(live);
    if (!runtime.contextDetail) throw new Error("这个执行器不能查看上下文明细");
    return runtime.contextDetail();
  }

  #memberOf(conversationId: string, memberId: string): MemberRow {
    const member = this.store.getMember(memberId);
    if (!member || member.conversation_id !== conversationId || member.left_at !== null) {
      throw new Error("没有这个成员");
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

  // ---- the human side ----

  async send(conversationId: string, text: string, attachments: readonly AttachmentRef[] = []): Promise<void> {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error("no such conversation");
    const members = this.store.activeMembers(conversationId);
    const mentioned = findMentions(text, this.#named(members));

    this.#append(conversationId, null, null, {
      type: "human.text",
      display: "message",
      text,
      mentions: mentioned.ids,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
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

    if (members.length === 0) this.#notice(conversationId, "群里还没有成员，先添加一个再发消息。");
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
    this.#denyPending((p) => p.conversationId === conversationId, "用户停止了这一轮。");
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
    p.resolve(allow ? { action: "allow" } : { action: "deny", reason: "Denied by the human." });
    this.#sync(conversationId);
    return true;
  }

  // ---- membership and rules ----

  addMember(conversationId: string, botId: string): MemberRow {
    if (!this.store.getConversation(conversationId)) throw new Error("no such conversation");
    const bot = this.store.getBot(botId);
    if (!bot || bot.archived_at !== null) throw new Error("通讯录里没有这个 bot");
    if (this.store.activeMembers(conversationId).some((m) => m.bot_id === botId)) {
      throw new Error(`${bot.name} 已经在群里了`);
    }
    const member = this.store.addMember(conversationId, botId);
    this.#notice(conversationId, `${bot.name} 加入了群聊`);
    this.#pushConversations();
    return member;
  }

  async removeMember(conversationId: string, memberId: string): Promise<void> {
    const member = this.store.getMember(memberId);
    if (!member || member.conversation_id !== conversationId || member.left_at !== null) {
      throw new Error("没有这个成员");
    }
    const conv = this.store.getConversation(conversationId)!;
    const leaderBefore = this.#leaderOf(conv, this.store.activeMembers(conversationId));
    const name = this.#name(member);
    this.store.leaveMember(memberId);
    const live = this.#lives.get(memberId);
    if (live) await this.#retire(live);
    this.#notice(conversationId, `${name} 被移出了群聊`);

    const rest = this.store.activeMembers(conversationId);
    if (conv.mode === "leader" && leaderBefore?.id === memberId && rest[0]) {
      this.store.setMode(conversationId, "leader", rest[0].id);
      this.#notice(conversationId, `群主改为 ${this.#name(rest[0])}`);
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
    if (!conv) throw new Error("no such conversation");
    const members = this.store.activeMembers(conversationId);
    if (leaderMemberId && !members.some((m) => m.id === leaderMemberId)) {
      throw new Error("群主必须是群里的成员");
    }
    const before = this.#leaderOf(conv, members);
    this.store.setMode(conversationId, mode, leaderMemberId ?? (mode === "leader" ? before?.id : null));
    const leader = this.#leaderOf(this.store.getConversation(conversationId)!, members);

    if (mode !== conv.mode) {
      this.#notice(
        conversationId,
        mode === "leader" && leader
          ? `群聊模式改为「群主分发」，群主是 ${this.#name(leader)}`
          : `群聊模式改为「${MODE_LABEL[mode]}」`,
      );
    } else if (mode === "leader" && leader && leader.id !== before?.id) {
      this.#notice(conversationId, `群主改为 ${this.#name(leader)}`);
    }
    // handoffs belong to the rules they were made under
    this.#group(conversationId).awaiting.clear();
    this.#pushConversations();
  }

  /** Adopts the bot's edited preset; the member restarts from the shared transcript. */
  async syncMember(conversationId: string, memberId: string): Promise<void> {
    const member = this.store.getMember(memberId);
    if (!member || member.conversation_id !== conversationId || member.left_at !== null) {
      throw new Error("没有这个成员");
    }
    const live = this.#lives.get(memberId);
    if (live?.running) throw new Error("它正在干活，等这一轮结束再同步");
    this.store.refreshSpec(memberId);
    if (live) {
      this.#drop(live);
      live.session = null;
    }
    this.#notice(conversationId, `${this.#name(member)} 更新了设定`);
    this.#pushConversations();
    // the old session's report no longer holds; show what the new spec will run until a turn restates it
    const synced = this.store.getMember(memberId);
    if (synced) {
      void this.#resting(synced).then((info) => {
        if (!this.#lives.get(memberId)?.session) this.broadcast({ kind: "session", conversationId, memberId, info });
      });
    }
  }

  /**
   * Archiving or deleting means you are done with it; holding backend sessions
   * open would keep subprocesses and their context alive for nothing. Resume
   * tokens are already stored, so unarchiving picks up where it left off.
   */
  async release(conversationId: string): Promise<void> {
    this.#denyPending((p) => p.conversationId === conversationId, "会话已关闭。");
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
    this.#denyPending(() => true, "Roster 正在退出。");
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
        buffer: "",
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
    }
    const turnId = randomUUID();
    Object.assign(live, { running: true, asks, turnId, buffer: "", aborted: false, errored: false });
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
      shape: conv.shape,
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
    if (!member || !conv) throw new Error("成员已不在会话里");
    const executor = this.registry.get(member.spec.executor_id);
    if (!executor) throw new Error(`unknown executor ${member.spec.executor_id}`);
    const { settings, sourceId } = this.#effective(member);
    // resolved now, key included: an endpoint edited since the last turn is what the next session runs on
    const source = this.sources.resolve(member.spec.executor_id, sourceId);

    const runtime = executor.create(source);
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
      throw new Error("成员已离开");
    }
    live.runtime = runtime;
    live.executor = executor.id;
    // the token only exists once the backend has opened its session
    if (runtime.resumeToken) this.store.setResumeToken(member.id, runtime.resumeToken);
    return runtime;
  }

  #onEvent(live: Live, e: NormalizedEvent): void {
    if (live.gone) return;
    switch (e.type) {
      case "assistant.text":
        if (e.final) break;
        live.buffer += e.delta;
        this.#delta(live, e.delta);
        return;
      case "assistant.thinking":
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
        break;
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
        if (member && e.info.mode && e.info.mode !== this.#effective(member).settings.mode) {
          this.store.setSettings(member.id, { ...member.settings, mode: e.info.mode });
        }
        this.broadcast({ kind: "session", conversationId: live.conversationId, memberId: live.memberId, info: e.info });
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
    this.#event(live, {
      type: "error",
      display: "message",
      message: err instanceof Error ? err.message : String(err),
    });
    this.#drop(live);
    if (live.running && live.turnId === turnId) {
      live.errored = true;
      this.#finish(live, "error");
    }
  }

  #finish(live: Live, reason: Reason): void {
    if (!live.running) return;
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

  /** Turns the accumulated deltas into the one row that represents what was said. */
  #flush(live: Live): string {
    const text = live.buffer.trim();
    live.buffer = "";
    if (text) this.#event(live, { type: "assistant.text", display: "message", delta: text, final: true });
    return text;
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
        const why = reason === "aborted" ? "被中止" : reason === "error" ? "出错了" : "没有输出";
        this.#notice(conv.id, `${this.#nameOf(live.memberId)} 没有交回结果（${why}）`);
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
      this.#notice(conversationId, `已经连续自动接力 ${RELAY_BRAKE} 次，先停下来等你。回一条消息让它继续。`);
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
    if (live.gone || live.aborted) return { action: "deny", reason: "已停止。", terminate: true };
    const conv = this.store.getConversation(live.conversationId);
    const member = this.store.getMember(live.memberId);
    const bot = member && this.store.getBot(member.bot_id);
    if (!conv || !member || !bot) return { action: "deny", reason: "成员已不在会话里。", terminate: true };

    // A backend with permission modes of its own decides by the mode picked for
    // the session, the way it would outside Roster. Discussion is talk only, so
    // there anything past reading goes through the human for every backend.
    const kind = kindOf(this.#effective(member).sourceId);
    const ownModes = this.registry.get(member.spec.executor_id)?.capabilities(kind).permissionModes === true;
    const deferring = ownModes && conv.mode !== "discussion";
    // the live tier, not the join-time snapshot: lowering it must take effect now
    const tier: Tier = conv.mode === "discussion" ? "read" : bot.permission_tier;
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
      return { action: "deny", reason: "已停止。", terminate: true };
    }
    this.#setPresence(live, "tool", call.name);
    return deferring ? { action: "defer" } : { action: "allow" };
  }

  /** The session's own mode wants a human for a call the gate deferred; the gate already holds the lease. */
  async #backendAsks(live: Live, call: ToolCall): Promise<ToolDecision> {
    if (live.gone || live.aborted) return { action: "deny", reason: "已停止。", terminate: true };
    const decision = await this.#askHuman(live, call);
    this.#event(live, { type: "permission.decision", display: "card", id: call.id, decision });
    if (decision.action === "deny") this.#setPresence(live, "thinking");
    else this.#setPresence(live, "tool", call.name);
    return decision;
  }

  #askHuman(live: Live, call: ToolCall): Promise<ToolDecision> {
    this.#event(live, { type: "permission.request", display: "card", call });
    this.#setPresence(live, "waiting_permission", call.name);
    const decided = new Promise<ToolDecision>((resolve) =>
      this.#pending.set(call.id, { conversationId: live.conversationId, memberId: live.memberId, resolve }),
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
   * not the bot as since edited -- and, for a mode nobody picked, the one its tier names.
   * The source is where the models come from: an endpoint id, or null for the agent's own sign-in.
   */
  #effective(m: MemberRow): { settings: SessionSettings; sourceId: string | null } {
    const tier = this.store.getBot(m.bot_id)?.permission_tier ?? "read";
    const sourceId = m.settings.source !== undefined ? m.settings.source : (m.spec.model_source ?? null);
    const model = m.settings.model ?? m.spec.model ?? undefined;
    const mode = m.settings.mode ?? this.registry.get(m.spec.executor_id)?.modeForTier?.(tier, kindOf(sourceId));
    return {
      sourceId,
      settings: {
        ...(model ? { model } : {}),
        ...(m.settings.effort ? { effort: m.settings.effort } : {}),
        ...(mode ? { mode } : {}),
        ...(m.settings.fast !== undefined ? { fast: m.settings.fast } : {}),
      },
    };
  }

  #sourceOf(m: MemberRow): ModelSource | null {
    try {
      return this.sources.resolve(m.spec.executor_id, this.#effective(m).sourceId);
    } catch {
      return null;
    }
  }

  /** A member with no live session: the backend's preview of its settings, and the context its last session left. */
  async #resting(m: MemberRow): Promise<SessionInfo> {
    const executor = this.registry.get(m.spec.executor_id);
    const source = this.#sourceOf(m);
    const preview = source ? await executor?.sessionInfo?.(this.#effective(m).settings, source).catch(() => null) : null;
    return { ...preview, ...(m.report?.context ? { context: m.report.context } : {}) };
  }

  /**
   * What a member's session can be switched to: its source's own options, plus
   * the models of every other source it could move to, each marked with where
   * it comes from. Picking one of those is a source switch, not a live change.
   */
  async #optionsFor(m: MemberRow): Promise<SessionOptions | null> {
    const executor = this.registry.get(m.spec.executor_id);
    const source = this.#sourceOf(m);
    if (!executor?.sessionOptions || !source) return null;
    const own = await executor.sessionOptions(source).catch(() => null);
    if (!own) return null;
    const sourceId = this.#effective(m).sourceId;
    const groups = await this.sources.groups(m.spec.executor_id).catch(() => []);
    const current = own.models.map((x) => ({ ...x, source: sourceId }));
    const others = groups
      .filter((g) => g.source !== sourceId)
      .flatMap((g) => g.models.map((x) => ({ id: x.id, label: x.label ?? x.id, efforts: [], source: g.source, sourceLabel: g.label })));
    return { ...own, models: [...current, ...others] };
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
    this.#denyPending((p) => p.memberId === live.memberId, "成员已被移出群聊。");
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
    const asking = [...this.#pending.values()].some((p) => p.conversationId === conversationId);
    if (asking) {
      this.store.setAttention(conversationId, "waiting_permission");
    } else if (!running && g.busy) {
      g.busy = false;
      this.store.setAttention(conversationId, g.failed ? "error" : "waiting_input");
    } else if (conv.attention === "waiting_permission") {
      this.store.setAttention(conversationId, "none");
    }
    this.#pushConversations();
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
    return m ? this.#name(m) : "成员";
  }

  #named(members: MemberRow[]) {
    return members.map((m) => ({ id: m.id, name: this.#name(m) }));
  }

  #setPresence(live: Live, state: PresenceState | null, detail?: string): void {
    if (live.presence?.state === (state ?? undefined) && live.presence?.detail === detail) return;
    live.presence = state
      ? { conversationId: live.conversationId, memberId: live.memberId, state, ...(detail ? { detail } : {}) }
      : null;
    this.broadcast({
      kind: "presence",
      conversationId: live.conversationId,
      memberId: live.memberId,
      state: state ?? "idle",
      ...(detail ? { detail } : {}),
    });
  }

  #delta(live: Live, text: string): void {
    // deltas go to the wire only
    this.broadcast({ kind: "delta", conversationId: live.conversationId, memberId: live.memberId, text });
  }

  #event(live: Live, e: CoreEvent): void {
    this.#append(live.conversationId, live.memberId, live.turnId, e);
  }

  #notice(conversationId: string, text: string): void {
    this.#append(conversationId, null, null, { type: "system.notice", display: "message", text });
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
