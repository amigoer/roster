# 接入更多 ACP agent

> 第三轮 · 2026-09-19 · 最近改动 2026-09-21（接入 Qwen Code、Qoder CLI；预设按协议兜底、按来源加启动参数、启动时写 PWD；Cline 暂缓）

**下一批 harness 还是按清单接：先补通道，不给哪一家单写适配代码。** 这一批四家：Cursor、Kimi Code、DeepSeek Harness、ZCode，后面还排着 Qwen Code、Qoder CLI、Copilot CLI 这些。它们大多原生支持 ACP，但形状各不一样：有的没有 npm 包，有的没有登录，有的恢复会话只认 `resume`。与其逐家写适配器，不如把这些差别做成清单里能声明的字段：通道补一次，之后每家还是一份清单。接 ACP agent 的基本做法见 [底层执行器](harness.md)，这一册只写新东西：各家现状、通道要补的几件事、先后、接入清单、还没查清的。

**这几家的模型今天已经能用，接 harness 图的是订阅和手感。** Kimi、DeepSeek、GLM 都提供 Anthropic 兼容的端点，Claude Code 接上就能跑，pi-agent 也有它们的预设。专门接各家自己的 harness，是为了各家的订阅登录（Cursor 账号、Kimi Code 会员、GLM Coding Plan），和为自家模型调过的工具与提示词。所以排先后时，有订阅的排前面。

## 起点：Grok Build 带来的

Grok Build 是照清单接进来的第三个 ACP agent，没写一行适配代码，但通道多了两样，验证的办法也定了下来：

- **`permissionModes: false`**：有权限模式、但客户端切不了的 agent，改由闸门按档位管它问到的调用，会话里切的是档位。
- **`sessionMeta`**：每次开会话、恢复会话都随 `_meta` 发给 agent 的设置。Grok Build 靠它把自己钉在「先问」，本机配置里的一律放行绕不过闸门。
- **验证**：把 agent 的数据目录指到临时目录（各家都有 `*_HOME` 一类的变量），再接一个本地的假 OpenAI 端点跑一整轮：工具调用、权限卡片、放行、回复、重启后恢复。不花钱，不碰真账号；订阅那条最后用真账号手测。

## OpenCode：第一个按热度接进来的

2026-09-20 接上，只有清单，没写适配代码。用的是它自己的登录，接模型 API 留到通道补齐以后。

- **程序**：npm `opencode-ai`，postinstall 把平台二进制放到 `bin/opencode.exe`；curl 脚本装到 `~/.opencode/bin/opencode`。`--version` 只打版本号。入口 `opencode acp`。
- **来源**：只有订阅一种，就是它自己能登的那些：OpenCode Zen / Go、ChatGPT Plus / Pro、Copilot、GitLab Duo、SuperGrok。不登录也能用免费模型；环境变量里的密钥（比如 `DEEPSEEK_API_KEY`）它也认，这些模型一起列出来。登录命令 `opencode auth login`。它的 `authMethods` 按旧的 terminal-auth 约定写，`authenticate` 什么也不做，所以 Roster 声明认这个约定，登录那栏只给命令。
- **权限**：它默认 `"*": "allow"`，只有设成 ask 的调用才走 `request_permission`，不钉的话闸门什么都看不见。清单的 `fixedEnv` 设了 `OPENCODE_PERMISSION`：edit、bash 先问，task 禁用。禁 task 是因为它的 ACP 桥找不到子会话时，直接不回权限请求，子 agent 会一直等下去，连只读的 explore 子 agent 也会跑 bash。build / plan 管的是能做什么，不管审批，所以声明 `permissionModes: false`，交给闸门按档位管。
- **被拒之后**：它默认被拒一次就结束这一轮，一个字不回。讨论模式里只读的 bot 一试着改文件就没声了，所以 `fixedEnv` 另设 `OPENCODE_CONFIG_CONTENT`，打开 `experimental.continue_loop_on_deny`，被拒的结果交回给模型接着说。
- **写文件**：放行一次编辑后，它不看客户端声明的能力，照样调 `fs/write_text_file`。Roster 不接这个方法，它也不等回复，文件由它自己的工具写。
- **会话**：`session/load`、`resume`、`list` 都有；模型、思考级别、模式走 `configOptions`。用量随 `usage_update` 来，带费用；模型没写上下文上限时不报。
- **验证**：用真程序接本地的假 OpenAI 端点，XDG 目录指到临时目录，跑了一整轮：写文件和命令都先问、放行后照做；闸门拒绝的写入没有落盘，模型接着回话；重启后 `session/load` 接回原会话；task 不在工具列表里。
- **还没做**：接模型 API，要按协议拼出 `OPENCODE_CONFIG_CONTENT` 里的 provider 配置，和第 4、5 条一起做。一键更新：`opencode upgrade` 没有只查不装的模式，认不出安装方式时还会停下来问。验明正身：npm 上的 `@opencode/cli` 2.0 也会装出一个 `opencode`，见第 2 条。
- **拦不住的**：用户配置里按 agent 写的权限（`agent.build.permission`）排在环境变量后面，会盖过「先问」。本机配置里的 MCP 工具默认放行，闸门看不见。

## DeepSeek Harness：第二个接进来的

2026-09-20 接上。只有清单，但通道补了五样，下面单列。只接 DeepSeek 预设。

- **程序**：npm `@deepseek-ai/dsh`，命令 `dsh`，`--version` 只打版本号。入口 `dsh --profile acp`：第一次用时在 `$DSH_HOME/profiles/acp`（默认 `~/.dsh`）下从模板建出 profile。还是开发者预览，版本钉在 0.1.5-rc.2，标实验。
- **来源**：没有登录，`authMethods` 是空的，所以清单写 `own: false`，只接模型 API。接的是 DeepSeek 预设：密钥进 `DEEPSEEK_API_KEY`，地址进 `DEEPSEEK_BASE_URL`，地址取自 pi 的预设目录，端点自己写了地址的以端点为准。它也能接 OpenAI 兼容的网关，但会话里只列 DeepSeek 的四个模型，接别家端点选不了那家的模型，所以不收自定义端点。
- **权限**：它管权限的是沙箱，没有模式。默认 `workspace-write`：工作区里改文件、在沙箱里跑命令都不问，只有越出沙箱才发审批，闸门什么都看不见。清单的 `fixedEnv` 把 `DSH_PERMISSION_MODE` 钉在 `read-only`：改动先被沙箱拒掉，模型照提示带上 `sandbox_permissions` 和 `justification` 重试，这一步才走 `request_permission`，闸门就都看得到了。代价是每次改动多一轮模型调用。只读的命令照常直接跑；不写文件、只动网络的命令，闸门也看不见。
- **工具**：`tool_call` 带标题（write、bash 这样的工具名）和参数，kind 一律是 other；权限请求只带 `toolCallId`。
- **会话**：没有 `session/load`，有 `resume`、`list`、`close`。模型和思考级别走 `configOptions`，模型的值是 `["deepseek-official","deepseek-v4-pro"]` 这样的 JSON 对，思考级别是 off / low / high / max。消息整段提交，不逐字流出。
- **验证**：真程序接本地的假 OpenAI 端点，`DSH_HOME` 指到临时目录，走 DeepSeek 预设那条路：密钥和地址都按预设传进去；改动先被沙箱拒、放宽后才问，问到的写文件按「写」、命令按「执行」过闸门；闸门拒掉的没有落盘，模型接着回话；bot 选的 `deepseek-v4-pro` 对上了那个 JSON 对；重启后 `resume` 接回原会话。
- **还没做**：验明正身：`dsh` 也是经典的 distributed shell 的名字，PATH 上那个会被当成它，见第 2 条。按档位换沙箱：可执行档其实不必走 read-only 的两步，要等档位能换环境变量。
- **拦不住的**：只读沙箱里不写文件的命令，比如只发网络请求的。

通道补的五样，都先用假 agent 覆盖：

- **`own: false`**（第 3 条）：没有自带登录的类型，只接模型 API，设置页不给登录那栏。
- **`presets`**（第 4 条）：清单按预设 id 声明能接哪些、密钥和地址各进哪个变量。预设目录由带代码的 harness 汇总，现在就是 pi 报的那份；接预设的类型也算能接模型 API，能力、建 agent、bot 编辑器里的组合都认它。
- **先 `session/resume`**（第 6 条）：agent 声明了就用它，失败或没声明再退回 `session/load`。
- **权限请求按 id 合并**：`tool_call` 先报过的标题、kind、参数都记着，权限请求只带 id 时补上，卡片上看得到要批的是什么。
- **`toolEffects`**：kind 报 other 的 agent，由清单按工具标题说它是读、写还是执行，闸门照这个管。另外，bot 选的是端点列出的裸模型 id，agent 用的是「provider + 模型」时，只要正好有一个对得上，就选那一个。

## Kimi Code：第三个接进来的

2026-09-20 接上，订阅和模型 API 两条都有，通道又补了五样。

- **程序**：npm `@moonshot-ai/kimi-code`，命令 `kimi`，是跑在 Roster 自己运行时上的脚本，要 node ≥ 22.19。curl 脚本装到 `~/.local/bin/kimi`。`--version` 只打版本号，入口 `kimi acp`。版本钉在 2.0.2。
- **登录**：一个 terminal 类的方法，命令是 `kimi login`，走设备码登录；没登录时开会话报 -32000 Authentication required。数据目录由 `KIMI_CODE_HOME` 指，默认 `~/.kimi-code`。
- **模型 API**：`KIMI_MODEL_NAME`、`KIMI_MODEL_API_KEY`、`KIMI_MODEL_BASE_URL`、`KIMI_MODEL_PROVIDER_TYPE` 合成一个 provider，它成为默认模型，账号里的模型还在列表里。自定义端点按协议接：OpenAI 兼容对 openai，Anthropic 兼容对 anthropic；预设接 `moonshotai`、`moonshotai-cn`（对 kimi）和 `kimi-coding`（对 anthropic）。模型 id 只在启动时进环境变量，会话开了不再按它切：切了可能换到账号里同名的模型，走的就是订阅了。
- **权限**：模式 default、plan、auto、yolo，管的就是审批。可是它的 `config.toml` 能把默认模式写成 yolo，那样一个都不问。所以清单写 `permissionModes: false`，交给闸门按档位管，另用 `pinnedMode` 把每个会话一开始就放回 default。实测：配置里写着 yolo，写文件和命令照样都问。读文件不问。
- **子 agent**：Agent 工具开的子 agent 要写文件，权限请求会用父会话的 id 转出来，不会卡死；但事先没有 `tool_call`，只带标题和一句它自己的描述。标题靠清单的 `toolEffects` 定是写还是执行，描述显示在卡片上。
- **提问**：AskUserQuestion 也走权限请求，每个答案是一个 allow_once，另有一个「Skip」。Roster 答 Skip，让它改用文字问，不替人挑答案。
- **plan 模式**：模型能自己调 EnterPlanMode 进去；退出要批准，选项是 Approve 和两个拒绝。清单把 ExitPlanMode 算作写：可写档以上自己批，之后的写照样过闸门。
- **工具**：`tool_call` 带 kind，参数不在 rawInput，而是 content 里一段 JSON 文本；权限请求只带标题和描述。
- **会话**：load、resume、list、close、fork 都有，Roster 用 resume。模型、thinking（开 / 关）、模式走 `configOptions`。
- **验证**：真程序、隔离的 `KIMI_CODE_HOME`（配置里故意写 yolo）、本地假 OpenAI 端点，走自定义端点那条路：写文件先问、参数和描述都在，命令按执行档被拒，提问被跳过，子 agent 的写先问，重启后 resume 接着原会话；界面上两张权限卡片一张有参数、一张只有它那句描述，都看得明白。没登录时登录那栏只给 `kimi login`。订阅那条要真账号，还没手测。
- **还没做**：验明正身：旧的 Python 版 kimi-cli（1.x）也叫 `kimi`，也有 `kimi acp`，PATH 上是它就会被当成 Kimi Code，见第 2 条。node 版本：`pnpm core` 用本机 node，低于 22.19 跑不了，见第 9 条。一键更新：`kimi upgrade` 没有只查不装的模式。模型 API 的 agent 在会话里换不了模型。提问以后可以做成聊天里的问题卡。

通道补的五样：

- **启动时带上模型和定值**（第 5 条）：映射加 `model`，存模型 id 的变量；再加 `set`，跟着这个协议或预设一起写死的值。启动推迟到开会话时，那时才知道 bot 选了哪个模型；只探一探能做什么的时候，用端点列出的第一个模型。
- **`pinnedMode`**：每个会话开出来、接回来，都先放进这个模式，不管 agent 自己的设置让它从哪里开始。
- **提问不替人答**：一个权限请求里有不止一个 allow_once，就是在问问题，答它的 reject_once，没有就取消。
- **描述上卡片**：权限请求带着的文字存成调用的 `detail`；没有参数可看时，卡片上显示它。
- **JSON 文本当参数**：调用没有 rawInput、content 又正好是一个 JSON 对象的文字时，拿它当参数。只用于显示，闸门看的是 kind。

## Qwen Code：第四个接进来的

2026-09-21 接上，订阅和模型 API 两条都有，通道补了三样。

- **程序**：npm `@qwen-code/qwen-code`，命令 `qwen`，是跑在 Roster 自己运行时上的脚本，要 node ≥ 22。官方的 curl 脚本自带一份 node，装到 `~/.local/bin/qwen`。`--version` 只打版本号，入口 `qwen --acp`。版本钉在 0.24.2。
- **登录**：Qwen 账号走设备码，但 ACP 里只报了「用 OpenAI 密钥」一个方法，Qwen 账号那个没报出来，所以登录交给终端：清单写 `qwen`，在它自己的界面里登。数据目录由 `QWEN_HOME` 指，默认 `~/.qwen`。
- **模型 API**：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 一组，认 openai 和 openai-responses 两种协议，地址要带 `/v1`。要紧的是**登录态排在环境变量前面**：本机登过 Qwen 账号的，`settings.json` 里记着 `qwen-oauth`，只给环境变量它照旧用账号，开会话直接报「要先登录」。所以按来源加上 `--auth-type`，端点这条才算数。Anthropic 协议它也接，但密钥是按 `Authorization: Bearer` 发的，Anthropic 官方端点认的是 `x-api-key`，接上去会 401，所以清单不收这个协议。
- **权限**：模式 plan、default、auto-edit、auto、yolo，管的就是审批，默认是 auto——由模型分类器自己批「安全」的调用，写文件根本不问，闸门看不见。所以清单声明 `permissionModes: false`，并在命令里写死 `--approval-mode default`：写文件和命令都先问，读文件不问。用启动参数而不是 `pinnedMode`，是因为它从进程起就生效，接回来的会话也算数。
- **子 agent 和 plan 模式**：这两样都会绕开闸门，清单用 `--exclude-tools` 去掉。子 agent 是 Agent 工具开的后台 agent，在信任目录里按 auto-edit 跑：批准 Agent 一次之后，它写文件不再问，闸门一个都看不到（命令倒是跑不成，后台没人可问，直接失败）。plan 模式是模型自己能进，退出时的权限请求给了两个「允许一次」（回到原模式、手动批编辑），Roster 把多个「允许一次」当成问题跳过，于是它退不出来，这一轮还没话说就结束了。
- **工具**：`tool_call` 的 kind 是照协议报的，读、搜索、编辑、执行都对，用不上 `toolEffects`；参数在 rawInput 里。提问是 AskUserQuestion，kind 报 think，只有一个「允许一次」，闸门按读放行，它拿到一个空答案会接着用文字问。
- **被拒之后**：不管拒的是哪个调用，这一轮当场结束，一个字也不回，而且没有开关能改（源码里写死）。闸门拒掉的写入不会落盘，但用户看到的是一张被拒的卡片加一片安静。
- **会话**：load、resume、list 都有，Roster 用 resume。模型和模式走 `configOptions`；模型的值是 `$runtime|openai|<模型>(openai)` 这样的串，接 API 时模型只在启动时进环境变量，会话里不再按它切。它每轮另外会向同一个端点发几次自己的调用（整理记忆、给建议），账单上算用户的。
- **验证**：真程序、隔离的 `QWEN_HOME`（settings 里故意写上 yolo 和 qwen-oauth）、本地假 OpenAI 端点，走 `qwen-token-plan` 预设那条路：预设不在清单里，靠协议兜底接上，密钥和地址照预设进环境变量，`--auth-type` 盖过了账号，模式钉在 default；写文件按「写」、提问按「读」、命令按「执行」过闸门，命令被拒后没有落盘；重启后 resume 接回原会话，agent 记得前一轮。订阅那条要真账号，还没手测。
- **还没做**：一键更新：`qwen update` 没有只查不装的模式。node 版本，见第 9 条。子 agent 和 plan 模式要等第 7 条把档位和模式的关系写明，再看能不能收回来。

通道补的三样：

- **预设按协议兜底**：清单里没写的预设，看它的协议在不在清单的 `env` 里，在就按那份映射接，地址照旧从预设目录取。清单只为要特别对待的预设单写一条（Kimi 的那三个）。通用的 OpenAI 客户端因此不用把二十几个预设抄进清单；Gemini CLI 这样早就接了协议的，也跟着能用上 Google 预设了。
- **按来源加启动参数**：协议或预设的映射除了环境变量，还能写 `args`，启动时接在命令后面。Qwen Code 靠它写明这个端点说的是哪种协议，盖过本机登录态。
- **`_meta` 里的 terminal 登录**：`_meta.type` 是 terminal 的登录方法也当终端登录看，参数取 `_meta.args`；清单写了登录命令的，一律不再列这些方法。否则界面上会多出一个按了只报错的「用 OpenAI 密钥」。

## Qoder CLI：第五个接进来的

2026-09-21 接上，只有订阅一种来源，通道补了一样。

- **程序**：npm `@qoder-ai/qodercli`，官方推荐的是 curl 脚本装的原生二进制，npm 那条是兼容老环境用的（要 node ≥ 20）。npm 包给两个命令：`qodercli` 是 agent 本身，`qoder` 是个派发器，第一个参数是已存在的路径或 `ide`、`chat` 这些词时转给 Qoder IDE。Roster 用 `qodercli`，原生装法把它放在 `~/.local/bin/qodercli` 或 `~/.qoder/bin/qodercli/qodercli`。`--version` 只打版本号，入口 `--acp`（帮助里没列这个参数，文档里有）。版本钉在 1.1.59。
- **登录**：Qoder 账号，`qoder login` 走浏览器；也认 `QODER_PERSONAL_ACCESS_TOKEN`。ACP 里报一个 terminal 类方法，可它 `_meta` 里写的命令是 node 解释器的路径，按那个提示登不了，所以清单直接给登录命令，把它盖掉。配置目录 `~/.qoder`，`QODER_CONFIG_DIR` 可改。
- **模型 API**：没有。BYOK 要在 `/model` 的向导里连，可选的家数和字段由账号决定，官方文档明写不要手改 `settings.json`；包里也没有 `OPENAI_*` 一类的环境变量。所以清单不写 `env`，只有订阅一种来源。模型随账号来：Qwen3.8-Max（0.20x 额度）和 Qwen3.8-Flash（0.00x，不计额度）。
- **权限**：模式 default、acceptEdits、auto、dontAsk、yolo，管的就是审批，ACP 里默认就是会问的 default。可是 `~/.qoder/settings.json` 的 `general.defaultPermissionMode` 能把默认改成 bypass_permissions，那样一个都不问；它的权限来源分八层，命令行参数（第 5 层）排在三份设置文件（第 1-3 层）之上，所以清单在命令里写死 `--permission-mode default`，再声明 `permissionModes: false` 交给闸门按档位管。只读命令（`ls`、`pwd`、`cat`）它自己放行，闸门看不见；写文件和别的命令都问。
- **子 agent**：Agent 工具的 kind 报 think，但子 agent 每个要批的调用都照样从同一条 `request_permission` 转出来，闸门都看得见，所以不像 OpenCode、Qwen Code 那样要禁掉。
- **被拒之后**：工具结果会告诉模型这次被拒、不要重试，它换一种办法再被拒，就用文字说明然后停下。不会一声不响地结束一轮。
- **工具和事件**：`tool_call` 的 kind 按协议报（edit、execute、think），参数在 `rawInput` 里，`_meta.qoder.toolName` 另带工具名，用不上 `toolEffects`。权限选项把「本会话都允许」排在第一个，Roster 只答一次性的那两个。没有 `usage_update`，用量在一轮结果的 `_meta.quota` 里，所以上下文占用读不到。
- **会话**：new、load、resume、list、fork、close、delete 都有，Roster 用 resume；重启后接回原会话，模型记得上一轮。恢复出来的会话模型会退回账号默认，Roster 每次开会话都重新带上 bot 选的那个。
- **改 shell 配置**：第一次跑起来它会把一段 PATH 写进 `~/.zshenv`、`~/.zprofile`、`~/.zshrc`（`~/.qoder/entry/.rc-written-sentinel` 记着 `auto_first`），指向它自己的派发器目录。源码里有开关 `QODER_NO_RC`，清单用 `fixedEnv` 设成 1，Roster 起的进程不碰这些文件。沙箱里没能复现触发的条件，所以这条是照源码下的保险，不是实测。
- **验证**：真账号加不计额度的 Flash 模型，走 Roster 自己的清单跑通了：登录状态 ok，两个模型都列得出，写文件按「写」过闸门并落盘，命令按「执行」被闸门拒掉、没有落盘、模型用文字解释了，重启后 `resume` 接回原会话并记得上一轮写的是哪个文件。
- **还没做**：一键更新：`qodercli update --check` 只打人话，没有 JSON，目录项就不写更新。它自己默认开着自动更新，Roster 下载的那份也会自我更新，版本钉不住。
- **拦不住的**：用户自己 `settings.json` 里的 allow 规则（第 1-3 层）仍然能放行具体工具，那些调用不会问，闸门也看不见。额度用完时只有 0.00x 的 Flash 还能跑。

通道补的一样：

- **启动时把工作目录也写进 `PWD`**：进程的 cwd 一直是会话的目录，但 `PWD` 是从宿主继承的，指着 Roster 自己的启动目录。Qoder CLI 的模型照着 `PWD` 猜，把文件写到了那个目录里（第一次实测时写进了 Roster 自己的仓库）。现在 spawn 时一并把 `PWD` 设成会话目录。

## 各家现状

2026-09-19 查的，出处列在文末。

| | 出品 | ACP 入口 | 自带登录 | 接模型 API | 结论 |
|---|---|---|---|---|---|
| Cursor | Cursor | `agent acp` | Cursor 账号，`agent login` | 不接 | 接；先补程序识别 |
| Kimi Code | 月之暗面 | `kimi acp` | Kimi Code 会员，`kimi login` | `KIMI_MODEL_*` 一组变量 | 已接，见上文 |
| DeepSeek Harness | DeepSeek | `dsh --profile acp` | 无 | DeepSeek 预设 | 已接，见上文 |
| ZCode | 智谱 | 没有官方入口 | app 里的 Z.ai / BigModel 账号 | app 里配 | 暂缓 |

### Cursor

- **程序**：官方只给 curl 脚本（`curl https://cursor.com/install -fsS | bash`），装到 `~/.local/bin/agent`，自己更新；没有 npm 包，Roster 装不了，只能检测。命令以前叫 `cursor-agent`，两个名字都要认；`agent` 这个名字太泛，要验明正身（通道第 2 条）。
- **登录**：`agent login`；ACP 里报的方法叫 `cursor_login`。环境里有 `CURSOR_API_KEY` 也认。
- **模型 API**：不接。模型来自 Cursor 账号，这个 harness 只有订阅一种来源。
- **权限**：模式 agent / plan / ask 管的是能做什么，不管审批；审批走 `session/request_permission`，选项是允许一次、总是允许、拒绝一次。所以声明 `permissionModes: false`，交给闸门按档位管（通道第 7 条）。
- **会话**：有 `session/load`。MCP 读 `.cursor/mcp.json`；团队级的 MCP 在 ACP 里不生效。
- **扩展方法**：`cursor/ask_question`、`cursor/create_plan` 是它向客户端要回复的请求（通道第 8 条）。

### Kimi Code

已接，见上文。接之前这里定的档位映射（只读对 plan、可执行对 yolo）没有用：yolo 什么都不问，闸门和写锁都看不见，最后是交给闸门按档位管、把模式钉在 default。

### DeepSeek Harness

已接，见上文。接之前这里写过「workspace-write 先问」，实测不是：工作区里的改动它都不问。

### ZCode

- **是什么**：智谱给 GLM-5.3 做的桌面开发环境，文档里给的下载是 macOS 版。它自带 `zcode` CLI，无头后端是私有协议的 `zcode app-server --stdio`。登录用 Z.ai 或 BigModel 账号，或者 GLM Coding Plan；凭据和 provider 配置在 `~/.zcode/v2/config.json`。
- **ACP**：官方没有。社区有 `@brokkai/zcode-acp` 一类的适配器，包着 app-server 翻成 ACP，分叉很多，并且声明与智谱无关。
- **结论**：暂缓，理由见「不做」。GLM 眼下走 Claude Code 接智谱的 Anthropic 兼容端点，或者 pi-agent 的智谱预设。

## 通道要补的几件事

编号供下文引用。每条都先用测试里的假 agent 覆盖，不依赖任何一家。

1. **程序不一定来自 npm。** 目录现在假定程序都能用 npm 装；Cursor 只有 curl 脚本，ZCode 是 app 包。目录项里的 npm 改成可选：没有时 Harness 卡片不给「下载」，只给官方的安装命令让人复制，和终端登录一样，Roster 不代跑。检测照旧，PATH 和常见位置之外再加 app 包里的路径。（Cursor，以后的 ZCode）
2. **验明正身。** `agent`、`grok`、`kimi` 这种命令名谁都能叫：PATH 上叫 `agent` 的多半不是 Cursor，旧的 kimi-cli 也叫 `kimi`，社区的 grok-cli 也装出一个 `grok`。目录项加一条 `--version` 输出要满足的式子，对不上就不算检测到，卡片上说明找到的同名程序不是它。（Cursor 必须；Kimi Code、Grok Build 顺手补上）
3. **没有自带登录的 ACP agent。**（已做，2026-09-20）只有清单的 ACP 类型现在一律按「有订阅」建，加载器里写死了。清单加 `own: false`：这种类型没有订阅 agent，agent 页直接选模型 API，和 pi-agent 一样。（DeepSeek Harness）
4. **预设接到 ACP 类型上。**（已做，2026-09-20；目前只有 DeepSeek Harness 声明了预设）ACP 类型原先只收自定义端点：预设是 pi 报的，别的类型认不得。可用户最先加的往往就是预设，DeepSeek、Moonshot、xAI、OpenAI 都是；结果 DeepSeek Harness 用不上 DeepSeek 预设，Grok Build 用不上 xAI 预设，Codex 也用不上 OpenAI 预设。清单按预设 id 声明能接哪些、密钥进哪个变量；地址和协议照旧从预设目录里取，启动时补进端点，清单里不再抄一遍。（DeepSeek Harness 必须；其余 ACP agent 都受益）
5. **启动时带上模型和定值。**（已做，2026-09-20）协议到环境变量的映射原先只有地址和密钥两项；Kimi Code 接 API 还要模型 id，外加一个写死的类型值。映射加上 `model` 和定值两项。不分来源、每次都带的定值已经有了，就是清单的 `fixedEnv`（OpenCode 用它）；还缺按来源的定值和模型。模型开会话时才定，所以环境变量改到开会话时解析，不在建 runtime 时；会话里换模型就是带新变量重开后端会话，能 `resume` 就接着原会话。（Kimi Code）
6. **优先 `session/resume`。**（已做，2026-09-20）恢复原先只走 `session/load`，它把历史重放一遍，Roster 再全部丢掉。ACP v1 的 `session/resume` 只恢复、不重放：agent 声明了就用它，没有再退回 `load`。（DeepSeek Harness 必须；Kimi Code 也更快）
7. **档位到模式明写。** 现在是按模式名里的 yolo、auto、edit 这些词去猜三档各对应哪个模式。Cursor 的 agent / plan / ask 管的是能做什么，猜出来是错的；Kimi Code 的 yolo 和 auto 都像「可执行」，但只有 yolo 还会把有风险的调用交给人。清单可以直接写三档各对哪个模式，猜只作兜底。模式不管审批的，就声明 `permissionModes: false` 交给闸门；讨论这种只读的场合再另指一个只读模式（Cursor 的 ask），省得它一轮轮去试着写文件再被拦下。（Cursor、Kimi Code）
8. **要等回复的扩展方法。** Cursor 会向客户端发 `cursor/ask_question`、`cursor/create_plan` 并等回复；Roster 对不认识的请求一律回「没有这个方法」。先实测 Cursor 收到后是换条路走，还是整轮失败。最少要保证一轮不卡死、失败时说得清原因；以后可以把 ask_question 接成聊天里的一张问题卡。（Cursor）
9. **核对程序要的 node 版本。** 脚本类的程序跑在 Roster 自己的运行时上：桌面端是 Electron 44 自带的 node 24，`pnpm core` 用的是本机的 node，README 只要求 22.13。Kimi Code 要 22.19 以上。跑之前读程序包里的 `engines.node`，不满足就说清楚缺什么，不让它半路崩。（Kimi Code）
10. **只答一次性的选项。**（已做，2026-09-20）权限应答原先取 agent 给的第一个「允许」类选项，允许一次和总是允许不分先后；哪家把总是允许排在前面，Roster 就替人答成了永久放行，之后同类调用它不再问，闸门也就看不见了。Gemini CLI 正是把「本会话都允许」排在第一个。现在只选 `allow_once` / `reject_once`，没有一次性的选项就当取消，拒绝那边同理。

## 顺序

**2026-09-20 起按热度排：知名的开源 agent 先接，闭源的按用量排在后面，用得最少的最后。** 开源的看 GitHub star，闭源的看 npm 周下载这类用量；卡在别的问题上的留在原位，标出卡在哪。第一个是 OpenCode，第二个是 DeepSeek Harness，第三个是 Kimi Code，第四个是 Qwen Code，第五个是 Qoder CLI，都已经接上，见上文。Cline 暂缓：npm 上发的 macOS 二进制签名全是坏的，macOS 27 一启动就杀（[cline/cline#14209](https://github.com/cline/cline/issues/14209)），修复已合并、还没发版，发了再接。下面 A1 到 A4 是按旧的排法写的，A1、A4 已经做完。

里程碑和做完的标志见 [路线图](roadmap.md) 的 A1 到 A4。这条线和移动端不抢先后，插空做。

- **A1 · Kimi Code 订阅。**（已做，2026-09-20）订阅那条还要真账号手测。
- **A2 · 通道补齐。** 还剩第 1、2、7 条，全用假 agent 测；第 3、4、5、6、10 条已经随 OpenCode、DeepSeek Harness、Kimi Code 做了，Qwen Code 又补了预设按协议兜底、按来源加启动参数和 `_meta` 里的 terminal 登录，Qoder CLI 补了启动时写 `PWD`。
- **A3 · Cursor。** 用户最多，但离不开第 1、2、7 条，第 8 条还得实测，所以排在通道之后。
- **A4 · Kimi Code 接 API，DeepSeek Harness。**（已做，2026-09-20）还剩第 9 条，核对程序要的 node 版本。
- **ZCode 暂缓。** 什么时候重开见「不做」。

排队的，每家照「接入清单」走一遍，大致按对用户的用处排：

- **Qwen Code**：已接，见上文。接之前这里写的「DashScope 密钥（已有阿里的预设）」不准：预设目录里阿里那几个叫 `qwen-token-plan`，现在按协议兜底，任何 OpenAI 兼容的预设都能接。
- **Qoder CLI**：已接，见上文。接之前这里写的入口 `qoder --acp` 对，但 Roster 用的是 `qodercli`：`qoder` 是会转给 IDE 的派发器。
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
- **旧的会话模型接口**：`models` 加 `session/set_model` 这一套，grok 1.0.16 之前只有它；Roster 只认 `configOptions`，这些版本在会话里选不了模型。各家都在往 `configOptions` 走，先不补；主力 agent 里有停在旧接口的再说。

## 出处

- Cursor：[ACP](https://cursor.com/docs/cli/acp)、[安装](https://cursor.com/docs/cli/installation)
- Kimi Code：[kimi acp](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)、[kimi 命令](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)、[环境变量](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)、[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
- DeepSeek Harness：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，其中 `packages/acp/acp` 的 README 和 `.agents/notes` 里的两篇 ACP 笔记
- Qwen Code：[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)，以及 npm 包里 `qwen --help` 和它自己的 ACP 实现
- Qoder CLI：[ACP](https://docs.qoder.com/cli/acp)、[安装与升级](https://docs.qoder.com/cli/installation)、[权限](https://docs.qoder.com/cli/permissions)、[自定义模型](https://docs.qoder.com/cli/custom-models)
- ZCode：[文档](https://zcode.z.ai/en/docs/welcome)、[连接模型与套餐](https://zcode.z.ai/en/docs/configuration)、社区适配器 [BrokkAi/zcode-acp](https://github.com/BrokkAi/zcode-acp)
- 排队的：[ACP 名录](https://agentclientprotocol.com/overview/agents)、[Qoder CLI 的 ACP](https://docs.qoder.com/cli/acp)、[Copilot CLI 的 ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)
