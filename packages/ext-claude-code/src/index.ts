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
  ContextUse,
  Deliver,
  HarnessType,
  InstanceConfig,
  ModelOption,
  ModelSource,
  NormalizedEvent,
  ProviderConfig,
  SessionInfo,
  SessionOptions,
  SessionSettings,
  SlashCommand,
  StartOpts,
  ToolCall,
  ToolEffect,
  Unsubscribe,
} from "@roster/adapter-api";

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
 * Claude Code on an Anthropic-compatible endpoint, driven through the Claude
 * Agent SDK: this is the channel with the PreToolUse gate, context accounting
 * and effort control. The agent's own sign-in is not handled here -- the
 * extension's manifest routes it over ACP, where the credentials belong to the
 * CLI alone.
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
}

/**
 * Every inherited ANTHROPIC_* goes first: one left over from the host would
 * otherwise quietly win over the endpoint the bot named.
 */
function launchOf(instance: InstanceConfig, provider: ProviderConfig): Launch {
  const env = cleanEnv();
  const executable = instance.settings["executable"]?.trim();
  for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_")) delete env[key];
  if (provider.baseUrl) env["ANTHROPIC_BASE_URL"] = provider.baseUrl;
  // the official API authenticates with x-api-key; gateways and compatible endpoints take a bearer token
  if (provider.apiKey) env[provider.preset === CUSTOM_PRESET ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = provider.apiKey;
  // Claude Code reaches for Haiku, Sonnet and Opus by name on its own; another endpoint has none of them
  const first = provider.models?.[0];
  if (first) for (const tier of ["HAIKU", "SONNET", "OPUS"]) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = first;
  return { env, ...(executable ? { executable } : {}) };
}

const START_MODE: PermissionMode = "default";

/**
 * Claude Code's own titles for its modes, in the order its picker cycles them.
 * dontAsk is left out: it only ever denies. A tier names the mode that grants
 * the same, so a bot's tier still picks where a new session starts.
 */
const MODES: Array<{ id: PermissionMode; label: string; description: string; tier?: ToolEffect }> = [
  { id: "default", label: "Manual", description: "改文件、跑有副作用的命令前先问你", tier: "read" },
  { id: "acceptEdits", label: "Accept edits", description: "直接改文件，跑命令前仍会问你", tier: "write" },
  { id: "plan", label: "Plan", description: "只读分析、先出方案，你确认后才动手" },
  { id: "auto", label: "Auto", description: "由 Claude 判断操作是否安全，有风险的会拦下或问你" },
  { id: "bypassPermissions", label: "Bypass Permissions", description: "什么都不问，直接做", tier: "execute" },
];

/** As Claude Code's model picker spells them. */
const EFFORT_LABEL: Record<EffortLevel, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh", max: "Max" };

/**
 * Claude Code offers ultracode as one more effort: xhigh plus standing workflow
 * orchestration. It is a session setting rather than an effort level, and only
 * exists where the account has dynamic workflows and the model takes xhigh.
 */
const ULTRACODE = "ultracode";
const ULTRACODE_OPTION = { id: ULTRACODE, label: "Ultracode", description: "xHigh + 多 agent 编排，最耗额度" };

const isMode = (v: unknown): v is PermissionMode => MODES.some((m) => m.id === v);
const isEffort = (v: unknown): v is EffortLevel => typeof v === "string" && Object.hasOwn(EFFORT_LABEL, v);
const isFastState = (v: unknown): v is "on" | "off" | "cooldown" => v === "on" || v === "off" || v === "cooldown";

/** The CLI's own category names, said the way the rest of Roster says things. An unknown one passes through. */
const CATEGORY_LABEL: Record<string, string> = {
  Messages: "消息",
  "System prompt": "系统提示词",
  "System tools": "系统工具",
  Skills: "技能",
  "MCP tools": "MCP 工具",
  "Memory files": "记忆文件",
  "Custom agents": "自定义 Agent",
};

function contextOf(c: Awaited<ReturnType<Query["getContextUsage"]>>): ContextUse {
  const max = c.rawMaxTokens || c.maxTokens;
  return {
    used: c.totalTokens,
    max,
    percent: c.percentage,
    ...(c.isAutoCompactEnabled && c.autoCompactThreshold && max
      ? { autoCompactAt: Math.round((c.autoCompactThreshold / max) * 100) }
      : {}),
    // free space and the compaction reserve are not in use; deferred tool schemas sit outside the window
    parts: c.categories
      .filter((p) => p.kind === "used" && p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map((p) => ({ name: CATEGORY_LABEL[p.name] ?? p.name, tokens: p.tokens })),
  };
}

/** "claude-haiku-4-5-20251001" reads as "Haiku 4.5"; an id of any other shape is shown as it is. */
function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m?.[1]) return id;
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** What a model's effort picker lists: its own levels, then ultracode wherever xhigh is one of them. */
function effortsOf(m: ModelInfo, ultracode: boolean): string[] {
  const levels = m.supportsEffort ? (m.supportedEffortLevels ?? []) : [];
  return ultracode && levels.includes("xhigh") ? [...levels, ULTRACODE] : levels;
}

/** Catalog descriptions lead with the versioned name: "Opus 5 · Best for everyday, complex tasks". */
function catalogEntry(m: ModelInfo): { label: string; description: string } {
  const [name, ...rest] = m.description.split(" · ");
  if (!name || rest.length === 0) return { label: m.displayName, description: m.description };
  return { label: name, description: rest.join(" · ") };
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

  constructor(private launch: Launch) {}

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
      // Isolation mode. Without this the SDK loads the user's own
      // ~/.claude/settings.json, whose pre-approved tools never reach
      // canUseTool -- a session in Manual would silently run Bash because the
      // human allowed it in their CLI months ago. Roster's gate and the session's
      // mode have to be the only authorities. Cost: CLAUDE.md is not loaded
      // either (it rides on the 'project' source), which is the deliberate trade.
      settingSources: [],
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
            content: typeof block["content"] === "string" ? block["content"] : "",
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
    const model = typeof m["model"] === "string" ? m["model"] : undefined;
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
    if (c) this.#report({ context: contextOf(c) });
  }

  /** Counts every category with the token-count API, which the per-turn summary only estimates. */
  async contextDetail(): Promise<ContextDetail> {
    const q = this.#query;
    if (!q || this.#dead) throw new Error("claude: no live session to read");
    const c = await q.getContextUsage({ detail: "full" });
    const rows = (list: Array<{ name: string; tokens: number }>) =>
      list.filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    const m = c.messageBreakdown;
    return {
      ...contextOf(c),
      model: c.model,
      sections: [
        {
          title: "消息",
          rows: m
            ? rows([
                { name: "工具调用", tokens: m.toolCallTokens },
                { name: "工具结果", tokens: m.toolResultTokens },
                { name: "附件", tokens: m.attachmentTokens },
                { name: "助手消息", tokens: m.assistantMessageTokens },
                { name: "用户消息", tokens: m.userMessageTokens },
              ])
            : [],
        },
        { title: "记忆文件", rows: rows(c.memoryFiles.map((f) => ({ name: f.path, tokens: f.tokens }))) },
        { title: "MCP 工具", rows: rows(c.mcpTools.map((t) => ({ name: t.name, tokens: t.tokens }))) },
        { title: "自定义 Agent", rows: rows(c.agents.map((a) => ({ name: a.agentType, tokens: a.tokens }))) },
        { title: "技能", rows: rows((c.skills?.skillFrontmatter ?? []).map((s) => ({ name: s.name, tokens: s.tokens }))) },
        { title: "系统工具", rows: rows((c.systemTools ?? []).map((t) => ({ name: t.name, tokens: t.tokens }))) },
      ].filter((s) => s.rows.length > 0),
    };
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

interface Snapshot {
  catalog: ModelInfo[];
  /** what a session started with no model resolves to */
  applied: Applied | null;
  fast: { available: boolean; reason?: string } | undefined;
  /** whether a session on an xhigh model could turn ultracode on */
  ultracode: boolean;
  /** how the CLI authenticates against the endpoint */
  account: { subscriptionType?: string; tokenSource?: string; apiKeySource?: string } | null;
  commands: SdkCommand[];
}

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

/** One cache per endpoint: two endpoints serve different catalogs, and must not show each other's. */
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
async function probe(launch: Launch): Promise<Snapshot> {
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
      (async () => {
        const init = await q.initializationResult();
        const [applied, account] = await Promise.all([readApplied(q).catch(() => null), q.accountInfo().catch(() => null)]);
        const fast = await readFast(q, init.models).catch(() => undefined);
        const ultracode = await readUltracode(q, init.models).catch(() => false);
        return { catalog: init.models, applied, fast, ultracode, account, commands: init.commands ?? [] };
      })(),
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

/** The aliases the CLI resolves on its own; a custom endpoint serves exactly what it was set up with. */
function catalogOf(endpoint: ProviderConfig): ModelOption[] {
  if (endpoint.preset === CUSTOM_PRESET) {
    return (endpoint.models ?? []).map((id) => ({ id, label: `${endpoint.name} · ${id}`, available: Boolean(endpoint.apiKey), provider: endpoint.name }));
  }
  const available = Boolean(endpoint.apiKey);
  return [
    { id: "sonnet", label: "Sonnet · 均衡", available, provider: "anthropic" },
    { id: "opus", label: "Opus · 最强", available, provider: "anthropic" },
    { id: "haiku", label: "Haiku · 最快", available, provider: "anthropic" },
  ];
}

const endpointOf = (source: ModelSource): ProviderConfig => {
  if (source.kind !== "endpoint") throw new Error("claude: the SDK channel runs on an endpoint; the agent's own sign-in goes over ACP");
  return source.endpoint;
};

function claudeExecutor(instance: InstanceConfig): BotRuntimeFactory {
  // probes are per endpoint, since each serves its own catalog; the launch env carries the key, so the cache is keyed by id only
  const probes = new Map<string, (maxAgeMs: number) => Promise<Snapshot>>();
  const snapshotFor = (endpoint: ProviderConfig) => {
    let p = probes.get(endpoint.id);
    if (!p) {
      p = probeCache(launchOf(instance, endpoint));
      probes.set(endpoint.id, p);
    }
    return p;
  };
  return {
    id: instance.id,
    label: instance.label,
    type: "claude-code",
    sources: { own: false, apis: ["anthropic-messages"] },
    capabilities: () => CLAUDE_CAPABILITIES,
    create: (source) => new ClaudeRuntime(launchOf(instance, endpointOf(source))),
    // starting the CLI with this executor's binary and the endpoint's environment is what can fail here
    async check(source) {
      const endpoint = endpointOf(source);
      const snapshot = await snapshotFor(endpoint)(0).catch((err: unknown) => err as Error);
      if (snapshot instanceof Error) return { ok: false, detail: `Claude Code 启动不了：${snapshot.message}` };
      const account = snapshot.account;
      const via = account?.apiKeySource ?? account?.tokenSource;
      return { ok: true, detail: `Claude Code 启动正常，认证走 ${via ?? endpoint.name}` };
    },
    async sessionInfo({ model, effort, mode, fast }, source): Promise<SessionInfo> {
      const { catalog, applied, fast: gate, ultracode } = await snapshotFor(endpointOf(source))(CATALOG_REUSE_MS);
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
    async sessionOptions(source): Promise<SessionOptions> {
      const endpoint = endpointOf(source);
      const { catalog, fast, ultracode, commands } = await snapshotFor(endpoint)(CATALOG_REUSE_MS);
      // a custom endpoint serves what it was set up with; the CLI's catalog only knows Anthropic's own names
      const models =
        endpoint.preset === CUSTOM_PRESET && endpoint.models?.length
          ? endpoint.models.map((id) => ({ id, label: id, efforts: [] as string[] }))
          : catalog
              .filter((m) => m.value !== "default")
              .map((m) => ({
                id: m.value,
                ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
                ...catalogEntry(m),
                efforts: effortsOf(m, ultracode),
                fast: m.supportsFastMode === true,
              }));
      return {
        models,
        efforts: [
          ...Object.entries(EFFORT_LABEL).map(([id, label]) => ({ id, label })),
          ...(ultracode ? [ULTRACODE_OPTION] : []),
        ],
        modes: MODES.map(({ id, label, description }) => ({ id, label, description })),
        ...(fast ? { fast } : {}),
        compact: true,
        ...(commands.length > 0 ? { commands: commandsOf(commands) } : {}),
      };
    },
    modeForTier: (tier) => MODES.find((m) => m.tier === tier)?.id ?? START_MODE,
  };
}

/** Claude Code on an Anthropic-compatible endpoint. Its own sign-in is the manifest's ACP block, composed in by the host. */
export const claudeHarness: HarnessType = {
  type: "claude-code",
  label: "Claude Code",
  sources: { own: false, apis: ["anthropic-messages"] },
  capabilities: () => CLAUDE_CAPABILITIES,
  fields: [
    {
      key: "executable",
      label: "Claude Code 可执行文件",
      kind: "path",
      placeholder: "留空用本机检测到的，或 Roster 装的",
      help: "只在想指定另一份 claude 时填，比如另一个版本；订阅登录也走这一份",
    },
  ],
  presets: async () => [
    { id: ANTHROPIC_PRESET, label: "Anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: 3, keyLabel: "Anthropic API key" },
  ],
  catalog: async (endpoint) => catalogOf(endpoint),
  create: claudeExecutor,
};

export const harness = claudeHarness;
