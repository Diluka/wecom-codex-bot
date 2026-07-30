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
CODEX_INTERMEDIATE_OUTPUT=full
CODEX_STATUS_DETAIL=verbose
```

`CODEX_WORKSPACE` 支持相对路径，按机器人项目目录解析。机器人只将解析后的 `cwd`
传给 Codex；审批、沙盒、网络、模型等行为全部使用现有 Codex config。

`CODEX_INTERMEDIATE_OUTPUT` 控制 Codex 的中间过程内容，默认 `full`：

| 值                | 行为                                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| `full`            | 输出摘要、工具生命周期和工具结果。                                               |
| `no_tool_results` | 保留摘要和工具生命周期，不输出命令、进程、文件及 MCP 的结果增量。                |
| `merge_same_tool` | 同一 turn 内相同且并发执行的工具只显示一次启动；只在最后一个完成时显示完成状态。 |
| `merge_all_tools` | 同一 turn 的任意工具聚合为一次 `[tools] running` 和一次 `[tools completed]`。    |
| `none`            | 不输出普通中间过程。错误和警告仍会显示。                                         |

相同工具的合并按活动调用计数，而不是简单布尔缓存：重复的启动会增加计数，只有对应的
最后一次完成才会释放该工具。计数仅作用于一个 `threadId + turnId`，turn 结束、App
Server 重启或机器人关闭时会清理。

`CODEX_STATUS_DETAIL` 控制被动状态信息，默认 `verbose`：

| 值        | 行为                                                               |
| --------- | ------------------------------------------------------------------ |
| `verbose` | 显示排队、turn 和工具的开始/完成状态；关闭机器人时也显示关闭状态。 |
| `turn`    | 仅显示排队和 turn 的开始/完成状态。                                |
| `none`    | 不显示被动状态信息。                                               |

最终回答、直接失败、错误/警告、`/status`
和需要用户输入的提示不会被这些设置隐藏。 当 `CODEX_INTERMEDIATE_OUTPUT=none`
时，也不会显示被动状态信息。

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
