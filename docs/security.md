# 安全边界

WeCom Codex Bot 把企业微信消息交给本机 Codex，并允许 Codex 在 `CODEX_WORKSPACE`
中工作。它适合由可信用户控制的本地机器人；owner
识别用于向模型表达操作策略，不是操作系统级访问控制。

## 先建立清晰的信任边界

项目不会识别、扫描、替换或脱敏以下内容中的敏感值：

- 用户聊天与引用消息
- Codex 输出、工具调用和工具结果
- 错误消息
- 企业微信 SDK 日志
- Pino 日志字段

企业微信输出只进行格式化、长度控制、限流和分段。请把凭据保存在 Codex
工作区之外，并让机器人只服务可信的会话与工作目录。

引用消息会把原始 `quote` JSON 交给 Codex，其中可能保留企业微信 URL 与 AES
字段。图片支持沿用相同的信任边界，不增加内容脱敏层。

## owner 识别

`WECOM_OWNER_USER_ID` 是可选的企业微信 sender user ID：

- 未设置、空值或校验失败时，所有 turn 使用 `restricted` 策略。
- 配置有效时，一个聚合批次中的每条消息都必须来自该 sender，整个 turn 才使用
  `owner` 策略。
- sender ID 采用区分大小写的精确匹配。
- 群聊和单聊使用同一套判定；混合 sender 批次会收敛到 `restricted`。

原始配置中只要出现控制符、CR/LF 或 Unicode
行/段分隔符，整项配置就视为未配置。通过校验后才会去除普通首尾空格。

## 两层策略注入

机器人通过两层可信元数据把策略传给 Codex：

1. 每次 App Server 启动或重启时，注入稳定的 owner 隔离 developer instructions。
2. 每个 `turn/start` 通过 `additionalContext.wecom_owner_policy` 注入本 turn 的
   `owner` 或 `restricted` 结果，类型为 `kind: "application"`。

owner ID 会写入 developer instructions，并可能出现在 App Server 进程参数或 Codex
session metadata 中。它是身份标识，不应作为 Secret 使用。

## restricted turn 可以做什么

restricted 策略允许：

- 在目标仓库的 main checkout 中读取、搜索和检查状态
- 在仓库认可的位置创建隔离 worktree
- 创建或继续非默认任务分支
- 在隔离工作树中修改文件、安装依赖、测试、构建和提交
- 通过非强制推送更新任务分支
- 在用户要求时创建或更新对应 PR/MR

需要写入时，目标仓库根目录、默认分支和安全 worktree
路径必须先明确。分支命名、验证、提交和 PR/MR 流程继续遵循目标仓库的 `AGENTS.md`
与贡献文档。

restricted 策略把以下动作保留给 owner 或其他外部授权边界：

- 修改 main checkout、默认分支或无关嵌套仓库
- 改写 index、stash 或现有未提交工作
- 强制推送、删除远端引用或覆盖并发更新
- 合并或关闭 PR/MR
- 发布、部署、修改仓库设置或 owner 全局配置

这套规则是 developer instructions 形成的软隔离。实际能力仍由 Codex
配置、沙盒、审批策略、文件权限和仓库指令共同决定。

## Codex 子进程与 `.env`

App Server 子进程环境会移除 `BOT_ID`、`BOT_SECRET` 和
`WECOM_OWNER_USER_ID`。这可以减少它们通过子进程环境继承暴露的机会，但不构成完整隔离：当
`.env` 位于 `CODEX_WORKSPACE` 中时，Codex 仍能通过文件读取它。

推荐目录关系：

```text
/opt/wecom-codex-bot/.env       # 机器人凭据
/work/your-project/             # CODEX_WORKSPACE
```

让机器人仓库与目标工作区分开，可以避免 `.env` 自然落入 Codex 的读取范围。

## 日志中的信息

机器人自己的 Codex
生命周期日志只记录方法、ID、类型、状态、耗时、长度和路由结果，不记录聊天正文、reasoning
summary、命令、参数或工具结果。高频 delta 会聚合后记录计数与总长度。

这不是敏感值检测：

- request 日志包含真实 `chat_id`、`user_id`、`msg_id`、thread ID 和 turn ID。
- `received` 状态包含折叠空白后的前 10 个 Unicode 字素簇摘要。
- 启动日志会记录规范化后的 owner user ID。
- 企业微信 SDK 的上游诊断仍可能包含文本片段。
- 普通嵌套 Pino 结构由 Pino 原生序列化。

`logs/`
应作为本地敏感运行数据管理，不提交或公开。更多日志位置和轮换方式见[运行与排障](operations.md#日志)。

## Docker 挂载

Compose 会把宿主机的 `~/.codex` 和 `~/.agents`
挂入容器，其中可能包含高敏配置、访问凭据和可执行指令。部署主机、镜像和容器内进程都应处于同一可信边界。

同一个 Bot ID
保持单实例运行，可以避免多个进程同时接收消息、争用状态并以同一身份执行 Codex
工作。
