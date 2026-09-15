import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionInfo, SessionSettings, SourceKind } from "@roster/adapter-api";
import { attachmentsPreview, type AttachmentRef } from "./attachments.js";
import { everyLocale, stored, t } from "./i18n/index.js";
import { routeOf, type CoreEvent, type Notice } from "./log.js";

export type Attention = "none" | "waiting_input" | "waiting_permission" | "error" | "stalled";
export type Tier = "read" | "write" | "execute";
export type Mode = "human_led" | "leader" | "discussion";

export interface BotRow {
  id: string;
  name: string;
  title: string | null;
  /** a logo id; see logos.ts */
  avatar: string | null;
  system_prompt: string | null;
  /** the executor it runs on, which also settles where its models come from */
  executor_id: string;
  /** its own pick among the executor's models; null runs the executor's default */
  model: string | null;
  permission_tier: Tier;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export type BotInput = Pick<BotRow, "name" | "title" | "avatar" | "system_prompt" | "executor_id" | "model" | "permission_tier">;

export interface ExecutorRow {
  id: string;
  name: string;
  /** a harness type registered in code */
  type: string;
  /** own runs on the agent's own sign-in; endpoint on provider_id */
  source_kind: SourceKind;
  provider_id: string | null;
  /** what bots on it run when they name no model of their own */
  model: string | null;
  /** bumped whenever what it runs with changes, so members started on the old setup show as stale */
  rev: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export type ExecutorInput = Pick<ExecutorRow, "name" | "type" | "source_kind" | "provider_id" | "model">;

export interface ProviderRow {
  id: string;
  name: string;
  /** a preset id a harness knows, or "custom" */
  preset: string;
  api: string | null;
  base_url: string | null;
  /** what its API listed for a preset; what a person entered for a custom endpoint */
  models: string[];
  headers: Record<string, string>;
  /** where the key is in secrets; null when there is none or it comes from key_env */
  secret_ref: string | null;
  /** read the key from this environment variable instead of keeping it */
  key_env: string | null;
  /** bumped when where it points or what it serves changes; a new key alone does not count */
  rev: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export type ProviderInput = Pick<ProviderRow, "name" | "preset" | "api" | "base_url" | "models" | "headers" | "key_env">;

/**
 * What a member runs with, frozen when it joins: editing a bot must not change
 * a backend session that was started with the old preset. The permission tier
 * is deliberately not here -- lowering a tier has to take effect at once.
 */
export type BotSpec = Pick<BotRow, "name" | "system_prompt" | "executor_id" | "model"> & {
  executor_rev?: number;
  /** the revision of the model API the executor named, when it named one */
  source_rev?: number;
};

/** A member's picks for its session. The source is not among them: it belongs to the executor. */
export type MemberSettings = SessionSettings;

export interface ConversationRow {
  id: string;
  title: string;
  shape: "direct" | "group";
  mode: Mode;
  leader_member_id: string | null;
  repo_path: string;
  worktree_path: string;
  created_at: number;
  archived_at: number | null;
  last_seq: number;
  last_activity_at: number;
  preview: string | null;
  attention: Attention;
  run_state: "idle" | "running";
}

export interface MemberRow {
  id: string;
  conversation_id: string;
  bot_id: string;
  spec: BotSpec;
  joined_at: number;
  left_at: number | null;
  delivered_seq: number;
  resume_token: string | null;
  /** picked for this session in the composer; anything unset falls back to the spec, then the backend */
  settings: MemberSettings;
  /** the backend's last report, kept so a restart can show it before a turn runs */
  report: SessionInfo | null;
}

/** The list and header want the live identity; names and avatars follow edits. */
export interface MemberView {
  id: string;
  bot: BotRow;
  /** what its session runs on, from the snapshot rather than the bot as since edited */
  executor_id: string;
  model: string | null;
  joined_at: number;
  left_at: number | null;
  /** preset, model or executor changed since this member joined */
  stale: boolean;
}

export type ConversationView = ConversationRow & { members: MemberView[]; archived: boolean };

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  turn_id: string | null;
  author_kind: "human" | "bot" | "system";
  author_member_id: string | null;
  card_kind: "text" | "steps" | "permission" | "artifact" | "system" | "error";
  body_json: string;
  status: string | null;
  created_at: number;
  updated_at: number;
}

/** One line of the shared transcript, as a member catching up reads it. */
export interface TranscriptItem {
  seq: number;
  memberId: string | null;
  kind: "human" | "bot" | "notice";
  text: string;
  at: number;
  /** what the human attached; a line can be files alone */
  attachments?: AttachmentRef[];
}

const now = () => Date.now();

/** The list shows one line of plain text; raw Markdown there reads as noise. */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ` ${t("preview.code")} `)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[>#*\-+]+\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A default title in any language Roster writes one in, and the one it wrote before it had languages. */
export const UNTITLED = new RegExp(
  `^(${[
    ...everyLocale("conversation.directTitle", { name: "<name>" }).map((s) => escapeRegExp(s).replace("<name>", ".+")),
    ...everyLocale("conversation.newGroup").map(escapeRegExp),
    "New conversation",
  ].join("|")})$`,
);

/** A default title reads in the current language until the first message replaces it; one someone typed stays as typed. */
function shownTitle(title: string, members: readonly MemberView[]): string {
  if (everyLocale("conversation.newGroup").includes(title)) return t("conversation.newGroup");
  const named = members.find((m) => everyLocale("conversation.directTitle", { name: m.bot.name }).includes(title));
  return named ? t("conversation.directTitle", { name: named.bot.name }) : title;
}

/** A notice written as a key reads in the current language; one from before keys, as it was written. */
const noticeText = (text: string, notice: Notice | undefined): string =>
  (notice && stored(notice.key, notice.params)) ?? text;

function localized(row: MessageRow): MessageRow {
  if (row.card_kind !== "system") return row;
  const body = JSON.parse(row.body_json) as { text: string; notice?: Notice };
  return body.notice ? { ...row, body_json: JSON.stringify({ ...body, text: noticeText(body.text, body.notice) }) } : row;
}

/**
 * Derived from the first message rather than generated by a model: a title is
 * worth zero API calls, and the first line of what you asked is almost always
 * what the conversation is about.
 */
export function titleFrom(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[\s>#*\-`]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) return "";
  // cut at the first sentence end when one arrives early enough to still be a title
  const stop = line.search(/[。！？.!?]/);
  const head = stop > 0 && stop <= 28 ? line.slice(0, stop) : line;
  return head.length > 28 ? `${head.slice(0, 28)}…` : head;
}

const specOf = (bot: BotRow, executorRev: number, sourceRev: number): BotSpec => ({
  name: bot.name,
  system_prompt: bot.system_prompt,
  executor_id: bot.executor_id,
  executor_rev: executorRev,
  source_rev: sourceRev,
  model: bot.model,
});

const sameSpec = (a: BotSpec, b: BotSpec) =>
  (a.system_prompt ?? "") === (b.system_prompt ?? "") &&
  a.executor_id === b.executor_id &&
  // snapshots from before executors had revisions were taken at the first one
  (a.executor_rev ?? 1) === (b.executor_rev ?? 1) &&
  (a.source_rev ?? 1) === (b.source_rev ?? 1) &&
  (a.model ?? "") === (b.model ?? "");

const json = <T,>(text: string): T => JSON.parse(text) as T;

type RawExecutor = ExecutorRow & { config_json: string; provider_ids_json: string };
type RawProvider = Omit<ProviderRow, "models" | "headers"> & { models_json: string; headers_json: string };
type RawBot = BotRow & { model_source?: string | null; tools_json?: string };

const executorOf = ({ config_json: _program, provider_ids_json: _legacy, ...rest }: RawExecutor): ExecutorRow => rest;

// the legacy columns only the migrations read stay out of everything else
const botOf = ({ model_source: _source, tools_json: _tools, ...rest }: RawBot): BotRow => rest;

const providerOf = ({ models_json, headers_json, ...rest }: RawProvider): ProviderRow => ({
  ...rest,
  models: json(models_json),
  headers: json(headers_json),
});

interface RawMember {
  id: string;
  conversation_id: string;
  bot_id: string;
  spec_json: string;
  joined_at: number;
  left_at: number | null;
  delivered_seq: number;
  resume_token: string | null;
  settings_json: string;
  session_json: string | null;
}

export class Store {
  constructor(private db: DatabaseSync) {}

  // ---- preferences ----

  preference(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM preferences WHERE key = ?`).get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  setPreference(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  }

  // ---- executors ----

  listExecutors(): ExecutorRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM executors WHERE archived_at IS NULL ORDER BY created_at, id`)
      .all() as unknown as RawExecutor[];
    return rows.map(executorOf);
  }

  getExecutor(id: string): ExecutorRow | undefined {
    const row = this.db.prepare(`SELECT * FROM executors WHERE id = ?`).get(id) as unknown as RawExecutor | undefined;
    return row && executorOf(row);
  }

  createExecutor(input: ExecutorInput & { id?: string }): ExecutorRow {
    const id = input.id ?? randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO executors (id, name, type, source_kind, provider_id, model, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, input.name, input.type, input.source_kind, input.provider_id, input.model, t, t);
    return this.getExecutor(id)!;
  }

  /** A new name alone is not a new setup; anything it runs with is, and bumps the revision. */
  updateExecutor(id: string, patch: Partial<Omit<ExecutorInput, "type">>): ExecutorRow {
    const current = this.getExecutor(id);
    if (!current) throw new Error(`unknown executor ${id}`);
    const next = { ...current, ...patch };
    const changed =
      next.source_kind !== current.source_kind || next.provider_id !== current.provider_id || next.model !== current.model;
    this.db
      .prepare(
        `UPDATE executors SET name = ?, source_kind = ?, provider_id = ?, model = ?, rev = rev + ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.name, next.source_kind, next.provider_id, next.model, changed ? 1 : 0, now(), id);
    return this.getExecutor(id)!;
  }

  archiveExecutor(id: string): boolean {
    const r = this.db.prepare(`UPDATE executors SET archived_at = ? WHERE id = ? AND archived_at IS NULL`).run(now(), id);
    return Number(r.changes) > 0;
  }

  /**
   * Moves what runs on one executor onto another and archives it. Members still
   * in a conversation start a fresh backend session there, owed the backlog, as
   * a sync would; members that left keep pointing at it, so history still says
   * who spoke.
   */
  mergeExecutor(fromId: string, intoId: string): void {
    const into = this.getExecutor(intoId);
    if (!into) throw new Error(`unknown executor ${intoId}`);
    const t = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE bots SET executor_id = ?, updated_at = ? WHERE executor_id = ? AND archived_at IS NULL`).run(intoId, t, fromId);
      this.db
        .prepare(
          `UPDATE members SET spec_json = json_set(spec_json, '$.executor_id', ?, '$.executor_rev', ?, '$.source_rev', ?),
                              resume_token = NULL, delivered_seq = 0, settings_json = '{}', session_json = NULL
            WHERE left_at IS NULL AND json_extract(spec_json, '$.executor_id') = ?`,
        )
        .run(intoId, into.rev, this.#sourceRevOf(into.provider_id), fromId);
      this.archiveExecutor(fromId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  executorNameTaken(name: string, exceptId?: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM executors WHERE archived_at IS NULL AND lower(name) = lower(?) AND id IS NOT ? LIMIT 1`)
        .get(name, exceptId ?? null) !== undefined
    );
  }

  liveBotsOn(executorId: string): BotRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM bots WHERE archived_at IS NULL AND executor_id = ? ORDER BY created_at`)
        .all(executorId) as unknown as RawBot[]
    ).map(botOf);
  }

  /** Members still in a conversation someone can open whose session was started on this executor. */
  membersOn(executorId: string): Array<{ id: string; conversation_id: string }> {
    return this.db
      .prepare(
        `SELECT m.id, m.conversation_id FROM members m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.left_at IS NULL AND c.archived_at IS NULL AND json_extract(m.spec_json, '$.executor_id') = ?`,
      )
      .all(executorId) as unknown as Array<{ id: string; conversation_id: string }>;
  }

  /** Live executors that run on this model API. */
  executorsOnProvider(providerId: string): ExecutorRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM executors WHERE archived_at IS NULL AND provider_id = ? ORDER BY created_at, id`)
        .all(providerId) as unknown as RawExecutor[]
    ).map(executorOf);
  }

  #sourceRevOf(providerId: string | null): number {
    if (!providerId) return 1;
    const row = this.db.prepare(`SELECT rev FROM providers WHERE id = ?`).get(providerId) as unknown as
      | { rev: number }
      | undefined;
    return row?.rev ?? 1;
  }

  #specOf(bot: BotRow): BotSpec {
    const executor = this.getExecutor(bot.executor_id);
    return specOf(bot, executor?.rev ?? 1, this.#sourceRevOf(executor?.provider_id ?? null));
  }

  // ---- harness types ----

  /** The program a person picked for a type, if they picked one. */
  harnessProgram(type: string): string | null {
    const row = this.db.prepare(`SELECT program FROM harness_settings WHERE type = ?`).get(type) as unknown as
      | { program: string | null }
      | undefined;
    return row?.program ?? null;
  }

  harnessPrograms(): Record<string, string> {
    const rows = this.db
      .prepare(`SELECT type, program FROM harness_settings WHERE program IS NOT NULL`)
      .all() as unknown as Array<{ type: string; program: string }>;
    return Object.fromEntries(rows.map((r) => [r.type, r.program]));
  }

  setHarnessProgram(type: string, program: string | null): void {
    this.db
      .prepare(
        `INSERT INTO harness_settings (type, program, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(type) DO UPDATE SET program = excluded.program, updated_at = excluded.updated_at`,
      )
      .run(type, program, now());
  }

  // ---- providers ----

  listProviders(): ProviderRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM providers WHERE archived_at IS NULL ORDER BY created_at, id`)
      .all() as unknown as RawProvider[];
    return rows.map(providerOf);
  }

  getProvider(id: string): ProviderRow | undefined {
    const row = this.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as unknown as RawProvider | undefined;
    return row && providerOf(row);
  }

  createProvider(input: ProviderInput & { secret_ref: string | null }): ProviderRow {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO providers (id, name, preset, api, base_url, models_json, headers_json, secret_ref, key_env, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.preset,
        input.api,
        input.base_url,
        JSON.stringify(input.models),
        JSON.stringify(input.headers),
        input.secret_ref,
        input.key_env,
        t,
        t,
      );
    return this.getProvider(id)!;
  }

  /**
   * Where it points and what it serves are part of every session on it, so
   * those bump its revision and the members on it show as stale. A new key is
   * not: sessions pick it up when they next start, with nothing to re-sync.
   */
  updateProvider(id: string, patch: Partial<ProviderInput> & { secret_ref?: string | null }): ProviderRow {
    const current = this.getProvider(id);
    if (!current) throw new Error(`unknown provider ${id}`);
    const next = { ...current, ...patch };
    const moved =
      next.preset !== current.preset ||
      next.api !== current.api ||
      next.base_url !== current.base_url ||
      JSON.stringify(next.models) !== JSON.stringify(current.models) ||
      JSON.stringify(next.headers) !== JSON.stringify(current.headers);
    this.db
      .prepare(
        `UPDATE providers SET name = ?, preset = ?, api = ?, base_url = ?, models_json = ?, headers_json = ?,
                              secret_ref = ?, key_env = ?, rev = rev + ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.preset,
        next.api,
        next.base_url,
        JSON.stringify(next.models),
        JSON.stringify(next.headers),
        next.secret_ref,
        next.key_env,
        moved ? 1 : 0,
        now(),
        id,
      );
    return this.getProvider(id)!;
  }

  /**
   * What a preset endpoint's API listed. A fresh list is not a new setup, so
   * the revision stays: a running session keeps its model, and the next one
   * picks the list up.
   */
  setListedModels(id: string, models: readonly string[]): void {
    this.db.prepare(`UPDATE providers SET models_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(models), now(), id);
  }

  archiveProvider(id: string): boolean {
    const r = this.db.prepare(`UPDATE providers SET archived_at = ? WHERE id = ? AND archived_at IS NULL`).run(now(), id);
    return Number(r.changes) > 0;
  }

  providerNameTaken(name: string, exceptId?: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM providers WHERE archived_at IS NULL AND lower(name) = lower(?) AND id IS NOT ? LIMIT 1`)
        .get(name, exceptId ?? null) !== undefined
    );
  }

  // ---- bots ----

  createBot(b: BotInput & { id?: string }): BotRow {
    const id = b.id ?? randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO bots (id, name, title, avatar, system_prompt, executor_id, model,
                           permission_tier, tools_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(id, b.name, b.title, b.avatar, b.system_prompt, b.executor_id, b.model, b.permission_tier, t, t);
    return this.getBot(id)!;
  }

  updateBot(id: string, patch: Partial<BotInput>): BotRow {
    const current = this.getBot(id);
    if (!current) throw new Error(`unknown bot ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE bots SET name = ?, title = ?, avatar = ?, system_prompt = ?, executor_id = ?,
                         model = ?, permission_tier = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.name, next.title, next.avatar, next.system_prompt, next.executor_id, next.model, next.permission_tier, now(), id);
    return this.getBot(id)!;
  }

  /**
   * A soft delete. Members snapshot the bot, and history still has to say who
   * spoke, so the row stays; it only leaves the contact list.
   */
  archiveBot(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE bots SET archived_at = ? WHERE id = ? AND archived_at IS NULL`)
      .run(now(), id);
    return Number(r.changes) > 0;
  }

  /**
   * The logo worn by the fewest live bots, earliest in the catalog on a tie, so
   * a roster stays tellable apart until the set runs out.
   */
  leastUsedLogo(ids: readonly string[], exceptBotId?: string): string {
    const counts = new Map(ids.map((id) => [id, 0]));
    const worn = this.db
      .prepare(`SELECT avatar FROM bots WHERE archived_at IS NULL AND id IS NOT ?`)
      .all(exceptBotId ?? null) as unknown as Array<{ avatar: string | null }>;
    for (const { avatar } of worn) {
      if (avatar && counts.has(avatar)) counts.set(avatar, counts.get(avatar)! + 1);
    }
    return ids.reduce((best, id) => (counts.get(id)! < counts.get(best)! ? id : best), ids[0]!);
  }

  /** Bots from before logos, or wearing one no longer shipped, get the least used one. */
  assignLogos(ids: readonly string[]): number {
    const rows = this.db
      .prepare(`SELECT id, avatar FROM bots ORDER BY created_at, rowid`)
      .all() as unknown as Array<{ id: string; avatar: string | null }>;
    let n = 0;
    for (const r of rows) {
      if (r.avatar && ids.includes(r.avatar)) continue;
      this.db.prepare(`UPDATE bots SET avatar = ? WHERE id = ?`).run(this.leastUsedLogo(ids), r.id);
      n += 1;
    }
    return n;
  }

  /** Archived rows count: a bot the user deleted must not be re-seeded. */
  hasAnyBot(): boolean {
    return this.db.prepare(`SELECT 1 FROM bots LIMIT 1`).get() !== undefined;
  }

  /** No turn survives a restart: nothing is running, and no permission prompt can still be answered. */
  recoverAfterRestart(): void {
    this.db.exec(`
      UPDATE messages SET status = 'expired' WHERE card_kind = 'permission' AND status = 'pending';
      UPDATE conversations SET run_state = 'idle' WHERE run_state = 'running';
      UPDATE conversations SET attention = 'waiting_input' WHERE attention = 'waiting_permission';
    `);
  }

  listBots(): BotRow[] {
    return (
      this.db.prepare(`SELECT * FROM bots WHERE archived_at IS NULL ORDER BY created_at`).all() as unknown as RawBot[]
    ).map(botOf);
  }

  getBot(id: string): BotRow | undefined {
    const row = this.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(id) as unknown as RawBot | undefined;
    return row && botOf(row);
  }

  nameTaken(name: string, exceptId?: string): boolean {
    const r = this.db
      .prepare(
        `SELECT 1 FROM bots WHERE archived_at IS NULL AND lower(name) = lower(?) AND id IS NOT ? LIMIT 1`,
      )
      .get(name, exceptId ?? null);
    return r !== undefined;
  }

  // ---- conversations ----

  createConversation(input: {
    title: string;
    repoPath: string;
    worktreePath: string;
    botIds: string[];
    mode?: Mode;
    leaderBotId?: string;
  }): ConversationRow {
    const id = randomUUID();
    const t = now();
    // shape is a presentation hint; a 1:1 is a one-member group and takes the
    // same code path everywhere below
    const shape = input.botIds.length > 1 ? "group" : "direct";
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, shape, mode, repo_path, worktree_path,
                                    created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title, shape, input.mode ?? "human_led", input.repoPath, input.worktreePath, t, t);

    for (const botId of new Set(input.botIds)) {
      const member = this.#insertMember(id, botId, t);
      if (botId === input.leaderBotId) {
        this.db.prepare(`UPDATE conversations SET leader_member_id = ? WHERE id = ?`).run(member.id, id);
      }
    }
    return this.getConversation(id)!;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as unknown as
      | ConversationRow
      | undefined;
  }

  setMode(id: string, mode: Mode, leaderMemberId?: string | null): void {
    this.db
      .prepare(
        `UPDATE conversations SET mode = ?, leader_member_id = COALESCE(?, leader_member_id) WHERE id = ?`,
      )
      .run(mode, leaderMemberId ?? null, id);
  }

  setArchived(id: string, archived: boolean): void {
    this.db
      .prepare(`UPDATE conversations SET archived_at = ? WHERE id = ?`)
      .run(archived ? now() : null, id);
  }

  /** Cascades to members, events and messages via the schema's foreign keys. */
  delete(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    return Number(r.changes) > 0;
  }

  /** Whether a sent message carries this attachment; one still in the composer can be thrown away. */
  isAttachmentSent(conversationId: string, attachmentId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND author_kind = 'human' AND body_json LIKE ? LIMIT 1`)
      .get(conversationId, `%"id":"${attachmentId}"%`);
    return row !== undefined;
  }

  /** Sort order is the product rule: needs-a-human first, longest-waiting first, then recency. */
  listConversations(includeArchived = false): ConversationView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversations ${includeArchived ? "" : "WHERE archived_at IS NULL"}
         ORDER BY (archived_at IS NOT NULL),
                  CASE attention
                    WHEN 'waiting_permission' THEN 0 WHEN 'error' THEN 1
                    WHEN 'stalled' THEN 2 WHEN 'waiting_input' THEN 3 ELSE 4 END,
                  attention_since ASC,
                  last_activity_at DESC`,
      )
      .all() as unknown as ConversationRow[];

    // two queries for the whole list rather than two per conversation
    const bots = new Map((this.db.prepare(`SELECT * FROM bots`).all() as unknown as RawBot[]).map((b) => [b.id, botOf(b)]));
    const byConv = new Map<string, MemberView[]>();
    for (const m of this.db
      .prepare(`SELECT * FROM members ORDER BY joined_at, rowid`)
      .all() as unknown as RawMember[]) {
      const bot = bots.get(m.bot_id);
      if (!bot) continue;
      const list = byConv.get(m.conversation_id) ?? [];
      list.push(this.#view(m, bot));
      byConv.set(m.conversation_id, list);
    }
    return rows.map((c) => {
      const members = byConv.get(c.id) ?? [];
      return { ...c, title: shownTitle(c.title, members), members, archived: c.archived_at !== null };
    });
  }

  /** Current and former members; history needs the names of those who left. */
  members(conversationId: string): MemberView[] {
    const rows = this.db
      .prepare(`SELECT * FROM members WHERE conversation_id = ? ORDER BY joined_at, rowid`)
      .all(conversationId) as unknown as RawMember[];
    return rows.flatMap((m) => {
      const bot = this.getBot(m.bot_id);
      return bot ? [this.#view(m, bot)] : [];
    });
  }

  activeMembers(conversationId: string): MemberRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM members WHERE conversation_id = ? AND left_at IS NULL ORDER BY joined_at, rowid`,
      )
      .all(conversationId) as unknown as RawMember[];
    return rows.map((m) => this.#member(m));
  }

  getMember(id: string): MemberRow | undefined {
    const m = this.db.prepare(`SELECT * FROM members WHERE id = ?`).get(id) as unknown as
      | RawMember
      | undefined;
    return m ? this.#member(m) : undefined;
  }

  /** Joining turns a 1:1 into a group for good; history now has more than one voice. */
  addMember(conversationId: string, botId: string): MemberRow {
    const member = this.#insertMember(conversationId, botId, now());
    if (this.activeMembers(conversationId).length > 1) {
      this.db.prepare(`UPDATE conversations SET shape = 'group' WHERE id = ?`).run(conversationId);
    }
    return member;
  }

  leaveMember(memberId: string): void {
    this.db.prepare(`UPDATE members SET left_at = ? WHERE id = ?`).run(now(), memberId);
  }

  /**
   * Adopts the bot's current preset. The old backend session was primed with
   * the old one, so the member starts a fresh session and is owed the backlog.
   */
  refreshSpec(memberId: string): void {
    const m = this.getMember(memberId);
    const bot = m && this.getBot(m.bot_id);
    if (!m || !bot) return;
    // what was picked for the old session goes with it
    this.db
      .prepare(
        `UPDATE members SET spec_json = ?, resume_token = NULL, delivered_seq = 0,
                            settings_json = '{}', session_json = NULL WHERE id = ?`,
      )
      .run(JSON.stringify(this.#specOf(bot)), memberId);
  }

  setSettings(memberId: string, settings: MemberSettings): void {
    this.db.prepare(`UPDATE members SET settings_json = ? WHERE id = ?`).run(JSON.stringify(settings), memberId);
  }

  setReport(memberId: string, info: SessionInfo): void {
    this.db.prepare(`UPDATE members SET session_json = ? WHERE id = ?`).run(JSON.stringify(info), memberId);
  }

  setDelivered(memberId: string, seq: number): void {
    this.db.prepare(`UPDATE members SET delivered_seq = ? WHERE id = ?`).run(seq, memberId);
  }

  /** The member whose text most recently landed, among those still present. */
  lastSpeaker(conversationId: string): string | null {
    const r = this.db
      .prepare(
        `SELECT e.member_id FROM events e JOIN members m ON m.id = e.member_id
          WHERE e.conversation_id = ? AND e.type = 'assistant.text' AND m.left_at IS NULL
          ORDER BY e.seq DESC LIMIT 1`,
      )
      .get(conversationId) as unknown as { member_id: string } | undefined;
    return r?.member_id ?? null;
  }

  #insertMember(conversationId: string, botId: string, t: number): MemberRow {
    const bot = this.getBot(botId);
    if (!bot) throw new Error(`unknown bot ${botId}`);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO members (id, conversation_id, bot_id, spec_json, capabilities_json, joined_at)
         VALUES (?, ?, ?, ?, '{}', ?)`,
      )
      .run(id, conversationId, botId, JSON.stringify(this.#specOf(bot)), t);
    return this.getMember(id)!;
  }

  #member(m: RawMember): MemberRow {
    const { spec_json, settings_json, session_json, ...rest } = m;
    return {
      ...rest,
      spec: JSON.parse(spec_json) as BotSpec,
      settings: JSON.parse(settings_json || "{}") as MemberSettings,
      report: session_json ? (JSON.parse(session_json) as SessionInfo) : null,
    };
  }

  #view(m: RawMember, bot: BotRow): MemberView {
    const spec = JSON.parse(m.spec_json) as BotSpec;
    return {
      id: m.id,
      bot,
      executor_id: spec.executor_id,
      model: spec.model ?? null,
      joined_at: m.joined_at,
      left_at: m.left_at,
      stale: !sameSpec(spec, this.#specOf(bot)),
    };
  }

  /** The backend's own handle on this bot's context, so a restart can pick it up. */
  getResumeToken(memberId: string): string | undefined {
    const r = this.db
      .prepare(`SELECT resume_token FROM members WHERE id = ?`)
      .get(memberId) as unknown as { resume_token: string | null } | undefined;
    return r?.resume_token ?? undefined;
  }

  setResumeToken(memberId: string, token: string): void {
    this.db.prepare(`UPDATE members SET resume_token = ? WHERE id = ?`).run(token, memberId);
  }

  /** Conversations that predate title derivation still carry the useless default. */
  backfillTitles(): number {
    const rows = this.db
      .prepare(`SELECT id, title FROM conversations WHERE archived_at IS NULL`)
      .all() as unknown as Array<{ id: string; title: string }>;
    let n = 0;
    for (const r of rows) {
      if (!UNTITLED.test(r.title)) continue;
      const first = this.db
        .prepare(
          `SELECT body_json FROM messages WHERE conversation_id = ? AND author_kind = 'human'
           ORDER BY seq LIMIT 1`,
        )
        .get(r.id) as unknown as { body_json: string } | undefined;
      if (!first) continue;
      const text = String((JSON.parse(first.body_json) as { text?: string }).text ?? "");
      const title = titleFrom(text);
      if (!title) continue;
      this.rename(r.id, title);
      n += 1;
    }
    return n;
  }

  rename(id: string, title: string): void {
    this.db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id);
  }

  /**
   * Opening a conversation clears the notification kinds of attention but not
   * the live ones: reading about a pending permission does not decide it, and a
   * stalled run is still stalled after you have looked at it.
   */
  markRead(id: string): boolean {
    const c = this.getConversation(id);
    if (!c || (c.attention !== "waiting_input" && c.attention !== "error")) return false;
    this.setAttention(id, "none");
    return true;
  }

  setRunState(id: string, state: "idle" | "running"): void {
    this.db.prepare(`UPDATE conversations SET run_state = ? WHERE id = ?`).run(state, id);
  }

  setAttention(id: string, attention: Attention): void {
    const current = this.getConversation(id);
    if (current?.attention === attention) return;
    this.db
      .prepare(`UPDATE conversations SET attention = ?, attention_since = ? WHERE id = ?`)
      .run(attention, attention === "none" ? null : now(), id);
  }

  // ---- events ----

  /**
   * The single write path. Appends to the log when the routing table says to
   * persist, then folds the event into the message projection.
   */
  append(
    conversationId: string,
    memberId: string | null,
    turnId: string | null,
    event: CoreEvent,
  ): { seq: number | null; touched: MessageRow[] } {
    const route = routeOf(event);
    let seq: number | null = null;
    if (route.persist) {
      const r = this.db
        .prepare(
          `INSERT INTO events (conversation_id, member_id, turn_id, type, payload_json,
                               surface, broadcast, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conversationId,
          memberId,
          turnId,
          event.type,
          JSON.stringify(event),
          route.surface ? 1 : 0,
          route.broadcast ? 1 : 0,
          now(),
        );
      seq = Number(r.lastInsertRowid);
      this.db
        .prepare(`UPDATE conversations SET last_seq = ?, last_activity_at = ? WHERE id = ?`)
        .run(seq, now(), conversationId);
    }
    const touched = this.project(conversationId, memberId, turnId, event, seq);
    return { seq, touched };
  }

  /**
   * Broadcast events a member has not consumed yet. A member with prior
   * context never reads its own lines back; a fresh one (delivered_seq 0)
   * needs them to know what it already said.
   */
  backlog(member: MemberRow): { items: TranscriptItem[]; upTo: number } {
    const rows = this.db
      .prepare(
        `SELECT seq, member_id, type, payload_json, created_at FROM events
          WHERE conversation_id = ? AND broadcast = 1 AND seq > ?
          ORDER BY seq`,
      )
      .all(member.conversation_id, member.delivered_seq) as unknown as Array<{
      seq: number;
      member_id: string | null;
      type: string;
      payload_json: string;
      created_at: number;
    }>;
    const fresh = member.delivered_seq === 0;
    const items: TranscriptItem[] = [];
    let upTo = member.delivered_seq;
    for (const r of rows) {
      upTo = Math.max(upTo, r.seq);
      if (!fresh && r.member_id === member.id) continue;
      const e = JSON.parse(r.payload_json) as CoreEvent;
      const text =
        e.type === "assistant.text"
          ? e.delta
          : e.type === "human.text"
            ? e.text
            : e.type === "system.notice"
              ? noticeText(e.text, e.notice)
              : "";
      const attachments = e.type === "human.text" ? e.attachments : undefined;
      if (!text.trim() && !attachments?.length) continue;
      items.push({
        seq: r.seq,
        memberId: r.member_id,
        kind: e.type === "human.text" ? "human" : e.type === "system.notice" ? "notice" : "bot",
        text,
        at: r.created_at,
        ...(attachments?.length ? { attachments } : {}),
      });
    }
    return { items, upTo };
  }

  private nextLocalSeq(conversationId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?`)
      .get(conversationId) as unknown as { n: number };
    return r.n;
  }

  #insertMessage(row: {
    conversationId: string;
    seq: number | null;
    turnId: string | null;
    authorKind: MessageRow["author_kind"];
    memberId: string | null;
    cardKind: MessageRow["card_kind"];
    body: unknown;
    status?: string;
  }): MessageRow {
    const id = randomUUID();
    const t = now();
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, seq, turn_id, author_kind, author_member_id,
                               card_kind, body_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.conversationId,
        row.seq ?? this.nextLocalSeq(row.conversationId),
        row.turnId,
        row.authorKind,
        row.memberId,
        row.cardKind,
        JSON.stringify(row.body),
        row.status ?? null,
        t,
        t,
      );
    return this.getMessage(id)!;
  }

  private project(
    conversationId: string,
    memberId: string | null,
    turnId: string | null,
    event: CoreEvent,
    seq: number | null,
  ): MessageRow[] {
    const at = now();
    switch (event.type) {
      case "human.text": {
        const msg = this.#insertMessage({
          conversationId,
          seq,
          turnId: null,
          authorKind: "human",
          memberId: null,
          cardKind: "text",
          body: {
            text: event.text,
            mentions: event.mentions,
            ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          },
        });
        this.#setPreview(conversationId, plainPreview(event.text) || attachmentsPreview(event.attachments ?? []));
        return [msg];
      }
      case "system.notice":
        return [
          this.#insertMessage({
            conversationId,
            seq,
            turnId: null,
            authorKind: "system",
            memberId: null,
            cardKind: "system",
            body: { text: event.text, ...(event.notice ? { notice: event.notice } : {}) },
          }),
        ];
      case "assistant.text": {
        if (!event.final) return [];
        const msg = this.#insertMessage({
          conversationId,
          seq,
          turnId,
          authorKind: "bot",
          memberId,
          cardKind: "text",
          body: { text: event.delta },
        });
        // in a group the list line has to say who said it
        const conv = this.getConversation(conversationId);
        const speaker = conv?.shape === "group" && memberId ? this.getMember(memberId)?.bot_id : undefined;
        const name = speaker ? this.getBot(speaker)?.name : undefined;
        const preview = plainPreview(event.delta);
        this.#setPreview(conversationId, name ? t("preview.speaker", { name, text: preview }) : preview);
        return [msg];
      }
      case "tool.start":
      case "tool.end": {
        // one steps card per turn per member, updated in place
        const card = this.stepsCard(conversationId, memberId, turnId, seq);
        const body = JSON.parse(card.body_json) as {
          steps: Array<{ id: string; name: string; effect: string; ok?: boolean }>;
        };
        if (event.type === "tool.start") {
          if (body.steps.some((s) => s.id === event.call.id)) return [];
          body.steps.push({ id: event.call.id, name: event.call.name, effect: event.call.effect });
        } else {
          const step = body.steps.find((s) => s.id === event.id);
          if (step) step.ok = !event.isError;
        }
        this.db
          .prepare(`UPDATE messages SET body_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(body), at, card.id);
        return [this.getMessage(card.id)!];
      }
      case "permission.request":
        return [
          this.#insertMessage({
            conversationId,
            seq,
            turnId,
            authorKind: "bot",
            memberId,
            cardKind: "permission",
            body: { call: event.call, requestId: event.call.id },
            status: "pending",
          }),
        ];
      case "permission.decision": {
        // mutate the same card rather than adding a second one
        const row = this.db
          .prepare(
            `SELECT * FROM messages WHERE conversation_id = ? AND card_kind = 'permission'
               AND json_extract(body_json, '$.requestId') = ? LIMIT 1`,
          )
          .get(conversationId, event.id) as unknown as MessageRow | undefined;
        if (!row) return [];
        this.db
          .prepare(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ?`)
          .run(event.decision.action === "allow" ? "allowed" : "denied", at, row.id);
        return [this.getMessage(row.id)!];
      }
      case "error":
        return [
          this.#insertMessage({
            conversationId,
            seq,
            turnId,
            authorKind: "system",
            memberId,
            cardKind: "error",
            body: { text: event.message },
          }),
        ];
      default:
        return [];
    }
  }

  #setPreview(conversationId: string, preview: string): void {
    this.db.prepare(`UPDATE conversations SET preview = ? WHERE id = ?`).run(preview, conversationId);
  }

  private stepsCard(
    conversationId: string,
    memberId: string | null,
    turnId: string | null,
    seq: number | null,
  ): MessageRow {
    const existing = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND card_kind = 'steps'
           AND turn_id IS ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(conversationId, turnId) as unknown as MessageRow | undefined;
    if (existing) return existing;
    return this.#insertMessage({
      conversationId,
      seq,
      turnId,
      authorKind: "bot",
      memberId,
      cardKind: "steps",
      body: { steps: [] },
    });
  }

  getMessage(id: string): MessageRow | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as unknown as MessageRow | undefined;
    return row && localized(row);
  }

  listMessages(conversationId: string): MessageRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq, created_at`)
        .all(conversationId) as unknown as MessageRow[]
    ).map(localized);
  }
}
