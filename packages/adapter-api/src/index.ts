/**
 * The contract every backend implements. One BotRuntime instance drives exactly
 * one bot. It never learns whether that bot is alone in a conversation or one of
 * several in a group -- that is the orchestrator's concern.
 *
 * The layers are strict. A harness type is code, shipped as an extension:
 * Claude Code, pi-agent, an ACP agent; it holds no state of its own. An
 * executor -- an agent, to a person -- binds one harness type to one model
 * source: the agent's own sign-in, or one model endpoint. A model endpoint is
 * where models come from and which key opens them; it runs nothing itself. A
 * bot names an executor, and with it everything about how it runs.
 *
 * This package is types only. An extension imports it with `import type` and
 * needs nothing from Roster at runtime.
 */

/**
 * What a backend can actually do. Consumers branch on this instead of on which
 * backend it is, and the UI degrades per flag rather than collapsing to the
 * intersection of every backend.
 */
export interface Capabilities {
  /** Every tool call can be inspected before it executes, not only the ones the agent asks about. */
  interceptToolCall: boolean;
  /** Tool arguments can be rewritten before execution, not just allowed/denied. */
  mutateToolInput: boolean;
  /** Which mid-run delivery modes send() accepts beyond "now". */
  midRunInject: readonly Deliver[];
  /** A hard spend or turn ceiling can be handed to the backend. */
  costLimit: boolean;
  mcp: boolean;
  /** Conversation history can be branched and resumed at an earlier point. */
  branch: boolean;
  /**
   * The backend has permission modes of its own. A call the host defers is
   * decided by that mode, and the mode's asks come back through onPermission.
   * Without them the host gates every call by tier, and a session switches
   * between tiers where it would switch modes.
   */
  permissionModes: boolean;
}

/**
 * "now" starts a turn. "steer" interrupts the running turn at the next tool
 * boundary; "followUp" queues until the turn finishes.
 */
export type Deliver = "now" | "steer" | "followUp";

/**
 * A file a person attached to a message. The text handed to send() already
 * names it by path, so a backend that does nothing with this still gets it
 * across; one that takes images natively attaches those as well.
 */
export interface Attachment {
  name: string;
  /** e.g. image/png */
  mime: string;
  /** bytes */
  size: number;
  /** absolute, outside the worktree */
  path: string;
}

/** A command the backend runs itself when a message starts with "/name". */
export interface SlashCommand {
  /** without the slash */
  name: string;
  description?: string;
  /** what goes after the name, e.g. "<file>" */
  hint?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Backend-declared classification, used for the permission tier and the write lock. */
  effect: ToolEffect;
}

/** Whether a tool only observes, mutates the worktree, or runs arbitrary commands. */
export type ToolEffect = "read" | "write" | "execute";

export type ToolDecision =
  | { action: "allow"; input?: Record<string, unknown> }
  | { action: "deny"; reason: string; terminate?: boolean }
  // leaves the call to the backend's own permission mode; only for backends that declare permissionModes
  | { action: "defer" };

export interface StartOpts {
  /** The conversation's worktree. */
  cwd: string;
  /**
   * The bot's preset. Appended to the backend's own coding prompt, never a
   * replacement for it: that prompt is what teaches the agent its tools.
   */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  /** a permission mode id from sessionOptions; never given to backends without permissionModes */
  mode?: string;
  fast?: boolean;
  /** Tool names the bot may use at all; omitted means the backend default set. */
  tools?: readonly string[];
  /** Hands the backend its own prior session so context survives an app restart. */
  resumeToken?: string;
  /**
   * The host's single choke point. Permission decisions and the worktree write
   * lock both run through here, because the interception is already happening.
   * May take arbitrarily long -- a human is on the other end.
   */
  onToolCall?: (call: ToolCall) => Promise<ToolDecision>;
  /** The backend's own permission mode wants a human to decide a call the host deferred. */
  onPermission?: (call: ToolCall) => Promise<ToolDecision>;
  budget?: { maxTurns?: number; maxUsd?: number };
}

/** How the UI should present an event. The log records every event regardless. */
export type Display =
  | "message" // its own bubble in the stream
  | "fold" // collapses into the "ran N steps" card
  | "card" // its own card: permission, artifact
  | "status"; // drives conversation state only, never rendered

export type NormalizedEvent =
  | { type: "assistant.text"; display: "message"; delta: string; final?: boolean }
  | { type: "assistant.thinking"; display: "fold"; delta: string }
  | { type: "tool.start"; display: "fold"; call: ToolCall }
  | { type: "tool.update"; display: "fold"; id: string; chunk: string }
  | { type: "tool.end"; display: "fold"; id: string; isError: boolean; content: string }
  | { type: "permission.request"; display: "card"; call: ToolCall }
  | { type: "permission.decision"; display: "card"; id: string; decision: ToolDecision }
  // A turn spans one send() until the bot is idle again, however many model
  // calls and tool rounds that takes. Every started turn must end, errors included.
  | { type: "turn.start"; display: "status" }
  | { type: "turn.end"; display: "status"; reason: "done" | "aborted" | "error" }
  | {
      type: "cost";
      display: "status";
      usd?: number;
      /** input tokens processed in full, outside the prompt cache */
      inputTokens?: number;
      outputTokens?: number;
      cacheRead?: number;
      cacheWrite?: number;
    }
  // what the session runs with: the whole picture each time, not a patch
  | { type: "session.info"; display: "status"; info: SessionInfo }
  | { type: "error"; display: "message"; message: string };

/** What a backend session runs with, as the backend itself reports it. A backend fills in what it knows. */
export interface SessionInfo {
  /** the model id the backend resolved, e.g. claude-opus-5 */
  model?: string;
  /** a short human name for that model, e.g. "Opus 5" */
  modelLabel?: string;
  /** the backend's own permission mode; the host puts the session's tier here for a backend without permissionModes */
  mode?: string;
  /** reasoning effort; null when the model takes none */
  effort?: string | null;
  /** faster output at a higher rate; cooldown is on but paused after a rate limit */
  fast?: "on" | "off" | "cooldown";
  context?: ContextUse;
  /** how the last turn's requests met the prompt cache */
  cache?: CacheUse;
  /** what this session's own slash commands are, which can depend on its worktree */
  commands?: SlashCommand[];
}

/**
 * Input tokens of a turn by where they came from. A turn is several requests,
 * each re-sending the whole context: what the provider served from its prompt
 * cache costs a fraction of what it processed in full.
 */
export interface CacheUse {
  /** served from the cache */
  read: number;
  /** processed in full and written to the cache for the next request */
  write: number;
  /** processed in full and not cached */
  uncached: number;
}

/** How full the session's context window is. */
export interface ContextUse {
  /** tokens */
  used: number;
  /** the window usage is measured against */
  max: number;
  /** 0-100, past 100 when over */
  percent: number;
  /** where the backend compacts on its own, as a percent of max; absent when it never does */
  autoCompactAt?: number;
  /** what occupies it, largest first */
  parts?: Array<{ name: string; tokens: number }>;
  /** the end of the window held back so compaction has room to run: inside max, never in used */
  reserved?: { name: string; tokens: number };
  /** what waits outside the window until it is needed, such as tool schemas loaded on demand */
  deferred?: Array<{ name: string; tokens: number }>;
}

/** Everything the context holds, read on request: heavier than what rides along with every turn. */
export interface ContextDetail extends ContextUse {
  model: string;
  sections: Array<{
    title: string;
    /** what the rows add up to, when they are all of what the section holds */
    tokens?: number;
    rows: Array<{ name: string; tokens: number }>;
  }>;
}

/** What a person picked for one session; anything left out falls back to the bot's spec or the backend's default. */
export interface SessionSettings {
  model?: string;
  effort?: string;
  mode?: string;
  fast?: boolean;
}

/** What a session can be switched to, labelled in the backend's own words. */
export interface SessionOptions {
  /** resolved is the model id an entry runs, so a session's report can be matched back to it */
  models: Array<{
    id: string;
    resolved?: string;
    label: string;
    description?: string;
    efforts: string[];
    /** takes fast mode */
    fast?: boolean;
  }>;
  efforts: Array<{ id: string; label: string; description?: string }>;
  /** permission modes; the host offers its tiers here instead for a backend without permissionModes */
  modes: Array<{ id: string; label: string; description?: string }>;
  /** whether this account can turn fast mode on at all, and why not */
  fast?: { available: boolean; reason?: string };
  /** a session can be compacted on request */
  compact: boolean;
  /** slash commands a session would offer, before one has started to say for itself */
  commands?: SlashCommand[];
}

/** A subscription plan's usage limits. They belong to the account, so every session on it shares them. */
export interface Quota {
  /** e.g. "pro"; null when the plan is not named */
  plan: string | null;
  windows: QuotaWindow[];
  /** the provider's own page for this account's usage */
  url?: string;
}

export interface QuotaWindow {
  /** session is the rolling few-hour window, weekly the long one */
  kind: "session" | "weekly";
  /** the one model a window counts, e.g. "Fable"; absent when it counts all of them */
  scope?: string;
  /** 0-100 */
  usedPercent: number;
  /** epoch ms */
  resetsAt?: number;
}

export type Unsubscribe = () => void;

export interface ModelOption {
  id: string;
  label?: string;
  /** Credentials for its provider are configured, so it should work as-is. */
  available: boolean;
}

/** A model endpoint and the credentials for it, independent of which harness calls it. */
export interface ProviderConfig {
  id: string;
  name: string;
  /** a preset id a harness already knows how to reach, e.g. pi's "deepseek"; "custom" when everything below is given */
  preset: string;
  /** the wire protocol, e.g. "anthropic-messages" or "openai-completions" */
  api?: string;
  baseUrl?: string;
  /** plaintext, and only ever in memory: never logged, never sent back to the UI */
  apiKey?: string;
  /**
   * The model ids it serves: what its own API listed, or what a person entered
   * for a custom endpoint that lists none. No harness adds to or describes them.
   */
  models?: readonly string[];
  headers?: Readonly<Record<string, string>>;
}

/** The preset id of an endpoint a person described by hand: protocol, address, models. */
export type CustomPreset = "custom";

/** An endpoint a harness can reach by id alone, so a person only has to bring a key. Its models are whatever its API lists. */
export interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  baseUrl?: string;
  /** what the provider calls the key, e.g. "DeepSeek API key" */
  keyLabel?: string;
}

/**
 * Where an executor's models come from. "own" is the agent's own sign-in -- a
 * subscription, an account -- which cannot be taken apart into an endpoint;
 * "endpoint" is one the person set up, handed over with its key resolved.
 */
export type ModelSource = { kind: "own" } | { kind: "endpoint"; endpoint: ProviderConfig };

export type SourceKind = ModelSource["kind"];

/** Which model sources a harness type offers at all. */
export interface Sources {
  /** the agent signs in on its own and brings its own catalog */
  own: boolean;
  /** the wire protocols it can speak to an endpoint; an endpoint on any other cannot be used with it */
  apis: readonly string[];
}

/** How a person signs an agent in, when the agent brings its own models. */
export interface LoginMethod {
  id: string;
  label: string;
  description?: string;
  /** a command the person runs in their own terminal; Roster does not drive it */
  terminal?: { command: string; args: readonly string[] };
}

/** Whether the agent's own sign-in is there. */
export interface LoginState {
  /** unknown when the backend could not be asked */
  state: "ok" | "none" | "unknown";
  /** who is signed in, in the agent's own words: a plan name, an email */
  account?: string;
  /** what went wrong, when state is unknown */
  detail?: string;
  methods: readonly LoginMethod[];
}

export interface BotRuntime {
  readonly capabilities: Capabilities;
  start(opts: StartOpts): Promise<void>;
  /** Resolves once the input is accepted; completion arrives as turn.end. */
  send(text: string, deliver?: Deliver, attachments?: readonly Attachment[]): Promise<void>;
  abort(): Promise<void>;
  /** Opaque backend handle for resuming this bot's context later; undefined until it exists. */
  readonly resumeToken?: string | undefined;
  dispose(): Promise<void>;
  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe;
  /** Plan usage read through this live session, which is cheaper than the factory's cold read. */
  quota?(): Promise<Quota | null>;
  /** Switches the live session; a new model or effort applies from its next request. Reports session.info when done. */
  configure?(settings: SessionSettings): Promise<void>;
  /** Summarizes the session's history to free its context. Runs as a turn, so completion arrives as turn.end. */
  compact?(): Promise<void>;
  contextDetail?(): Promise<ContextDetail>;
}

/**
 * One executor: a harness type bound to one model source. A runtime is created
 * per session, and the source never changes under it -- another source is
 * another executor.
 */
export interface BotRuntimeFactory {
  /** the executor's id, which bots reference */
  readonly id: string;
  /** the harness type it was created from */
  readonly type: string;
  /** what a person calls it */
  readonly label: string;
  /** Readable without constructing a runtime, so the UI can degrade before anything starts. */
  readonly capabilities: Capabilities;
  create(): BotRuntime;
  /** The models the agent's own sign-in offers; an endpoint's are the ids its API listed, which the host already has. Suggestions only; free text stays allowed. */
  models?(): Promise<ModelOption[]>;
  /** What a runtime started with these settings would report, so it can be shown before one exists. */
  sessionInfo?(settings: SessionSettings): Promise<SessionInfo>;
  sessionOptions?(): Promise<SessionOptions>;
  /** The permission mode that grants what a tier grants; a session nobody picked a mode for starts there. */
  modeForTier?(tier: ToolEffect): string;
  /** Plan usage for the agent's own sign-in; null when it has no such limit. */
  quota?(): Promise<Quota | null>;
  /** Whether this executor can actually reach its models, without spending anything. */
  check?(): Promise<{ ok: boolean; detail?: string }>;
}

/** Everything a harness type is handed to build one executor. */
export interface InstanceConfig {
  id: string;
  label: string;
  source: ModelSource;
  /** the agent program the host settled on: the person's pick, else the one found on the machine, else Roster's own install */
  program?: string;
  /**
   * Ask the model API to keep each session's prompt cache for an hour rather
   * than minutes, where it offers the choice. Dearer per cache write, cheaper
   * for a session that waits on people between turns. A backend that cannot
   * pass it on ignores it.
   */
  longCache?: boolean;
  /**
   * The language Roster is in, as a BCP 47 tag such as "en" or "zh-CN". Text an
   * adapter writes for a person -- descriptions, check results, errors -- is in
   * it; the backend's own names stay as the backend spells them. The host makes
   * executors again when it changes.
   */
  locale?: string;
}

/**
 * A harness Roster knows how to drive. Types come from extensions and hold no
 * state; people add executors of them, never new types.
 */
export interface HarnessType {
  readonly type: string;
  readonly label: string;
  /** the version of the agent an adapter carries as a library, such as pi; a separate program's is read from the program */
  readonly version?: string;
  readonly sources: Sources;
  /** Differs by source kind: the channels differ. */
  capabilities(kind: SourceKind): Capabilities;
  /** endpoints it can reach by id alone */
  presets?(): Promise<ProviderPreset[]>;
  /** Throws when the source is one this type cannot run on. */
  create(instance: InstanceConfig): BotRuntimeFactory;
  /**
   * Whether the agent's own sign-in is there on this machine, and how to get one.
   * It belongs to the program, not to an executor. Method labels are in locale,
   * as InstanceConfig describes it.
   */
  login?(program?: string, locale?: string): Promise<LoginState>;
  /** Runs a sign-in method the agent can complete on its own, without a terminal. */
  authenticate?(methodId: string, program?: string): Promise<void>;
}

/**
 * What an extension's package.json carries under "roster". A code extension
 * exports a HarnessType from its entry; a manifest-only one describes an ACP
 * agent and the host supplies the type. Both together: the entry drives
 * endpoints, the ACP block drives the agent's own sign-in.
 */
export interface ExtensionManifest {
  /** the contract major version this extension was written against */
  api: number;
  /** the harness type id; a code entry's own id wins, a manifest-only extension defaults to its package name */
  type?: string;
  /** what a person sees */
  label?: string;
  /** a module exporting `harness: HarnessType`, relative to the package */
  entry?: string;
  acp?: AcpManifest;
  /**
   * The agent program this adapter drives, when it is a separate thing from the
   * adapter: found on the machine, or fetched by the host when it is not. An
   * adapter that carries its agent as a library (pi) declares none.
   */
  program?: ProgramManifest;
}

/** An agent program as an npm package, and how to recognise one already installed. */
export interface ProgramManifest {
  /** the npm package; "{platform}" is replaced with `${process.platform}-${process.arch}` */
  npm: string;
  version?: string;
  /** the command name, on PATH or in the package's bin */
  bin: string;
  /** a file inside the package that is the program, when the package declares no bin for it */
  binPath?: string;
  /** where an install other than npm puts it; ~ is the home directory */
  paths?: readonly string[];
  versionArgs?: readonly string[];
  /**
   * The program's own updater, for a copy found on the machine rather than one
   * Roster fetched: the arguments that install the latest version, and ones
   * that only check, printing JSON with `latestVersion` and `updateAvailable`.
   */
  update?: { args: readonly string[]; check?: readonly string[] };
}

/** Everything the host needs to run an agent over the Agent Client Protocol. */
export interface AcpManifest {
  /**
   * The program and its arguments. "node" is the host's own runtime, "@program"
   * is the agent program the host found or installed, a relative path resolves
   * against the extension's directory, and a package subpath is resolved the
   * way the extension's own code would resolve it.
   */
  command: readonly string[];
  /** per wire protocol, the environment variables that carry an endpoint's address and key */
  env?: Readonly<Record<string, { baseUrl?: string; key: string }>>;
  /**
   * Presets the agent takes by id, and the environment variables their key
   * and address go into. The address and protocol come from the preset
   * catalog the other harnesses report; an endpoint's own address wins.
   */
  presets?: Readonly<Record<string, { baseUrl?: string; key: string }>>;
  /** False when the agent has no sign-in of its own and runs only on a model API. Defaults to true. */
  own?: boolean;
  /**
   * What each tool does, by the title the agent gives its calls, for an agent
   * that reports a tool's kind as other or not at all. The gate goes by it.
   */
  toolEffects?: Readonly<Record<string, ToolEffect>>;
  /** how the person signs the agent in when it advertises no in-protocol method */
  login?: { terminal?: readonly string[] };
  /**
   * Where the program path goes. Into this environment variable when the
   * command is an adapter that wraps the real program; in place of the
   * program itself otherwise.
   */
  executable?: { env: string };
  /**
   * False when the agent has permission modes but offers none a client can
   * switch. The host then answers what it asks by tier, as for a backend
   * without modes of its own. Defaults to true.
   */
  permissionModes?: boolean;
  /** Sent as `_meta` with every session the host opens or loads: settings the agent takes nowhere else. */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * Environment variables set on every launch, whatever the source, over any
   * the host inherited: settings the agent reads only from its environment,
   * such as a permission policy pinned to asking. A value that is not a
   * string is passed as JSON.
   */
  fixedEnv?: Readonly<Record<string, unknown>>;
}
