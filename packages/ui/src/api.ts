export type Tier = "read" | "write" | "execute";
export type Mode = "human_led" | "leader" | "discussion";

export interface Bot {
  id: string;
  name: string;
  title: string | null;
  /** a logo id from the bundled set */
  avatar: string | null;
  system_prompt: string | null;
  /** the executor it runs on */
  executor_id: string;
  /** the endpoint its models come from; null is the agent's own sign-in */
  model_source: string | null;
  model: string | null;
  permission_tier: Tier;
  created_at: number;
  archived_at: number | null;
}

export type BotInput = Pick<
  Bot,
  "name" | "title" | "avatar" | "system_prompt" | "executor_id" | "model_source" | "model" | "permission_tier"
>;

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
  paths: { data: string; agents: string; attachments: string; extensions: string };
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

export type SourceKind = "own" | "endpoint";

/** Capabilities differ by where the models come from: the channels differ. */
export type CapabilitySet = Partial<Record<SourceKind, Capabilities>>;

/** Which model sources an executor offers. */
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
  /** who serves it, e.g. "deepseek" */
  provider?: string;
  /** facts the catalog knows; absent when it would only be guessing */
  contextWindow?: number;
  reasoning?: boolean;
  images?: boolean;
  /** USD per million tokens */
  cost?: { input: number; output: number };
}

/** One place a bot's models can come from, and what it offers. */
export interface ModelGroup {
  /** an endpoint id, or null for the agent's own sign-in */
  source: string | null;
  label: string;
  models: ModelOption[];
}

/** The models one agent offers from an endpoint. */
export interface CatalogGroup {
  type: string;
  label: string;
  models: ModelOption[];
}

/** A configured instance of a harness type; bots run on one. */
export interface Executor {
  id: string;
  /** the harness type, e.g. claude-code */
  type: string;
  label: string;
  sources: Sources;
}

/** An endpoint as the rest of the app sees it: a name to label sources with, never a key. */
export interface SourceRef {
  id: string;
  name: string;
  preset: string;
  api: string | null;
}

export interface HarnessField {
  key: string;
  label: string;
  kind: "text" | "path" | "secret" | "env" | "select";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ id: string; label: string }>;
}

export interface HarnessTypeInfo {
  type: string;
  label: string;
  sources: Sources;
  capabilities: CapabilitySet;
  fields: HarnessField[];
}

/** An endpoint a harness knows by id, so only a key is needed. */
export interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  baseUrl?: string;
  models: number;
  keyLabel?: string;
}

export const CUSTOM_PRESET = "custom";

export interface ExecutorRecord {
  id: string;
  name: string;
  type: string;
  settings: Record<string, string>;
  rev: number;
  /** its type is provided by an installed extension */
  known: boolean;
}

export interface ProviderRecord {
  id: string;
  name: string;
  preset: string;
  api: string | null;
  base_url: string | null;
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

/** Where an agent's program is, if anywhere: on the machine already, or fetched by Roster. */
export interface ProgramState {
  /** the adapter drives a separate program; false for a library adapter such as pi */
  needed: boolean;
  detected?: DetectedProgram;
  installed?: { path: string; version: string | null };
  path?: string;
  /** a bot on this agent can start */
  usable: boolean;
}

/** One agent as the settings page shows it: its adapter ships with Roster or not, its program is found or not. */
export interface AgentView {
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
  agents: AgentView[];
  installed: Extension[];
  jobs: InstallJob[];
  root: string;
  programsRoot: string;
  environment: Environment | null;
}

export type ExecutorBody = { name?: string; type?: string; settings?: Record<string, string> };
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
  joined_at: number;
  left_at: number | null;
  /** the bot, its executor or its endpoint changed since it joined */
  stale: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  shape: "direct" | "group";
  mode: Mode;
  leader_member_id: string | null;
  repo_path: string;
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
  commands?: SlashCommand[];
}

export interface ContextUse {
  used: number;
  max: number;
  percent: number;
  /** percent of max where the backend compacts on its own */
  autoCompactAt?: number;
  parts?: Array<{ name: string; tokens: number }>;
}

export interface ContextDetail extends ContextUse {
  model: string;
  sections: Array<{ title: string; rows: Array<{ name: string; tokens: number }> }>;
}

/** A pick for one session; source is an endpoint id, null for the agent's own sign-in. */
export interface SessionSettings {
  model?: string;
  effort?: string;
  mode?: string;
  fast?: boolean;
  source?: string | null;
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
    /** where it comes from; picking one from another source restarts the session there */
    source?: string | null;
    sourceLabel?: string;
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

/** A subscription plan's limits: account-wide, so one per executor rather than per conversation. */
export interface Quota {
  plan: string | null;
  windows: QuotaWindow[];
  url?: string;
}

export type PresenceState = "starting" | "thinking" | "tool" | "waiting_permission" | "waiting_lock" | "compacting";

export interface Presence {
  conversationId: string;
  memberId: string;
  state: PresenceState;
  detail?: string;
}

export type ServerMsg =
  | { kind: "message"; conversationId: string; message: Message }
  | { kind: "delta"; conversationId: string; memberId: string; text: string }
  | { kind: "conversations"; conversations: Conversation[] }
  | { kind: "bots"; bots: Bot[] }
  | { kind: "session"; conversationId: string; memberId: string; info: SessionInfo }
  | { kind: "quota"; executor: string; quota: Quota | null }
  | { kind: "executors"; executors: Executor[]; capabilities: Record<string, CapabilitySet> }
  | { kind: "extensions" }
  | ({ kind: "presence" } & Omit<Presence, "state"> & { state: PresenceState | "idle" });

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
      capabilities: Record<string, CapabilitySet>;
      sources: SourceRef[];
      presence: Presence[];
      logos: Logo[];
      defaultDir: string;
    }>(`/api/state${archived ? "?archived=1" : ""}`),
  models: () => j<{ models: Record<string, ModelGroup[]> }>("/api/models"),

  executorSettings: () => j<ExecutorSettings>("/api/executors"),
  createExecutor: (input: ExecutorBody) =>
    j<{ executor?: ExecutorRecord; error?: string }>("/api/executors", body("POST", input)),
  updateExecutor: (id: string, patch: ExecutorBody) =>
    j<{ executor?: ExecutorRecord; error?: string }>(`/api/executors/${id}`, body("PATCH", patch)),
  deleteExecutor: (id: string) => j<{ ok?: boolean; error?: string }>(`/api/executors/${id}`, { method: "DELETE" }),
  checkExecutor: (id: string) =>
    j<{ ok: boolean; items: CheckItem[]; error?: string }>(`/api/executors/${id}/check`, { method: "POST" }),
  executorLogin: (id: string, fresh = false) =>
    j<LoginState & { error?: string }>(`/api/executors/${id}/login${fresh ? "?fresh=1" : ""}`),
  authenticate: (id: string, method: string) =>
    j<LoginState & { error?: string }>(`/api/executors/${id}/authenticate`, body("POST", { method })),
  createProvider: (input: ProviderBody) =>
    j<{ provider?: ProviderRecord; error?: string }>("/api/providers", body("POST", input)),
  updateProvider: (id: string, patch: ProviderBody) =>
    j<{ provider?: ProviderRecord; error?: string }>(`/api/providers/${id}`, body("PATCH", patch)),
  deleteProvider: (id: string) => j<{ ok?: boolean; error?: string }>(`/api/providers/${id}`, { method: "DELETE" }),
  /** models: the ids the endpoint itself listed, when it lists any */
  checkProvider: (id: string) => j<CheckItem & { models?: string[]; error?: string }>(`/api/providers/${id}/check`, { method: "POST" }),
  providerModels: (id: string) => j<{ groups?: CatalogGroup[]; error?: string }>(`/api/providers/${id}/models`),
  presetModels: (preset: string) => j<{ groups?: CatalogGroup[]; error?: string }>(`/api/presets/${encodeURIComponent(preset)}/models`),
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
    j<{ messages: Message[]; streams: Record<string, string> }>(`/api/conversations/${id}/messages`),
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
  createConversation: (input: {
    title?: string;
    repoPath: string;
    botIds: string[];
    mode?: Mode;
    leaderBotId?: string;
  }) => j<{ conversation?: Conversation; error?: string }>("/api/conversations", body("POST", input)),
  send: (id: string, text: string, attachments: string[] = []) =>
    j<{ ok?: boolean; error?: string }>(`/api/conversations/${id}/messages`, body("POST", { text, attachments })),
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
          resolve({ error: `上传失败（${xhr.status}）` });
        }
      };
      xhr.onerror = () => resolve({ error: "上传失败，连不上 Roster" });
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
export function connect(onMsg: (m: ServerMsg) => void, onReconnect?: () => void): () => void {
  const es = new EventSource("/api/stream");
  let dropped = false;
  es.onmessage = (e) => onMsg(JSON.parse(e.data) as ServerMsg);
  es.onerror = () => {
    dropped = true;
  };
  es.onopen = () => {
    if (dropped) onReconnect?.();
    dropped = false;
  };
  return () => es.close();
}
