# Roster

**English** | [简体中文](README.zh-CN.md)

Coding agents as contacts: a direct chat is a session, a group chat is an agent team.

Roster is a desktop app for the coding agents you already use: Claude Code, Codex, Gemini CLI and pi-agent. It does not write its own agent loop. It drives those agents, so model upgrades and prompt tuning keep coming from them, and gives them the shape of a chat app: conversations that persist, bots you set up once and reuse, groups where several agents work in the same repository, and one list that shows what needs you.

> [!NOTE]
> Early development: there are no packaged releases yet, so run it from source. The interface is in Chinese for now.

## Features

- **Bots are contacts.** A bot keeps a name, avatar, preset prompt, agent, model and permission level. The same bot can join any number of conversations.
- **Groups are agent teams.** Pick several bots and choose how turns pass: you lead with @mentions, a leader bot splits the task and assigns it, or every member answers each message while you decide. Members can talk at the same time; only one edits files at a time.
- **Your agents, detected.** Agents already on your machine are used as they are. Missing ones are downloaded into Roster's own folder.
- **Subscription or API.** A bot runs on the agent's own sign-in, or on a model API you add. Keys can come from environment variables; keys you save are encrypted with a key the operating system protects (Keychain on macOS).
- **Permission levels.** Read-only, can write, or can execute. Anything beyond a bot's level becomes an approval card in the chat, never a blocking dialog.
- **What needs you comes first.** Conversations waiting for an approval or a reply sort to the top, longest wait first. The desktop app adds notifications and a Dock badge.
- **One working directory per conversation**, chosen when you start it. Attachments, slash commands and a context usage panel are built in.

Planned: a space (空间) that collects the documents and reports agents produce.

## Agents

| Agent | Sign-in | Model API |
|---|---|---|
| Claude Code | Claude subscription | Anthropic-compatible API |
| Codex | ChatGPT account | OpenAI-compatible API |
| Gemini CLI | Google account | Gemini API key |
| pi-agent | none | any model API you add |

Adapters ship with Roster. pi-agent is a library, so it needs no separate program. Codex and Gemini CLI support is experimental.

## Getting started

You need Node.js 22.13 or later and pnpm 10. Roster is developed on macOS; Windows and Linux are untested.

```bash
git clone https://github.com/amigoer/roster.git
cd roster
pnpm install
pnpm build
pnpm start
```

Settings (设置) > Agent shows which agents were found and offers to download the rest. Add API keys under Settings > 模型 API.

To run without Electron, use `pnpm core` and open http://127.0.0.1:7788 in a browser. Without the desktop app there is no keychain, so saved keys are stored unencrypted; read them from environment variables instead.

## Development

```bash
pnpm typecheck               # all packages
pnpm test                    # builds the adapters, then runs the core tests
pnpm -C packages/ui dev      # Vite on :5173, proxying /api to core on :7788
```

The desktop app serves the built UI from `packages/ui/dist`, so after UI changes run `pnpm --filter @roster/ui build` and reload the window. `ROSTER_SCRIPTED=1` swaps real agents for a scripted one, which helps when working on the interface.

| Variable | Default | Purpose |
|---|---|---|
| `ROSTER_DATA_DIR` | `~/.roster` | Database, attachments and downloaded agents |
| `ROSTER_PORT` | `7788` | Port core listens on, 127.0.0.1 only; a free port is used if it is taken |
| `ROSTER_EXTENSIONS` | | Extra adapter directories, as a path list |
| `ROSTER_SCRIPTED` | | `1` runs a scripted agent instead of real ones |
| `ROSTER_CORE` | `http://127.0.0.1:7788` | Where the UI dev server sends `/api` |

## Project layout

| Path | Contents |
|---|---|
| `packages/core` | Headless Node server: conversations, turn-taking, SQLite event log, HTTP API |
| `packages/ui` | React interface (Vite, Tailwind CSS, shadcn/ui), served by core |
| `packages/desktop` | Electron shell: window, notifications, Dock badge, keychain |
| `packages/adapter-api` | The types every adapter implements |
| `packages/ext-*` | Adapters: Claude Code and pi-agent in code, Codex and Gemini CLI as manifests |

An agent that speaks the Agent Client Protocol (ACP) needs only a manifest under the `roster` key of its `package.json`: the command to start it, which environment variables carry a model API, and how to sign in. See [`packages/ext-codex`](packages/ext-codex/package.json).

## License

[Apache License 2.0](LICENSE). Bot avatars come from [ip-as-logo](https://github.com/s1dashu/ip-as-logo-skill) and provider marks from [LobeHub Icons](https://github.com/lobehub/lobe-icons), both MIT.
