# 接入更多 ACP agent

> 第三轮 · 2026-09-19

**下一批 harness 还是按清单接：先补通道，不给哪一家单写适配代码。** 这一批四家：Cursor、Kimi Code、DeepSeek Harness、ZCode，后面还排着 Qwen Code、Qoder CLI、Copilot CLI 这些。它们大多原生支持 ACP，但形状各不一样：有的没有 npm 包，有的没有登录，有的恢复会话只认 `resume`。与其逐家写适配器，不如把这些差别做成清单里能声明的字段：通道补一次，之后每家还是一份清单。接 ACP agent 的基本做法见 [底层执行器](harness.md)，这一册只写新东西：各家现状、通道要补的几件事、先后、接入清单、还没查清的。

**这几家的模型今天已经能用，接 harness 图的是订阅和手感。** Kimi、DeepSeek、GLM 都提供 Anthropic 兼容的端点，Claude Code 接上就能跑，pi-agent 也有它们的预设。专门接各家自己的 harness，是为了各家的订阅登录（Cursor 账号、Kimi Code 会员、GLM Coding Plan），和为自家模型调过的工具与提示词。所以排先后时，有订阅的排前面。

## 起点：Grok Build 带来的

Grok Build 是照清单接进来的第三个 ACP agent，没写一行适配代码，但通道多了两样，验证的办法也定了下来：

- **`permissionModes: false`**：有权限模式、但客户端切不了的 agent，改由闸门按档位管它问到的调用，会话里切的是档位。
- **`sessionMeta`**：每次开会话、恢复会话都随 `_meta` 发给 agent 的设置。Grok Build 靠它把自己钉在「先问」，本机配置里的一律放行绕不过闸门。
- **验证**：把 agent 的数据目录指到临时目录（各家都有 `*_HOME` 一类的变量），再接一个本地的假 OpenAI 端点跑一整轮：工具调用、权限卡片、放行、回复、重启后恢复。不花钱，不碰真账号；订阅那条最后用真账号手测。

## 各家现状

2026-09-19 查的，出处列在文末。

| | 出品 | ACP 入口 | 自带登录 | 接模型 API | 结论 |
|---|---|---|---|---|---|
| Cursor | Cursor | `agent acp` | Cursor 账号，`agent login` | 不接 | 接；先补程序识别 |
| Kimi Code | 月之暗面 | `kimi acp` | Kimi Code 会员，`kimi login` | `KIMI_MODEL_*` 一组变量 | 订阅现在就接；接 API 等通道 |
| DeepSeek Harness | DeepSeek | `dsh --profile acp` | 无 | 只认 `DEEPSEEK_API_KEY` | 接，标实验；先补三样 |
| ZCode | 智谱 | 没有官方入口 | app 里的 Z.ai / BigModel 账号 | app 里配 | 暂缓 |

### Cursor

- **程序**：官方只给 curl 脚本（`curl https://cursor.com/install -fsS | bash`），装到 `~/.local/bin/agent`，自己更新；没有 npm 包，Roster 装不了，只能检测。命令以前叫 `cursor-agent`，两个名字都要认；`agent` 这个名字太泛，要验明正身（通道第 2 条）。
- **登录**：`agent login`；ACP 里报的方法叫 `cursor_login`。环境里有 `CURSOR_API_KEY` 也认。
- **模型 API**：不接。模型来自 Cursor 账号，这个 harness 只有订阅一种来源。
- **权限**：模式 agent / plan / ask 管的是能做什么，不管审批；审批走 `session/request_permission`，选项是允许一次、总是允许、拒绝一次。所以声明 `permissionModes: false`，交给闸门按档位管（通道第 7 条）。
- **会话**：有 `session/load`。MCP 读 `.cursor/mcp.json`；团队级的 MCP 在 ACP 里不生效。
- **扩展方法**：`cursor/ask_question`、`cursor/create_plan` 是它向客户端要回复的请求（通道第 8 条）。

### Kimi Code

- **程序**：npm `@moonshot-ai/kimi-code`，命令 `kimi`，入口是 `dist/main.mjs`，跑在 Roster 自己的运行时上；也有 curl 脚本，装到 `~/.local/bin/kimi`。旧的 Python 版 kimi-cli 在退场，它的命令也叫 `kimi`，要靠版本号分开。
- **登录**：`kimi login` 是设备码登录，不进 TUI，正好当终端登录的命令；ACP 里的方法 id 是 `login`。没登录时开会话报 Authentication required，和现有的判断对得上。
- **模型 API**：它不读壳环境里的 `KIMI_API_KEY`，要靠 `KIMI_MODEL_NAME`、`KIMI_MODEL_API_KEY`、`KIMI_MODEL_BASE_URL`、`KIMI_MODEL_PROVIDER_TYPE`（kimi / openai / anthropic）临时合成一个 provider，启动时就得知道模型 id（通道第 5 条）。Moonshot 预设对 kimi，OpenAI 兼容对 openai，Anthropic 兼容对 anthropic。
- **权限**：有 `session/set_mode`。命令行上的几档是默认、`--yolo`（日常的改动和命令自动放行，有风险的还会问）、`--auto`（从不打断）、`--plan`（只探索）。ACP 里的模式 id 待实测，映射先定成：只读对 plan，可写对默认，可执行对 yolo。不用 auto：有风险的调用还是要交给人。
- **会话**：`session/load` 和 `session/resume` 都有，`set_config_option` 选模型，图片、MCP 都支持；这几家里它的 ACP 做得最全。
- **运行时**：要 node ≥ 22.19（通道第 9 条）。

### DeepSeek Harness

- **程序**：npm `@deepseek-ai/dsh`，命令 `dsh`。开发者预览，README 明说会有不兼容的改动：钉版本、标实验。
- **入口**：`dsh --profile acp`，是 DSH 自己定位为「只面向自动化」的 ACP 子集：会话 new / list / resume / close，`set_config_option` 选模型和思考级别，权限请求，`usage_update`；没有 `session/load`、模式、斜杠命令。消息整段提交，不逐字流出，聊天里看到的是一段一段出来。这是它有意的取舍，照实声明，不去补。
- **登录**：没有，`authenticate` 直接成功，只能接模型 API（通道第 3 条）。
- **模型 API**：官方的 provider 读 `DEEPSEEK_API_KEY`；能不能换地址、接别家端点待查。所以它最该接的是用户已经加过的 DeepSeek 预设（通道第 4 条）。选模型的值是「provider/模型」的不透明串，怎么和端点列出的模型 id 对上要实测。
- **权限**：没有模式，审批由启动配置决定：测试 profile 读 `DSH_PERMISSION_MODE`，workspace-write 先问，danger-full-access 不问。钉在先问，交给闸门按档位管。
- **会话**：只有 `resume`（通道第 6 条），不补的话重启一次丢一次上下文。

### ZCode

- **是什么**：智谱给 GLM-5.3 做的桌面开发环境，文档里给的下载是 macOS 版。它自带 `zcode` CLI，无头后端是私有协议的 `zcode app-server --stdio`。登录用 Z.ai 或 BigModel 账号，或者 GLM Coding Plan；凭据和 provider 配置在 `~/.zcode/v2/config.json`。
- **ACP**：官方没有。社区有 `@brokkai/zcode-acp` 一类的适配器，包着 app-server 翻成 ACP，分叉很多，并且声明与智谱无关。
- **结论**：暂缓，理由见「不做」。GLM 眼下走 Claude Code 接智谱的 Anthropic 兼容端点，或者 pi-agent 的智谱预设。

## 通道要补的几件事

编号供下文引用。每条都先用测试里的假 agent 覆盖，不依赖任何一家。

1. **程序不一定来自 npm。** 目录现在假定程序都能用 npm 装；Cursor 只有 curl 脚本，ZCode 是 app 包。目录项里的 npm 改成可选：没有时 Harness 卡片不给「下载」，只给官方的安装命令让人复制，和终端登录一样，Roster 不代跑。检测照旧，PATH 和常见位置之外再加 app 包里的路径。（Cursor，以后的 ZCode）
2. **验明正身。** `agent`、`grok`、`kimi` 这种命令名谁都能叫：PATH 上叫 `agent` 的多半不是 Cursor，旧的 kimi-cli 也叫 `kimi`，社区的 grok-cli 也装出一个 `grok`。目录项加一条 `--version` 输出要满足的式子，对不上就不算检测到，卡片上说明找到的同名程序不是它。（Cursor 必须；Kimi Code、Grok Build 顺手补上）
3. **没有自带登录的 ACP agent。** 只有清单的 ACP 类型现在一律按「有订阅」建，加载器里写死了。清单加 `own: false`：这种类型没有订阅 agent，agent 页直接选模型 API，和 pi-agent 一样。（DeepSeek Harness）
4. **预设接到 ACP 类型上。** ACP 类型现在只收自定义端点：预设是 pi 报的，别的类型认不得。可用户最先加的往往就是预设，DeepSeek、Moonshot、xAI、OpenAI 都是；结果 DeepSeek Harness 用不上 DeepSeek 预设，Grok Build 用不上 xAI 预设，Codex 也用不上 OpenAI 预设。清单按预设 id 声明能接哪些、密钥进哪个变量；地址和协议照旧从预设目录里取，启动时补进端点，清单里不再抄一遍。（DeepSeek Harness 必须；其余 ACP agent 都受益）
5. **启动时带上模型和定值。** 协议到环境变量的映射现在只有地址和密钥两项；Kimi Code 接 API 还要模型 id，外加一个写死的类型值。映射加上 `model` 和定值两项。模型开会话时才定，所以环境变量改到开会话时解析，不在建 runtime 时；会话里换模型就是带新变量重开后端会话，能 `resume` 就接着原会话。（Kimi Code）
6. **优先 `session/resume`。** 恢复现在只走 `session/load`，它把历史重放一遍，Roster 再全部丢掉。ACP v1 的 `session/resume` 只恢复、不重放：agent 声明了就用它，没有再退回 `load`。（DeepSeek Harness 必须；Kimi Code 也更快）
7. **档位到模式明写。** 现在是按模式名里的 yolo、auto、edit 这些词去猜三档各对应哪个模式。Cursor 的 agent / plan / ask 管的是能做什么，猜出来是错的；Kimi Code 的 yolo 和 auto 都像「可执行」，但只有 yolo 还会把有风险的调用交给人。清单可以直接写三档各对哪个模式，猜只作兜底。模式不管审批的，就声明 `permissionModes: false` 交给闸门；讨论这种只读的场合再另指一个只读模式（Cursor 的 ask），省得它一轮轮去试着写文件再被拦下。（Cursor、Kimi Code）
8. **要等回复的扩展方法。** Cursor 会向客户端发 `cursor/ask_question`、`cursor/create_plan` 并等回复；Roster 对不认识的请求一律回「没有这个方法」。先实测 Cursor 收到后是换条路走，还是整轮失败。最少要保证一轮不卡死、失败时说得清原因；以后可以把 ask_question 接成聊天里的一张问题卡。（Cursor）
9. **核对程序要的 node 版本。** 脚本类的程序跑在 Roster 自己的运行时上：桌面端是 Electron 44 自带的 node 24，`pnpm core` 用的是本机的 node，README 只要求 22.13。Kimi Code 要 22.19 以上。跑之前读程序包里的 `engines.node`，不满足就说清楚缺什么，不让它半路崩。（Kimi Code）
10. **只答一次性的选项。** 权限应答现在取 agent 给的第一个「允许」类选项，允许一次和总是允许不分先后；哪家把总是允许排在前面，Roster 就替人答成了永久放行，之后同类调用它不再问，闸门也就看不见了。改成只选 `allow_once` / `reject_once`，没有一次性的选项就当取消。拒绝那边同理。（所有 ACP agent；和第几家无关，可以先做）

## 顺序

里程碑和做完的标志见 [路线图](roadmap.md) 的 A1 到 A4。这条线和移动端不抢先后，插空做。

- **A1 · Kimi Code 订阅先上。** 它的 ACP 在这几家里最全，订阅那条只要一份清单，和 Grok Build 一样；顺带实测它的模式 id，看第 7 条要不要提前做。
- **A2 · 通道补齐。** 第 1 到 4 条和第 6、7、10 条，全用假 agent 测。四家里有三家等着它；Grok Build、Codex、Gemini CLI 也借第 4 条用上各自家的预设。
- **A3 · Cursor。** 用户最多，但离不开第 1、2、7 条，第 8 条还得实测，所以排在通道之后。
- **A4 · Kimi Code 接 API，DeepSeek Harness。** 第 5、9 条只有它俩要。DeepSeek Harness 还在预览，放最后，接的时候钉住当时的版本。
- **ZCode 暂缓。** 什么时候重开见「不做」。

排队的，每家照「接入清单」走一遍，大致按对用户的用处排：

- **Qwen Code**：`qwen --acp`，npm `@qwen-code/qwen-code`；用 Qwen 账号，或者 DashScope 密钥（已有阿里的预设）。
- **Qoder CLI**：`qoder --acp`，npm `@qoder-ai/qodercli`；`qoder login`，或者环境变量 `QODER_PERSONAL_ACCESS_TOKEN`。
- **GitHub Copilot CLI**：`copilot --acp`（公开预览），npm `@github/copilot`。
- **OpenCode**：`opencode acp`，npm `opencode-ai`；它自己就能接很多家的 API。
- ACP 名录里其余几十家（Goose、Kiro CLI、Mistral Vibe、Cline、Factory Droid、Augment Code、Junie……），有人要再排。

## 接入清单

照 Grok Build 走过的顺序，每接一家都过一遍：

1. **入口**：官方的 ACP 命令和参数；程序怎么装（npm、curl 脚本、app 包），命令名，常见安装位置，`--version` 输出什么样。
2. **更新**：程序有没有自己的更新命令（`grok update`、`agent update`、`kimi upgrade`），有没有只查不装、输出 JSON 的检查；有就写进目录项，Roster 就能在它的页面上一键更新。
3. **登录**：终端登录命令；ACP 报的 `authMethods` 里哪些是 terminal 类、哪些能直接 `authenticate`；没登录时开会话报什么错。
4. **模型 API**：接哪些协议，地址、密钥、模型各进哪个变量，有没有要写死的值；本机已经登录时，API 模式会不会被登录态盖过。Grok Build 就是这样：只给密钥不够，要连地址一起给，它才改用密钥。
5. **权限**：ACP 里有没有模式，模式管不管审批；没有的话，怎么把它钉在「先问」（`sessionMeta`、环境变量、启动参数）；权限请求给哪些选项。
6. **会话**：`load`、`resume`、`list` 各有没有；模型和思考级别走 `configOptions`，还是旧的 `models`。
7. **事件**：是不是逐字流出，有没有 `usage_update`，工具调用带不带 `kind`；有没有要客户端回复的扩展方法。
8. **验证**：隔离数据目录，接假 OpenAI 端点跑一整轮；订阅那条用真账号手测。
9. **落地**：清单、目录项、品牌标（LobeHub Icons 里这几家都有）、目录描述和斜杠命令的中文、README 和 CREDITS、测试。

## 不做

- **不适配私有协议。** ZCode 的 app-server 会随 app 升级而变，跟着它跑等于替别人维护一份协议，也违背「加一个 agent 是写一份清单」。重开的条件：智谱给出官方的 ACP 入口，或者公开并承诺 app-server 协议。想先试的人可以自己写一份清单，挂进 `ROSTER_EXTENSIONS`，指向社区适配器；它不进内置目录。
- **社区适配器不进内置目录。** 维护和授权都不在这边。codex-acp 是例外：它在 ACP 官方的组织下。
- **不代跑别人的安装脚本，不替 agent 登录，不搬凭据。** 沿用 [底层执行器](harness.md) 的规矩：没有 npm 包的程序只给安装命令，登录只给命令，或者走 ACP 的 `authenticate`。

## 待定

要实测才知道的，接到那一家时先查清：

- **Cursor**：客户端不认 `cursor/ask_question`、`cursor/create_plan` 时它怎么办；会话里能不能选模型、走不走 `configOptions`；有没有 `usage_update`。
- **Kimi Code**：ACP 里的模式 id；用 `KIMI_MODEL_*` 合成的 provider，`configOptions` 里是不是只有那一个模型。
- **DeepSeek Harness**：正式的 acp profile 认不认 `DSH_PERMISSION_MODE`；能不能换地址；选模型的值怎么对上端点的模型 id。
- **旧的会话模型接口**：`models` 加 `session/set_model` 这一套，grok 1.0.16 之前只有它；Roster 只认 `configOptions`，这些版本在会话里选不了模型。各家都在往 `configOptions` 走，先不补；主力 agent 里有停在旧接口的再说。

## 出处

- Cursor：[ACP](https://cursor.com/docs/cli/acp)、[安装](https://cursor.com/docs/cli/installation)
- Kimi Code：[kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)、[kimi 命令](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)、[环境变量](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)、[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- DeepSeek Harness：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，其中 `packages/acp/acp` 的 README 和 `.agents/notes` 里的两篇 ACP 笔记
- ZCode：[文档](https://zcode.z.ai/en/docs/welcome)、[连接模型与套餐](https://zcode.z.ai/en/docs/configuration)、社区适配器 [BrokkAi/zcode-acp](https://github.com/BrokkAi/zcode-acp)
- 排队的：[ACP 名录](https://agentclientprotocol.com/overview/agents)、[Qoder CLI 的 ACP](https://docs.qoder.com/cli/acp)、[Copilot CLI 的 ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
