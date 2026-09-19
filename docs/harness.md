# 底层执行器

> 第一轮 · 2026-09-12 · 最近改动 2026-09-20（接入 OpenCode、DeepSeek Harness；清单能写死环境变量、声明预设和工具分类；权限只答一次性的选项）

session 背后真正干活的是现成的 code agent，Roster 不自写 agent loop，只做适配；为什么这样选见 [总体设计](design.md#底层执行器)。这一册讲怎么接：harness、agent、模型来源的层级，适配器怎么装，设置页长什么样，两个后端的控制面，以及事件模型。

## Harness、agent、模型来源：层级是严格的

```
Bot → Agent → Harness（Claude Code / Codex / Gemini CLI / Grok Build / OpenCode / DeepSeek Harness / pi-agent）
        └──→ 模型来源：订阅登录，或者一个模型 API
```

- **Harness** —— 跑 agent 循环的程序加上 Roster 里的适配器，业内就叫 agent harness。**harness 没有实例、没有状态**：每种 harness 全局一个，它只声明有没有订阅登录、能接哪些协议的 API、每种来源下能做什么。程序在哪、订阅有没有登录，是这台机器上这个 harness 的事实，所以程序路径和登录都挂在 harness 上。
- **模型 API** —— 模型从哪调、用谁的密钥：协议、地址、密钥，以及它的 API 列出的模型。它自己不跑任何东西，可以给多个 agent 用。
- **订阅** —— Claude Code 这类订阅拆不成模型：登录属于程序本身，模型目录由程序报告。所以订阅不是模型 API，是 **harness 自带的模型来源**，由驱动这个程序的通道来用：Claude Code 走 Agent SDK，其他 agent 走 ACP。
- **Agent** —— **一个 harness 绑定一个模型来源**，再加一个默认模型和名字，比如「Claude Code · 订阅」「Claude Code · Kimi」「pi-agent · DeepSeek」。数据里叫执行器（`executors` 表）。

**Bot = 人设 + agent + 模型。** 选了 agent，就定了 harness 和模型从哪来；bot 只在这个 agent 的模型里挑一个，不挑就用 agent 的默认模型。

**规矩：**

- **agent 的 harness 建好不能改**，换 harness 就是另一个 agent。来源可以改，已经在会话里的成员提示「设定有更新」，同步后才用新的。
- **协议在建、改 agent 时检查**，建执行器时适配器自己再查一次，对不上的建不出来，并说明原因。
- **每个 harness 最多一个订阅 agent**：登录是这台机器上程序的，只有一个账号。多账号以后再做，到时让 agent 带自己的配置目录。**没有自带登录的 harness（pi-agent、DeepSeek Harness）没有订阅 agent**，agent 页也不给「订阅 / 模型 API」二选一，直接选模型 API。
- **自动起的名字跟着来源走**：名字还是「harness · 来源」这种自动名时，换来源就跟着改名；人起的名字不动。
- **agent 按需建，不自动建。** Bot 编辑器的 agent 下拉先列已有的，再列「能用但还没建」的组合（harness × 订阅、harness × 每个接得上的模型 API），选中就建，所以建 bot 不会多出一步。
- **删除按引用拦**：有 bot 或还在会话里的成员跑在上面的 agent 删不掉；有 agent 接着的模型 API 删不掉。
- **会话里能切模型、思考级别、模式，不能切来源或 agent。** 来源属于 agent，要换就改 bot 或 agent 再同步。同步时换新快照、开新后端会话，会话里切过的选择还有效的就留着。

| Harness | 接模型 API | 订阅登录 |
|---|---|---|
| pi-agent | 进程内注册；pi 自己的 auth 文件不再算数 | 无 |
| Claude Code | Claude Agent SDK，环境变量注入，不读本机设置 | Claude Agent SDK，用程序自己的登录和本机设置 |
| ACP agent（Codex、Gemini CLI、Grok Build、OpenCode、DeepSeek Harness、自定义命令） | ACP，按清单把协议或预设映射到环境变量 | ACP |

**Claude Code 只走 Agent SDK。** 订阅和模型 API 都是同一条通道：PreToolUse 闸门、上下文占用（分类、自动压缩预留、按需加载的工具、各分组明细）、思考级别、fast mode 两边都有。区别只在环境：接模型 API 时是隔离模式，不读 `~/.claude`，免得本机的放行规则和 env 盖过闸门和端点；用订阅时就是本人的 Claude Code，加载 CLAUDE.md、MCP、技能和权限规则，闸门仍然看得到每个调用，只有闸门交给模式决定的调用会碰到本人的放行规则。订阅另外能读套餐用量：先问 SDK 的 `get_usage`（程序用自己的登录去取）；程序太旧答不了时，读程序存下的 OAuth token（macOS 钥匙串或 `~/.claude/.credentials.json`）直接问用量接口，token 只在这一步内存里用，不记日志、不缓存、不给界面。token 过期不替程序刷新，免得和它抢着改同一份凭据。

**以前订阅走过 ACP（claude-agent-acp）。** 换到 SDK 是因为 ACP 只报总量：没有分类明细、没有套餐用量、闸门拦不全。ACP 上建的会话 id 就是 Claude Code 自己的会话 id，同一工作目录下 SDK 能直接接着恢复。

**ACP 通道的能力要老实声明。** 闸门退化成 agent 自己的 `request_permission`：agent 不问的调用拦不住、改不了参数，档位只能靠选模式近似，讨论模式只读因此是尽力而为。有权限模式却不让客户端切的 agent（Grok Build）在清单里写 `permissionModes: false`，档位就回到闸门上：它问到的调用按档位放行，超出的转给人。清单的 `sessionMeta` 随每次开会话、恢复会话发给 agent，Grok Build 靠它把自己的模式钉在「先问」，免得本机配置里的一律放行绕过闸门。只从环境变量读这类设置的 agent 用清单的 `fixedEnv`：每次启动都带上，盖过从宿主继承来的同名变量，不是字符串的值按 JSON 传。OpenCode 默认一律放行，闸门什么都看不见，所以靠它把编辑和命令钉在「先问」。**agent 问到的调用，Roster 只答一次性的选项**（`allow_once` / `reject_once`），没有就当取消：答了「总是」，agent 之后同类调用就不再问，档位和写锁都管不到了。Gemini CLI 就把「本会话都允许」排在第一个。权限请求可以只带调用的 id，Roster 拿 agent 先前报过的 `tool_call` 补全名字和参数；把工具一律报成 other 的 agent，由清单的 `toolEffects` 按工具名说它是读、写还是执行。恢复会话先用 `session/resume`，只恢复不重放，agent 没声明再用 `session/load`。上下文占用来自 `usage_update`，套餐配额读不到，中途注入没有。界面照旧按能力降级并说明。**能力随 agent**：同一个 harness 上订阅和接 API 的能力声明可以不同；两份一样时界面只列一份。

**登录是 harness 的属性。** 它属于这台机器上的程序，不属于哪个 agent，同一个 harness 上用订阅的 agent 共用它。ACP 的 `authMethods` 说怎么登：terminal 类的 Roster 不代劳，把命令给用户；agent 类的直接发 `authenticate`。按旧的 terminal-auth 约定把命令写在 `_meta` 里的也算 terminal 类，Roster 在 `initialize` 里声明认这个约定；OpenCode 就是这样，它的 `authenticate` 什么也不做。Claude Code 由 SDK 读账号信息判断登没登，登录命令 `claude auth login` 交给用户在终端跑。设置页上，有订阅的 harness 在自己的页面上显示登录状态；agent 页的测试连接测的是这个 agent 实际要跑的组合：订阅登录或模型 API 的密钥，再加程序能不能启动。

## 界面上的词

| 界面上 | 数据里 | 说明 |
|---|---|---|
| Harness（Claude Code、Codex……） | 执行器类型（`HarnessType`）+ `harness_settings` | 程序、订阅登录、能做什么；没有实例。没有好的中文译法，界面上用英文原词，和代码同名 |
| agent（「Claude Code · 订阅」） | 执行器（`executors` 表） | harness + 来源 + 默认模型；bot 选的就是它 |
| 订阅 | `source_kind = 'own'` | harness 自带的登录 |
| 模型 API | `providers` 表，`source_kind = 'endpoint'` 时的 `provider_id` | 密钥和地址 |

**迁移。** 老数据里 bot 自己带来源、执行器只有程序路径。升级时，每个在用的「执行器 + 来源」组合变成一个 agent（老执行器留给第一个组合，完全相同的组合合并成一个），bot 和成员快照都指向它；同类型最早那个执行器的程序路径移到 harness 上；会话里切过来源的成员丢掉那次切换，重新开后端会话。迁移时还不知道 harness 有没有自带登录，所以 pi 上没带来源的老 bot 会迁成「pi-agent · 订阅」，这种 agent 永远启动不了；core 启动时补一步：这个 harness 上正好有一个能跑的模型 API agent，就把 bot 和还在会话里的成员挪过去（成员重开后端会话、补发历史），再归档它；不止一个就不猜，留着并说明原因，打开它直接落在模型 API 上，保存即修好。

## Harness 是扩展，按需安装

常见 agent 会有几十种，不能都塞进包里。**一种 harness = 一个扩展 = 一个 npm 包**，装在 `~/.roster/extensions/<id>` 下各自带 node_modules；只用 Claude Code 就只装它那一个，卸载就是删目录。安装器用 app 自带的 node 跑 npm——agent SDK 带平台相关的二进制（Claude 的 SDK 一个平台包 194MB，pi 也有原生模块），自己打 bundle 会碎，npm 本来就是解决这个的；Zed 装 ACP agent 也是这么做的。

扩展分两种：

- **有代码的**：导出一个 `HarnessType`（Claude Code、pi-agent）。契约就是 `@roster/adapter-api`，纯类型，扩展运行时不依赖 Roster 任何东西；清单里声明契约大版本，对不上的 core 不加载并在设置页说明。
- **只有清单的**：ACP agent 只需要三样东西——命令、协议→环境变量名、登录方式——加一个 npm 依赖（agent 程序本身）。几十种 agent 里大多数是这种：**加一个 agent 是写一份清单，不是写代码。** 下一批的现状和通道要补的几件事见 [接入更多 ACP agent](acp-agents.md)。

所以 **ACP 客户端进 core**：它是协议不是某家 agent，自定义命令不装扩展也能跑。core 自带契约、ACP 客户端、加载器和安装器。

**适配器随 Roster 内置，agent 程序才是要找或要装的东西。** 适配器很薄（Claude 的 SDK 不到 20MB，pi 的库 23MB），几十种也装得下，所以 `packages/ext-*` 直接随 Roster 打包，不用用户装；重的是 agent 程序本身（Claude 的 CLI 194MB、gemini-cli、codex-acp），本机有就直接用，没有才下载到 `~/.roster/agents/<id>`。目录里每个 agent 只描述「程序是哪个 npm 包、命令叫什么、装在哪里」，清单里用 `@program` 指代它。第三方适配器仍走扩展安装那条路，只是目前一个也没有。

装了扩展的类型才出现在 Harness 列表里。卸掉扩展，它上面的 agent 和 bot 留在库里，agent 页和开会话时都说「这个版本不认识它」，装回来就能用——`Registry.from` 把建不出来的原因记下来，就是这个行为。扩展和 core 同进程，不做隔离：装扩展等于装代码，和编辑器扩展一样，信任由人给。

**先看本机有什么，检测到就直接用。** 用户多半已经装了 claude、codex 或 gemini。第一次打开先检测：PATH 上的命令、npm 全局包、常见安装路径，读版本；环境变量从登录 shell 读一次（桌面图标启动的 app 读不到 .zshrc，模型 API「从环境变量读」以前就栽在这里）。检测到的程序不需要任何安装动作，harness 的「程序」按用户指定的 > 检测到的 > Roster 自己装的这个顺序找。只有本机没有的 harness 才显示「下载安装」。**界面只说版本，不说从哪来**：程序是本机检测到的还是 Roster 下载的，用户不关心，能用就显示版本号（pi 这种库形态的显示它带的库版本），用不了才说缺什么；从哪来只留在 harness 页的「程序」设置和总览里的检测结果里。**凭据不搬**：Claude 的登录由 claude 自己用，Roster 只在程序报不出套餐用量时读一次它的 token 去问用量；pi 的 auth.json 和环境变量里的 key 检测到只提示导入成模型 API，导不导由人定。

**更新走程序自己的更新命令。** 本机找到的程序由它自己的安装方式管着，Roster 不另起一套：目录项可以声明程序自带的更新命令，外加一个只查不装、输出 JSON 的检查（Grok Build 是 `grok update` 和 `grok update --check --json`）。core 启动时查一次，打开这个 harness 的页面时再查一次，有新版本就在总览那一行和「程序」里说，点一下跑它自己的更新，输出一行行显示在同一个位置，失败了留着输出、旧版本照常能用。Roster 下载的那份不走这条路，照旧按目录里钉的版本重新下载；人手指定的程序照它的话办，也不代为更新。更新完先重新检测版本、重建 agent；这个 harness 上空闲的会话丢掉旧进程，下一轮用新程序接着原会话，正在跑的等这一轮结束再换。

## 设置页的样子

设置沿用三列，但中列只放页面，不放实例：通用（外观、语言、关于）和 Agent 与模型（Harness、Agent、模型 API）六行，装多少 harness、建多少 agent 它都不变长；每行第二行是一句摘要——主题、语言、能用的 harness 数、agent 数和其中用不了的数、模型 API 数，core 有问题的行用琥珀色提醒。右列是这一项的总览：Harness 页最上面是检测结果，下面每个 harness 一张卡，本机有的直接可用，没有的卡上一键下载；Agent 页按 harness 分组列 agent，每行说来源、默认模型、几个 bot 在用，用不了的说原因；模型 API 页列每个 API 的预设和密钥来源、几个 agent 接着，本机找到还没添加的密钥在下面提示一键添加，密钥存在哪一行放页脚。**在总览里点一项才进它的页面，标题栏带返回**：harness 页有程序（留空用检测到的；本机找到、自带更新命令的可以一键更新，Roster 下载的可以重新下载或卸载）、订阅登录、能做什么、这个 harness 上的 agent；agent 页有来源（订阅或选一个模型 API）、默认模型、名字、测试连接、能做什么、在用的 bot。首启还没有 agent 时直接落在 Harness 页。第二轮在通用下加第七行「手机」：允许手机连接的开关、配对码、已配对的设备（见 [移动端](mobile.md)）。**「外观」管主题、字体和字号，点卡片就生效**：字体只列本机装了的，另有一格填别的名字；字号只改消息和输入框里的文字，界面不跟着缩放。**「关于」只讲 Roster 自己：版本和数据目录，也报 core 在不在跑旧代码**：core 启动后代码又构建过，界面刷新了也没用，这一行会提醒完全退出重开。用到的开源项目不进界面，列在仓库根目录的 `CREDITS.md`，由 README 引用。

**模型 API 页先回答「能不能用」。** 添加分两步：先从带搜索的卡片网格里选从哪调（本机找到的密钥排最前），再填密钥；建好之后预设不能换，页面顶部一行是连接状态，每次保存后自动再测。**模型只以 API 列出的为准，Roster 不做任何模型预设**：预设只管从哪调（地址、协议、密钥叫什么），不带模型列表，也不给模型配名字、上下文、价格——这些预设和厂商实际提供的总会对不上，也维护不过来。打开页面就测一次，测试拉到的 id 原样存下、原样列出；每次测试连接和每次启动都重新拉，列表跟着变不算设定变了，会话里的成员不用同步。agent 的默认模型、bot 选模型、会话里切模型用的都是这一份。API 不提供列表的，给 agent 或 bot 手填模型 id；自定义 API 的模型仍由人填或从接口拉取，测试不会覆盖。pi 跑模型时，自己认得的 id 沿用 pi 的请求参数，不认得的用通用参数，这些都不出现在界面上。

**全部用 shadcn 现成件搭，不再手写选择器。** 协议这类「多选一」用可见的选项卡片；按来源分组的模型选择用带 group 的 Select；状态（已登录 / 未登录 / 版本号 / 没找到程序 / 契约不符）用 Badge；安装进度用 Progress，结果用 toast，警告用 Alert；导入凭据用 Dialog 确认；加载用 Skeleton，不用「加载中…」三个字。

**打磨在 token 层。** 浅色、圆角、大留白，向飞书靠：改的是 `index.css` 里的变量和几个组件变体，结构不动——这正是当初选 shadcn 的原因。一条规矩：**同一种信息全 app 只有一种长相**——agent 在设置页、通讯录、会话栏里是同一个 tile、同一组 Badge；模型 API 的品牌标同理。

**适配器只管跑一个 bot** —— 喂消息、拿事件。这个 bot 是独自在会话里，还是群里三个之一，适配器不知道也不需要知道；否则同一套集成要写两遍，而且必然走偏。

session 是单成员的群，所以**底层只有一条代码路径** —— 界面上呈现成一对一（不显示头像名字、不显示成员列表），仅此而已。

代价是各家暴露的控制面不一样：有的能拦截工具调用、能中途注入上下文，有的只给一条文本流。**第一版接 Claude Code 和 pi-agent** —— 两个都是库形态、控制面够宽，同时做两个反而能防止协议被某一家的怪癖带偏。

规矩是**按能力声明设计协议，不按两者的交集设计**：每个后端声明自己支持什么，界面按能力降级，并明确告诉用户当前后端缺哪些功能。取交集是这类产品的死法 —— 为了对齐把协议压成最小公分母，上面这些功能一个都做不出来。

## 两边的控制面（调研结论）

pi 是 `earendil-works/pi`，MIT，TypeScript。**两个都是 Node 生态，不需要跨语言桥接。**

| 能力 | Claude Agent SDK | pi |
|---|---|---|
| 拦截工具调用 | `PreToolUse` hook | 扩展的 `tool_call` 事件，能 block、能改 `input` |
| 改工具结果 | `PostToolUse` hook | `tool_result` 事件 |
| 中途注入 | streaming input 模式 | `pi.sendMessage(deliverAs: steer / followUp / nextTurn)` |
| 分支与恢复 | `forkSession`、`resumeSessionAt` | JSONL 树，`id`/`parentId`，原地分支 |
| 自定义工具 | `tool()` + `createSdkMcpServer()` | `pi.registerTool()`，可替换内置工具 |
| MCP | 原生 | **不支持**（官方明说，要靠扩展自己加） |
| 成本上限 | `maxBudgetUsd`、`maxTurns` | 无等价物 |

**控制面都够宽，但形状不同** —— 一边是 hooks，一边是 extensions。适配器的活是形状转换，不是能力补齐，这比预期的好。

两条真差异要写进能力声明：**MCP** 和**成本上限**。后者在群聊场景会咬人 —— N 个 bot 各自持有 context，没有硬上限就没有刹车。

## 实现时被推翻的两条

**一、`canUseTool` 不是拦截点，只是「提示」的出口。** Claude Agent SDK 的 `permissionMode: 'default'` 是「对它自己认为危险的操作才提示」，`echo hi` 不算，于是压根不调用 `canUseTool` —— 一个声明只读的 bot 会直接跑命令。**唯一可靠的拦截点是 `PreToolUse` hook**，它对每次工具调用都触发，还带真实 `tool_use_id`。

**二、还要切断两条隐形的旁路。** `settingSources` 默认加载用户自己的 `~/.claude/settings.json`，里面预批准过的工具永远到不了我们的闸门；spawn 出来的 CLI 还会继承宿主的 `CLAUDE_CODE_*` 环境变量，把自己当成别人的子会话、把权限路由回去。两条都要显式关掉 —— **Roster 的闸门和会话的权限模式必须是唯一权威，否则它们就是谎言。**

顺带一个白送的：pi 的 session 是带 `parentId` 的树，原地分支。以后要做「同一个需求跑多个方案再对比」，基础已经在那了。

## 事件模型

**每条事件回答三个问题，写入时就答好、存成列。** 适配器把后端的事件归一成 `NormalizedEvent`，每种带一个 `display` 提示：`message` 自己一条气泡、`fold` 折进「执行了 N 步」卡片、`card` 自己一张卡片（权限、产出物）、`status` 只改状态不上屏。core 再按类型定三个位：`persist`（进不进日志：文本增量一秒几十条，只走 SSE 不落库）、`surface`（上不上屏）、`broadcast`（群里其他成员下一轮看不看得到）。

**只有人说的话、bot 的最终回复和系统通知会广播。** 思考过程永远不广播——一个模型的推理进另一个模型的上下文只是加倍噪音；工具调用和权限请求上屏但不广播，别的成员看结果就够了；`turn.start`、`turn.end`、`cost` 只改状态——运行中不算未读。`surface` 和 `broadcast` 存成列而不是读时算：上屏和投递各是一次索引范围扫描，规则以后改了也不会悄悄改写历史。
