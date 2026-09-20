<p align="center">
  <img src="packages/ui/public/icon.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Roster</h1>

<p align="center">Coding agents as contacts: a direct chat is a session, a group chat is an agent team.</p>

<p align="center">
  <a href="https://github.com/amigoer/roster/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/amigoer/roster?color=2F75F8"></a>
  <a href="LICENSE"><img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-555555"></a>
  <a href="#harnesses"><img alt="Ten harnesses" src="https://img.shields.io/badge/harnesses-10-1D2230"></a>
  <img alt="Node 22.13 or later" src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-5FA04E?logo=node.js&logoColor=white">
  <img alt="macOS" src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white">
</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

Roster is a desktop app for the coding agents you already use. It writes no agent loop of its own. It drives theirs, so model upgrades and prompt tuning keep coming from them, and gives them the shape of a chat app: conversations that persist, bots you set up once and reuse, groups where several agents work in one repository, and one list of what needs you.

## What it does

- **Bots are contacts.** Name, avatar, preset prompt, agent, model, permission level: set once, reusable in any number of conversations.
- **Groups are agent teams.** Several bots in one repository. You lead with @mentions, a leader bot splits the task, or everyone answers and you decide. They talk at the same time; only one edits files at a time.
- **Your agents, as they are.** Ones already on your machine are detected and used; missing ones download into Roster's own folder.
- **Subscription or API, settled per agent.** An agent is a harness plus where its models come from, so a bot picks an agent and how it runs is decided in one place. Saved keys are sealed with a key the operating system protects; environment variables work too.
- **Permission levels.** Read-only, write, or execute. Anything past a bot's level becomes an approval card in the chat, never a blocking dialog.
- **What needs you comes first.** Waiting conversations sort to the top, longest wait first, with notifications, a Dock badge and a count in the menu bar.
- **Two languages.** English and Simplified Chinese, following the system or your pick in Settings, down to the instructions Roster gives agents.

## Harnesses

| Harness | Sign-in | Model API |
|---|---|---|
| Claude Code | Claude subscription | Anthropic-compatible API |
| Codex | ChatGPT account | OpenAI-compatible API |
| Gemini CLI | Google account | Gemini API key |
| Grok Build | Grok account | OpenAI-compatible API |
| OpenCode | its own providers, from free models to ChatGPT and Copilot | not yet |
| DeepSeek Harness | none | DeepSeek API |
| Kimi Code | Kimi account | Moonshot, Kimi Coding, or an OpenAI- or Anthropic-compatible API |
| Qwen Code | Qwen account | any OpenAI-compatible API |
| Qoder CLI | Qoder account | not applicable: its models come with the account |
| pi-agent | none | any model API you add |

Adapters ship with Roster, and pi-agent is a library, so it needs no separate program. Everything but Claude Code and pi-agent is experimental.

## Getting started

Node.js 22.13 or later and pnpm 10. Roster is developed on macOS; Windows and Linux are untested.

```bash
git clone https://github.com/amigoer/roster.git
cd roster
pnpm install
pnpm build
pnpm start
```

The first run on macOS asks whether Roster may send notifications. Say yes: macOS asks once, and until it is allowed, replies and approval requests arrive with nothing to show for them.

Then, in Settings: **Harness** shows what was found and downloads the rest, **Model API** takes your keys, **Agent** pairs the two, which the bot editor can also do inline.

To run without Electron: `pnpm core`, then <http://127.0.0.1:7788>. No desktop shell means no keychain, so saved keys sit unencrypted; use environment variables instead.

## Development

```bash
pnpm typecheck                  # every package
pnpm test                       # build the adapters, then run core's tests
pnpm -C packages/ui dev         # Vite on :5173, /api proxied to core on :7788
pnpm --filter @roster/ui build  # rebuild the UI bundle the app serves
pnpm icons                      # redraw the icons from their SVGs
```

`ROSTER_SCRIPTED=1` swaps real agents for a scripted one, which is the way to work on the interface.

On macOS `pnpm start` first clones the Electron bundle to `packages/desktop/.mac/Roster.app` under Roster's own name, icon, identifier and signature: macOS reads a notification's sender, icon and permission off the bundle it came from, and refuses the one npm ships. See [`start.cjs`](packages/desktop/start.cjs).

<details>
<summary>Environment variables</summary>

| Variable | Default | Purpose |
|---|---|---|
| `ROSTER_DATA_DIR` | `~/.roster` | Database, attachments, chat spaces and downloaded agents |
| `ROSTER_PORT` | `7788` | Port core listens on, 127.0.0.1 only; a free port is used if it is taken |
| `ROSTER_EXTENSIONS` | | Extra adapter directories, as a path list |
| `ROSTER_SCRIPTED` | | `1` runs a scripted agent instead of real ones |
| `ROSTER_CORE` | `http://127.0.0.1:7788` | Where the UI dev server sends `/api` |

</details>

<details>
<summary>Project layout</summary>

| Path | Contents |
|---|---|
| `packages/core` | Headless Node server: conversations, turn-taking, SQLite event log, HTTP API |
| `packages/ui` | React interface (Vite, Tailwind CSS, shadcn/ui), served by core |
| `packages/desktop` | Electron shell: window, notifications, Dock badge, menu bar item, keychain |
| `packages/adapter-api` | The types every adapter implements |
| `packages/ext-*` | Adapters: Claude Code and pi-agent in code, the rest as manifests |

An agent that speaks the Agent Client Protocol (ACP) needs only a manifest under the `roster` key of its `package.json`: the command to start it, which environment variables carry a model API, and how to sign in. See [`packages/ext-codex`](packages/ext-codex/package.json).

</details>

## Design notes

[`docs/`](docs/README.md) holds what was decided and why, by topic. They are written in Chinese.

## Credits

The projects and assets Roster is built on, and their licenses, are listed in [CREDITS.md](CREDITS.md).

## License

[Apache License 2.0](LICENSE).
