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
```

<!-- deno-fmt-ignore -->
`CODEX_WORKSPACE` 支持相对路径，按机器人项目目录解析。机器人将解析后的 `cwd`
传给 Codex，并在每个 turn 上显式设置 `effort: "ultra"`，使 Codex 可在任务适合时主动
使用子代理。审批、沙盒、网络、模型等其余行为仍使用现有 Codex config。

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
