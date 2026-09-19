# Credits

**English** | [简体中文](CREDITS.zh-CN.md)

The main projects Roster is built on. Licenses are as each package declares them; the full dependency tree, with exact versions, is in [`pnpm-lock.yaml`](pnpm-lock.yaml).

## Agents and protocols

| Project | Used for | License |
|---|---|---|
| [pi](https://github.com/earendil-works/pi) | pi-agent itself, a coding agent packaged as a library | MIT |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | Claude Code, on a Claude subscription or a model API | [Anthropic terms](https://code.claude.com/docs/en/legal-and-compliance) |
| [Agent Client Protocol](https://github.com/agentclientprotocol/typescript-sdk) | Driving Codex, Gemini CLI, Grok Build and other ACP agents | Apache-2.0 |
| [npm](https://github.com/npm/cli) | Downloading agents that are missing from your machine | Artistic-2.0 |

## Desktop and interface

| Project | Used for | License |
|---|---|---|
| [Electron](https://github.com/electron/electron) | Desktop shell | MIT |
| [React](https://github.com/react/react) | Interface | MIT |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | The components in `packages/ui/src/components/ui` | MIT |
| [Radix UI](https://github.com/radix-ui/primitives) | Component behavior and accessibility | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | Styling | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | Icons | ISC |
| [Sonner](https://github.com/emilkowalski/sonner) | Toasts | MIT |
| [react-markdown](https://github.com/remarkjs/react-markdown), [remark-gfm](https://github.com/remarkjs/remark-gfm) | Markdown in messages | MIT |

## Assets

| Project | Used for | License |
|---|---|---|
| [ip-as-logo](https://github.com/s1dashu/ip-as-logo-skill) | Bot avatars, in `packages/core/assets/logos` | MIT |
| [LobeHub Icons](https://github.com/lobehub/lobe-icons) | Provider marks, in `packages/ui/src/provider-icon.tsx` | MIT |

pi's mark comes from the pi.dev press kit. Brand marks remain trademarks of their owners.

## Agents downloaded on demand

These are not part of this repository. When an agent is missing from your machine, Roster can download it from npm into its own folder; using it is subject to its publisher's license.

| Agent | npm package | License |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk-{platform}` | [Anthropic terms](https://code.claude.com/docs/en/legal-and-compliance) |
| Codex | [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) | Apache-2.0 |
| Gemini CLI | [`@google/gemini-cli`](https://github.com/google-gemini/gemini-cli) | Apache-2.0 |
| Grok Build | [`@xai-official/grok`](https://github.com/xai-org/grok-build) | Apache-2.0 |
