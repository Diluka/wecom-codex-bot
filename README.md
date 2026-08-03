# WeCom Codex Bot

通过企业微信智能机器人长连接，把每个单聊或群聊绑定到一个持久化的 Codex CLI
会话。机器人和 Codex App Server 都直接运行在宿主机上。

## 要求

- Deno 2.9 或更高版本
- 已安装并登录 Codex CLI 最新稳定版（见
  [openai/codex](https://github.com/openai/codex)）
- 企业微信智能机器人的 Bot ID 和 Secret
- 同一个 Bot ID 同时只能运行一个机器人实例

本项目只按 Codex 最新稳定版协议开发；本机升级短暂滞后不构成旧版兼容要求。

## 配置

复制 `.env.example` 的键到 `.env`：

```dotenv
BOT_ID=your-bot-id
BOT_SECRET=your-bot-secret
WECOM_OWNER_USER_ID=
CODEX_WORKSPACE=.
LOG_LEVEL=info
OUTPUT_LEVEL=full
OUTPUT_LABEL=show
OUTPUT_FORMAT_TOOL=individual
```

`CODEX_WORKSPACE` 支持相对路径，按机器人项目目录解析。机器人只将解析后的 `cwd`
传给 Codex；审批、沙盒、网络、模型等行为全部使用现有 Codex config。

### 敏感信息边界

> [!WARNING]
> 本项目不会识别、扫描、替换或脱敏聊天内容、Codex 输出、工具结果、错误消息、
> 企业微信 SDK 日志或 Pino 字段中的敏感值。是否避免从模型输出泄露敏感信息完全
> 依赖模型自行遵守指令，这不是可靠的安全边界。

不要在聊天或 `CODEX_WORKSPACE` 中放置不应由模型读取的凭据或敏感数据。发送到企业
微信的内容只经过现有的格式化、长度控制、限流和分段，不进行敏感值过滤。SDK 诊断、
错误消息和其他进入日志的字符串同样不会脱敏。

引用消息仍按既有契约把未改写的原始 `quote` JSON 发送给 Codex；其中可能保留企业
微信 URL 和 AES 字段。图片消息支持没有新增脱敏层。

### Owner 权限与隔离

`WECOM_OWNER_USER_ID` 是可选的企业微信 sender user ID。未设置、空值或无效值都
不会授予 owner 权限，所有 turn 都按 `restricted` 处理。配置有效时，每个防抖聚合
批次中的每一条消息都必须由该 ID 发送，整个 turn 才是 `owner`。私聊、群聊和混合
发送者批次都使用相同规则。

解析会先检查原始值：任意位置只要包含控制符（包括 CR/LF）或 Unicode 行分隔符、段
分隔符，整项配置就视为未配置。通过检查后才 trim 普通首尾空格；所得 ID 与企业微信
sender user ID 进行区分大小写的精确匹配，不做大小写折叠或部分匹配。

机器人通过两层可信元数据把判定传给 Codex：App Server 每次启动或重启时注入稳定的
owner 隔离 developer instructions；每个 `turn/start` 再通过
`additionalContext.wecom_owner_policy` 注入 `kind: "application"` 的本 turn
`owner`/`restricted` 结果。

owner ID 会写入 developer instructions，并有意对模型可见。

它也可能出现在 App Server 进程 argv 或 Codex session metadata 中；不要把它当作
Secret。

机器人每次启动都会记录 `owner_configuration` lifecycle
日志。配置有效时，日志中的 `configured` 为 `true`，`owner_user_id`
是规范化后的配置值；与其他 Pino 字符串一样，超过 100 个 Unicode
字素簇时会被截断。未设置、空值或无效时，`configured` 为 `false`，
`owner_user_id` 为 `null`。既有 request 日志保持不变，仍会记录每条消息真实的
sender `user_id`。

restricted turn 的写操作、测试、构建、格式化和依赖安装等必须在隔离 worktree 中
执行。worktree 位置、分支命名、验证、提交约定，以及 PR/MR 的类型、模板和工作流均
由目标仓库的 `AGENTS.md` 与贡献文档决定；机器人不固定 Draft 或 Ready。隔离边界
优先于冲突的仓库工作流规则。

该机制是 developer instructions 形成的软约束，不是 OS 权限、Codex sandbox 或 Git
hook 级别的硬隔离。

owner turn 仍受现有 Codex 配置、仓库文档、sandbox 和审批策略约束。

### 企业微信输出

现有 `OUTPUT_*` 配置既是私聊配置，也是群聊的默认配置：

```dotenv
OUTPUT_LEVEL=full
OUTPUT_LABEL=show
OUTPUT_FORMAT_TOOL=individual
```

`OUTPUT_LEVEL` 设置私聊和默认 profile 中所有活动标签的全局输出级别。
`OUTPUT_LEVEL_<TAG>` 可单独覆盖一个标签，留空或未设置时继承全局值。两者都支持：

| 值        | 行为                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `off`     | 不输出该标签的任何内容。                                                                                     |
| `line`    | 每个来源流只输出第一个非空逻辑行，最多 160 个 Unicode 码点；省略了内容时追加一次 `...`，之后的片段不再输出。 |
| `excerpt` | 输出一个来源流的前 800 个 Unicode 码点；超出时追加一次 `...`，并抑制该来源流的后续片段。                     |
| `full`    | 保留原始文本，不截断正文。                                                                                   |

支持以下 10 个标签；标签名同时也是 `OUTPUT_LEVEL_<TAG>`、
`OUTPUT_LABEL_<TAG>`、`OUTPUT_GROUP_LEVEL_<TAG>` 和 `OUTPUT_GROUP_LABEL_<TAG>`
的后缀：

| 标签          | 说明                                             |
| ------------- | ------------------------------------------------ |
| `QUEUE`       | 消息已提交给 Codex 的排队状态。                  |
| `TURN`        | turn 的开始、完成或终止状态。                    |
| `TOOL`        | 工具调用的启动与完成生命周期。                   |
| `TOOL_RESULT` | 命令、进程、文件或 MCP 等工具结果增量。          |
| `CONTENT`     | Codex 的推理摘要或过程性内容。                   |
| `PLAN`        | Codex 生成的计划内容。                           |
| `WARNING`     | Codex App Server 发出的警告。                    |
| `ERROR`       | Codex 或机器人运行过程中的错误。                 |
| `SHUTDOWN`    | 机器人关闭时的中断状态。                         |
| `SUBAGENT`    | 子代理的启动、工作和终止状态；不暴露子代理内容。 |

`OUTPUT_LABEL` 设置全局标签样式，`OUTPUT_LABEL_<TAG>` 可按标签覆盖；留空或未设置
时继承全局值。`show` 会添加生成的 `[tag]` 前缀，`hide` 只移除这个前缀，不删除或
隐藏正文，也不改变输出级别。

`OUTPUT_FORMAT_TOOL` 选择工具输出格式，默认 `individual`：

| 值           | 行为                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `individual` | 每个工具调用分别显示启动与完成事件。                                                                            |
| `summary`    | 保留 App Server 返回的 reasoning summary `CONTENT`，抑制普通 `TOOL` 生命周期和全部普通 `TOOL_RESULT` 工具详情。 |

`individual` 逐一呈现工具生命周期。工具生命周期和工具结果是否可见，仍由对应的
输出级别决定。

工具生命周期与工具结果分别由独立的 `OUTPUT_LEVEL_TOOL` 和
`OUTPUT_LEVEL_TOOL_RESULT` 控制。例如，只显示无标签的工具生命周期首行、隐藏工具
结果：

```dotenv
OUTPUT_LEVEL=off
OUTPUT_LEVEL_TOOL=line
OUTPUT_LEVEL_TOOL_RESULT=off
OUTPUT_LABEL_TOOL=hide
OUTPUT_FORMAT_TOOL=individual
```

`summary` 是明确的工具详情隐藏模式。它不会读取 `ActivityEvent.summary` 中记录的
命令、查询或工具名称，也不会调用模型、按工具分类，或根据本轮工具历史动态生成
摘要。

它只沿用 App Server 通知
`item/reasoning/summaryTextDelta`。当最终生效的工具格式为 `summary`
时，机器人会在对应的 `turn/start` 请求中显式传入 `summary: "auto"`，
再把该通知作为 `CONTENT` 流式输出。`individual` 不传这个字段，继续使用现有 Codex
配置和模型默认值。普通 commentary 目前也属于 `CONTENT`，行为保持不变。

同一 reasoning summary section 的增量会先按 App Server 提供的 `itemId` 和
`summaryIndex` 累积，再原位刷新当前企业微信 stream 的活动摘要尾块。新的 section
立即接替它时，机器人会先把旧尾块替换为固定的
`*已完成上一阶段，继续处理中…*`，再显示新摘要。只有摘要完整一行都是 `**bold**`
时才会转成 `*italic*`；普通文本、行内格式、代码和其他 Markdown 都保持原样。

一旦出现其他可见进度，当前摘要就会固化，之后的摘要从新的活动尾块开始。被输出级别
抑制的事件和 direct 消息不会中断这条替换链。企业微信 stream 到达六分钟 scheduled
rotation 时，机器人会在 finalize 旧 stream 前先把仍有效的活动摘要尾块封口为同一
固定提示。所有尾块改写都要求记录内容与实际尾部精确匹配；因 UTF-8 截断或其他原因
不匹配时会保留原文，不会强制覆盖。

摘要仍服从 `OUTPUT_LEVEL_CONTENT` 和 `OUTPUT_LABEL_CONTENT`。如果 App Server
没有返回 reasoning summary，工具活动就保持静默。工具名称、命令、参数、状态和结果
不会作为后备内容，也不会伪造通用占位信息。

下面的配置会显示不带标签的完整内容摘要。所有工具详情都会被隐藏：

```dotenv
OUTPUT_FORMAT_TOOL=summary
OUTPUT_LEVEL_CONTENT=full
OUTPUT_LABEL_CONTENT=hide
```

群聊可以用同构的 `OUTPUT_GROUP_*` 变量覆盖这份默认配置。所有群聊变量都留空或
未设置时，群聊行为与当前私聊/默认配置逐项相同。输出级别和标签样式的优先级是：

```text
群聊标签级覆盖 > 群聊全局覆盖 > 私聊/默认标签级配置 > 私聊/默认全局配置 > 内置默认值
```

因此，群聊全局值会覆盖现有标签级配置，再由群聊标签级值设置例外。工具格式的
优先级是 `OUTPUT_GROUP_FORMAT_TOOL > OUTPUT_FORMAT_TOOL > individual`。例如，让
群聊整体显示更少、但保留警告和错误：

```dotenv
OUTPUT_GROUP_LEVEL=off
OUTPUT_GROUP_LEVEL_WARNING=line
OUTPUT_GROUP_LEVEL_ERROR=full
```

也可以让群聊比私聊显示更多，同时改变标签并只保留 App Server 的 reasoning
summary：

```dotenv
OUTPUT_LEVEL=off
OUTPUT_GROUP_LEVEL=line
OUTPUT_GROUP_LEVEL_CONTENT=full
OUTPUT_GROUP_LABEL=hide
OUTPUT_GROUP_FORMAT_TOOL=summary
```

不需要配置 `OUTPUT_SINGLE_*`：私聊始终使用现有 `OUTPUT_*`。配置只在进程启动时
读取，修改 `.env` 后需要重启机器人。

直发消息不经过上述级别和标签过滤。即使所有输出级别均为 `off`，最终回答、
`/help`、`/status`、`/model`、`/effort`、`/stop`、不支持消息类型的提示、用户输入
请求和直接失败消息仍会发送。

`CODEX_INTERMEDIATE_OUTPUT` 和 `CODEX_STATUS_DETAIL` 这两个旧变量会被静默忽略：
它们不再被读取、校验，也不会继续影响运行时行为；迁移时应删除旧变量并改用
`OUTPUT_*`。

### 运行日志

`LOG_LEVEL` 支持 `info` 和 `debug`，默认 `info`。前台终端使用 Pino Pretty 输出
单行结构化日志，格式如下：

```text
[2026-07-31T14:22:33.456 +0800] INFO: [request] received {"chat_type":"group","chat_id":"room-1","user_id":"alice","msg_id":"m1","summary":"检查订单状态是否完成…","active_count":1,"pending_count":0}
```

方括号中的时间是带本地时区偏移的 ISO 时间，不是固定 UTC 时间。`INFO` 是 Pino
级别，第二个方括号是 scope。终端日志只有以下五个 scope：

| scope       | 内容                                                 |
| ----------- | ---------------------------------------------------- |
| `request`   | 普通用户请求的状态、计数和编排错误。                 |
| `codex`     | Codex App Server 的进程、RPC、事件、通知路由和错误。 |
| `wecom`     | 企业微信鉴权、SDK 日志、网关错误和致命错误。         |
| `output`    | 输出过滤决策、企业微信流式输出和发送错误。           |
| `lifecycle` | 启动、恢复、信号、清理和关闭状态。                   |

同一普通用户请求的每个状态都会重复携带消息中的真实 `chat_id`、`user_id` 和
`msg_id`；获得 Codex 标识后，后续状态还会重复真实 `thread_id` 和 `turn_id`，不会
另外生成替代标识。只有 `received` 状态包含 `summary`：正文会折叠空白，再按
Unicode 字素簇截取前 10 个，超长时追加省略号。摘要不会把完整聊天正文写到终端，
也不会检测或脱敏其中的敏感值。

启动时的 `owner_configuration` lifecycle 日志会把规范化后的 owner ID 作为
`owner_user_id`；该字段与其他 Pino 字符串一样，超过 100 个 Unicode 字素簇时会被
截断。未配置、空值、无效时记录 `null`。如果真实请求由该用户发送，上述既有
request 日志也会记录其真实 `user_id`。

内建命令 `/help`、`/status`、`/model`、`/effort`、`/new`、`/stop` 和不支持的消息
类型不产生 request 状态。未知斜杠命令仍按普通用户请求处理。

`info` 会记录 App Server 进程就绪和退出、thread 启动、turn 启动和终态。
`warn`/`error` 用于 RPC 失败或超时、协议异常、策略拒绝、失败
turn、非预期进程退出和无法恢复的 fatal。App Server 原始 stderr 记为 `debug`，
只记录 chunk 长度而不记录原文；客户端或 runtime 自身诊断记为 `warn`。

`debug` 会额外记录下列结构化细节：

- `codex/rpc_started`、`rpc_completed`：RPC 方法、request ID 和耗时。
- `codex/item_started`、`item_completed`、`item_delta`：item
  ID、类型、状态，以及 delta 长度或 reasoning summary/content 分段数。同一
  method/thread/turn/item 的 delta 会累计 chunk 数和总长度，并在 item、turn
  完成或进程退出时只记录一次。
- `codex/notification_route`：通知的方法名、thread/turn、runtime
  generation，以及通知被投递、缓冲或忽略的原因；高频 delta 不逐块重复记录。
- `output/activity_decision`：活动标签、投递类型，以及内容被渲染或抑制的原因；例如
  `tool_format_summary`、`level_off`、`line_complete`。此外，高频 `TOOL_RESULT`
  不逐块重复记录。

机器人新增的 Codex 生命周期、决策和 App Server stderr 日志不会记录聊天正文、
reasoning summary 文本、命令、参数或工具输出；它们只记录功能性元数据。企业微信
SDK 属于上游原始诊断流，仍可能包含文本片段。经过 Pino log method 的消息和顶层
字符串字段只会单行化并按 Unicode 字素簇截断到最多 100 个字符；普通嵌套结构由
Pino 原生处理。上述过程不会检测或脱敏敏感值。

因此可用下面的配置判断 App Server 是否发出了 reasoning summary。该配置也能判断
输出管线是否将其过滤：

```dotenv
LOG_LEVEL=debug
OUTPUT_FORMAT_TOOL=summary
```

每次启动时，旧的 `logs/wecom-codex-bot.log` 会先按 UTC 启动时间改名，例如
`logs/wecom-codex-bot.20260731T081322123Z.log`；同一进程随后始终写新的活跃文件，
进程内不再轮换。终端 target 使用 `pino-pretty`，文件 target 使用 Pino 内置的
`pino/file` 并写 JSONL。日志目录初始化失败或文件 transport 在运行时失效时，服务
继续使用终端日志。

`OUTPUT_*` 不影响运行日志。`logs/` 是本地运行状态并已被 Git 忽略；文件中仍包含
排障所需的 chat/thread/turn 标识，不应提交或公开。

当前实验配置把 `.env` 放在 Codex 工作区内，因此 Codex 可以读取机器人 Secret。
项目不提供输出或日志级敏感值保护；避免泄露依赖模型自觉以及使用者不把凭据放进模型
可读的聊天和工作区。

## 本地运行

```bash
deno task start
```

这是前台服务。收到 `SIGINT` 或 `SIGTERM` 后，它会停止接收消息、中断活动
turn、结束流式回复并关闭 App Server 和状态数据库。

状态保存在 `.data/bot.sqlite`，仅包含聊天与 Codex thread 的绑定、消息 ID 去重和
turn 状态，不保存聊天正文或 Codex 输出。图片字节和本地临时路径也不会写入
SQLite。

## Docker Compose

Docker 镜像使用 Deno 全局安装 Codex CLI。Compose 会挂载当前项目目录以保留 Codex
产生的文件修改和 `.data` 状态，并把宿主机的 `~/.codex` 挂载到容器中，因此 Codex
登录信息及现有 config 会继续生效。

镜像构建通过 BuildKit 复用 APT 和 Deno 缓存；Deno 的 npm 兼容层使用淘宝镜像，
不会改写项目的 `deno.lock`。

```bash
docker compose up -d --build
docker compose logs -f bot
docker compose down
```

容器收到停止请求时会向机器人发送 `SIGTERM`，最多等待一分钟完成现有的优雅
退出流程。`restart: unless-stopped` 负责异常退出后的自动重启。Docker 仍收集终端
输出；进程也会写容器内的 `/app/logs`，当前 Compose 没有为它配置宿主卷，重建容器
后这些文件不会保留。

不要同时运行本地 `deno task start` 和 Compose 服务，否则两个实例会争用同一个
企业微信 Bot ID。Codex config 中如果引用了宿主机专有的命令或绝对路径，需要让
相同命令或路径在容器内也可用。

## 命令

- `/new`：中断当前任务并为当前聊天新建 Codex 会话
- `/stop`：停止当前聊天正在执行或等待的任务，但保留现有 Codex thread
- `/status`：查看当前聊天的 thread、模型、推理强度和 turn 状态
- `/model`：查看当前模型和可选模型；`/model <model-id>` 仅机器人 owner
  可切换模型并保存为新会话默认值
- `/effort`：查看当前推理强度和可选强度；`/effort <level>` 仅机器人 owner
  可切换强度并保存为新会话默认值
- `/help`：显示命令帮助

不带参数的 `/model` 会显示当前有效模型和 App Server 返回的模型目录；不带参数的
`/effort` 会显示当前有效推理强度和当前模型支持的强度。这两种查询对所有 sender
可用。带一个参数的修改命令只允许 `WECOM_OWNER_USER_ID` 配置的机器人 owner
使用。owner 未配置、配置无效、sender 不匹配或大小写不一致时都会 fail closed。
拒绝时不读取 thread，也不调用设置写入。授权成功后，机器人再校验目录：
`/model <model-id>` 切换模型，如果原有推理强度不受新模型支持，会自动改为该模型的
默认强度；`/effort <level>` 只接受当前模型支持的强度。多余参数只返回用法，不会
成为 Codex prompt。

如果聊天已绑定 thread，切换会先更新该 thread，再把相同设置写入 Codex 用户级
config，作为新会话默认值；没有绑定 thread 时只写用户级默认值。thread 更新成功但
config 写入失败时，回复会明确报告“当前 thread 已切换、全局默认保存失败”；没有
thread 且 config 写入失败时则报告设置未修改。设置命令不会写入机器人 SQLite。

用户级 config 通过 `config/batchWrite` 写入，并固定使用
`reloadUserConfig: false`。这不会把用户配置热重载到其他已存在的会话。当前绑定的
thread 由独立的 `thread/settings/update` 更新。工作区的 project config 仍遵循
Codex 自身优先级，可能覆盖这里保存的用户级默认值。`/status`、`/model` 和
`/effort` 显示当前聊天的有效值。

`/model` 和 `/effort` 绕过防抖与任务 slot，不会中断正在执行的 turn。活动 turn
继续使用启动时的旧设置，当前绑定 thread 的后续 turn 才使用新设置；回复会明确提示
这一点。

普通 `text`、独立 `image`、`mixed` 消息，以及 `quote` 中按已知 `image` 或
`mixed` 结构识别出的图片，共用同一个 conversation 固定 3 秒尾随防抖窗口。窗口内
每收到一条通过 `msgid` 去重的新消息，等待时间都会从头计算；连续 3 秒没有新消息
后，机器人按到达顺序将整个批次聚合成一次 Codex turn。群聊中的不同成员共享该群聊
的窗口，但每条消息各自的 sender、`msgid` 和引用消息 `quote` 都会保留。批次使用
最后一条企业微信消息的 frame 承载过程输出和最终回复。

命令只由 `text` 消息的文本正文识别；只有纯文本命令本身才是命令。这样的命令消息
即使带有图片引用也只执行命令，不会下载引用图片。`mixed` 消息中形似命令的文本按
普通用户请求进入防抖窗口。

图片由企业微信 SDK 下载并解密；当前按 Codex 支持的 JPEG、PNG、GIF 和 WebP
格式识别。一个聚合批次中任意图片处理失败，整个批次都不会提交给 Codex，并直接
回复 `图片处理失败，请重新发送图片。`。

下载并解密后的图片只写入 Linux 当前进程专属的随机目录
`/tmp/wecom-codex-bot-*`。机器人通过 App Server `localImage` 输入把图片交给
Codex；这些图片不会持久化到 SQLite。文件会在请求进入终态后删除，正常进程关闭时
也会清理整个临时目录。原生 Linux 进程崩溃可能遗留该进程的随机临时目录，交由系统
清理；机器人不会扫描或删除其他进程的目录。

防抖等待期间不会中断正在执行的 turn。只有批次到期、进入任务队列后，才应用原有
latest-wins：如果已有活动 turn，则请求中断它；如果已有普通 pending，则只保留最后
一个到期的批次。不同聊天的窗口和任务相互独立，但仍可并发操作同一个工作目录，
可能产生文件冲突。

内建命令和不支持的消息类型都绕过防抖窗口。`/help`、`/status`、`/model`、
`/effort` 和不支持消息不会重置窗口或中断任务。`/new` 会取消尚未发送的聚合批次，
再按原有会话重置流程执行。`/stop` 会立即清除当前聊天的聚合批次、普通 pending 和
待执行的 `/new`，并请求中断活动 turn；它不会删除或替换当前 thread，之后的新普通
用户请求仍可开始新的防抖批次。

机器人关闭时，尚在等待窗口中的批次会直接丢弃。`/stop` 生效后不会再发起旧 turn
的最终回复，但如果该回复已经进入企业微信发送队列，现有发送接口无法将其撤回。

## 验证

```bash
deno task check
deno task test
deno task smoke
deno fmt --check
deno lint
```

需要运行时权限的 task 已在 `deno.json` 中使用配置文件权限集，并通过 `-P` 启用；
无需在命令行重复展开权限。Deno 目前会打印下面这条实验性功能警告，这是预期输出，
不表示验证失败：

```text
Warning Permissions in the config file is an experimental feature and may change in the future.
```

`deno task smoke` 先在当前 workspace 的 `.data/` 下生成并结构化校验临时 App
Server JSON schema，确认 `TurnStartParams.additionalContext` 支持精确的
`kind: "application"`，并确认 `TurnStartParams.input` 支持必需字符串路径的
`localImage.path`。验证通过后，它完成本机 `codex app-server --stdio` 握手，并在
结束时尽最大努力清理临时目录。它不会启动模型 turn，也不会连接企业微信。

需要显式调用一次真实模型 turn 时运行：

```bash
RUN_CODEX_TURN=1 deno task smoke-turn
```

该命令会消耗一次模型调用，但仍不会连接企业微信；未设置 `RUN_CODEX_TURN=1`
时会直接拒绝运行。
