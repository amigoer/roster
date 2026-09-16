import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  query,
  type EffortLevel,
  type HookInput,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PreToolUseHookInput,
  type Query,
  type SDKMessage,
  type SlashCommand as SdkCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Attachment,
  BotRuntime,
  BotRuntimeFactory,
  Capabilities,
  ContextDetail,
  Deliver,
  HarnessType,
  InstanceConfig,
  LoginState,
  ModelOption,
  ModelSource,
  NormalizedEvent,
  Quota,
  SessionInfo,
  SessionOptions,
  SessionSettings,
  SlashCommand,
  StartOpts,
  ToolCall,
  ToolEffect,
  Unsubscribe,
} from "@roster/adapter-api";
import { contextOf, detailOf } from "./context.js";
import { listModels, modelLabel, wireModel } from "./models.js";
import { planUsage, planUsageFromCredentials } from "./plan.js";
import { resultText } from "./result.js";
import { wordsFor, type Words } from "./words.js";

/** Formats every Claude model reads as an image; anything else stays a path in the text. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The API refuses an image whose base64 passes 5 MB, which is about this many raw bytes. */
const IMAGE_MAX_BYTES = 3_750_000;

/** The images among a turn's attachments, as content blocks. A file gone since it was attached is still named in the text. */
async function imageBlocks(attachments: readonly Attachment[]) {
  const blocks = [];
  for (const a of attachments) {
    if (!IMAGE_TYPES.has(a.mime) || a.size > IMAGE_MAX_BYTES) continue;
    const data = await readFile(a.path).catch(() => null);
    if (!data) continue;
    blocks.push({
      type: "image" as const,
      source: { type: "base64" as const, media_type: a.mime as "image/png", data: data.toString("base64") },
    });
  }
  return blocks;
}

const commandsOf = (list: readonly SdkCommand[]): SlashCommand[] =>
  list.map((c) => ({ name: c.name, ...(c.description ? { description: c.description } : {}), ...(c.argumentHint ? { hint: c.argumentHint } : {}) }));

/**
 * Claude Code driven through the Claude Agent SDK, on an Anthropic-compatible
 * endpoint or on the machine's own sign-in: the channel with the PreToolUse
 * gate, context accounting, plan limits and effort control. The sign-in stays
 * the CLI's to use; Roster only reads its token when the CLI is too old to
 * report plan limits itself.
 */

/** The preset id of an endpoint a person described by hand. */
const CUSTOM_PRESET = "custom";

const ANTHROPIC_PRESET = "anthropic";

/**
 * Claude Code's built-in tool names. Anything unrecognised comes from MCP or a
 * plugin and is treated as the worst case.
 */
const EFFECTS: Record<string, ToolEffect> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  WebFetch: "read",
  WebSearch: "read",
  NotebookRead: "read",
  TodoWrite: "read",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Bash: "execute",
  BashOutput: "execute",
  KillShell: "execute",
};

const effectOf = (name: string): ToolEffect => EFFECTS[name] ?? "execute";

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID") continue;
    out[k] = v;
  }
  return out;
}

/** How a CLI of this executor is started: which binary, and with which environment. */
interface Launch {
  env: Record<string, string>;
  executable?: string;
  /** on the machine's own sign-in rather than an endpoint */
  own: boolean;
}

/**
 * Every inherited ANTHROPIC_* goes first: one left over from the host would
 * otherwise quietly win over the endpoint the executor names, or over the
 * sign-in when it names none.
 */
function launchOf(program: string | undefined, source: ModelSource): Launch {
  const env = cleanEnv();
  const executable = program?.trim();
  for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_")) delete env[key];
  if (source.kind === "endpoint") {
    const { endpoint } = source;
    if (endpoint.baseUrl) env["ANTHROPIC_BASE_URL"] = endpoint.baseUrl;
    // the official API authenticates with x-api-key; gateways and compatible endpoints take a bearer token
    if (endpoint.apiKey) env[endpoint.preset === CUSTOM_PRESET ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = endpoint.apiKey;
    // Claude Code reaches for Haiku, Sonnet and Opus by name on its own; another endpoint has none of them
    const first = endpoint.models?.[0];
    if (first) for (const tier of ["HAIKU", "SONNET", "OPUS"]) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = first;
  }
  return { env, ...(executable ? { executable } : {}), own: source.kind === "own" };
}

const START_MODE: PermissionMode = "default";

/**
 * Claude Code's own titles for its modes, in the order its picker cycles them.
 * dontAsk is left out: it only ever denies. A tier names the mode that grants
 * the same, so a bot's tier still picks where a new session starts.
 */
const MODES: Array<{ id: PermissionMode; label: string; tier?: ToolEffect }> = [
  { id: "default", label: "Manual", tier: "read" },
  { id: "acceptEdits", label: "Accept edits", tier: "write" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "bypassPermissions", label: "Bypass Permissions", tier: "execute" },
];

/** As Claude Code's model picker spells them. */
const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };

/**
 * Claude Code offers ultracode as one more effort: xhigh plus standing workflow
 * orchestration. It is a session setting rather than an effort level, and only
 * exists where the account has dynamic workflows and the model takes xhigh.
 */
const ULTRACODE = "ultracode";

const isMode = (v: unknown): v is PermissionMode => MODES.some((m) => m.id === v);
const isEffort = (v: unknown): v is EffortLevel => typeof v === "string" && Object.hasOwn(EFFORT_LABEL, v);
const isFastState = (v: unknown): v is "on" | "off" | "cooldown" => v === "on" || v === "off" || v === "cooldown";

/** What a model's effort picker lists: its own levels, then ultracode wherever xhigh is one of them. */
function effortsOf(m: ModelInfo, ultracode: boolean): string[] {
  const levels = m.supportsEffort ? (m.supportedEffortLevels ?? []) : [];
  return ultracode && levels.includes("xhigh") ? [...levels, ULTRACODE] : levels;
}

/** ultracode is true only while it is in effect: a model without xhigh suspends it until the session is back on one */
type Applied = { model?: string; effort?: string | null; ultracode?: boolean };

/**
 * The CLI's own answer to what its next request will use. getSettings exists on
 * the query object but not yet in the SDK's typed surface, hence the check.
 */
async function readApplied(q: Query): Promise<Applied | null> {
  const getSettings = (q as unknown as { getSettings?: () => Promise<{ applied?: Applied }> }).getSettings;
  if (typeof getSettings !== "function") return null;
  return (await getSettings.call(q)).applied ?? null;
}

const effortOf = (a: Applied): string | null => (a.ultracode ? ULTRACODE : (a.effort ?? null));

export const CLAUDE_CAPABILITIES: Capabilities = {
  interceptToolCall: true,
  // PermissionResult's allow branch carries updatedInput, so arguments really
  // can be rewritten -- not approve/deny only
  mutateToolInput: true,
  // streaming input is consumed between turns; there is no true mid-generation steer
  midRunInject: ["followUp"],
  costLimit: true,
  mcp: true,
  branch: true,
  permissionModes: true,
};

/** A queue the SDK pulls from, so one query() spans the whole conversation. */
class Inbox implements AsyncIterable<never> {
  #queue: unknown[] = [];
  #waiting: ((v: IteratorResult<never>) => void) | undefined;
  #closed = false;

  push(value: unknown): void {
    if (this.#closed) return;
    const w = this.#waiting;
    if (w) {
      this.#waiting = undefined;
      w({ value: value as never, done: false });
      return;
    }
    this.#queue.push(value);
  }

  close(): void {
    this.#closed = true;
    this.#waiting?.({ value: undefined as never, done: true });
    this.#waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<never> {
    return {
      next: () => {
        const v = this.#queue.shift();
        if (v !== undefined) return Promise.resolve({ value: v as never, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<never>>((resolve) => (this.#waiting = resolve));
      },
    };
  }
}

/**
 * A CLI whose stdin has closed exits in well under a second; one still up after
 * this is stuck. Closing it takes up to 2s more, which the SDK waits out.
 */
const EXIT_GRACE_MS = 2_000;

/** Whether the promise settles within ms; it keeps running either way. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  return Promise.race([p.then(() => true, () => true), late]).finally(() => clearTimeout(timer));
}

class ClaudeRuntime implements BotRuntime {
  readonly capabilities = CLAUDE_CAPABILITIES;

  constructor(
    private launch: Launch,
    private words: Words,
  ) {}

  #inbox = new Inbox();
  #query: Query | undefined;
  #handlers = new Set<(e: NormalizedEvent) => void>();
  #pump: Promise<void> | undefined;
  #sessionId: string | undefined;
  /** sends not yet answered by a result message */
  #inFlight = 0;
  #aborting = false;
  /** the CLI process is gone; nothing reads the inbox any more */
  #dead = false;
  #info: SessionInfo = {};

  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #emit(e: NormalizedEvent): void {
    for (const h of this.#handlers) h(e);
  }

  async start(opts: StartOpts): Promise<void> {
    if (this.#query) throw new Error("claude runtime already started");
    const { onToolCall, onPermission } = opts;
    const mode = isMode(opts.mode) ? opts.mode : START_MODE;
    // nothing is listening until start returns, and init only arrives with the
    // first turn -- so hold the mode we are starting in, or a report that comes
    // before then (a switch, say) would leave it out of the picture
    this.#info = { mode };
    const settings = {
      // an SDK session has to opt into fast mode through settings; the account can still refuse it
      ...(opts.fast !== undefined ? { fastMode: opts.fast } : {}),
      // brings xhigh with it
      ...(opts.effort === ULTRACODE ? { ultracode: true } : {}),
    };

    const options: Options = {
      cwd: opts.cwd,
      // deltas are what make the reply feel live; the log stores only the final text
      includePartialMessages: true,
      // an SDK session gets its thinking omitted, blocks with no words; this asks for the summary
      // without pinning --thinking, so whether and how much to think stays the CLI's call
      extraArgs: { "thinking-display": "summarized" },
      // On an endpoint, isolation mode. Without it the SDK loads the user's own
      // ~/.claude/settings.json, whose pre-approved tools never reach
      // canUseTool -- a session in Manual would silently run Bash because the
      // human allowed it in their CLI months ago -- and whose env can point the
      // CLI somewhere other than the endpoint. Cost: CLAUDE.md is not loaded
      // either (it rides on the 'project' source), which is the deliberate trade.
      // On the machine's own sign-in it is the person's Claude Code, so it runs
      // with their CLAUDE.md, MCP servers and skills, as the CLI itself would;
      // PreToolUse still sees every call, and only what the gate defers meets
      // their allow rules.
      settingSources: this.launch.own ? ["user", "project", "local"] : [],
      permissionMode: mode,
      // only makes Bypass Permissions selectable later, as Claude Code's own picker allows
      allowDangerouslySkipPermissions: true,
      ...(isEffort(opts.effort) ? { effort: opts.effort } : {}),
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      // The CLI is a child process and inherits our environment. If Roster itself
      // was launched from inside a Claude Code session, the child sees that
      // session's messaging socket and treats itself as its child -- permission
      // prompts then route to that host instead of to canUseTool, and the tier
      // is silently bypassed. Always hand it a clean, standalone environment.
      env: this.launch.env,
      ...(this.launch.executable ? { pathToClaudeCodeExecutable: this.launch.executable } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      // The SDK's own default is a bare prompt without Claude Code's tool
      // guidance; the preset keeps that and the bot's preset rides on top.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(opts.systemPrompt?.trim() ? { append: opts.systemPrompt.trim() } : {}),
      },
      ...(opts.resumeToken ? { resume: opts.resumeToken } : {}),
      ...(opts.budget?.maxTurns ? { maxTurns: opts.budget.maxTurns } : {}),
      ...(opts.budget?.maxUsd ? { maxBudgetUsd: opts.budget.maxUsd } : {}),
      // The host's gate is PreToolUse, not canUseTool. canUseTool is only the
      // *prompt* surface: Manual prompts for what the CLI itself deems dangerous,
      // so `echo hi` never reaches it. PreToolUse fires for every tool call and
      // carries the real tool_use_id; a call the host defers goes on to the
      // session's mode, whose prompts arrive at canUseTool.
      ...(onPermission
        ? {
            canUseTool: async (toolName: string, input: Record<string, unknown>, o: { toolUseID: string }) => {
              const decision = await onPermission({ id: o.toolUseID, name: toolName, input, effect: effectOf(toolName) });
              return decision.action === "allow"
                ? { behavior: "allow" as const, updatedInput: decision.input ?? input }
                : { behavior: "deny" as const, message: decision.action === "deny" ? decision.reason : "Not allowed." };
            },
          }
        : {}),
      ...(onToolCall
        ? {
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    async (input: HookInput, toolUseID: string | undefined) => {
                      const pre = input as PreToolUseHookInput;
                      if (pre.hook_event_name !== "PreToolUse") return {};
                      const call: ToolCall = {
                        id: toolUseID ?? pre.tool_use_id,
                        name: pre.tool_name,
                        input: (pre.tool_input ?? {}) as Record<string, unknown>,
                        effect: effectOf(pre.tool_name),
                      };
                      this.#emit({ type: "tool.start", display: "fold", call });
                      // no deadline here either -- a human may take as long as they like
                      const decision = await onToolCall(call);
                      // no decision: the session's mode takes it from here
                      if (decision.action === "defer") return {};
                      return {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse" as const,
                          permissionDecision:
                            decision.action === "deny" ? ("deny" as const) : ("allow" as const),
                          ...(decision.action === "deny"
                            ? { permissionDecisionReason: decision.reason }
                            : {}),
                          ...(decision.action === "allow" && decision.input
                            ? { updatedInput: decision.input }
                            : {}),
                        },
                      };
                    },
                  ],
                },
              ],
            },
          }
        : {}),
    };

    this.#query = query({ prompt: this.#inbox as AsyncIterable<never>, options });
    this.#pump = this.#drain();
    // a timer, because the host only starts listening once this call has returned
    setTimeout(() => void this.#introduce(), 0);
  }

  /**
   * What the session runs with before it has said anything. Its init only comes
   * with the first turn, and a session switched or looked at before then would
   * otherwise show up half-known.
   */
  async #introduce(): Promise<void> {
    const q = this.#query;
    if (!q || this.#dead) return;
    const a = await readApplied(q).catch(() => null);
    if (a) {
      this.#report({
        ...(a.model ? { model: a.model, modelLabel: modelLabel(a.model) } : {}),
        ...("effort" in a ? { effort: effortOf(a) } : {}),
      });
    }
    const commands = await q.supportedCommands().catch(() => null);
    if (commands) this.#report({ commands: commandsOf(commands) });
    // a resumed session is already full before the first turn
    await this.#readContext();
  }

  async #drain(): Promise<void> {
    const q = this.#query;
    if (!q) return;
    try {
      for await (const msg of q as AsyncGenerator<SDKMessage, void>) {
        this.#normalize(msg);
      }
    } catch (err) {
      this.#emit({
        type: "error",
        display: "message",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#dead = true;
      // every started turn must end, or the host waits on it forever
      for (; this.#inFlight > 0; this.#inFlight--) {
        this.#emit({ type: "turn.end", display: "status", reason: "error" });
      }
    }
  }

  #normalize(msg: SDKMessage): void {
    const m = msg as unknown as Record<string, any>;
    switch (m["type"]) {
      case "system":
        if (m["subtype"] === "init") {
          // the init message carries the session id that makes resume possible
          if (typeof m["session_id"] === "string") this.#sessionId = m["session_id"];
          this.#onInit(m);
        } else if (m["subtype"] === "status" && typeof m["permissionMode"] === "string") {
          // the mode can change mid-session, e.g. when the model enters plan mode
          this.#report({ mode: m["permissionMode"] });
        } else if (m["subtype"] === "commands_changed" && Array.isArray(m["commands"])) {
          // skills found as the agent works; the push is the whole list, not a patch
          this.#report({ commands: commandsOf(m["commands"] as SdkCommand[]) });
        }
        return;

      case "stream_event": {
        // text lives here only; emitting it again from the assistant message would double it
        const ev = m["event"] as Record<string, any> | undefined;
        if (ev?.["type"] !== "content_block_delta") return;
        const d = ev["delta"] as Record<string, any> | undefined;
        if (d?.["type"] === "text_delta" && typeof d["text"] === "string") {
          this.#emit({ type: "assistant.text", display: "message", delta: d["text"] });
        } else if (d?.["type"] === "thinking_delta" && typeof d["thinking"] === "string") {
          this.#emit({ type: "assistant.thinking", display: "fold", delta: d["thinking"] });
        }
        return;
      }

      case "user": {
        const content = (m["message"] as Record<string, any> | undefined)?.["content"];
        if (!Array.isArray(content)) return;
        for (const block of content as Array<Record<string, any>>) {
          if (block["type"] !== "tool_result") continue;
          this.#emit({
            type: "tool.end",
            display: "fold",
            id: String(block["tool_use_id"] ?? ""),
            isError: block["is_error"] === true,
            content: resultText(block["content"]),
          });
        }
        return;
      }

      case "result": {
        const usage = m["usage"] as Record<string, any> | undefined;
        if (typeof m["total_cost_usd"] === "number" || usage) {
          this.#emit({
            type: "cost",
            display: "status",
            ...(typeof m["total_cost_usd"] === "number" ? { usd: m["total_cost_usd"] } : {}),
            ...(typeof usage?.["input_tokens"] === "number"
              ? { inputTokens: usage["input_tokens"] }
              : {}),
            ...(typeof usage?.["output_tokens"] === "number"
              ? { outputTokens: usage["output_tokens"] }
              : {}),
          });
        }
        if (this.#inFlight > 0) this.#inFlight--;
        const reason = this.#aborting ? "aborted" : m["subtype"] === "success" ? "done" : "error";
        if (this.#inFlight === 0) this.#aborting = false;
        this.#emit({ type: "turn.end", display: "status", reason });
        if (isFastState(m["fast_mode_state"])) this.#report({ fast: m["fast_mode_state"] });
        void this.#readContext();
        return;
      }

      default:
        return;
    }
  }

  /** Each turn's init restates what the session runs with. */
  #onInit(m: Record<string, any>): void {
    const reported = typeof m["model"] === "string" ? m["model"] : undefined;
    // an init names the model as the API does, so a session on a longer context would drop back to the shorter name
    const known = this.#info.model;
    const model = reported && known && wireModel(known) === reported ? known : reported;
    const patch: SessionInfo = {
      ...(model ? { model, modelLabel: modelLabel(model) } : {}),
      ...(typeof m["permissionMode"] === "string" ? { mode: m["permissionMode"] } : {}),
      // an init names only the level, and under ultracode that level is its xhigh
      ...("effort" in m
        ? { effort: m["effort"] === "xhigh" && this.#info.effort === ULTRACODE ? ULTRACODE : (m["effort"] ?? null) }
        : {}),
      ...(isFastState(m["fast_mode_state"]) ? { fast: m["fast_mode_state"] } : {}),
    };
    const q = this.#query;
    if ("effort" in m || "effort" in this.#info || !q) return this.#report(patch);
    // SDK sessions leave effort out of init; ask once, and report together so the effort does not blink in
    void readApplied(q)
      .then((a) => this.#report({ ...patch, ...(a && "effort" in a ? { effort: effortOf(a) } : {}) }))
      .catch(() => this.#report(patch));
  }

  /** Always emitted, even unchanged: the host drops events that race its own bookkeeping, and dedupes itself. */
  #report(patch: SessionInfo): void {
    this.#info = { ...this.#info, ...patch };
    this.#emit({ type: "session.info", display: "status", info: this.#info });
  }

  /** The window fills with every turn and its size follows the model, so this is re-read after both. */
  async #readContext(): Promise<void> {
    const q = this.#query;
    if (!q || this.#dead) return;
    const c = await q.getContextUsage({ detail: "summary" }).catch(() => null);
    if (c) this.#report({ context: contextOf(c, this.words) });
  }

  /** Counts every category with the token-count API, which the per-turn summary only estimates. */
  async contextDetail(): Promise<ContextDetail> {
    const q = this.#query;
    if (!q || this.#dead) throw new Error("claude: no live session to read");
    const c = await q.getContextUsage({ detail: "full" });
    const detail = detailOf(c, this.words);
    // the fresher count is what the ring and the card should show from now on
    this.#report({ context: contextOf(c, this.words) });
    return detail;
  }

  /** The account's plan limits, read through the live session; an endpoint has none. */
  async quota(): Promise<Quota | null> {
    const q = this.#query;
    if (!this.launch.own || !q || this.#dead) return null;
    return planUsage(q);
  }

  /** Claude Code compacts on its own slash command; it runs as an ordinary turn and says nothing back. */
  async compact(): Promise<void> {
    await this.send("/compact");
  }

  async configure(settings: SessionSettings): Promise<void> {
    const q = this.#query;
    if (!q || this.#dead) throw new Error("claude: no live session to switch");
    if (settings.mode !== undefined) {
      if (!isMode(settings.mode)) throw new Error(`claude: unknown permission mode ${settings.mode}`);
      await q.setPermissionMode(settings.mode);
      this.#report({ mode: settings.mode });
    }
    if (settings.effort !== undefined && !isEffort(settings.effort) && settings.effort !== ULTRACODE) {
      throw new Error(`claude: unknown effort ${settings.effort}`);
    }
    if (settings.model !== undefined) await q.setModel(settings.model);
    // an effort level ends ultracode by itself
    if (settings.effort === ULTRACODE) await q.applyFlagSettings({ ultracode: true });
    else if (isEffort(settings.effort)) await q.applyFlagSettings({ effortLevel: settings.effort });
    if (settings.fast !== undefined) {
      await q.applyFlagSettings({ fastMode: settings.fast });
      // whether it actually runs fast is only known from the next turn's init
      this.#report({ fast: settings.fast ? "on" : "off" });
    }
    if (settings.model === undefined && settings.effort === undefined && settings.fast === undefined) return;
    // a model without effort downgrades it silently, and fast mode can promote the model; ask what actually applies
    const a = await readApplied(q).catch(() => null);
    if (a) {
      this.#report({
        ...(a.model ? { model: a.model, modelLabel: modelLabel(a.model) } : {}),
        ...("effort" in a ? { effort: effortOf(a) } : {}),
      });
    }
    if (settings.model !== undefined) await this.#readContext();
  }

  async send(text: string, _deliver: Deliver = "now", attachments: readonly Attachment[] = []): Promise<void> {
    if (!this.#query) throw new Error("claude runtime not started");
    if (this.#dead) throw new Error("claude: the Claude Code process has exited");
    const images = await imageBlocks(attachments);
    this.#inFlight++;
    this.#emit({ type: "turn.start", display: "status" });
    this.#inbox.push({
      type: "user",
      message: { role: "user", content: images.length > 0 ? [{ type: "text", text }, ...images] : text },
      parent_tool_use_id: null,
      session_id: this.#sessionId ?? "",
    });
  }

  async abort(): Promise<void> {
    if (this.#inFlight === 0 || this.#dead) return;
    this.#aborting = true;
    await this.#query?.interrupt();
  }

  get resumeToken(): string | undefined {
    return this.#sessionId;
  }

  async dispose(): Promise<void> {
    const q = this.#query;
    const pump = this.#pump;
    // The interrupt goes out before stdin closes, as later writes are dropped, and
    // is not awaited, as a stuck CLI never answers. It also stops background
    // tasks, which would otherwise keep the CLI up for seconds after EOF.
    if (q && !this.#dead) void q.interrupt().catch(() => {});
    this.#inbox.close();
    // a CLI still up is closed: the SDK stops reading it and terminates the process
    if (q && pump && !(await settlesWithin(pump, EXIT_GRACE_MS))) q.close();
    await pump?.catch(() => {});
    this.#query = undefined;
    this.#handlers.clear();
  }
}

type Account = { email?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string };

interface Snapshot {
  catalog: ModelInfo[];
  /** what a session started with no model resolves to */
  applied: Applied | null;
  fast: { available: boolean; reason?: string } | undefined;
  /** whether a session on an xhigh model could turn ultracode on */
  ultracode: boolean;
  /** how the CLI authenticates: the endpoint's key, or the machine's sign-in and its plan */
  account: Account | null;
  commands: SdkCommand[];
}

/** A CLI with nobody signed in still starts; it just has nothing to say about who is using it. */
const signedIn = (a: Account | null): boolean => Boolean(a && (a.email || a.subscriptionType || a.tokenSource || a.apiKeySource));

/**
 * Fast mode has two gates: an SDK session must opt in through settings, and the
 * account may still refuse -- a plan without extra usage, say. Only asking with
 * the opt-in set shows the second one. This switches the probe's model, so it
 * has to run after anything that reads the default.
 */
async function readFast(q: Query, catalog: ModelInfo[]): Promise<Snapshot["fast"]> {
  const row = catalog.find((m) => m.supportsFastMode);
  if (!row) return { available: false, reason: "model_not_allowed" };
  await q.setModel(row.value);
  await q.applyFlagSettings({ fastMode: true });
  const reason = (await q.reinitialize()).fast_mode_disabled_reason;
  return reason ? { available: false, reason } : { available: true };
}

/** Dynamic workflows are the account's to have, and nothing reports them; turning ultracode on is the only way to know. Switches the model too. */
async function readUltracode(q: Query, catalog: ModelInfo[]): Promise<boolean> {
  const row = catalog.find((m) => m.supportedEffortLevels?.includes("xhigh"));
  if (!row) return false;
  await q.setModel(row.value);
  await q.applyFlagSettings({ ultracode: true });
  return (await readApplied(q))?.ultracode === true;
}

const PROBE_TIMEOUT_MS = 20_000;
const CATALOG_REUSE_MS = 10 * 60_000;

/** One cache per executor: each binds its own endpoint, and two endpoints must not show each other's catalogs. */
function probeCache(launch: Launch): (maxAgeMs: number) => Promise<Snapshot> {
  let snapshot: { at: number; value: Promise<Snapshot> } | null = null;
  return (maxAgeMs) => {
    if (snapshot && Date.now() - snapshot.at < maxAgeMs) return snapshot.value;
    const entry = { at: Date.now(), value: probe(launch) };
    snapshot = entry;
    // a failed probe must not be served from the cache
    entry.value.catch(() => {
      if (snapshot === entry) snapshot = null;
    });
    return entry.value;
  };
}

/**
 * A CLI started only to be asked questions. It is never handed a prompt, so it
 * spends nothing; a live session is not needed to know the account's limits or
 * what an unconfigured session would run.
 */
async function ask<T>(launch: Launch, questions: (q: Query) => Promise<T>): Promise<T> {
  const inbox = new Inbox();
  const q = query({
    prompt: inbox as AsyncIterable<never>,
    options: {
      cwd: tmpdir(),
      settingSources: [],
      permissionMode: START_MODE,
      env: launch.env,
      ...(launch.executable ? { pathToClaudeCodeExecutable: launch.executable } : {}),
      persistSession: false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      questions(q),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("claude: the probe did not answer")), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    inbox.close();
    q.close();
  }
}

const probe = (launch: Launch): Promise<Snapshot> =>
  ask(launch, async (q) => {
    const init = await q.initializationResult();
    const [applied, account] = await Promise.all([readApplied(q).catch(() => null), q.accountInfo().catch(() => null)]);
    const fast = await readFast(q, init.models).catch(() => undefined);
    const ultracode = await readUltracode(q, init.models).catch(() => false);
    return { catalog: init.models, applied, fast, ultracode, account, commands: init.commands ?? [] };
  });

function claudeExecutor(instance: InstanceConfig): BotRuntimeFactory {
  const { source } = instance;
  const launch = launchOf(instance.program, source);
  const snapshot = probeCache(launch);
  const words = wordsFor(instance.locale);
  return {
    id: instance.id,
    label: instance.label,
    type: "claude-code",
    capabilities: CLAUDE_CAPABILITIES,
    create: () => new ClaudeRuntime(launch, words),
    // starting the CLI with this program and this environment is what can fail here
    async check() {
      const probed = await snapshot(0).catch((err: unknown) => err as Error);
      if (probed instanceof Error) return { ok: false, detail: words.cantStart(probed.message) };
      const account = probed.account;
      if (source.kind === "own" && !signedIn(account)) return { ok: false, detail: words.signedOut };
      const via = account?.apiKeySource ?? account?.tokenSource ?? account?.subscriptionType;
      return { ok: true, detail: words.starts(via ?? (source.kind === "endpoint" ? source.endpoint.name : "Claude")) };
    },
    ...(source.kind === "own"
      ? {
          async models(): Promise<ModelOption[]> {
            const { catalog, account } = await snapshot(CATALOG_REUSE_MS);
            return listModels(catalog).map(({ row, label }) => ({ id: row.value, label, available: signedIn(account) }));
          },
          // the host asks here only while no live session can answer, so this one starts a CLI of its own
          quota: (): Promise<Quota | null> => ask(launch, planUsage).catch(() => planUsageFromCredentials()),
        }
      : {}),
    async sessionInfo({ model, effort, mode, fast }): Promise<SessionInfo> {
      const { catalog, applied, fast: gate, ultracode } = await snapshot(CATALOG_REUSE_MS);
      // an alias such as "opus" resolves through the catalog; no model means the CLI's default
      const id = model ? (catalog.find((m) => m.value === model)?.resolvedModel ?? model) : applied?.model;
      const row = catalog.find((m) => m.resolvedModel === id || m.value === id);
      // the probe ran with no effort set, so its effort is the default; a model without effort takes none
      const efforts = row ? effortsOf(row, ultracode) : undefined;
      let applies: string | null | undefined = applied?.effort;
      if (efforts?.length === 0) applies = null;
      else if (effort && (isEffort(effort) || (effort === ULTRACODE && ultracode)) && (!efforts || efforts.includes(effort))) {
        applies = effort;
      }
      return {
        mode: isMode(mode) ? mode : START_MODE,
        ...(id ? { model: id, modelLabel: modelLabel(id) } : {}),
        ...(applies !== undefined ? { effort: applies } : {}),
        fast: fast && row?.supportsFastMode && gate?.available ? "on" : "off",
      };
    },
    async sessionOptions(): Promise<SessionOptions> {
      const { catalog, fast, ultracode, commands } = await snapshot(CATALOG_REUSE_MS);
      const models =
        source.kind === "endpoint"
          ? // only what the endpoint's API listed; the CLI's own catalog just says which efforts and fast mode an id takes
            (source.endpoint.models ?? []).map((id) => {
              const row = catalog.find((m) => m.resolvedModel === id || m.value === id);
              return { id, label: id, efforts: row ? effortsOf(row, ultracode) : [], fast: row?.supportsFastMode === true };
            })
          : // the sign-in's catalog is the CLI's own, aliases and all
            listModels(catalog).map(({ row: m, label }) => ({
              id: m.value,
              ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
              label,
              ...(m.description ? { description: m.description } : {}),
              efforts: effortsOf(m, ultracode),
              fast: m.supportsFastMode === true,
            }));
      return {
        models,
        efforts: [
          ...Object.entries(EFFORT_LABEL).map(([id, label]) => ({ id, label })),
          ...(ultracode ? [{ id: ULTRACODE, label: "Ultracode", description: words.ultracode }] : []),
        ],
        modes: MODES.map(({ id, label }) => ({ id, label, description: words.modes[id] ?? "" })),
        ...(fast ? { fast } : {}),
        compact: true,
        ...(commands.length > 0 ? { commands: commandsOf(commands) } : {}),
      };
    },
    modeForTier: (tier) => MODES.find((m) => m.tier === tier)?.id ?? START_MODE,
  };
}

/** Claude Code on an Anthropic-compatible endpoint, or on the machine's own sign-in. */
export const claudeHarness: HarnessType = {
  type: "claude-code",
  label: "Claude Code",
  sources: { own: true, apis: ["anthropic-messages"] },
  capabilities: () => CLAUDE_CAPABILITIES,
  presets: async () => [
    { id: ANTHROPIC_PRESET, label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", keyLabel: "Anthropic API key" },
  ],
  create: claudeExecutor,
  // the sign-in is the program's, so it is asked afresh every time rather than cached with any executor
  async login(program, locale): Promise<LoginState> {
    const words = wordsFor(locale);
    // Roster does not drive the sign-in; the person runs it where the program is
    const methods = [{ id: "terminal", label: words.loginTerminal, terminal: { command: program?.trim() || "claude", args: ["auth", "login"] } }];
    const account = await ask(launchOf(program, { kind: "own" }), (q) => q.accountInfo()).catch((err: unknown) => err as Error);
    if (account instanceof Error) return { state: "unknown", detail: words.cantStart(account.message), methods };
    if (!signedIn(account)) return { state: "none", methods };
    const who = account.email ?? account.subscriptionType;
    return { state: "ok", ...(who ? { account: who } : {}), methods };
  },
};

export const harness = claudeHarness;
