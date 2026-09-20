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
  type ClientCapabilities,
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
  EndpointVariables,
  HarnessType,
  InstanceConfig,
  LoginMethod,
  LoginState,
  ModelOption,
  ModelSource,
  NormalizedEvent,
  ProviderConfig,
  ProviderPreset,
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
import { locale, stored, t } from "./i18n/index.js";
import { isScript } from "./scripts.js";
import { CUSTOM_PRESET } from "./sources.js";

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

const capabilitiesOf = (manifest: AcpManifest): Capabilities =>
  manifest.permissionModes === false ? { ...ACP_CAPABILITIES, permissionModes: false } : ACP_CAPABILITIES;

const metaOf = (manifest: AcpManifest): { _meta?: Record<string, unknown> } =>
  manifest.sessionMeta ? { _meta: { ...manifest.sessionMeta } } : {};

/** How a manifest's command becomes a process. */
export interface AcpSpec {
  type: string;
  label: string;
  /** the extension's package directory: relative paths and package subpaths resolve against it */
  dir: string;
  manifest: AcpManifest;
  /** whether the agent's own sign-in counts as a model source */
  own: boolean;
  /** the presets the other harnesses report, for the ones this agent takes by id */
  presetCatalog?: () => Promise<ProviderPreset[]>;
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
/**
 * The host keeps files and terminals to itself. The terminal-auth flag is the
 * older convention by which an agent marks a sign-in as a command to run,
 * which the host shows rather than runs.
 */
const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { "terminal-auth": true },
};
/** JSON-RPC code an agent answers with when nobody is signed in */
const AUTH_REQUIRED = -32000;
/** what JSON-RPC calls a failure the agent did not name; the reason, if any, is in the error's data */
const BARE_INTERNAL_ERROR = "Internal error";
/** past this a detail is cut: one log line can carry a whole HTTP response body */
const DETAIL_MAX = 500;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Text an agent wrote for a terminal, as it reads in a message: no color codes, and not all of it. */
function readable(text: string): string {
  const plain = text.replace(ANSI_ESCAPE, "").trim();
  return plain.length > DETAIL_MAX ? `${plain.slice(0, DETAIL_MAX)}…` : plain;
}

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

/**
 * A "node" head runs on the host's own runtime, so a machine without node on
 * PATH still works. The program is the one the host settled on for this agent
 * type: it goes where the manifest says.
 */
function resolveLaunch(spec: AcpSpec, executable: string | undefined, source: ModelSource, preset?: ProviderPreset, model?: string): Launch {
  const req = createRequire(join(spec.dir, "package.json"));
  const program = executable?.trim() || undefined;
  const resolveItem = (item: string): string => {
    if (item === "node") return process.execPath;
    if (item === PROGRAM) {
      if (!program) throw new Error(t("error.acp.noProgram", { label: spec.label }));
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
  for (const [key, value] of Object.entries(spec.manifest.fixedEnv ?? {})) env[key] = typeof value === "string" ? value : JSON.stringify(value);
  if (items[0] === process.execPath && process.versions["electron"]) env["ELECTRON_RUN_AS_NODE"] = "1";
  if (program && spec.manifest.executable?.env) env[spec.manifest.executable.env] = program;

  const command = items[0] ?? "";
  const args = items.slice(1);
  const shown = program ?? (spec.manifest.command[0] === "node" ? (spec.manifest.command[1] ?? "") : (spec.manifest.command[0] ?? ""));
  if (source.kind === "endpoint") {
    const { endpoint } = source;
    const map = variablesFor(spec.manifest, endpoint, preset);
    if (map) {
      if (endpoint.apiKey) env[map.key] = endpoint.apiKey;
      const baseUrl = endpoint.baseUrl ?? preset?.baseUrl;
      if (map.baseUrl && baseUrl) env[map.baseUrl] = baseUrl;
      if (map.model && model) env[map.model] = model;
      Object.assign(env, map.set);
      args.push(...(map.args ?? []));
    }
  }
  return { command, args, env, program: shown };
}

/**
 * Where an endpoint's key and address go: by its preset when the manifest
 * names one, else by the protocol it speaks. A preset the manifest does not
 * name still goes in when the agent speaks that preset's protocol.
 */
function variablesFor(manifest: AcpManifest, endpoint: ProviderConfig, preset?: ProviderPreset): EndpointVariables | undefined {
  if (endpoint.preset === CUSTOM_PRESET) return endpoint.api ? manifest.env?.[endpoint.api] : undefined;
  return manifest.presets?.[endpoint.preset] ?? (preset ? manifest.env?.[preset.api] : undefined);
}

/** The text blocks of a call's content, which an agent may fill with the call's arguments or its own account of them. */
function textsOf(u: ToolCallUpdate): string[] {
  return (u.content ?? []).flatMap((c) => (c.type === "content" && c.content.type === "text" ? [c.content.text] : []));
}

/** The arguments of a call that carries no rawInput but spells them as one JSON object in its content. */
function argumentsIn(u: ToolCallUpdate): Record<string, unknown> | undefined {
  const texts = textsOf(u);
  const text = texts.length === 1 ? texts[0]!.trim() : "";
  if (!text.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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

/** The model a provider/model pair names, whether spelled with a slash or as a JSON pair. */
function pairedModel(value: string): string | undefined {
  if (!value.startsWith("[")) return value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : undefined;
  try {
    const pair = JSON.parse(value) as unknown;
    return Array.isArray(pair) && typeof pair.at(-1) === "string" ? (pair.at(-1) as string) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The option a model id picks. An endpoint lists bare ids, while an agent that
 * routes to several providers pairs each with its provider, so a bare id also
 * picks the one pair that names it.
 */
function modelValue(opt: SessionConfigOption, id: string): string | undefined {
  const values = selectOptions(opt).map((o) => o.value);
  if (values.includes(id)) return id;
  const paired = values.filter((v) => pairedModel(v) === id);
  return paired.length === 1 ? paired[0] : undefined;
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

/**
 * What an agent wrote in English for a person -- a mode, a command, a level --
 * said in Roster's language when the catalog knows it by the agent's type and
 * id. In English, and for anything unknown, the agent's own words stand.
 */
const say = (key: string, original: string): string => (locale() === "en" ? original : (stored(key) ?? original));

/** Codex describes each reasoning level in words of its own; the ones seen so far, by their text. */
const CODEX_EFFORT_DESCRIPTIONS: Record<string, string> = {
  "Fast responses with lighter reasoning": "acp.codex.effort.fast",
  "Balances speed with some reasoning": "acp.codex.effort.some",
  "Balances speed and reasoning depth for everyday tasks": "acp.codex.effort.everyday",
};

const commandsOf = (type: string, list: readonly AvailableCommand[]): SlashCommand[] =>
  list.map((c) => ({
    name: c.name,
    ...(c.description ? { description: say(`acp.${type}.command.${c.name}`, c.description) } : {}),
    ...(c.input?.hint ? { hint: c.input.hint } : {}),
  }));

function optionsOf(
  type: string,
  options: readonly SessionConfigOption[],
  modes: SessionModeState | null,
  commands: readonly AvailableCommand[],
): SessionOptions {
  const model = byCategory(options, "model");
  const effort = byCategory(options, "thought_level");
  const mode = byCategory(options, "mode");
  const efforts = effort ? selectOptions(effort) : [];
  const modeOf = (id: string, name: string, description: string | null | undefined) => ({
    id,
    label: say(`acp.${type}.mode.${id}`, name),
    ...(description ? { description: say(`acp.${type}.mode.${id}.description`, description) } : {}),
  });
  const modeList = mode
    ? selectOptions(mode).map((o) => modeOf(o.value, o.name, o.description))
    : (modes?.availableModes ?? []).map((m) => modeOf(m.id, m.name, m.description));
  const fast = fastOption(options);
  return {
    models: (model ? selectOptions(model) : []).map((o) => ({
      id: o.value,
      label: o.name,
      ...(o.description ? { description: o.description } : {}),
      efforts: efforts.map((e) => e.value),
      ...(fast ? { fast: true } : {}),
    })),
    efforts: efforts.map((e) => ({
      id: e.value,
      // levels go by the same ids everywhere; the name is only the id capitalised
      label: say(`effort.${e.value}`, e.name),
      ...(e.description ? { description: say(CODEX_EFFORT_DESCRIPTIONS[e.description] ?? "", e.description) } : {}),
    })),
    modes: modeList,
    ...(fast ? { fast: { available: true } } : {}),
    compact: commands.some((c) => c.name === "compact"),
    ...(commands.length > 0 ? { commands: commandsOf(type, commands) } : {}),
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
  /** a line still being written, which a pipe can hand over across any number of chunks */
  #partial = "";
  /** the exit code, or the error code of a program that never started */
  #exit: Promise<number | string | null>;

  constructor(launch: Launch, cwd: string, client: Client) {
    this.child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      const lines = (this.#partial + chunk).split("\n");
      // only a line's head is shown, so a huge line is not held whole; the slack leaves room for color codes
      this.#partial = (lines.pop() ?? "").slice(0, DETAIL_MAX * 4);
      for (const raw of lines) {
        const line = readable(raw);
        if (!line) continue;
        this.#stderr.push(line);
        if (this.#stderr.length > 30) this.#stderr.shift();
        if (process.env["ROSTER_ACP_LOG"] === "1") console.error(`[acp] ${line}`);
      }
    });
    this.#exit = new Promise((resolve) => {
      this.child.once("exit", (code) => resolve(code));
      // a program that cannot start reports only this, never an exit; left unheard, it takes the host down
      this.child.on("error", (err: NodeJS.ErrnoException) => {
        if (this.child.pid !== undefined) return;
        this.#stderr.push(readable(err.message));
        resolve(err.code ?? null);
      });
    });
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = new ClientSideConnection(() => client, stream);
  }

  get exited(): Promise<number | string | null> {
    return this.#exit;
  }

  /** The last thing the agent printed, which is the only explanation a dead process leaves. */
  tail(): string {
    const partial = readable(this.#partial);
    return [...this.#stderr, ...(partial ? [partial] : [])].slice(-5).join("\n");
  }

  close(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}

class AcpRuntime implements BotRuntime {
  readonly capabilities: Capabilities;

  constructor(
    /** the process for a session that runs this model, where the agent takes its model only when it starts */
    private launch: (model?: string) => Promise<Launch>,
    private label: string,
    /** the agent's manifest entry; its type is what its English is catalogued under */
    private spec: AcpSpec,
    /** whether the model went into the environment, in which case the session is not switched to it again */
    private modelInEnv: () => Promise<boolean> = async () => false,
  ) {
    this.capabilities = capabilitiesOf(spec.manifest);
  }

  #handlers = new Set<(e: NormalizedEvent) => void>();
  #link: Link | undefined;
  #sessionId: string | undefined;
  #options: SessionConfigOption[] = [];
  #modes: SessionModeState | null = null;
  #commands: AvailableCommand[] = [];
  /** the agent said at initialize that a prompt may carry image blocks */
  #images = false;
  /** what each open call is, as far as the agent has said: a permission ask may carry only the id */
  #calls = new Map<string, { title?: string; kind?: ToolKind; rawInput?: unknown }>();
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
    const link = new Link(await this.launch(opts.model), opts.cwd, this.#client());
    this.#link = link;
    void link.exited.then(() => {
      this.#dead = true;
      // every started turn must end, or the host waits on it forever
      if (this.#running) {
        const output = link.tail();
        const message = output ? t("error.acp.exitedWith", { label: this.label, output }) : t("error.acp.exited", { label: this.label });
        this.#emit({ type: "error", display: "message", message });
        this.#end("error");
      }
    });
    try {
      const init = await link.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: "roster", version: "0.1.0" },
      });
      this.#images = init.agentCapabilities?.promptCapabilities?.image === true;
      let session: { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null } | undefined;
      const caps = init.agentCapabilities;
      // resume restores a session without replaying its history, so it goes before load
      if (opts.resumeToken && caps?.sessionCapabilities?.resume) {
        try {
          session = await link.conn.resumeSession({ sessionId: opts.resumeToken, cwd: opts.cwd, mcpServers: [], ...metaOf(this.spec.manifest) });
          this.#sessionId = opts.resumeToken;
        } catch {
          session = undefined;
        }
      }
      if (!session && opts.resumeToken && caps?.loadSession) {
        this.#replaying = true;
        try {
          session = await link.conn.loadSession({ sessionId: opts.resumeToken, cwd: opts.cwd, mcpServers: [], ...metaOf(this.spec.manifest) });
          this.#sessionId = opts.resumeToken;
        } catch {
          session = undefined;
        } finally {
          this.#replaying = false;
        }
      }
      if (!session) {
        const created = await link.conn.newSession({ cwd: opts.cwd, mcpServers: [], ...metaOf(this.spec.manifest) });
        this.#sessionId = created.sessionId;
        session = created;
        this.#preset = opts.systemPrompt?.trim() || undefined;
      }
      this.#options = session.configOptions ?? [];
      this.#modes = session.modes ?? null;
      await this.#apply({
        ...((await this.modelInEnv()) ? {} : { model: opts.model }),
        effort: opts.effort,
        mode: opts.mode ?? this.spec.manifest.pinnedMode,
        fast: opts.fast,
      });
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
        this.#know(u);
        this.#emit({ type: "tool.start", display: "fold", call: this.#callOf(u) });
        if (u.status === "completed" || u.status === "failed") {
          this.#emit({ type: "tool.end", display: "fold", id: u.toolCallId, isError: u.status === "failed", content: textOf(u) });
          this.#calls.delete(u.toolCallId);
        }
        return;
      }
      case "tool_call_update":
        if (this.#replaying) return;
        this.#know(u);
        if (u.status === "completed" || u.status === "failed") {
          this.#emit({ type: "tool.end", display: "fold", id: u.toolCallId, isError: u.status === "failed", content: textOf(u) });
          this.#calls.delete(u.toolCallId);
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

  #know(u: ToolCallUpdate): void {
    const known = this.#calls.get(u.toolCallId);
    // a finished call's content is its output, not its arguments
    const settled = u.status === "completed" || u.status === "failed";
    const rawInput = u.rawInput ?? (known?.rawInput === undefined && !settled ? argumentsIn(u) : undefined);
    this.#calls.set(u.toolCallId, {
      ...known,
      ...(u.title ? { title: u.title } : {}),
      ...(u.kind ? { kind: u.kind } : {}),
      ...(rawInput !== undefined && rawInput !== null ? { rawInput } : {}),
    });
  }

  #callOf(u: ToolCallUpdate | (ToolCallUpdate & { title: string })): ToolCall {
    const known = this.#calls.get(u.toolCallId);
    const kind = u.kind ?? known?.kind ?? "other";
    const title = u.title ?? known?.title;
    const raw = u.rawInput ?? known?.rawInput;
    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    // an agent that calls every tool other says what each one does in its manifest
    const declared = kind === "other" && title ? this.spec.manifest.toolEffects?.[title] : undefined;
    return { id: u.toolCallId, name: u.name ?? title ?? kind, input, effect: declared ?? EFFECT_OF_KIND[kind] ?? "execute" };
  }

  /**
   * The one place the host gets a say. The gate runs first, for the tier and
   * the write lease; a deferred call goes to the human as the agent's own ask.
   */
  async #permission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // several one-time choices make it a question for a person, which has no card here yet: skip it, so the agent asks in words
    if (p.options.filter((o) => o.kind === "allow_once").length > 1) {
      const skip = p.options.find((o) => o.kind === "reject_once");
      return skip ? { outcome: { outcome: "selected", optionId: skip.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const said = textsOf(p.toolCall).join("\n\n").trim();
    const call = { ...this.#callOf(p.toolCall), ...(said ? { detail: said.slice(0, DETAIL_MAX * 4) } : {}) };
    let decision: ToolDecision = (await this.#onToolCall?.(call)) ?? { action: "allow" };
    if (decision.action === "defer") {
      decision = (await this.#onPermission?.(call)) ?? { action: "deny", reason: "nobody to ask" };
    }
    // a lasting answer would let the agent stop asking, and later calls like this one would never reach the gate
    const kind: PermissionOptionKind = decision.action === "allow" ? "allow_once" : "reject_once";
    const option = p.options.find((o) => o.kind === kind);
    if (!option) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  async #apply(settings: SessionSettings): Promise<void> {
    const link = this.#link;
    const sessionId = this.#sessionId;
    if (!link || !sessionId) return;
    const select = async (category: string, value: string | undefined) => {
      const opt = byCategory(this.#options, category);
      if (!opt || value === undefined) return;
      const picked = category === "model" ? modelValue(opt, value) : selectOptions(opt).find((o) => o.value === value)?.value;
      if (picked === undefined) return;
      const r = await link.conn.setSessionConfigOption({ sessionId, configId: opt.id, value: picked });
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
      ...(this.#commands.length > 0 ? { commands: commandsOf(this.spec.type, this.#commands) } : {}),
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
    if (this.#dead) throw new Error(t("error.acp.dead", { label: this.label }));
    if (this.#running) throw new Error(t("error.acp.busy", { label: this.label }));
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
    if (!this.#commands.some((c) => c.name === "compact")) throw new Error(t("error.acp.noCompact", { label: this.label }));
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

/**
 * The reason an agent put in a JSON-RPC error's data. TypeScript agents write
 * it under details and Rust ones under message, and either may pass an
 * upstream API's JSON error body on as a string.
 */
function reasonOf(data: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof data === "string") {
    const text = data.trim();
    if (!text.startsWith("{")) return text || undefined;
    try {
      return reasonOf(JSON.parse(text), depth + 1) ?? text;
    } catch {
      return text;
    }
  }
  if (!data || typeof data !== "object") return undefined;
  const fields = data as Record<string, unknown>;
  return reasonOf(fields["error"], depth + 1) ?? reasonOf(fields["message"], depth + 1) ?? reasonOf(fields["details"], depth + 1);
}

/** The message a person can act on, whatever shape the failure took. */
function describe(err: unknown, label: string, link?: Link): string {
  if (err instanceof RequestError && err.code === AUTH_REQUIRED) return t("error.acp.signedOut", { label });
  const message = err instanceof Error ? err.message : String(err);
  const reason = err instanceof RequestError ? reasonOf(err.data) : undefined;
  // the agent's own account wins over its log, which is mostly about other things
  if (reason) {
    const detail = readable(reason);
    if (message.includes(detail)) return message;
    return message === BARE_INTERNAL_ERROR ? detail : `${message}: ${detail}`;
  }
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
async function probe(launch: Launch, label: string, manifest: AcpManifest): Promise<Snapshot> {
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
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { name: "roster", version: "0.1.0" },
        });
        snapshot.authMethods = init.authMethods ?? [];
        // the identity arrives on its own, shortly after initialize; a session is opened either way
        await Promise.race([authSeen, new Promise((r) => setTimeout(r, AUTH_STATUS_WAIT_MS))]);
        try {
          const session = await link.conn.newSession({ cwd: tmpdir(), mcpServers: [], ...metaOf(manifest) });
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
        timer = setTimeout(() => reject(new Error(t("error.acp.timeout", { label, count: PROBE_TIMEOUT_MS / 1000 }))), PROBE_TIMEOUT_MS);
      }),
      link.exited.then((exit) => {
        const code = exit ?? "signal";
        const output = link.tail();
        throw new Error(output ? t("error.acp.exitedOnStartWith", { label, code, output }) : t("error.acp.exitedOnStart", { label, code }));
      }),
    ]);
  } finally {
    clearTimeout(timer);
    link.close();
  }
  return snapshot;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((a): a is string => typeof a === "string") : []);

/** The command a method names under the older terminal-auth convention, where it is otherwise an agent method. */
function terminalAuth(m: AuthMethod): { command: string; args: string[] } | null {
  const meta = m._meta?.["terminal-auth"];
  if (!meta || typeof meta !== "object") return null;
  const { command, args } = meta as { command?: unknown; args?: unknown };
  if (typeof command !== "string" || !command) return null;
  return { command, args: strings(args) };
}

/** Sign-in methods a person can act on, from the agent's own list and the manifest's hint. */
function loginMethods(spec: AcpSpec, launch: Launch, methods: readonly AuthMethod[]): LoginMethod[] {
  const out: LoginMethod[] = [];
  const hint = spec.manifest.login?.terminal;
  if (hint && hint.length > 0) {
    out.push({ id: "terminal", label: t("login.terminal"), terminal: { command: hint[0]!, args: hint.slice(1) } });
  }
  for (const m of methods) {
    const byMeta = terminalAuth(m);
    // some agents keep the whole terminal method inside _meta, where the protocol's own field would say the same
    const meta = (m._meta ?? {}) as { type?: unknown; args?: unknown };
    if (("type" in m && m.type === "terminal") || meta.type === "terminal" || byMeta) {
      if (hint) continue;
      const extra = "args" in m && m.args ? m.args : strings(meta.args);
      out.push({
        id: m.id,
        label: m.name,
        ...(m.description ? { description: m.description } : {}),
        terminal: byMeta ?? { command: launch.program, args: [...launch.args, ...extra] },
      });
    } else {
      out.push({ id: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) });
    }
  }
  return out;
}

function acpFactory(spec: AcpSpec, instance: InstanceConfig): BotRuntimeFactory {
  const { source } = instance;
  if (source.kind === "own" && !spec.own) throw new Error(t("error.source.noOwn", { label: spec.label }));
  // a preset endpoint carries only its id; the address comes from the catalog, looked up when the agent starts
  const presetOf = async (): Promise<ProviderPreset | undefined> => {
    if (source.kind !== "endpoint" || source.endpoint.preset === CUSTOM_PRESET) return undefined;
    return (await spec.presetCatalog?.())?.find((p) => p.id === source.endpoint.preset);
  };
  // which variables an endpoint goes into can rest on its preset's protocol, and only the catalog knows that
  let variables: Promise<EndpointVariables | undefined> | null = null;
  const variablesOf = (): Promise<EndpointVariables | undefined> =>
    (variables ??= (async () => {
      if (source.kind !== "endpoint") return undefined;
      const map = variablesFor(spec.manifest, source.endpoint, await presetOf());
      if (!map) throw new Error(t("error.source.mismatch", { endpoint: source.endpoint.name, label: spec.label }));
      return map;
    })());
  // with nobody's pick yet, as when the agent is only asked what it offers, the endpoint's first model stands in
  const fallbackModel = source.kind === "endpoint" ? source.endpoint.models?.[0] : undefined;
  const launch = async (model?: string) => {
    await variablesOf();
    return resolveLaunch(spec, instance.program, source, await presetOf(), model ?? fallbackModel);
  };
  let snapshot: { at: number; value: Promise<Snapshot> } | null = null;
  let lastModes: Array<{ id: string; label: string }> = [];
  const snapshotOf = (maxAgeMs: number): Promise<Snapshot> => {
    if (snapshot && Date.now() - snapshot.at < maxAgeMs) return snapshot.value;
    const entry = { at: Date.now(), value: Promise.resolve().then(async () => probe(await launch(), instance.label, spec.manifest)) };
    snapshot = entry;
    entry.value.then(
      (s) => {
        lastModes = optionsOf(spec.type, s.options, s.modes, s.commands).modes;
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
    capabilities: capabilitiesOf(spec.manifest),
    create: () => new AcpRuntime(launch, instance.label, spec, async () => Boolean((await variablesOf())?.model)),
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
      return optionsOf(spec.type, s.options, s.modes, s.commands);
    },
    modeForTier: (tier) => modeForTier(lastModes, tier) ?? "default",
    async check() {
      const s = await snapshotOf(0).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }) as Snapshot);
      if (s.error) return { ok: false, detail: s.error };
      if (s.loggedOut) return { ok: false, detail: t("error.acp.signedOut", { label: spec.label }) };
      const models = byCategory(s.options, "model");
      return { ok: true, detail: models ? t("check.acp.okModels", { count: selectOptions(models).length }) : t("check.acp.ok") };
    },
  };
}

/** An ACP agent as a harness type: the manifest says which agent, the protocol says the rest. */
export function acpHarness(spec: AcpSpec): HarnessType {
  const named = Object.keys(spec.manifest.presets ?? {});
  const spoken = Object.keys(spec.manifest.env ?? {});
  const signIn: Pick<HarnessType, "login" | "authenticate"> = {
    // the sign-in is the program's, so it is asked afresh every time rather than cached with any executor
    async login(program): Promise<LoginState> {
      const launch = resolveLaunch(spec, program, { kind: "own" });
      const s = await probe(launch, spec.label, spec.manifest);
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
        await link.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: CLIENT_CAPABILITIES, clientInfo: { name: "roster", version: "0.1.0" } });
        await link.conn.authenticate({ methodId });
      } finally {
        link.close();
      }
    },
  };
  return {
    type: spec.type,
    label: spec.label,
    sources: { own: spec.own, apis: spoken },
    capabilities: () => capabilitiesOf(spec.manifest),
    ...(named.length > 0 || spoken.length > 0
      ? {
          async presets() {
            const catalog = (await spec.presetCatalog?.()) ?? [];
            return catalog.filter((p) => named.includes(p.id) || spoken.includes(p.api));
          },
        }
      : {}),
    create: (instance) => acpFactory(spec, instance),
    ...(spec.own ? signIn : {}),
  };
}
