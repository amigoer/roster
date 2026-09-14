import { randomUUID } from "node:crypto";
import type {
  Attachment,
  BotRuntime,
  BotRuntimeFactory,
  Capabilities,
  ContextDetail,
  ContextUse,
  Deliver,
  NormalizedEvent,
  Quota,
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
 * A backend that answers from a script instead of a model. It drives every
 * orchestrator path -- streaming, tool calls through the gate, leader
 * dispatch -- with no credentials and no spend. Used by the tests and by
 * ROSTER_SCRIPTED=1 for working on the UI.
 *
 * Put #read, #write or #exec in a message to make the bot call a tool of that effect.
 * A message starting with one of its slash commands is answered as that command.
 */
const CAPABILITIES: Capabilities = {
  interceptToolCall: true,
  mutateToolInput: false,
  midRunInject: [],
  costLimit: false,
  mcp: false,
  branch: false,
  permissionModes: false,
};

const TOOLS: Record<string, { name: string; effect: ToolEffect }> = {
  "#read": { name: "read", effect: "read" },
  "#write": { name: "write", effect: "write" },
  "#exec": { name: "bash", effect: "execute" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMMANDS: SlashCommand[] = [
  { name: "review", description: "审查当前分支的改动" },
  { name: "init", description: "生成项目说明文件" },
  { name: "explain", description: "解释一段代码", hint: "<文件或符号>" },
  { name: "compact", description: "压缩对话历史" },
];

const OPTIONS: SessionOptions = {
  models: [
    { id: "scripted", resolved: "scripted", label: "脚本回复", description: "不调用模型", efforts: ["low", "high"], fast: true },
    { id: "scripted-plain", resolved: "scripted-plain", label: "脚本回复 · 无思考", efforts: [] },
  ],
  efforts: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  modes: [
    { id: "default", label: "Manual" },
    { id: "plan", label: "Plan" },
  ],
  fast: { available: true },
  compact: true,
  commands: COMMANDS,
};

const infoOf = ({ model, effort, mode, fast }: SessionSettings): SessionInfo => ({
  model: model ?? "scripted",
  modelLabel: OPTIONS.models.find((m) => m.id === (model ?? "scripted"))?.label ?? model,
  mode: mode ?? "default",
  effort: model === "scripted-plain" ? null : (effort ?? "high"),
  fast: fast ? "on" : "off",
});

/** The window fills a little every turn and empties on compaction, so the context meter has something to show. */
const contextOf = (turns: number): ContextUse => {
  const parts = [
    { name: "系统工具", tokens: 9_000 },
    { name: "系统提示词", tokens: 3_000 },
    { name: "消息", tokens: turns * 3_000 },
  ].filter((p) => p.tokens > 0);
  const used = parts.reduce((n, p) => n + p.tokens, 0);
  return { used, max: 200_000, percent: Math.round((used / 200_000) * 100), autoCompactAt: 84, parts };
};

/** Fixed levels, so the status bar has plan limits to draw without an account. */
const quotaOf = (): Quota => ({
  plan: "scripted",
  windows: [
    { kind: "session", usedPercent: 24, resetsAt: Date.now() + 2 * 3600_000 },
    { kind: "weekly", usedPercent: 81, resetsAt: Date.now() + 4 * 86400_000 },
    { kind: "weekly", scope: "Scripted", usedPercent: 0, resetsAt: Date.now() + 4 * 86400_000 },
  ],
});

class ScriptedRuntime implements BotRuntime {
  readonly capabilities = CAPABILITIES;
  #handlers = new Set<(e: NormalizedEvent) => void>();
  #opts: StartOpts | undefined;
  #settings: SessionSettings = {};
  #turns = 0;
  #running = false;
  #aborting = false;

  constructor(private delayMs: number) {}

  subscribe(handler: (e: NormalizedEvent) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  #emit(e: NormalizedEvent): void {
    for (const h of this.#handlers) h(e);
  }

  async start(opts: StartOpts): Promise<void> {
    this.#opts = opts;
    this.#settings = { model: opts.model, effort: opts.effort, mode: opts.mode, fast: opts.fast };
  }

  #report(): void {
    this.#emit({
      type: "session.info",
      display: "status",
      info: { ...infoOf(this.#settings), context: contextOf(this.#turns), commands: COMMANDS },
    });
  }

  async compact(): Promise<void> {
    if (this.#running) throw new Error("scripted runtime is busy");
    this.#running = true;
    this.#emit({ type: "turn.start", display: "status" });
    void (async () => {
      await sleep(this.delayMs * 2);
      this.#turns = 0;
      this.#running = false;
      this.#emit({ type: "turn.end", display: "status", reason: "done" });
      this.#report();
    })();
  }

  async contextDetail(): Promise<ContextDetail> {
    return {
      ...contextOf(this.#turns),
      model: this.#settings.model ?? "scripted",
      sections: [{ title: "消息", rows: [{ name: "用户消息", tokens: this.#turns * 1_000 }] }],
    };
  }

  async send(text: string, _deliver?: Deliver, attachments: readonly Attachment[] = []): Promise<void> {
    if (!this.#opts) throw new Error("scripted runtime not started");
    if (this.#running) throw new Error("scripted runtime is busy");
    this.#running = true;
    this.#aborting = false;
    this.#turns++;
    this.#emit({ type: "turn.start", display: "status" });
    // a real backend restates what it runs with at the start of each turn
    this.#report();
    void this.#play(text, attachments);
  }

  async configure(settings: SessionSettings): Promise<void> {
    this.#settings = { ...this.#settings, ...settings };
    this.#report();
  }

  async #play(text: string, attachments: readonly Attachment[]): Promise<void> {
    let reason: "done" | "aborted" | "error" = "done";
    // only the newest thing the human said; a backlog replays older tags
    const said = [...text.matchAll(/<message from="用户"[^>]*>\n([\s\S]*?)\n<\/message>/g)].at(-1)?.[1] ?? text;
    try {
      for (const [tag, tool] of Object.entries(TOOLS)) {
        if (said.includes(tag) && !this.#aborting) await this.#tool(tool);
      }
      const files = attachments.length > 0 ? `\n\n附件：${attachments.map((a) => `${a.name}（${a.mime}）`).join("、")}` : "";
      const reply = this.#reply(text, said) + files;
      for (let i = 0; i < reply.length && !this.#aborting; i += 4) {
        this.#emit({ type: "assistant.text", display: "message", delta: reply.slice(i, i + 4) });
        await sleep(this.delayMs);
      }
    } catch (err) {
      reason = "error";
      this.#emit({ type: "error", display: "message", message: err instanceof Error ? err.message : String(err) });
    }
    this.#running = false;
    this.#emit({ type: "turn.end", display: "status", reason: this.#aborting ? "aborted" : reason });
  }

  async #tool(tool: { name: string; effect: ToolEffect }): Promise<void> {
    const call: ToolCall = { id: randomUUID(), name: tool.name, input: { path: "notes.md" }, effect: tool.effect };
    this.#emit({ type: "tool.start", display: "fold", call });
    const gated: ToolDecision = (await this.#opts?.onToolCall?.(call)) ?? { action: "allow" };
    // stands in for a backend's own mode: reads pass, anything else asks
    const decision: ToolDecision =
      gated.action !== "defer" || tool.effect === "read"
        ? gated
        : ((await this.#opts?.onPermission?.(call)) ?? { action: "deny", reason: "nobody to ask" });
    await sleep(this.delayMs * 2);
    const denied = decision.action === "deny";
    this.#emit({ type: "tool.end", display: "fold", id: call.id, isError: denied, content: denied ? decision.reason : "ok" });
    if (denied && decision.terminate) this.#aborting = true;
  }

  #reply(text: string, said: string): string {
    const roster = [...text.matchAll(/^- ([^（：\n]+)(（[^）]*）)?/gm)]
      .map((m) => ({ name: m[1]!.trim(), self: (m[2] ?? "").includes("你") }))
      .filter((m) => m.name !== "用户");
    const self = roster.find((m) => m.self)?.name ?? "我";
    const others = roster.filter((m) => !m.self).map((m) => m.name);

    if (text.includes("你是这个群的群主")) {
      if (others.length === 0) return "群里只有我，这件事我直接来做。";
      return `我来拆一下：\n\n${others.map((n, i) => `@${n} 负责第 ${i + 1} 部分，做完交回结果。`).join("\n\n")}`;
    }
    if (text.includes("你分派的成员已经回复")) return "汇总：分派出去的部分都交回了，这件事完成了。";
    if (text.includes("群主给你分派了任务")) return `${self} 已经完成分到的部分。`;
    if (text.includes("现在是讨论模式")) return `${self} 的看法：先把边界情况列清楚，再决定怎么改。`;
    const command = COMMANDS.find((c) => new RegExp(`^/${c.name}(\\s|$)`).test(said));
    if (command) {
      const arg = said.slice(command.name.length + 1).split("\n")[0]!.trim();
      return `执行了 /${command.name}${arg ? `，参数：${arg}` : ""}`;
    }
    // attachments are spelled out after what was typed; the echo keeps to the typed part
    const typed = said.replace(/<attachment[\s\S]*$/, "").replace(/\s+/g, " ").trim();
    return typed ? `收到：${typed.slice(0, 60)}` : "收到了你发的文件";
  }

  async abort(): Promise<void> {
    if (this.#running) this.#aborting = true;
  }

  readonly resumeToken = undefined;

  async dispose(): Promise<void> {
    this.#aborting = true;
    this.#handlers.clear();
  }
}

/** An executor that stands in for the one with this id, so bots saved against it run on scripts. */
export function scriptedFactory(id: string, delayMs = 40, label = `脚本回复（${id}）`): BotRuntimeFactory {
  return {
    id,
    type: "scripted",
    label,
    capabilities: CAPABILITIES,
    create: () => new ScriptedRuntime(delayMs),
    models: async () => OPTIONS.models.map((m) => ({ id: m.id, label: m.label, available: true })),
    sessionInfo: async (settings) => infoOf(settings),
    sessionOptions: async () => OPTIONS,
    modeForTier: () => "default",
    // only claude has plan limits to stand in for
    ...(id === "claude" ? { quota: async () => quotaOf() } : {}),
  };
}
