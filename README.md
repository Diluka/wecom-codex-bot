<div align="center">
  <h1>WeCom Codex Bot</h1>
  <p><strong>把 Codex 接进企业微信，让聊天直接变成持续的开发会话。</strong></p>
  <p>一个基于 Deno 的轻量桥接服务：企业微信负责入口，Codex App Server 负责理解、执行与工具调用。</p>

<p>
    <a href="https://github.com/Diluka/wecom-codex-bot/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Diluka/wecom-codex-bot/ci.yml?branch=master&style=flat-square&label=ci"></a>
    <a href="https://deno.com/"><img alt="Deno 2.9+" src="https://img.shields.io/badge/Deno-2.9%2B-111111?style=flat-square&logo=deno&logoColor=white"></a>
    <a href="https://github.com/openai/codex"><img alt="Codex CLI" src="https://img.shields.io/badge/Codex_CLI-latest-1f6feb?style=flat-square"></a>
  </p>
</div>

每个企业微信单聊或群聊都会绑定一个持久的 Codex
thread。你可以在手机上继续同一段上下文，看到执行进度，发送图片，并用几条本地命令控制会话；真正的代码读取、修改和工具调用仍由本机的
Codex 完成。

> [!WARNING]
> 机器人能够把聊天内容交给 Codex，并允许 Codex 访问
> `CODEX_WORKSPACE`。请先阅读[安全边界](docs/security.md)，只把它接入你信任的企业微信机器人和工作目录。

## 它解决什么问题

- **聊天与上下文连续。** 单聊和群聊各自保存 thread 绑定，服务重启后可以继续。
- **过程看得见。** Codex
  的状态、计划、工具活动、警告和最终回答可以按需流式回传。
- **沿用本机 Codex。** 登录状态、模型、审批、沙盒、网络和项目指令继续使用现有
  Codex 配置。
- **会话可以控制。** `/new`、`/stop`、`/status`、`/model` 和 `/effort`
  都在机器人本地处理。
- **文本与图片一起工作。**
  连续消息会短暂聚合，图片经过企业微信下载后作为本地图片输入交给 Codex。

## 消息怎样走

![企业微信消息到 Codex 的处理闭环](docs/architecture/wecom-codex-message-flow.png)

[查看可编辑的 draw.io 源图](docs/architecture/wecom-codex-message-flow.drawio)

普通消息经过企业微信长连接进入机器人，按聊天去重并聚合，然后恢复已有 thread
或创建新 thread，再启动一次 Codex
turn。执行中的增量通知经过输出策略整理后回到企业微信；最终回答单独直发。SQLite
只保存 thread 绑定、消息去重和 turn 状态，不保存聊天正文与 Codex 输出。

更完整的并发、恢复和模块边界见[架构说明](docs/architecture.md)。

## 快速开始

### 1. 准备环境

你需要：

- Deno 2.9 或更高版本
- 最新稳定版 [Codex CLI](https://github.com/openai/codex)，并已完成登录
- 企业微信智能机器人的 Bot ID 与 Secret

同一个 Bot ID 同一时间只运行一个机器人实例。

### 2. 配置机器人

```bash
git clone https://github.com/Diluka/wecom-codex-bot.git
cd wecom-codex-bot
cp .env.example .env
```

先填写最小配置：

```dotenv
BOT_ID=your-bot-id
BOT_SECRET=your-bot-secret
CODEX_WORKSPACE=/absolute/path/to/your/project
```

`CODEX_WORKSPACE` 是 Codex
实际读取和修改的目录。相对路径按机器人进程的工作目录解析，长期运行时建议使用绝对路径。

如需让自己的消息获得 owner 策略，可再配置企业微信 sender user ID：

```dotenv
WECOM_OWNER_USER_ID=your-user-id
```

未配置 owner 时，所有 turn 都按 `restricted`
执行；这仍允许读取，以及在隔离工作树和非默认分支中完成受控开发。具体权限边界见[安全说明](docs/security.md)。

### 3. 启动

```bash
deno task start
```

这是一个前台服务。按 `Ctrl+C` 后，机器人会停止接收新消息、中断活动
turn、结束流式回复，并依次关闭企业微信连接、Codex App Server 和 SQLite。

开发时可以使用自动重载：

```bash
deno task start:watch
```

## 在企业微信里使用

直接发送文本或图片即可。连续消息会在 3 秒无新消息后合并为一次 Codex
turn；不同聊天之间可以并发执行。

| 命令                | 作用                                                  |
| ------------------- | ----------------------------------------------------- |
| `/help`             | 查看机器人命令                                        |
| `/status`           | 查看当前 thread、模型、推理强度和 turn 状态           |
| `/new`              | 中断当前任务，并为这个聊天创建新 thread               |
| `/stop`             | 停止当前聊天正在执行或等待的任务，保留 thread         |
| `/model`            | 查看当前模型与可选模型                                |
| `/model <model-id>` | 切换当前 thread 与新会话的默认模型，仅 owner 可用     |
| `/effort`           | 查看当前推理强度与可选值                              |
| `/effort <level>`   | 切换当前 thread 与新会话的默认推理强度，仅 owner 可用 |

群聊里可以使用 `@机器人 /status` 这样的形式。命令会立即处理，不进入 Codex
prompt，也不等待消息聚合。

## 调整企业微信输出

默认配置会逐项显示 Codex 的工具活动和结果：

```dotenv
OUTPUT_LEVEL=full
OUTPUT_LABEL=show
OUTPUT_FORMAT_TOOL=individual
```

如果更希望群聊只显示精炼的过程摘要，可以使用：

```dotenv
OUTPUT_GROUP_LEVEL=off
OUTPUT_GROUP_LEVEL_CONTENT=full
OUTPUT_GROUP_LABEL_CONTENT=hide
OUTPUT_GROUP_FORMAT_TOOL=summary
```

输出级别、标签、工具摘要以及私聊/群聊覆盖关系见[配置参考](docs/configuration.md)。修改
`.env` 后需要重启机器人。

## Docker Compose

仓库提供了本地镜像和 Compose 配置：

```bash
docker compose up -d --build
docker compose logs -f bot
docker compose down
```

当前 Compose 更适合作为部署起点：宿主工作区挂载在 `/home/bot/workspace`，而默认
`CODEX_WORKSPACE=.` 指向 `/app`；SQLite
与文件日志也还没有宿主持久化卷。正式使用前请按[运行与排障](docs/operations.md#docker-compose)完成路径和持久化配置。

## 文档

| 文档                              | 内容                                           |
| --------------------------------- | ---------------------------------------------- |
| [架构说明](docs/architecture.md)  | 消息生命周期、并发模型、持久化、恢复与代码边界 |
| [配置参考](docs/configuration.md) | 全部环境变量、输出标签、继承规则与常用配置     |
| [安全边界](docs/security.md)      | 敏感信息、owner/restricted 策略与信任边界      |
| [运行与排障](docs/operations.md)  | 本地运行、Docker、日志、状态文件与烟测         |

## 参与开发

测试与实现文件共置在 `src/`。提交前运行：

```bash
deno fmt --check
deno lint
deno task check
deno task test
deno task smoke
```

`deno task smoke` 会校验本机 Codex App Server 协议并完成握手，不启动模型
turn，也不连接企业微信。项目的代码地图、运行时不变量和测试约定见
[AGENTS.md](AGENTS.md)。
