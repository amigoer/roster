# 致谢

[English](CREDITS.md) | **简体中文**

Roster 主要建立在下面这些项目之上。许可协议以各个包自己声明的为准；完整的依赖和确切版本见 [`pnpm-lock.yaml`](pnpm-lock.yaml)。

## agent 与协议

| 项目 | 用在哪 | 许可协议 |
|---|---|---|
| [pi](https://github.com/earendil-works/pi) | pi-agent 就是它，一个库形态的编码 agent | MIT |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | 驱动 Claude Code，订阅登录和接模型 API 都走它 | [Anthropic 条款](https://code.claude.com/docs/en/legal-and-compliance) |
| [Agent Client Protocol](https://github.com/agentclientprotocol/typescript-sdk) | 驱动 Codex、Gemini CLI、Grok Build、OpenCode、DeepSeek Harness、Kimi Code、Qwen Code、Qoder CLI 这类 agent 的协议 | Apache-2.0 |
| [npm](https://github.com/npm/cli) | 下载本机没有的 agent | Artistic-2.0 |

## 桌面与界面

| 项目 | 用在哪 | 许可协议 |
|---|---|---|
| [Electron](https://github.com/electron/electron) | 桌面外壳 | MIT |
| [React](https://github.com/react/react) | 界面 | MIT |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | `packages/ui/src/components/ui` 里组件的底子 | MIT |
| [Radix UI](https://github.com/radix-ui/primitives) | 组件的交互和无障碍 | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 样式 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Sonner](https://github.com/emilkowalski/sonner) | 提示条 | MIT |
| [react-markdown](https://github.com/remarkjs/react-markdown)、[remark-gfm](https://github.com/remarkjs/remark-gfm) | 消息里的 Markdown | MIT |

## 素材

| 项目 | 用在哪 | 许可协议 |
|---|---|---|
| [ip-as-logo](https://github.com/s1dashu/ip-as-logo-skill) | bot 的头像，在 `packages/core/assets/logos` | MIT |
| [LobeHub Icons](https://github.com/lobehub/lobe-icons) | 服务商的品牌标，在 `packages/ui/src/provider-icon.tsx` | MIT |

pi 的品牌标来自 pi.dev 的媒体资料包。各品牌标的商标归各自的所有者。

## 按需下载的 agent

这些不在本仓库里。本机没有某个 agent 时，Roster 可以从 npm 把它下载到自己的目录；使用时遵循发布方的许可协议。

| Agent | npm 包 | 许可协议 |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk-{platform}` | [Anthropic 条款](https://code.claude.com/docs/en/legal-and-compliance) |
| Codex | [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) | Apache-2.0 |
| Gemini CLI | [`@google/gemini-cli`](https://github.com/google-gemini/gemini-cli) | Apache-2.0 |
| Grok Build | [`@xai-official/grok`](https://github.com/xai-org/grok-build) | Apache-2.0 |
| OpenCode | [`opencode-ai`](https://github.com/anomalyco/opencode) | MIT |
| DeepSeek Harness | [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) | MIT |
| Kimi Code | [`@moonshot-ai/kimi-code`](https://github.com/MoonshotAI/kimi-code) | MIT |
| Qwen Code | [`@qwen-code/qwen-code`](https://github.com/QwenLM/qwen-code) | Apache-2.0 |
| Qoder CLI | [`@qoder-ai/qodercli`](https://qoder.com/cli) | Apache-2.0 |
