# WeCom Codex Bot

通过企业微信智能机器人长连接，把每个单聊或群聊绑定到一个持久化的 Codex CLI
会话。机器人和 Codex App Server 都直接运行在宿主机上。

## 要求

- Deno 2.9 或更高版本
- 已安装并登录可用的最新 Codex CLI
- 企业微信智能机器人的 Bot ID 和 Secret
- 同一个 Bot ID 同时只能运行一个机器人实例

## 配置

复制 `.env.example` 的键到 `.env`：

```dotenv
BOT_ID=your-bot-id
BOT_SECRET=your-bot-secret
CODEX_WORKSPACE=.
OUTPUT_LEVEL=full
OUTPUT_LABEL=show
OUTPUT_FORMAT_TOOL=individual
```

`CODEX_WORKSPACE` 支持相对路径，按机器人项目目录解析。机器人只将解析后的 `cwd`
传给 Codex；审批、沙盒、网络、模型等行为全部使用现有 Codex config。

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

`OUTPUT_FORMAT_TOOL` 只选择工具生命周期的格式或聚合方式，默认 `individual`：

| 值           | 行为                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `individual` | 每个工具调用分别显示启动与完成事件。                                                                               |
| `merge_same` | 同一 turn 内相同工具的并发调用按工具身份聚合，只显示第一次启动和最后一次完成。                                     |
| `merge_all`  | 将当前同时活动的所有工具聚合为一组；每组只显示首次启动和最后一次完成，引用计数归零后释放，之后启动的工具进入新组。 |

聚合使用活动调用的引用计数，而不是简单布尔缓存：每次启动增加计数、每次完成减少
计数，最后一个活动调用完成时释放该组状态；缓存和计数状态也会在 turn 结束、App
Server 重启和机器人关闭时释放。

`OUTPUT_FORMAT_TOOL` 永远不决定内容是否可见。工具生命周期与工具结果分别由独立的
`OUTPUT_LEVEL_TOOL` 和 `OUTPUT_LEVEL_TOOL_RESULT` 控制。例如，只显示无标签的工具
生命周期首行、隐藏工具结果，并聚合相同工具：

```dotenv
OUTPUT_LEVEL=off
OUTPUT_LEVEL_TOOL=line
OUTPUT_LEVEL_TOOL_RESULT=off
OUTPUT_LABEL_TOOL=hide
OUTPUT_FORMAT_TOOL=merge_same
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

也可以让群聊比私聊显示更多，同时改变标签和工具聚合方式：

```dotenv
OUTPUT_LEVEL=off
OUTPUT_GROUP_LEVEL=line
OUTPUT_GROUP_LEVEL_CONTENT=full
OUTPUT_GROUP_LABEL=hide
OUTPUT_GROUP_FORMAT_TOOL=merge_same
```

不需要配置 `OUTPUT_SINGLE_*`：私聊始终使用现有 `OUTPUT_*`。配置只在进程启动时
读取，修改 `.env` 后需要重启机器人。

直发消息不经过上述级别和标签过滤。即使所有输出级别均为 `off`，最终回答、
`/help`、`/status`、`/stop`、不支持消息类型的提示、用户输入请求和直接失败消息仍会
发送。

`CODEX_INTERMEDIATE_OUTPUT` 和 `CODEX_STATUS_DETAIL` 这两个旧变量会被静默忽略：
它们不再被读取、校验，也不会继续影响运行时行为；迁移时应删除旧变量并改用
`OUTPUT_*`。

### 终端日志

前台终端统一使用 Pino 和 Pino Pretty 输出单行结构化日志，格式如下：

```text
[2026-07-31T14:22:33.456 +0800] INFO: [request] received {"chat_type":"group","chat_id":"room-1","user_id":"alice","msg_id":"m1","summary":"检查订单状态是否完成…","active_count":1,"pending_count":0}
```

方括号中的时间是带本地时区偏移的 ISO 时间，不是固定 UTC 时间。`INFO` 是 Pino
级别，第二个方括号是 scope。终端日志只有以下五个 scope：

| scope       | 内容                                         |
| ----------- | -------------------------------------------- |
| `request`   | 普通文本请求的状态、计数和编排错误。         |
| `codex`     | Codex App Server 的诊断和致命错误。          |
| `wecom`     | 企业微信鉴权、SDK 日志、网关错误和致命错误。 |
| `output`    | 企业微信回复、流式输出和限流发送错误。       |
| `lifecycle` | 启动、恢复、信号、清理和关闭状态。           |

同一普通文本请求的每个状态都会重复携带消息中的真实 `chat_id`、`user_id` 和
`msg_id`；获得 Codex 标识后，后续状态还会重复真实 `thread_id` 和 `turn_id`，不会
另外生成替代标识。只有 `received` 状态包含 `summary`：正文先脱敏、折叠空白，再按
Unicode 字素簇截取前 10 个，超长时追加 `…`，不会把完整聊天正文写到终端。

内建命令 `/help`、`/status`、`/new` 和不支持的消息类型不产生 request 状态；未知
斜杠命令仍按普通文本请求处理。Codex 的原始 `ActivityEvent` 内容也不写入终端，仍
只经过企业微信输出管线；`OUTPUT_*` 不影响上述终端日志。本项目不提供 `LOG_*`
配置。所有结构化字段和消息都会在 Pino 边界递归脱敏。

当前实验配置把 `.env` 放在 Codex 工作区内，因此 Codex 可以读取机器人
Secret。发送到企业微信的内容会脱敏，但这不构成可靠的 Secret 隔离。

## 本地运行

```bash
deno task start
```

这是前台服务。收到 `SIGINT` 或 `SIGTERM` 后，它会停止接收消息、中断活动
turn、结束流式回复并关闭 App Server 和状态数据库。

状态保存在 `.data/bot.sqlite`，仅包含聊天与 Codex thread 的绑定、消息 ID 去重和
turn 状态，不保存聊天正文或 Codex 输出。

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
退出流程。`restart: unless-stopped` 负责异常退出后的自动重启，日志由 Docker
保存并轮换，不另外写后台日志文件。

不要同时运行本地 `deno task start` 和 Compose 服务，否则两个实例会争用同一个
企业微信 Bot ID。Codex config 中如果引用了宿主机专有的命令或绝对路径，需要让
相同命令或路径在容器内也可用。

## 命令

- `/new`：中断当前任务并为当前聊天新建 Codex 会话
- `/stop`：停止当前聊天正在执行或等待的任务，但保留现有 Codex thread
- `/status`：查看当前聊天的 thread 和 turn 状态
- `/help`：显示命令帮助

普通文本按 conversation 使用固定 3 秒的尾随防抖窗口。窗口内每收到一条通过
`msgid` 去重的新消息，等待时间都会从头计算；连续 3 秒没有新消息后，机器人按
到达顺序将整个批次聚合成一次 Codex turn。群聊中的不同成员共享该群聊的窗口，但
每条消息各自的 sender、`msgid` 和引用消息 `quote` 都会保留。批次使用最后一条
企业微信消息的 frame 承载过程输出和最终回复。

防抖等待期间不会中断正在执行的 turn。只有批次到期、进入任务队列后，才应用原有
latest-wins：如果已有活动 turn，则请求中断它；如果已有普通 pending，则只保留最后
一个到期的批次。不同聊天的窗口和任务相互独立，但仍可并发操作同一个工作目录，
可能产生文件冲突。

`/help`、`/status`、`/new`、`/stop` 和不支持的消息类型都绕过防抖窗口。
`/help`、`/status` 和不支持消息不会重置窗口或中断任务；`/new` 会取消尚未发送的
聚合批次，再按原有会话重置流程执行。`/stop` 会立即清除当前聊天的聚合批次、普通
pending 和待执行的 `/new`，并请求中断活动 turn；它不会删除或替换当前 thread，
之后的新普通文本仍可开始新的防抖批次。

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

`deno task smoke` 只验证本机 `codex app-server --stdio` 握手，不会启动模型
turn，也不会连接企业微信。

需要显式调用一次真实模型 turn 时运行：

```bash
RUN_CODEX_TURN=1 deno task smoke-turn
```

该命令会消耗一次模型调用，但仍不会连接企业微信；未设置 `RUN_CODEX_TURN=1`
时会直接拒绝运行。
