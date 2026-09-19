# Roster

[English](README.md) | **简体中文**

把 code agent 当联系人用：单聊就是一次会话，拉个群就是一支 agent team。

Roster 是给现成编码 agent 用的桌面应用，支持 Claude Code、Codex、Gemini CLI、Grok Build、OpenCode、DeepSeek Harness 和 pi-agent。它不自己写 agent 循环，而是驱动这些 agent，模型升级、提示词调优都由它们自己跟进；Roster 给它们套上 IM 的形态：会话一直都在，bot 配一次到处用，拉个群让几个 agent 在同一个仓库里干活，要你处理的事都在一个列表里。

> [!NOTE]
> 还在早期开发，没有安装包，需要从源码运行。

## 功能

- **bot 就是联系人。** bot 记着名字、头像、预设、agent、模型和权限档，同一个 bot 可以出现在任意多个会话里。
- **群就是 agent team。** 挑几个 bot 拉群，选谁接话：人主导（你 @ 谁谁回复）、群主分发（群主拆任务派给成员）、讨论（每条消息所有成员各说一次，由你拍板）。说话可以并发，改文件一次一个。
- **先用本机已有的 agent。** 检测到就直接用，本机没有的才下载到 Roster 自己的目录。
- **订阅或模型 API，由 agent 定下来。** agent 是一个 harness（Claude Code 这样的 agent 程序）加上模型从哪来：程序自带的订阅登录，或者你添加的模型 API。bot 只选 agent，怎么跑就只在一处决定。密钥可以从环境变量读；存在 Roster 里的密钥，用操作系统保管的密钥加密（macOS 上是钥匙串）。
- **权限档。** 只读、可写、可执行。超出档位的操作变成会话里的权限卡片，不弹阻塞的对话框。
- **要你处理的排最前。** 等你批准、等你回复的会话排在列表最上面，等得越久越靠前；桌面端还有系统通知和 Dock 角标。
- **单聊就是纯聊天**，各自有一个 Roster 数据目录下的聊天空间，和同一个 bot 的多条会话收在一个入口里。**干活就拉群**，一个 bot 也行：建群时选工作目录，之后也能改。附件、`/` 命令和上下文占用面板都已内置。
- **中文和英文界面。** 默认跟随系统语言，也可以在「设置 > 语言」里选；群里的提示和 Roster 交给 agent 的说明跟着界面一起切换。

## 支持的 harness

| Harness | 自带登录 | 模型 API |
|---|---|---|
| Claude Code | Claude 订阅 | Anthropic 兼容的 API |
| Codex | ChatGPT 账号 | OpenAI 兼容的 API |
| Gemini CLI | Google 账号 | Gemini API 密钥 |
| Grok Build | Grok 账号 | OpenAI 兼容的 API |
| OpenCode | 它自己接的服务，从免费模型到 ChatGPT、Copilot | 暂不支持 |
| DeepSeek Harness | 无 | DeepSeek 的 API |
| pi-agent | 无 | 你添加的任意模型 API |

适配器随 Roster 内置；pi-agent 是库形态，不需要另装程序。Codex、Gemini CLI、Grok Build、OpenCode 和 DeepSeek Harness 的支持还在试验阶段。

## 快速开始

需要 Node.js 22.13 及以上和 pnpm 10。Roster 在 macOS 上开发，Windows 和 Linux 还没有测试过。

```bash
git clone https://github.com/amigoer/roster.git
cd roster
pnpm install
pnpm build
pnpm start
```

macOS 第一次启动会问 Roster 能不能发通知，选允许——系统只问这一次，没允许的话回复和权限请求都不会有任何提示。

打开后在「设置 > Harness」看本机检测到了哪些 harness，没有的可以直接下载；在「设置 > 模型 API」添加密钥。agent（harness 加上订阅或模型 API）可以在「设置 > Agent」里建，也可以在建 bot 时直接建。

不想用 Electron 的话，运行 `pnpm core`，再用浏览器打开 http://127.0.0.1:7788。没有桌面端就没有系统钥匙串，存下的密钥不会加密，这时建议从环境变量读密钥。

## 开发

```bash
pnpm typecheck               # 检查所有包的类型
pnpm test                    # 先构建适配器，再跑 core 的测试
pnpm -C packages/ui dev      # Vite 开在 :5173，/api 转发到 :7788 的 core
```

桌面端加载的是构建好的 `packages/ui/dist`，改完界面要运行 `pnpm --filter @roster/ui build`，再刷新窗口。设置 `ROSTER_SCRIPTED=1` 会用一个脚本化的假 agent 代替真实 agent，调界面时方便。

macOS 上 `pnpm start` 会先构建 `packages/desktop/.mac/Roster.app`：把 Electron 的应用包克隆一份，换成 Roster 的名字、标识和签名。系统是按应用包来认通知的发送者和权限的，npm 发的那个包会被直接拒收。APFS 是克隆不是复制，不额外占空间；Electron 版本变了会自动重建。

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `ROSTER_DATA_DIR` | `~/.roster` | 数据库、附件、聊天空间和下载的 agent |
| `ROSTER_PORT` | `7788` | core 监听的端口，只绑 127.0.0.1；被占用时自动换一个空闲端口 |
| `ROSTER_EXTENSIONS` | | 额外的适配器目录，路径列表 |
| `ROSTER_SCRIPTED` | | 设为 `1` 时用脚本化的假 agent |
| `ROSTER_CORE` | `http://127.0.0.1:7788` | UI 开发服务器把 `/api` 转发到哪里 |

## 目录结构

| 路径 | 内容 |
|---|---|
| `packages/core` | 无界面的 Node 服务：会话、轮流发言、SQLite 事件日志、HTTP API |
| `packages/ui` | React 界面（Vite、Tailwind CSS、shadcn/ui），由 core 提供 |
| `packages/desktop` | Electron 外壳：窗口、通知、Dock 角标、钥匙串 |
| `packages/adapter-api` | 适配器要实现的类型 |
| `packages/ext-*` | 适配器：Claude Code 和 pi-agent 用代码实现，Codex、Gemini CLI、Grok Build、OpenCode 和 DeepSeek Harness 只有清单 |

走 Agent Client Protocol（ACP）的 agent 只需要一份清单，写在 `package.json` 的 `roster` 字段下：启动命令、模型 API 对应哪些环境变量、怎么登录。可以参考 [`packages/ext-codex`](packages/ext-codex/package.json)。

## 致谢

Roster 用到的项目、素材以及各自的许可协议，见 [CREDITS.zh-CN.md](CREDITS.zh-CN.md)。

## 许可协议

[Apache License 2.0](LICENSE)。
