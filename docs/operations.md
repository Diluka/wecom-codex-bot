# 运行与排障

## 本地运行

```bash
deno task start
```

服务以前台进程运行。开发时可以启用文件监听：

```bash
deno task start:watch
```

同一个 Bot ID 保持单实例运行。本地进程与 Compose 服务使用同一 Bot ID
时，选择其中一种运行方式。

## 运行状态

| 路径                             | 内容                                           | 持久化建议                       |
| -------------------------------- | ---------------------------------------------- | -------------------------------- |
| `.data/bot.sqlite`               | conversation/thread 绑定、消息去重和 turn 状态 | 长期运行时备份或挂载持久卷       |
| `logs/wecom-codex-bot.log`       | 当前进程的 JSONL 文件日志                      | 作为敏感运行数据保留             |
| `logs/wecom-codex-bot.<UTC>.log` | 启动时轮换出的上一份日志                       | 按运维周期归档或清理             |
| `/tmp/wecom-codex-bot-*`         | 当前进程下载并解密的图片                       | 正常请求结束与服务关闭时自动清理 |

SQLite 不保存聊天正文、Codex 输出或图片字节。原生 Linux
进程异常崩溃时，图片临时目录可能由系统的 `/tmp` 清理策略接管。

## 日志

`LOG_LEVEL=info` 记录服务生命周期、App Server 就绪与退出、thread/turn
状态和错误。`LOG_LEVEL=debug` 额外记录 RPC、item、通知路由与输出决策元数据。

前台终端使用本地时区的单行日志：

```text
[2026-07-31T14:22:33.456 +0800] INFO: [request] received {...}
```

第二个方括号是 scope：

| scope       | 内容                                       |
| ----------- | ------------------------------------------ |
| `request`   | 普通用户请求的状态、计数和编排错误         |
| `codex`     | App Server 进程、RPC、事件、通知路由和错误 |
| `wecom`     | 企业微信鉴权、SDK 日志、网关错误和 fatal   |
| `output`    | 输出过滤、流式发送和发送错误               |
| `lifecycle` | 启动、恢复、信号、清理和关闭               |

文件日志使用 Pino JSONL。每次启动前，现有 `logs/wecom-codex-bot.log` 会按 UTC
启动时间重命名；同一进程内不继续轮换。日志目录或文件 transport
初始化失败时，服务继续使用终端日志。

常见 debug 事件：

| 事件                                                 | 用途                                |
| ---------------------------------------------------- | ----------------------------------- |
| `codex/rpc_started`、`rpc_completed`                 | 确认 RPC 方法、request ID 与耗时    |
| `codex/item_started`、`item_completed`、`item_delta` | 确认 item 生命周期与累计 delta 长度 |
| `codex/notification_route`                           | 判断通知被投递、缓冲或忽略的原因    |
| `output/activity_decision`                           | 判断活动内容被渲染或抑制的原因      |
| `lifecycle/owner_configuration`                      | 确认 owner 配置是否有效             |

检查 reasoning summary 是否由 App Server 返回并通过输出管线：

```dotenv
LOG_LEVEL=debug
OUTPUT_FORMAT_TOOL=summary
```

运行日志包含真实聊天、thread 和 turn
标识，完整敏感信息边界见[安全说明](security.md#日志中的信息)。

## Docker Compose

构建并启动：

```bash
docker compose up -d --build
docker compose logs -f bot
docker compose down
```

镜像在 Deno 基础镜像中全局安装 Codex CLI，并预装 Git、OpenSSH 和
ripgrep。Compose 把宿主的 `~/.codex`、`~/.agents`
与当前仓库挂入容器，停止宽限期为一分钟。

### 当前路径边界

仓库现有 Compose 配置包含三项需要在正式部署前明确的路径：

| 内容              | 当前容器路径              | 当前行为                            |
| ----------------- | ------------------------- | ----------------------------------- |
| 容器工作目录      | `/app`                    | 默认 `CODEX_WORKSPACE=.` 解析到这里 |
| 宿主仓库挂载      | `/home/bot/workspace`     | 与默认 workspace 不是同一路径       |
| SQLite 与文件日志 | `/app/.data`、`/app/logs` | 未配置独立宿主卷，重建容器后不保留  |

正式部署时，把 `CODEX_WORKSPACE` 指向实际挂载目录，并为需要保留的 `.data` 与
`logs` 配置持久卷。宿主 Codex config
引用的绝对路径和外部命令，也需要在容器内提供对应路径与程序。

Docker 仍会收集容器终端输出，因此即使文件日志没有挂载，也可以先通过
`docker compose logs` 排查启动问题。

## 验证

完整本地检查：

```bash
deno fmt --check
deno lint
deno task check
deno task test
deno task smoke
```

权限已在 `deno.json` 中配置，task 会通过 `-P` 使用这组权限。Deno
可能提示配置文件权限仍是实验性功能；该提示本身不代表命令失败。

`deno task smoke` 会：

1. 在当前 workspace 的 `.data/` 下生成临时 App Server JSON schema。
2. 校验 `TurnStartParams.additionalContext` 支持 `kind: "application"`。
3. 校验 `TurnStartParams.input` 支持带必需字符串路径的 `localImage.path`。
4. 与本机 `codex app-server --stdio` 完成握手。
5. 清理临时文件。

它不启动模型 turn，也不连接企业微信。

需要显式验证一次真实模型 turn 时运行：

```bash
RUN_CODEX_TURN=1 deno task smoke-turn
```

该命令会消耗一次模型调用，但仍不会连接企业微信。

## 常见检查路径

### 服务启动后没有收到消息

1. 查看 `wecom/authenticated` 是否出现。
2. 确认同一 Bot ID 只有一个运行实例。
3. 查看 `wecom` scope 的 SDK 与网关错误。
4. 核对 `BOT_ID`、`BOT_SECRET` 和企业微信机器人状态。

### 消息收到但 Codex 没有开始

1. 查看 `request/received`、`debounced`、`turn_starting` 等状态。
2. 查看 `codex` scope 中 App Server 是否 ready。
3. 使用 `/status` 查看当前聊天是否有活动 turn 或 pending 请求。
4. 运行 `deno task smoke` 验证本机 Codex 协议与登录环境。

### 过程内容没有显示

1. 查看最终生效的 `OUTPUT_LEVEL_*` 与群聊覆盖。
2. 使用 `LOG_LEVEL=debug` 查看 `output/activity_decision`。
3. `OUTPUT_FORMAT_TOOL=summary` 时确认 App Server 实际返回 reasoning summary。
4. 最终回答属于 direct 消息，不受活动输出过滤影响。

### 服务重启后 thread 恢复异常

1. 确认 `.data/bot.sqlite` 来自同一运行目录或持久卷。
2. 查看 `lifecycle/started` 的 `stale_turns`。
3. 查看 `codex` scope 的 resume 与 runtime generation 日志。
4. 使用 `/new` 为单个聊天建立新 thread，区分持久状态问题与 App Server 故障。
