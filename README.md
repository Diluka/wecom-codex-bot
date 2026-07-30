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

输出配置的全局默认值是：

```dotenv
OUTPUT_LEVEL=full
OUTPUT_LABEL=show
OUTPUT_FORMAT_TOOL=individual
```

`OUTPUT_LEVEL` 设置所有活动标签的全局输出级别。`OUTPUT_LEVEL_<TAG>`
可单独覆盖一个标签，留空或未设置时继承全局值。两者都支持：

| 值        | 行为                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `off`     | 不输出该标签的任何内容。                                                                                     |
| `line`    | 每个来源流只输出第一个非空逻辑行，最多 160 个 Unicode 码点；省略了内容时追加一次 `...`，之后的片段不再输出。 |
| `excerpt` | 输出一个来源流的前 800 个 Unicode 码点；超出时追加一次 `...`，并抑制该来源流的后续片段。                     |
| `full`    | 保留原始文本，不截断正文。                                                                                   |

支持以下 9 个标签；标签名同时也是 `OUTPUT_LEVEL_<TAG>` 和 `OUTPUT_LABEL_<TAG>`
的后缀：

| 标签          | 说明                                    |
| ------------- | --------------------------------------- |
| `QUEUE`       | 消息已提交给 Codex 的排队状态。         |
| `TURN`        | turn 的开始、完成或终止状态。           |
| `TOOL`        | 工具调用的启动与完成生命周期。          |
| `TOOL_RESULT` | 命令、进程、文件或 MCP 等工具结果增量。 |
| `CONTENT`     | Codex 的推理摘要或过程性内容。          |
| `PLAN`        | Codex 生成的计划内容。                  |
| `WARNING`     | Codex App Server 发出的警告。           |
| `ERROR`       | Codex 或机器人运行过程中的错误。        |
| `SHUTDOWN`    | 机器人关闭时的中断状态。                |

`OUTPUT_LABEL` 设置全局标签样式，`OUTPUT_LABEL_<TAG>` 可按标签覆盖；留空或未设置
时继承全局值。`show` 会添加生成的 `[tag]` 前缀，`hide` 只移除这个前缀，不删除或
隐藏正文，也不改变输出级别。

`OUTPUT_FORMAT_TOOL` 只选择工具生命周期的格式或聚合方式，默认 `individual`：

| 值           | 行为                                                                           |
| ------------ | ------------------------------------------------------------------------------ |
| `individual` | 每个工具调用分别显示启动与完成事件。                                           |
| `merge_same` | 同一 turn 内相同工具的并发调用按工具身份聚合，只显示第一次启动和最后一次完成。 |
| `merge_all`  | 同一 turn 内所有工具调用聚合，只显示第一项启动和最后一项完成。                 |

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

直发消息不经过上述级别和标签过滤。即使所有输出级别均为 `off`，最终回答、
`/help`、`/status`、不支持消息类型的提示、用户输入请求和直接失败消息仍会发送。

`CODEX_INTERMEDIATE_OUTPUT` 和 `CODEX_STATUS_DETAIL` 这两个旧变量会被静默忽略：
它们不再被读取、校验，也不会继续影响运行时行为；迁移时应删除旧变量并改用
`OUTPUT_*`。

原始 `ActivityEvent` 的架构边界是：未来会分发给两个独立配置的管线——本次迭代
负责企业微信消息的 `OutputPipeline`，以及未来迭代负责终端日志的 `LogPipeline`。
本次迭代不提供 `LOG_*`，不会把活动事件打印到终端，也不会让企业微信的输出过滤
影响未来日志。

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
- `/status`：查看当前聊天的 thread 和 turn 状态
- `/help`：显示命令帮助

同一聊天采用 latest-wins：新消息会中断当前 turn，并只执行最后一条待处理
消息。不同聊天可以并发操作同一个工作目录，可能产生文件冲突。

## 验证

```bash
deno task check
deno task test
deno task smoke
deno fmt --check
deno lint
```

`deno task smoke` 只验证本机 `codex app-server --stdio` 握手，不会启动模型
turn，也不会连接企业微信。

需要显式调用一次真实模型 turn 时运行：

```bash
RUN_CODEX_TURN=1 deno task smoke-turn
```

该命令会消耗一次模型调用，但仍不会连接企业微信；未设置 `RUN_CODEX_TURN=1`
时会直接拒绝运行。
