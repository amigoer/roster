import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AuthMethod,
  type AvailableCommand,
  type Client,
  type ContentBlock,
  type PermissionOptionKind,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type ToolCallUpdate,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  AcpManifest,
  Attachment,
  BotRuntime,
  BotRuntimeFactory,
  Capabilities,
  ContextUse,
  Deliver,
  HarnessType,
  InstanceConfig,
  LoginMethod,
  LoginState,
  ModelOption,
  ModelSource,
  NormalizedEvent,
  SessionInfo,
  SessionOptions,
  SessionSettings,
  SlashCommand,
  StartOpts,
  ToolCall,
  ToolDecision,
  ToolEffect,
  Unsubscribe,
} from "@roster/adapter-api";

/**
 * Any agent that speaks the Agent Client Protocol, driven over stdio. The
 * protocol is the host's to know; which agent it is comes from an extension's
 * manifest: the command, the environment variables that carry an endpoint,
 * and how a person signs in.
 *
 * What the protocol cannot do is declared, not papered over: the host sees a
 * tool call only when the agent asks permission for it, and cannot rewrite
 * its arguments; a running turn takes no injected text.
 */
export const ACP_CAPABILITIES: Capabilities = {
  interceptToolCall: false,
  mutateToolInput: false,
  midRunInject: [],
  costLimit: false,
  mcp: true,
  branch: false,
  permissionModes: true,
};

/** How a manifest's command becomes a process. */
export interface AcpSpec {
  type: string;
  label: string;
  /** the extension's package directory: relative paths and package subpaths resolve against it */
  dir: string;
  manifest: AcpManifest;
  /** whether the agent's own sign-in counts as a model source */
  own: boolean;
}

interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** the program a person would run to sign in, for a terminal method's display */
  program: string;
}

/** Formats every model that reads images takes; anything else stays a path in the text. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** An image past this is refused whole by the model APIs behind most agents, so it is left to the path. */
const IMAGE_MAX_BYTES = 3_750_000;
const PROBE_TIMEOUT_MS = 20_000;
const AUTH_STATUS_WAIT_MS = 1_500;
const COMMANDS_WAIT_MS = 400;
const SNAPSHOT_REUSE_MS = 10 * 60_000;
const AUTH_STATUS_METHOD = "_auth/status_update";
/** JSON-RPC code an agent answers with when nobody is signed in */
const AUTH_REQUIRED = -32000;

const EFFECT_OF_KIND: Record<ToolKind, ToolEffect> = {
  read: "read",
  search: "read",
  fetch: "read",
  think: "read",
  switch_mode: "read",
  edit: "write",
  delete: "write",
  move: "write",
  execute: "execute",
  other: "execute",
};

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Roster may itself be running inside a Claude Code session; the agent must not think it is that session's child
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID") continue;
    out[k] = v;
  }
  return out;
}

/** The agent program, as the manifest's "@program" stands for it; "node" is the host's own runtime. */
const PROGRAM = "@program";

const isScript = (p: string) => /\.(c|m)?js$/.test(p);

/**
 * A "node" head runs on the host's own runtime, so a machine without node on
 * PATH still works. The program is the one the host settled on for this agent
 * type: it goes where the manifest says.
 */
function resolveLaunch(spec: AcpSpec, executable: string | undefined, source: ModelSource): Launch {
  const req = createRequire(join(spec.dir, "package.json"));
  const program = executable?.trim() || undefined;
  const resolveItem = (item: string): string => {
    if (item === "node") return process.execPath;
    if (item === PROGRAM) {
      if (!program) throw new Error(`没有找到 ${spec.label} 的程序：本机没装，Roster 也没装，先到设置里的 Harness 页安装`);
      return program;
    }
    if (item.startsWith("./") || item.startsWith("../")) return resolve(spec.dir, item);
    // a package subpath, found the way the extension's own code would find it
    if (/^(@[^/]+\/)?[^/@][^/]*\/.+/.test(item)) {
      try {
        return req.resolve(item);
      } catch {
        return item;
      }
    }
    return item;
  };
  let items = spec.manifest.command.map(resolveItem);
  // a program that is a script runs on the host's runtime, whatever shim npm made for it
  if (items[0] && items[0] !== process.execPath && isScript(items[0])) items = [process.execPath, ...items];
  const env = cleanEnv();
  if (items[0] === process.execPath && process.versions["electron"]) env["ELECTRON_RUN_AS_NODE"] = "1";
  if (program && spec.manifest.executable?.env) env[spec.manifest.executable.env] = program;

  const command = items[0] ?? "";
  const args = items.slice(1);
  const shown = program ?? (spec.manifest.command[0] === "node" ? (spec.manifest.command[1] ?? "") : (spec.manifest.command[0] ?? ""));
  if (source.kind === "endpoint") {
    const { endpoint } = source;
    const map = endpoint.api ? spec.manifest.env?.[endpoint.api] : undefined;
    if (map) {
      if (endpoint.apiKey) env[map.key] = endpoint.apiKey;
      if (map.baseUrl && endpoint.baseUrl) env[map.baseUrl] = endpoint.baseUrl;
    }
  }
  return { command, args, env, program: shown };
}

type SelectOption = { value: string; name: string; description?: string | null };

/** Select options come flat or grouped; the picker does not care which. */
function selectOptions(opt: SessionConfigOption): SelectOption[] {
  if (opt.type !== "select") return [];
  const raw = opt.options as unknown as Array<Record<string, unknown>>;
  const out: SelectOption[] = [];
  for (const o of raw) {
    if (Array.isArray(o["options"])) {
      for (const inner of o["options"] as SelectOption[]) out.push(inner);
    } else if (typeof o["value"] === "string") {
      out.push(o as unknown as SelectOption);
    }
  }
  return out;
}

const currentOf = (opt: SessionConfigOption | undefined): string | undefined =>
  opt && opt.type === "select" && typeof opt.currentValue === "string" ? opt.currentValue : undefined;

function byCategory(options: readonly SessionConfigOption[], category: string): SessionConfigOption | undefined {
  return options.find((o) => o.category === category && o.type === "select");
}

const fastOption = (options: readonly SessionConfigOption[]): SessionConfigOption | undefined =>
  options.find((o) => o.type === "boolean" && (o.id === "fast" || o.category === "model_config"));

/** What a session runs with, read off its config options, with the picks laid over. */
function infoOf(options: readonly SessionConfigOption[], modes: SessionModeState | null, picks: SessionSettings): SessionInfo {
  const model = byCategory(options, "model");
  const effort = byCategory(options, "thought_level");
  const mode = byCategory(options, "mode");
  const fast = fastOption(options);
  const modelId = picks.model ?? currentOf(model);
  const modeId = picks.mode ?? currentOf(mode) ?? modes?.currentModeId;
  const effortId = effort ? (picks.effort ?? currentOf(effort) ?? null) : null;
  return {
    ...(modelId ? { model: modelId, modelLabel: selectOptions(model ?? ({} as SessionConfigOption)).find((o) => o.value === modelId)?.name ?? modelId } : {}),
    ...(modeId ? { mode: modeId } : {}),
    effort: effortId,
    ...(fast ? { fast: (picks.fast ?? fast.currentValue === true) ? "on" : "off" } : {}),
  };
}

const commandsOf = (list: readonly AvailableCommand[]): SlashCommand[] =>
  list.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.input?.hint ? { hint: c.input.hint } : {}) }));

function optionsOf(options: readonly SessionConfigOption[], modes: SessionModeState | null, commands: readonly AvailableCommand[]): SessionOptions {
  const model = byCategory(options, "model");
  const effort = byCategory(options, "thought_level");
  const mode = byCategory(options, "mode");
  const efforts = effort ? selectOptions(effort) : [];
  const modeList = mode
    ? selectOptions(mode).map((o) => ({ id: o.value, label: o.name, ...(o.description ? { description: o.description } : {}) }))
    : (modes?.availableModes ?? []).map((m) => ({ id: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) }));
  const fast = fastOption(options);
  return {
    models: (model ? selectOptions(model) : []).map((o) => ({
      id: o.value,
      label: o.name,
      ...(o.description ? { description: o.description } : {}),
      efforts: efforts.map((e) => e.value),
      ...(fast ? { fast: true } : {}),
    })),
    efforts: efforts.map((e) => ({ id: e.value, label: e.name, ...(e.description ? { description: e.description } : {}) })),
    modes: modeList,
    ...(fast ? { fast: { available: true } } : {}),
    compact: commands.some((c) => c.name === "compact"),
    ...(commands.length > 0 ? { commands: commandsOf(commands) } : {}),
  };
}

/** A mode that grants what a tier grants, by the names agents give their modes. */
function modeForTier(modes: ReadonlyArray<{ id: string; label: string }>, tier: ToolEffect): string | undefined {
  const find = (re: RegExp) => modes.find((m) => re.test(`${m.id} ${m.label}`.toLowerCase()))?.id;
  if (tier === "execute") return find(/bypass|yolo|full.?access|auto/) ?? modes.at(-1)?.id;
  if (tier === "write") return find(/accept.?edit|auto.?edit|edit/) ?? modes[0]?.id;
  return find(/default|ask|manual|read/) ?? modes[0]?.id;
}

function textOf(update: ToolCallUpdate): string {
  const parts = (update.content ?? []).flatMap((c) => {
    if (c.type === "content" && c.content.type === "text") return [c.content.text];
    if (c.type === "diff") return [`${c.path}\n${c.newText}`];
    return [];
  });
  if (parts.length > 0) return parts.join("\n");
  if (update.rawOutput === undefined || update.rawOutput === null) return "";
  return typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
}

const authState = (status: unknown): { ok: boolean; label?: string } | null => {
  if (!status || typeof status !== "object") return null;
  const s = status as Record<string, unknown>;
  if (typeof s["kind"] !== "string") return null;
  return { ok: s["kind"] !== "none", ...(typeof s["label"] === "string" ? { label: s["label"] } : {}) };
};

/** An agent process and the connection over its stdio. */
class Link {
  readonly conn: ClientSideConnection;
  readonly child: ChildProcess;
  #stderr: string[] = [];
  #exit: Promise<number | null>;

  constructor(launch: Launch, cwd: string, client: Client) {
    this.child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        this.#stderr.push(line);
        if (this.#stderr.length > 30) this.#stderr.shift();
        if (process.env["ROSTER_ACP_LOG"] === "1") console.error(`[acp] ${line}`);
      }
    });
    this.#exit = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = new ClientSideConnection(() => client, stream);
  }

  get exited(): Promise<number | null> {
    return this.#exit;
  }

  /** The last thing the agent printed, which is the only explanation a dead process leaves. */
  tail(): string {
    return this.#stderr.slice(-5).join("\n");
  }

  close(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}

class AcpRuntime implements BotRuntime {
  readonly capabilities = ACP_CAPABILITIES;

  constructor(
    private launch: Launch,
    private label: string,
  ) {}

  #handlers = new Set<(e: NormalizedEvent) => void>();
  #link: Link | undefined;
  #sessionId: string | undefined;
  #options: SessionConfigOption[] = [];
  #modes: SessionModeState | null = null;
  #commands: AvailableCommand[] = [];
  /** the agent said at initialize that a prompt may carry image blocks */
  #images = false;
  #kinds = new Map<string, ToolKind>();
  #info: SessionInfo = {};
  #running = false;
  #aborting = false;
  /** history is being replayed by session/load; nothing in it is new */
  #replaying = false;
  #dead = false;
  /** the first prompt of a fresh session carries the bot's preset, since the protocol has no system prompt */
  #preset: string | undefined;
  #onToolCall: StartOpts["onToolCall"];
  #onPermission: StartOpts["onPermission"];

  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #emit(e: NormalizedEvent): void {
    for (const h of this.#handlers) h(e);
  }

  async start(opts: StartOpts): Promise<void> {
    if (this.#link) throw new Error("acp runtime already started");
    this.#onToolCall = opts.onToolCall;
    this.#onPermission = opts.onPermission;
    const link = new Link(this.launch, opts.cwd, this.#client());
    this.#link = link;
    void link.exited.then(() => {
      this.#dead = true;
      // every started turn must end, or the host waits on it forever
      if (this.#running) {
        this.#emit({ type: "error", display: "message", message: `${this.label} 进程退出了${link.tail() ? `：${link.tail()}` : ""}` });
        this.#end("error");
      }
    });
    try {
      const init = await link.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "roster", version: "0.1.0" },
      });
      this.#images = init.agentCapabilities?.promptCapabilities?.image === true;
      let session: { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null } | undefined;
      if (opts.resumeToken && init.agentCapabilities?.loadSession) {
        this.#replaying = true;
        try {
          session = await link.conn.loadSession({ sessionId: opts.resumeToken, cwd: opts.cwd, mcpServers: [] });
          this.#sessionId = opts.resumeToken;
        } catch {
          session = undefined;
        } finally {
          this.#replaying = false;
        }
      }
      if (!session) {
        const created = await link.conn.newSession({ cwd: opts.cwd, mcpServers: [] });
        this.#sessionId = created.sessionId;
        session = created;
        this.#preset = opts.systemPrompt?.trim() || undefined;
      }
      this.#options = session.configOptions ?? [];
      this.#modes = session.modes ?? null;
      await this.#apply({ model: opts.model, effort: opts.effort, mode: opts.mode, fast: opts.fast });
    } catch (err) {
      link.close();
      throw new Error(describe(err, this.label, link));
    }
    // a timer, because the host only starts listening once this call has returned
    setTimeout(() => this.#report(), 0);
  }

  #client(): Client {
    return {
      requestPermission: (p) => this.#permission(p),
      sessionUpdate: (n) => this.#update(n),
      extNotification: () => {},
    };
  }

  #update(n: SessionNotification): void {
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (this.#replaying) return;
        if (u.content.type === "text") this.#emit({ type: "assistant.text", display: "message", delta: u.content.text });
        return;
      case "agent_thought_chunk":
        if (this.#replaying) return;
        if (u.content.type === "text") this.#emit({ type: "assistant.thinking", display: "fold", delta: u.content.text });
        return;
      case "tool_call": {
        if (this.#replaying) return;
        if (u.kind) this.#kinds.set(u.toolCallId, u.kind);
        this.#emit({ type: "tool.start", display: "fold", call: this.#callOf(u) });
        if (u.status === "completed" || u.status === "failed") {
          this.#emit({ type: "tool.end", display: "fold", id: u.toolCallId, isError: u.status === "failed", content: textOf(u) });
        }
        return;
      }
      case "tool_call_update":
        if (this.#replaying) return;
        if (u.kind) this.#kinds.set(u.toolCallId, u.kind);
        if (u.status === "completed" || u.status === "failed") {
          this.#emit({ type: "tool.end", display: "fold", id: u.toolCallId, isError: u.status === "failed", content: textOf(u) });
        }
        return;
      case "usage_update": {
        const context: ContextUse = {
          used: u.used,
          max: u.size,
          percent: u.size > 0 ? Math.round((u.used / u.size) * 100) : 0,
        };
        this.#report({ context });
        if (u.cost) this.#emit({ type: "cost", display: "status", usd: u.cost.amount });
        return;
      }
      case "current_mode_update":
        if (this.#modes) this.#modes = { ...this.#modes, currentModeId: u.currentModeId };
        this.#report({ mode: u.currentModeId });
        return;
      case "config_option_update":
        this.#options = u.configOptions;
        this.#report();
        return;
      case "available_commands_update":
        this.#commands = u.availableCommands;
        this.#report();
        return;
      default:
        return;
    }
  }

  #callOf(u: ToolCallUpdate | (ToolCallUpdate & { title: string })): ToolCall {
    const kind = u.kind ?? this.#kinds.get(u.toolCallId) ?? "other";
    const input = u.rawInput && typeof u.rawInput === "object" ? (u.rawInput as Record<string, unknown>) : {};
    return { id: u.toolCallId, name: u.name ?? u.title ?? kind, input, effect: EFFECT_OF_KIND[kind] ?? "execute" };
  }

  /**
   * The one place the host gets a say. The gate runs first, for the tier and
   * the write lease; a deferred call goes to the human as the agent's own ask.
   */
  async #permission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const call = this.#callOf(p.toolCall);
    let decision: ToolDecision = (await this.#onToolCall?.(call)) ?? { action: "allow" };
    if (decision.action === "defer") {
      decision = (await this.#onPermission?.(call)) ?? { action: "deny", reason: "nobody to ask" };
    }
    const pick = (kinds: PermissionOptionKind[]) => p.options.find((o) => kinds.includes(o.kind));
    const option = decision.action === "allow" ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
    if (!option) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  async #apply(settings: SessionSettings): Promise<void> {
    const link = this.#link;
    const sessionId = this.#sessionId;
    if (!link || !sessionId) return;
    const select = async (category: string, value: string | undefined) => {
      const opt = byCategory(this.#options, category);
      if (!opt || value === undefined || !selectOptions(opt).some((o) => o.value === value)) return;
      const r = await link.conn.setSessionConfigOption({ sessionId, configId: opt.id, value });
      this.#options = r.configOptions;
    };
    await select("model", settings.model);
    await select("thought_level", settings.effort);
    if (settings.mode !== undefined) {
      if (byCategory(this.#options, "mode")) await select("mode", settings.mode);
      else if (this.#modes?.availableModes.some((m) => m.id === settings.mode)) {
        await link.conn.setSessionMode({ sessionId, modeId: settings.mode });
        this.#modes = { ...this.#modes, currentModeId: settings.mode };
      }
    }
    if (settings.fast !== undefined) {
      const opt = fastOption(this.#options);
      if (opt) {
        const r = await link.conn.setSessionConfigOption({ sessionId, configId: opt.id, type: "boolean", value: settings.fast });
        this.#options = r.configOptions;
      }
    }
  }

  /** Always emitted, even unchanged: the host dedupes itself. */
  #report(patch: Partial<SessionInfo> = {}): void {
    const context = patch.context ?? this.#info.context;
    this.#info = {
      ...infoOf(this.#options, this.#modes, {}),
      ...patch,
      ...(context ? { context } : {}),
      ...(this.#commands.length > 0 ? { commands: commandsOf(this.#commands) } : {}),
    };
    this.#emit({ type: "session.info", display: "status", info: this.#info });
  }

  async configure(settings: SessionSettings): Promise<void> {
    if (!this.#link || this.#dead) throw new Error(`${this.label}: no live session to switch`);
    await this.#apply(settings);
    this.#report();
  }

  async send(text: string, _deliver?: Deliver, attachments: readonly Attachment[] = []): Promise<void> {
    const link = this.#link;
    const sessionId = this.#sessionId;
    if (!link || !sessionId) throw new Error("acp runtime not started");
    if (this.#dead) throw new Error(`${this.label} 进程已经退出`);
    if (this.#running) throw new Error(`${this.label} 正在回复`);
    this.#running = true;
    this.#aborting = false;
    this.#emit({ type: "turn.start", display: "status" });
    const preset = this.#preset;
    this.#preset = undefined;
    const prompt: ContentBlock[] = [{ type: "text", text: preset ? `<preset>\n${preset}\n</preset>\n\n${text}` : text }];
    if (this.#images) {
      for (const a of attachments) {
        if (!IMAGE_TYPES.has(a.mime) || a.size > IMAGE_MAX_BYTES) continue;
        // a file gone since it was attached is still named in the text; the turn goes on without its pixels
        const data = await readFile(a.path).catch(() => null);
        if (data) prompt.push({ type: "image", mimeType: a.mime, data: data.toString("base64") });
      }
    }
    void link.conn
      .prompt({ sessionId, prompt })
      .then(
        (r) => this.#end(r.stopReason === "cancelled" || this.#aborting ? "aborted" : r.stopReason === "refusal" ? "error" : "done"),
        (err: unknown) => {
          if (!this.#running) return;
          this.#emit({ type: "error", display: "message", message: describe(err, this.label, link) });
          this.#end("error");
        },
      );
  }

  #end(reason: "done" | "aborted" | "error"): void {
    if (!this.#running) return;
    this.#running = false;
    this.#aborting = false;
    this.#emit({ type: "turn.end", display: "status", reason });
  }

  async abort(): Promise<void> {
    if (!this.#running || !this.#link || !this.#sessionId || this.#dead) return;
    this.#aborting = true;
    await this.#link.conn.cancel({ sessionId: this.#sessionId });
  }

  /** Agents expose compaction as a slash command; sending it runs as an ordinary turn. */
  async compact(): Promise<void> {
    if (!this.#commands.some((c) => c.name === "compact")) throw new Error(`${this.label} 没有提供压缩命令`);
    await this.send("/compact");
  }

  get resumeToken(): string | undefined {
    return this.#sessionId;
  }

  async dispose(): Promise<void> {
    const link = this.#link;
    this.#link = undefined;
    this.#handlers.clear();
    if (!link) return;
    link.close();
    // a process that ignores SIGTERM is not waited for
    await Promise.race([link.exited, new Promise((r) => setTimeout(r, 2_000))]);
  }
}

/** The message a person can act on, whatever shape the failure took. */
function describe(err: unknown, label: string, link?: Link): string {
  if (err instanceof RequestError && err.code === AUTH_REQUIRED) return `${label} 没有登录`;
  const message = err instanceof Error ? err.message : String(err);
  const tail = link?.tail();
  return tail && !message.includes(tail) ? `${message}\n${tail}` : message;
}

interface Snapshot {
  authMethods: AuthMethod[];
  /** what the agent said about its sign-in, when it says anything */
  auth: { ok: boolean; label?: string } | null;
  /** a session could be opened; false with authRequired means nobody is signed in */
  session: boolean;
  loggedOut: boolean;
  options: SessionConfigOption[];
  modes: SessionModeState | null;
  commands: AvailableCommand[];
  error?: string;
}

/**
 * The agent started only to be asked questions: what it offers and whether it
 * is signed in. A session is opened in a scratch directory and never prompted.
 */
async function probe(launch: Launch, label: string): Promise<Snapshot> {
  const snapshot: Snapshot = { authMethods: [], auth: null, session: false, loggedOut: false, options: [], modes: null, commands: [] };
  let resolveAuth: (() => void) | undefined;
  const authSeen = new Promise<void>((r) => (resolveAuth = r));
  const client: Client = {
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: (n) => {
      if (n.update.sessionUpdate === "available_commands_update") {
        snapshot.commands = n.update.availableCommands;
      } else if (n.update.sessionUpdate === "config_option_update") {
        snapshot.options = n.update.configOptions;
      }
    },
    extNotification: (method, params) => {
      if (method !== AUTH_STATUS_METHOD) return;
      snapshot.auth = authState((params as { authStatus?: unknown }).authStatus);
      resolveAuth?.();
    },
  };
  const link = new Link(launch, tmpdir(), client);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const init = await link.conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "roster", version: "0.1.0" },
        });
        snapshot.authMethods = init.authMethods ?? [];
        // the identity arrives on its own, shortly after initialize; a session is opened either way
        await Promise.race([authSeen, new Promise((r) => setTimeout(r, AUTH_STATUS_WAIT_MS))]);
        try {
          const session = await link.conn.newSession({ cwd: tmpdir(), mcpServers: [] });
          snapshot.session = true;
          snapshot.options = session.configOptions ?? [];
          snapshot.modes = session.modes ?? null;
          await new Promise((r) => setTimeout(r, COMMANDS_WAIT_MS));
        } catch (err) {
          if (err instanceof RequestError && err.code === AUTH_REQUIRED) snapshot.loggedOut = true;
          else snapshot.error = describe(err, label, link);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 没有在 ${PROBE_TIMEOUT_MS / 1000} 秒内回答`)), PROBE_TIMEOUT_MS);
      }),
      link.exited.then((code) => {
        throw new Error(`${label} 启动就退出了（${code ?? "signal"}）${link.tail() ? `：${link.tail()}` : ""}`);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    link.close();
  }
  return snapshot;
}

/** Sign-in methods a person can act on, from the agent's own list and the manifest's hint. */
function loginMethods(spec: AcpSpec, launch: Launch, methods: readonly AuthMethod[]): LoginMethod[] {
  const out: LoginMethod[] = [];
  const hint = spec.manifest.login?.terminal;
  if (hint && hint.length > 0) {
    out.push({ id: "terminal", label: "在终端登录", terminal: { command: hint[0]!, args: hint.slice(1) } });
  }
  for (const m of methods) {
    if ("type" in m && m.type === "terminal") {
      if (hint) continue;
      out.push({
        id: m.id,
        label: m.name,
        ...(m.description ? { description: m.description } : {}),
        terminal: { command: launch.program, args: [...launch.args, ...(m.args ?? [])] },
      });
    } else {
      out.push({ id: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) });
    }
  }
  return out;
}

function acpFactory(spec: AcpSpec, instance: InstanceConfig): BotRuntimeFactory {
  const { source } = instance;
  if (source.kind === "own" && !spec.own) throw new Error(`「${spec.label}」没有自带登录，要接一个模型 API`);
  if (source.kind === "endpoint" && !(source.endpoint.api && spec.manifest.env?.[source.endpoint.api])) {
    throw new Error(`「${source.endpoint.name}」接不到「${spec.label}」上：协议对不上`);
  }
  const launch = () => resolveLaunch(spec, instance.program, source);
  let snapshot: { at: number; value: Promise<Snapshot> } | null = null;
  let lastModes: Array<{ id: string; label: string }> = [];
  const snapshotOf = (maxAgeMs: number): Promise<Snapshot> => {
    if (snapshot && Date.now() - snapshot.at < maxAgeMs) return snapshot.value;
    const entry = { at: Date.now(), value: Promise.resolve().then(() => probe(launch(), instance.label)) };
    snapshot = entry;
    entry.value.then(
      (s) => {
        lastModes = optionsOf(s.options, s.modes, s.commands).modes;
      },
      () => {
        if (snapshot === entry) snapshot = null;
      },
    );
    return entry.value;
  };

  return {
    id: instance.id,
    type: spec.type,
    label: instance.label,
    capabilities: ACP_CAPABILITIES,
    create: () => new AcpRuntime(launch(), instance.label),
    async models(): Promise<ModelOption[]> {
      const s = await snapshotOf(SNAPSHOT_REUSE_MS);
      const model = byCategory(s.options, "model");
      return (model ? selectOptions(model) : []).map((o) => ({ id: o.value, label: o.name, available: !s.loggedOut }));
    },
    async sessionInfo(settings) {
      const s = await snapshotOf(SNAPSHOT_REUSE_MS);
      return infoOf(s.options, s.modes, settings);
    },
    async sessionOptions() {
      const s = await snapshotOf(SNAPSHOT_REUSE_MS);
      return optionsOf(s.options, s.modes, s.commands);
    },
    modeForTier: (tier) => modeForTier(lastModes, tier) ?? "default",
    async check() {
      const s = await snapshotOf(0).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }) as Snapshot);
      if (s.error) return { ok: false, detail: s.error };
      if (s.loggedOut) return { ok: false, detail: `${spec.label} 没有登录` };
      const models = byCategory(s.options, "model");
      return { ok: true, detail: `启动正常${models ? `，${selectOptions(models).length} 个模型可选` : ""}` };
    },
  };
}

/** An ACP agent as a harness type: the manifest says which agent, the protocol says the rest. */
export function acpHarness(spec: AcpSpec): HarnessType {
  return {
    type: spec.type,
    label: spec.label,
    sources: { own: spec.own, apis: Object.keys(spec.manifest.env ?? {}) },
    capabilities: () => ACP_CAPABILITIES,
    create: (instance) => acpFactory(spec, instance),
    // the sign-in is the program's, so it is asked afresh every time rather than cached with any executor
    async login(program): Promise<LoginState> {
      const launch = resolveLaunch(spec, program, { kind: "own" });
      const s = await probe(launch, spec.label);
      const methods = loginMethods(spec, launch, s.authMethods);
      if (s.error && !s.session) return { state: "unknown", detail: s.error, methods };
      const ok = s.auth ? s.auth.ok : !s.loggedOut;
      return { state: ok ? "ok" : "none", ...(s.auth?.label ? { account: s.auth.label } : {}), methods };
    },
    async authenticate(methodId, program) {
      const link = new Link(resolveLaunch(spec, program, { kind: "own" }), tmpdir(), {
        requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: () => {},
      });
      try {
        await link.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "roster", version: "0.1.0" } });
        await link.conn.authenticate({ methodId });
      } finally {
        link.close();
      }
    },
  };
}
