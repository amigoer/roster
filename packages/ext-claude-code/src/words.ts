/** What this adapter says to a person. The CLI's own names for modes, efforts and categories stay as it spells them in English. */
export const WORDS = {
  en: {
    modes: {
      default: "Asks before editing files or running commands with side effects",
      acceptEdits: "Edits files without asking; still asks before running commands",
      plan: "Analyzes read-only and proposes a plan; acts only once you approve",
      auto: "Claude judges whether each action is safe, and blocks or asks about risky ones",
      bypassPermissions: "Asks nothing and just does it",
    } as Record<string, string>,
    ultracode: "xHigh + multi-agent orchestration; uses the most quota",
    categories: {} as Record<string, string>,
    deferred: (name: string) => `${name} (deferred)`,
    reserved: "Autocompact buffer",
    sections: {
      messages: "Messages",
      toolCalls: "Tool calls",
      toolResults: "Tool results",
      attachments: "Attachments",
      assistant: "Assistant messages",
      user: "User messages",
      memory: "Memory files",
      mcp: "MCP tools",
      agents: "Custom agents",
      skills: "Skills",
      tools: "System tools",
      prompt: "System prompt",
    },
    loginTerminal: "Sign in from a terminal",
    signedOut: "Claude Code isn't signed in",
    cantStart: (message: string) => `Claude Code can't start: ${message}`,
    starts: (via: string) => `Starts fine; authenticates with ${via}`,
  },
  "zh-CN": {
    modes: {
      default: "改文件、跑有副作用的命令前先问你",
      acceptEdits: "直接改文件，跑命令前仍会问你",
      plan: "只读分析、先出方案，你确认后才动手",
      auto: "由 Claude 判断操作是否安全，有风险的会拦下或问你",
      bypassPermissions: "什么都不问，直接做",
    } as Record<string, string>,
    ultracode: "xHigh + 多 agent 编排，最耗额度",
    // the CLI's category names, said the way the rest of Roster says things; an unknown one passes through
    categories: {
      Messages: "消息",
      "System prompt": "系统提示词",
      "System tools": "系统工具",
      Skills: "技能",
      "MCP tools": "MCP 工具",
      "Memory files": "记忆文件",
      "Custom agents": "自定义 Agent",
    } as Record<string, string>,
    deferred: (name: string) => `${name}（按需加载）`,
    reserved: "自动压缩预留",
    sections: {
      messages: "消息",
      toolCalls: "工具调用",
      toolResults: "工具结果",
      attachments: "附件",
      assistant: "助手消息",
      user: "用户消息",
      memory: "记忆文件",
      mcp: "MCP 工具",
      agents: "自定义 Agent",
      skills: "技能",
      tools: "系统工具",
      prompt: "系统提示词",
    },
    loginTerminal: "在终端登录",
    signedOut: "Claude Code 没有登录",
    cantStart: (message: string) => `Claude Code 启动不了：${message}`,
    starts: (via: string) => `启动正常，认证走 ${via}`,
  },
};

export type Words = (typeof WORDS)["en"];

/** Any Chinese the host asks for reads the Simplified text; anything else reads English. */
export const wordsFor = (locale: string | undefined): Words => (locale?.toLowerCase().startsWith("zh") ? WORDS["zh-CN"] : WORDS.en);
