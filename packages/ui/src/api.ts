import { translate, type LocalePreference, type LocaleState } from "./i18n";

export type Tier = "read" | "write" | "execute";
export type Mode = "human_led" | "leader" | "discussion";

export interface Bot {
  id: string;
  name: string;
  title: string | null;
  /** a logo id from the bundled set */
  avatar: string | null;
  system_prompt: string | null;
  /** the agent it runs on, which also settles where its models come from */
  executor_id: string;
  /** its own pick among the agent's models; null runs the agent's default */
  model: string | null;
  permission_tier: Tier;
  created_at: number;
  archived_at: number | null;
}

export type BotInput = Pick<Bot, "name" | "title" | "avatar" | "system_prompt" | "executor_id" | "model" | "permission_tier">;

export interface Logo {
  id: string;
  name: string;
  background: string;
}

/** Which build is running, on what, and where its data lives. */
export interface About {
  version: string;
  /** run from a checkout rather than a packaged app */
  fromSource: boolean;
  startedAt: number;
  /** core's code on disk changed after it started, so the running core is older than the build */
  stale: boolean;
  runtime: { node: string; electron?: string; chrome?: string; platform: string; release: string; arch: string };
  paths: { data: string; agents: string; attachments: string; chats: string; extensions: string };
  home: string;
}

export interface Capabilities {
  interceptToolCall: boolean;
  mutateToolInput: boolean;
  midRunInject: string[];
  costLimit: boolean;
  mcp: boolean;
  branch: boolean;
  /** the backend's own permission modes decide tool calls, not the bot's tier */
  permissionModes: boolean;
}

/** own is the harness's own sign-in (a subscription); endpoint is a model API. */
export type SourceKind = "own" | "endpoint";

/** What a harness can do on each kind of source: the channels differ. */
export type CapabilitySet = Partial<Record<SourceKind, Capabilities>>;

/** Which model sources a harness offers. */
export interface Sources {
  /** the agent signs in on its own and brings its own catalog */
  own: boolean;
  /** wire protocols it can speak to an endpoint */
  apis: string[];
}

export interface ModelOption {
  id: string;
  label?: string;
  available: boolean;
}

/** An agent: one harness bound to one model source. Bots run on one. */
export interface Executor {
  id: string;
  /** the harness, e.g. claude-code */
  type: string;
  label: string;
  source_kind: SourceKind;
  provider_id: string | null;
  /** what bots on it run when they name no model of their own */
  model: string | null;
  /** why it cannot run right now, when it cannot */
  problem: string | null;
}

/** An endpoint as the rest of the app sees it: a name to label sources with, never a key. */
export interface SourceRef {
  id: string;
  name: string;
  preset: string;
  api: string | null;
}

/** A harness as settings sees it: what sources it takes and what it can do on each. */
export interface HarnessTypeInfo {
  type: string;
  label: string;
  sources: Sources;
  capabilities: CapabilitySet;
}

/** An endpoint a harness knows by id, so only a key is needed. Its models are whatever its API lists. */
export interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  baseUrl?: string;
  keyLabel?: string;
}

export const CUSTOM_PRESET = "custom";

export interface ExecutorRecord {
  id: string;
  name: string;
  type: string;
  source_kind: SourceKind;
  provider_id: string | null;
  model: string | null;
  rev: number;
  /** 1 keeps each session's prompt cache for an hour instead of minutes */
  long_cache: number;
  /** why it cannot run right now: its harness is not installed, its model API is gone */
  problem: string | null;
}

/** A pairing of harness and source nobody has made an agent of yet. */
export interface Candidate {
  type: string;
  source_kind: SourceKind;
  provider_id: string | null;
  name: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  preset: string;
  api: string | null;
  base_url: string | null;
  /** what its API listed at the last test that got a list; for a custom one, what a person entered */
  models: string[];
  headers: Record<string, string>;
  key_env: string | null;
  rev: number;
  /** never the key itself: where it comes from, whether it is there, and how it ends */
  key: { source: "env" | "stored"; set: boolean; hint: string | null };
}

export interface ExecutorSettings {
  types: HarnessTypeInfo[];
  /** by harness type */
  presets: Record<string, ProviderPreset[]>;
  executors: ExecutorRecord[];
  providers: ProviderRecord[];
  /** program paths a person picked, by harness */
  programs: Record<string, string>;
  vault: { encrypted: boolean; keystore: string };
}

export interface CheckItem {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ModelProbe {
  ok: boolean;
  models?: string[];
  detail: string;
}

/** How a person signs an agent in. */
export interface LoginMethod {
  id: string;
  label: string;
  description?: string;
  /** a command the person runs in their own terminal */
  terminal?: { command: string; args: string[] };
}

export interface LoginState {
  state: "ok" | "none" | "unknown";
  account?: string;
  detail?: string;
  methods: LoginMethod[];
}

export interface DetectedProgram {
  id: string;
  path: string;
  version: string | null;
  found: "path" | "npm-global" | "known-path";
}

/** Where a harness's program is, if anywhere: on the machine already, or fetched by Roster. */
export interface ProgramState {
  /** the adapter drives a separate program; false for a library adapter such as pi */
  needed: boolean;
  detected?: DetectedProgram;
  installed?: { path: string; version: string | null };
  /** what runs when nobody picked a program: the one found, else Roster's own */
  path?: string;
  /** of that program, or of the library a program-less harness carries */
  version?: string;
  /** an agent on this harness can start */
  usable: boolean;
}

/** One harness as the settings page shows it: its adapter ships with Roster or not, its program is found or not. */
export interface HarnessView {
  id: string;
  label: string;
  description: string;
  brand?: string;
  program?: { npm: string; bin: string; version?: string };
  extension?: { npm: string };
  adapter: "bundled" | "installed" | "linked" | "missing" | "error";
  adapterError?: string;
  state: ProgramState;
}

export interface Extension {
  type: string;
  label: string;
  name: string;
  version: string;
  dir: string;
  origin: "bundled" | "installed" | "linked";
  kind: "harness" | "acp" | "both";
  error?: string;
}

export interface InstallJob {
  id: string;
  state: "running" | "done" | "failed";
  log: string[];
  startedAt: number;
  endedAt?: number;
}

export interface CredentialHint {
  kind: "env" | "pi-auth";
  name: string;
  preset: string;
}

export interface Environment {
  at: number;
  programs: DetectedProgram[];
  hints: CredentialHint[];
  shell: { name: string; ok: boolean };
}

export interface ExtensionsView {
  harnesses: HarnessView[];
  installed: Extension[];
  jobs: InstallJob[];
  root: string;
  programsRoot: string;
  environment: Environment | null;
}

export type ExecutorBody = {
  name?: string | null;
  type?: string;
  source_kind?: SourceKind;
  provider_id?: string | null;
  model?: string | null;
};
export type ProviderBody = {
  name?: string;
  preset?: string;
  api?: string | null;
  base_url?: string | null;
  models?: string[];
  key?: string;
  key_env?: string | null;
};

export type Attention = "none" | "waiting_input" | "waiting_permission" | "error" | "stalled";

export interface Member {
  id: string;
  bot: Bot;
  /** what its session runs on, as it joined rather than as the bot was since edited */
  executor_id: string;
  model: string | null;
  joined_at: number;
  left_at: number | null;
  /** the bot, its agent or the agent's model API changed since it joined */
  stale: boolean;
}

/** Where a conversation works: a directory a person picked, or a chat space of Roster's own. */
export type DirKind = "repo" | "chat";

/** Where a new conversation is to work, as the dialog picks it. */
export type Location = { kind: "chat" } | { kind: "repo"; path: string };

export interface Locations {
  /** the folder chat spaces are made under */
  chats: string;
  /** directories picked before, most recently used first, only those still there */
  recent: string[];
}

export interface Conversation {
  id: string;
  title: string;
  shape: "direct" | "group";
  mode: Mode;
  leader_member_id: string | null;
  repo_path: string;
  dir_kind: DirKind;
  /** a logo picked for the group; null shows its members' faces */
  avatar: string | null;
  last_activity_at: number;
  preview: string | null;
  attention: Attention;
  run_state: "idle" | "running";
  archived: boolean;
  /** former members included, so history can still say who spoke */
  members: Member[];
}

export interface Message {
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
}

/** One tool call as a steps card lists it; what it took and returned is read with api.step. */
export interface Step {
  id: string;
  name: string;
  effect: "read" | "write" | "execute";
  /** what the call is about, in one line */
  title?: string;
  /** how much of the turn's reply was written when the call was made; absent on older turns */
  at?: number;
  startedAt?: number;
  endedAt?: number;
  ok?: boolean;
  /** the first line of what a failed call returned */
  error?: string;
}

/** A stretch of thinking, listed where it fell among the calls; what it said is read with api.thought. */
export interface Thought {
  kind: "thought";
  id: string;
  /** its first line, once it is done */
  title?: string;
  /** how much of the turn's reply was written when it began */
  at: number;
  startedAt: number;
  endedAt?: number;
}

export const isThought = (s: Step | Thought): s is Thought => (s as Thought).kind === "thought";

export interface StepsBody {
  /** calls and thoughts, in the order they began */
  steps: Array<Step | Thought>;
  /** the seq of the latest event the card folded in */
  last?: number;
}

/** Everything one call took and returned. */
export interface StepDetail {
  id: string;
  name: string;
  effect: Step["effect"];
  input: Record<string, unknown>;
  output?: string;
  /** the output's full length, when only its start came back */
  size?: number;
  isError?: boolean;
  startedAt: number;
  endedAt?: number;
}

/** Everything a finished thought said. */
export interface ThoughtDetail {
  id: string;
  text: string;
  startedAt: number;
  endedAt: number;
}

/** The passage a message replies to, carried with it rather than pasted into it. */
export interface Quote {
  /** the message it came from, so a reply can point back at it */
  messageId?: string;
  /** who said it; absent when you quoted yourself */
  name?: string;
  text: string;
}

/** A file on a message, as core keeps it. */
export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** A command the backend runs itself when a message starts with "/name". */
export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
}

/** What a member's backend session runs with; fields the backend does not know are absent. */
export interface SessionInfo {
  model?: string;
  modelLabel?: string;
  mode?: string;
  effort?: string | null;
  fast?: "on" | "off" | "cooldown";
  context?: ContextUse;
  /** the last turn's input tokens by where they came from: served from the prompt cache, written to it, or neither */
  cache?: { read: number; write: number; uncached: number };
  commands?: SlashCommand[];
}

export interface ContextUse {
  used: number;
  max: number;
  percent: number;
  /** percent of max where the backend compacts on its own */
  autoCompactAt?: number;
  parts?: Array<{ name: string; tokens: number }>;
  /** the end of the window held back for compaction: inside max, never in used */
  reserved?: { name: string; tokens: number };
  /** what waits outside the window until it is needed */
  deferred?: Array<{ name: string; tokens: number }>;
}

export interface ContextDetail extends ContextUse {
  model: string;
  /** tokens is the section's total, where its rows are all of what it holds */
  sections: Array<{ title: string; tokens?: number; rows: Array<{ name: string; tokens: number }> }>;
}

/** A pick for one session. Where the models come from is the agent's, not the session's, to change. */
export interface SessionSettings {
  model?: string;
  effort?: string;
  mode?: string;
  fast?: boolean;
}

/** What a session can be switched to, labelled in the backend's own words. */
export interface SessionOptions {
  models: Array<{
    id: string;
    resolved?: string;
    label: string;
    description?: string;
    efforts: string[];
    fast?: boolean;
  }>;
  efforts: Array<{ id: string; label: string; description?: string }>;
  modes: Array<{ id: string; label: string; description?: string }>;
  fast?: { available: boolean; reason?: string };
  compact: boolean;
  commands?: SlashCommand[];
}

export interface QuotaWindow {
  kind: "session" | "weekly";
  /** the one model a window counts, e.g. "Fable" */
  scope?: string;
  /** 0-100 */
  usedPercent: number;
  resetsAt?: number;
}

/** A subscription plan's limits: account-wide, so one per agent rather than per conversation. */
export interface Quota {
  plan: string | null;
  windows: QuotaWindow[];
  url?: string;
}

export type PresenceState = "starting" | "thinking" | "writing" | "tool" | "waiting_permission" | "waiting_lock" | "compacting";

export interface Presence {
  conversationId: string;
  memberId: string;
  state: PresenceState;
  detail?: string;
  /** the turn being written */
  turnId?: string;
  /** when that turn began, epoch ms: members speaking at once take the floor in this order */
  since?: number;
}

export type ServerMsg =
  | { kind: "message"; conversationId: string; message: Message }
  | { kind: "delta"; conversationId: string; memberId: string; text: string }
  | { kind: "thinking"; conversationId: string; memberId: string; id: string; text: string }
  | { kind: "conversations"; conversations: Conversation[] }
  | { kind: "bots"; bots: Bot[] }
  | { kind: "session"; conversationId: string; memberId: string; info: SessionInfo }
  | { kind: "quota"; executor: string; quota: Quota | null }
  | { kind: "executors"; executors: Executor[]; capabilities: Record<string, Capabilities> }
  | { kind: "extensions" }
  | ({ kind: "preferences" } & Preferences)
  | ({ kind: "presence" } & Omit<Presence, "state"> & { state: PresenceState | "idle" });

/** What a person set for Roster as a whole, kept by core since core writes text in its language. */
export interface Preferences {
  locale: LocaleState;
}

const j = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  return (await r.json()) as T;
};

const body = (method: string, value: unknown): RequestInit => ({ method, body: JSON.stringify(value) });

export const activeMembers = (c: Conversation | undefined) => c?.members.filter((m) => m.left_at === null) ?? [];

export const attachmentUrl = (conversationId: string, id: string) => `/api/conversations/${conversationId}/attachments/${id}`;

export const api = {
  state: (archived = false) =>
    j<{
      bots: Bot[];
      conversations: Conversation[];
      executors: Executor[];
      capabilities: Record<string, Capabilities>;
      /** the harnesses loaded now, with what a person calls them */
      harnesses: Array<{ type: string; label: string }>;
      sources: SourceRef[];
      presence: Presence[];
      logos: Logo[];
      preferences?: Preferences;
    }>(`/api/state${archived ? "?archived=1" : ""}`),
  /** where a new conversation can work */
  locations: () => j<Locations>("/api/locations"),
  setLocale: (locale: LocalePreference) =>
    j<Preferences & { error?: string }>("/api/preferences", body("PATCH", { locale })),
  /** by agent id */
  models: () => j<{ models: Record<string, ModelOption[]> }>("/api/models"),

  executorSettings: () => j<ExecutorSettings>("/api/executors"),
  createExecutor: (input: ExecutorBody) =>
    j<{ executor?: ExecutorRecord; error?: string }>("/api/executors", body("POST", input)),
  updateExecutor: (id: string, patch: ExecutorBody) =>
    j<{ executor?: ExecutorRecord; error?: string }>(`/api/executors/${id}`, body("PATCH", patch)),
  deleteExecutor: (id: string) => j<{ ok?: boolean; error?: string }>(`/api/executors/${id}`, { method: "DELETE" }),
  checkExecutor: (id: string) =>
    j<{ ok: boolean; items: CheckItem[]; error?: string }>(`/api/executors/${id}/check`, { method: "POST" }),
  candidates: () => j<{ candidates?: Candidate[]; error?: string }>("/api/executors/candidates"),

  /** the sign-in belongs to the harness's program on this machine */
  harnessLogin: (type: string, fresh = false) =>
    j<LoginState & { error?: string }>(`/api/harnesses/${type}/login${fresh ? "?fresh=1" : ""}`),
  authenticate: (type: string, method: string) =>
    j<LoginState & { error?: string }>(`/api/harnesses/${type}/authenticate`, body("POST", { method })),
  setProgram: (type: string, program: string) =>
    j<{ program?: string | null; error?: string }>(`/api/harnesses/${type}`, body("PATCH", { program })),
  /** what an agent on this harness and source would offer, before it exists; no provider means its own sign-in */
  harnessModels: (type: string, providerId: string | null) =>
    j<{ models?: ModelOption[]; error?: string }>(
      `/api/harnesses/${type}/models${providerId ? `?provider=${encodeURIComponent(providerId)}` : ""}`,
    ),
  createProvider: (input: ProviderBody) =>
    j<{ provider?: ProviderRecord; error?: string }>("/api/providers", body("POST", input)),
  updateProvider: (id: string, patch: ProviderBody) =>
    j<{ provider?: ProviderRecord; error?: string }>(`/api/providers/${id}`, body("PATCH", patch)),
  deleteProvider: (id: string) => j<{ ok?: boolean; error?: string }>(`/api/providers/${id}`, { method: "DELETE" }),
  /** models: the ids the endpoint itself listed, when it lists any; a preset's saved list becomes them */
  checkProvider: (id: string) => j<CheckItem & { models?: string[]; error?: string }>(`/api/providers/${id}/check`, { method: "POST" }),
  probeModels: (input: { api: string; base_url: string; key?: string; provider_id?: string }) =>
    j<ModelProbe & { error?: string }>("/api/providers/probe-models", body("POST", input)),

  about: () => j<About>("/api/about"),
  extensions: () => j<ExtensionsView>("/api/extensions"),
  installExtension: (id: string) =>
    j<ExtensionsView & { job?: InstallJob; error?: string }>("/api/extensions/install", body("POST", { id })),
  updateExtension: (id: string) =>
    j<ExtensionsView & { job?: InstallJob; error?: string }>(`/api/extensions/${id}/update`, { method: "POST" }),
  removeExtension: (id: string) => j<ExtensionsView & { error?: string }>(`/api/extensions/${id}`, { method: "DELETE" }),
  environment: (fresh = false) => j<Environment & { error?: string }>(`/api/environment${fresh ? "?fresh=1" : ""}`),

  createBot: (input: BotInput) => j<{ bot?: Bot; error?: string }>("/api/bots", body("POST", input)),
  updateBot: (id: string, patch: Partial<BotInput>) =>
    j<{ bot?: Bot; error?: string }>(`/api/bots/${id}`, body("PATCH", patch)),
  deleteBot: (id: string) => j<{ ok: boolean }>(`/api/bots/${id}`, { method: "DELETE" }),

  messages: (id: string) =>
    j<{
      messages: Message[];
      streams: Record<string, string>;
      /** by thought id, for the thoughts still coming in */
      thoughts?: Record<string, string>;
    }>(`/api/conversations/${id}/messages`),
  step: (id: string, turnId: string, callId: string) =>
    j<{ step?: StepDetail }>(
      `/api/conversations/${id}/turns/${encodeURIComponent(turnId)}/steps/${encodeURIComponent(callId)}`,
    ).then((r) => r.step ?? null),
  thought: (id: string, turnId: string, thoughtId: string) =>
    j<{ thought?: ThoughtDetail }>(
      `/api/conversations/${id}/turns/${encodeURIComponent(turnId)}/thoughts/${encodeURIComponent(thoughtId)}`,
    ).then((r) => r.thought ?? null),
  status: (id: string) =>
    j<{
      sessions: Record<string, SessionInfo>;
      /** by member id */
      options: Record<string, SessionOptions>;
      quota: Record<string, Quota | null>;
    }>(`/api/conversations/${id}/status`),
  configure: (convId: string, memberId: string, patch: SessionSettings) =>
    j<{ ok?: boolean; error?: string }>(
      `/api/conversations/${convId}/members/${memberId}/session`,
      body("PATCH", patch),
    ),
  compact: (convId: string, memberId: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${convId}/members/${memberId}/compact`, {
      method: "POST",
    }),
  contextDetail: (convId: string, memberId: string) =>
    j<ContextDetail & { error?: string }>(`/api/conversations/${convId}/members/${memberId}/context`),
  createConversation: (
    input: { title?: string; botIds: string[]; mode?: Mode; leaderBotId?: string } & ({ chat: true } | { repoPath: string }),
  ) => j<{ conversation?: Conversation; error?: string }>("/api/conversations", body("POST", input)),
  send: (id: string, text: string, attachments: string[] = [], quote?: Quote) =>
    j<{ ok?: boolean; error?: string }>(
      `/api/conversations/${id}/messages`,
      body("POST", { text, attachments, ...(quote ? { quote } : {}) }),
    ),
  /** XHR rather than fetch, for the upload progress fetch does not report */
  upload: (conversationId: string, file: Blob, name: string, onProgress: (fraction: number) => void) =>
    new Promise<{ attachment?: AttachmentRef; error?: string }>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/conversations/${conversationId}/attachments`);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-file-name", encodeURIComponent(name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        try {
          resolve(JSON.parse(xhr.responseText) as { attachment?: AttachmentRef; error?: string });
        } catch {
          resolve({ error: translate("upload.failedStatus", { status: xhr.status }) });
        }
      };
      xhr.onerror = () => resolve({ error: translate("upload.unreachable") });
      xhr.send(file);
    }),
  removeAttachment: (conversationId: string, id: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${conversationId}/attachments/${id}`, { method: "DELETE" }),
  archive: (id: string, archived: boolean) =>
    j<{ ok: boolean }>(`/api/conversations/${id}/archive`, body("POST", { archived })),
  remove: (id: string) => j<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  markRead: (id: string) => j<{ ok: boolean }>(`/api/conversations/${id}/read`, { method: "POST" }),
  rename: (id: string, title: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${id}`, body("PATCH", { title })),
  setMode: (id: string, mode: Mode, leaderMemberId?: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${id}`, body("PATCH", { mode, leaderMemberId })),
  /** a logo for the group, or null for its members' faces */
  setAvatar: (id: string, avatar: string | null) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${id}`, body("PATCH", { avatar })),
  /** moves a group; every member starts over there */
  setDirectory: (id: string, location: Location) =>
    j<{ ok?: boolean; error?: string }>(
      `/api/conversations/${id}`,
      body("PATCH", location.kind === "chat" ? { chat: true } : { repoPath: location.path }),
    ),
  abort: (id: string) => j<{ ok: boolean }>(`/api/conversations/${id}/abort`, { method: "POST" }),
  resolvePermission: (convId: string, requestId: string, allow: boolean) =>
    j<{ ok: boolean }>(`/api/conversations/${convId}/permissions/${requestId}`, body("POST", { allow })),

  addMember: (convId: string, botId: string) =>
    j<{ memberId?: string; error?: string }>(`/api/conversations/${convId}/members`, body("POST", { botId })),
  removeMember: (convId: string, memberId: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${convId}/members/${memberId}`, {
      method: "DELETE",
    }),
  syncMember: (convId: string, memberId: string) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${convId}/members/${memberId}/sync`, {
      method: "POST",
    }),
};

/**
 * The UI is a pure projection: it only ever subscribes, never pushes state.
 * EventSource reconnects on its own, but whatever was pushed while it was down
 * is gone, so onReconnect is the cue to refetch.
 */
export function connect(onMsg: (m: ServerMsg) => void, onReconnect?: () => void, onLink?: (up: boolean) => void): () => void {
  const es = new EventSource("/api/stream");
  let dropped = false;
  es.onmessage = (e) => onMsg(JSON.parse(e.data) as ServerMsg);
  es.onerror = () => {
    dropped = true;
    onLink?.(false);
  };
  es.onopen = () => {
    if (dropped) onReconnect?.();
    dropped = false;
    onLink?.(true);
  };
  return () => es.close();
}
