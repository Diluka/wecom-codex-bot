# WeCom Codex Bot 项目指南

## 项目定位

这是一个前台服务，要求 Deno 2.9+ 和 Codex CLI 0.144.6+。它通过企业微信智能
机器人的 WebSocket 长连接，把单聊或群聊消息转发给
`codex app-server --stdio`。每个聊天持久绑定一个 Codex
thread；机器人负责消息路由、状态恢复、增量输出、限流和优雅关闭，Codex CLI
继续使用用户已有的登录信息、配置、沙盒和审批策略。

先用下面这条主链路建立心智模型：

```text
WeCom WebSocket
  -> WeComGateway
  -> ConversationOrchestrator
  -> CodexRuntime
  -> CodexAppServerClient
  -> codex app-server --stdio

Codex notifications
  -> ActivityEvent
  -> TurnOutputPipeline
  -> WeComChatOutput
  -> WeCom reply/stream
```

- 程序入口是 `main.ts`，这里只组装依赖、安装信号处理并统一配置 Pino 日志脱敏、
  终端输出和 `logs/` 文件 transport。
- `CODEX_WORKSPACE` 是 Codex 实际工作的目录；它相对进程工作目录解析，标准
  `deno task start` 从仓库根启动时才等同于相对项目根解析。
- `.data/bot.sqlite` 只保存聊天/thread 绑定、消息去重和 turn
  状态；不保存聊天正文，也不保存 Codex 输出。
- 当前默认分支名是 `master`，不要假设它叫 `main`。

## 代码地图

| 文件                         | 职责                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `main.ts`                    | 加载配置并组装状态库、Codex、企业微信、输出、编排器和生命周期     |
| `src/config.ts`              | 校验环境变量，解析工作目录、`LOG_LEVEL` 和 `OUTPUT_*` 配置        |
| `src/owner-policy.ts`        | 规范化 owner ID，判定 turn 权限并生成稳定的隔离 instructions      |
| `src/wecom.ts`               | 适配企业微信 SDK，规范化单聊/群聊消息，处理连接与回复             |
| `src/state.ts`               | 使用 `node:sqlite` 同步 API 管理持久状态和消息去重                |
| `src/codex-app-server.ts`    | 管理 App Server 子进程、JSONL/JSON-RPC、超时和服务端请求          |
| `src/codex-runtime.ts`       | 把 App Server 包装成可重启的 Codex port，路由早到事件和 turn 结果 |
| `src/orchestrator.ts`        | 核心会话状态机：命令、排队、中断、thread 恢复和最终回复           |
| `src/codex-events.ts`        | 将允许公开的 Codex 通知转换为原始 `ActivityEvent`                 |
| `src/output-settings.ts`     | 定义并解析输出级别、标签和工具格式配置                            |
| `src/output-pipeline.ts`     | 按来源流过滤、截断、加标签并格式化工具输出                        |
| `src/output.ts`              | UTF-8 安全切分、脱敏、限流、发送串行化和流轮换                    |
| `src/chat-output.ts`         | 把通用输出能力接到企业微信回复与流式消息                          |
| `src/lifecycle.ts`           | 固定启动、恢复和优雅关闭顺序                                      |
| `src/prompt.ts`              | 把不可伪造的聊天/发送者元数据加入 Codex prompt                    |
| `src/process-log.ts`         | 每次启动前轮换旧的 Pino 活跃日志文件                              |
| `src/jsonl.ts`、`src/log.ts` | JSONL 读取、Pino transport 和脱敏日志等小型边界工具               |

测试与实现共置为 `src/*.test.ts`。修改某个模块时，先读同名测试；这里大量行为
依赖并发时序，测试往往比类型签名更完整地描述契约。

## 必须保持的运行时不变量

- 普通文本先按 conversation 使用固定 3 秒 trailing debounce。每条通过 `msgid`
  去重的新消息重置窗口；到期后按到达顺序聚合为一个请求。群聊成员共享同一个窗口，
  但每条消息自己的 sender、`msgid` 和 `quote` 都必须保留。整个批次的 progress 和
  final 使用最后一条消息的企业微信 frame。不同 conversation 的窗口相互独立。
- 防抖等待不进入任务 slot，也不打断活动 turn。批次到期后才应用原有
  latest-wins：同一 conversation 中进入 slot 的请求严格串行，活动 turn 存在时由
  新批次请求中断它，普通 pending 只保留最后一个到期批次。不同 conversation 可以
  并发，因此会同时修改同一个工作区；不要在没有明确需求时改成全局串行。
- `/help`、`/status`、`/new`、`/stop` 和不支持的消息绕过防抖。`/help`、`/status`
  和不支持消息直接回复，不重置等待窗口、不进入任务 slot，也不打断活动 turn。
- `/new` 会先取消尚未到期的聚合批次，再使用独立的 reset pending：它会清掉旧的
  普通 pending；如果之后又收到普通文本，则先新建 thread，再执行最后一个到期的
  普通批次。
- `/stop` 必须立即清掉当前 conversation 的防抖批次、普通 pending 和 reset
  pending，并请求中断活动 turn；它保留 thread 绑定。停止后的新普通文本可以重新
  开始防抖窗口，且停止范围不能影响其他 conversation。
- 所有普通文本、命令和不支持的消息都必须先通过 `msgid` 去重。
- `WECOM_OWNER_USER_ID` 缺失、空白或无效时，所有 turn 都必须按 `restricted`
  处理。必须先检查原始值；任意位置含控制符（包括 CR/LF）或 Unicode 行/段分隔符
  即无效，不能先 trim 后绕过。其余值 trim 普通首尾空格后，与每条消息的 sender
  user ID 做区分大小写的精确匹配；聚合批次只有所有 sender 都匹配才是 `owner`，
  任何混合或不一致都必须 fail closed 为 `restricted`。
- owner 隔离 developer instructions 必须在 App Server 每次启动和重启时注入；每个
  turn 的实际判定必须另外通过 `TurnStartParams.additionalContext` 的
  `kind: "application"` 传递。不能依赖聊天正文、历史 turn 或模型自行推断 owner。
- App Server 重启后，持久 thread 必须按新的 runtime generation 重新 resume；崩溃
  时活动 turn 结束为 `runtime_lost`，旧 generation 的晚到事件不能泄漏到新 turn。
- 最终回答由 `TurnOutcome` 直发，不属于过程事件流。原始 `TURN` 通知由 runtime
  忽略，终态只由 orchestrator 生成，避免重复完成消息。
- `ActivityEvent.delivery === "direct"` 有意绕过 `OUTPUT_LEVEL_*` 和标签过滤。
  最终回答、帮助、状态、直接错误和用户输入请求即使所有输出级别为 `off`
  也要可见。
- 工具生命周期和工具结果是两个独立标签。`individual`、`merge_same` 和
  `merge_all` 只处理生命周期格式。
- `summary` 保留 App Server reasoning summary 对应的 `CONTENT`，并抑制普通
  `TOOL`、`TOOL_RESULT` 详情。摘要仍服从 `CONTENT` 的级别和标签规则；没有摘要时
  不得回退或伪造工具摘要。
- 聚合状态必须在 turn 完成、runtime 重启和关闭时清空。
- 企业微信发送按 conversation 保序，并为最终回复、流关闭等关键帧保留额度。修改
  限流、分段或流轮换时，必须保留“常规发送不能饿死关键发送”这一性质。`/stop`
  生效后不得再发起旧 turn 的 final，但已经进入企业微信发送队列的 final
  无法撤回。
- App Server 的交互审批和权限请求当前全部 fail closed。`requestUserInput`
  会把问题直发企业微信、给 App Server 返回空答案并中断
  turn；下一条用户消息会成为新 turn，不是对原请求的进程内续答。
- 关闭时必须取消并丢弃所有尚未到期的防抖批次，使晚到 timer callback 无效。关闭
  顺序必须保持：停止接收新工作并中断 turn、停止常规输出、完成活动流、断开企业
  微信、关闭 App Server、最后关闭 SQLite。每一步失败都不能阻止后续清理。

## Owner 权限与软隔离

- owner ID 被写入启动期 developer instructions，属于有意对模型可见的数据，并且
  可能出现在 App Server argv 或 Codex session metadata；不得把它当作 Secret。
- 不要新增输出 owner ID 的启动日志。既有 request 日志仍按真实消息记录 sender
  `user_id`；owner 配置不会替换、匿名化或隐藏该字段。
- restricted turn 可在 main checkout 中执行无副作用的读取、搜索和状态检查，但
  写操作、测试、构建、格式化、依赖安装及其他潜在写操作必须进入隔离 worktree。
  不得修改 main checkout、index、stash、未提交内容或嵌套仓库状态。
- worktree 位置、分支命名、验证、提交约定，以及 PR/MR 的类型、模板和工作流由目标
  仓库的 `AGENTS.md` 和贡献文档决定；不要在机器人策略中固定 Draft 或 Ready。
  owner 隔离边界优先于冲突的仓库工作流说明，无法安全确定时必须停止并解释。
- restricted turn 只能在非默认 worktree 分支提交和推送，不能提交或推送默认分支、
  不能合并，只能通过 PR/MR 交付；规则同样约束子代理。
- 这是 developer instructions 形成的软边界，不是 OS 权限、Codex sandbox 或 Git
  hook 级别的硬隔离。owner turn 不受这层新增隔离策略限制，但仍受现有 Codex
  配置、仓库文档、sandbox 和审批规则约束。

## 修改时从哪里落手

- 企业微信帧、conversation key 或 SDK 生命周期：改 `src/wecom.ts` 和
  `src/wecom.test.ts`。
- JSON-RPC 协议、App Server 超时或子进程退出：先改
  `src/codex-app-server.ts`，再检查
  `src/codex-runtime.ts`；覆盖乱序响应、早到通知、晚到事件和进程不退出等路径。
- 防抖、排队、latest-wins、`/new`、`/stop`、thread 绑定或关闭竞态：改
  `src/orchestrator.ts`，并同步检查 `src/lifecycle.ts`、`src/state.ts`
  及对应测试。
- 新增或修改 Codex 事件：先在 `src/codex-events.ts` 保持原始语义，再由
  `src/output-pipeline.ts` 决定显示；不要在 adapter 层提前拼接展示标签。
- 输出级别或标签：同步更新 `src/output-settings.ts`、`src/config.ts` 和
  `.env.example`，还要更新 README 配置表和测试。旧变量
  `CODEX_INTERMEDIATE_OUTPUT`、`CODEX_STATUS_DETAIL`
  已被静默忽略，不要重新接回运行时。
- 消息切分、限流、脱敏或流式发送：优先改 `src/output.ts` 的通用能力，再通过
  `src/chat-output.ts` 接入；所有长度边界都要按 UTF-8 验证，不能按 JavaScript
  字符串下标想当然处理。
- SQLite 结构：在 `src/state.ts` 中迁移并提高
  `PRAGMA user_version`，保留旧文件升级路径；不得把聊天正文、prompt 或 Codex
  输出加入状态库。
- 新增配置或命令时，代码、`.env.example`、README 和相应测试必须一起更新。
- 修改 owner 解析、权限判定或注入时，同步检查 `src/config.ts`、
  `src/owner-policy.ts`、`src/orchestrator.ts`、`src/codex-app-server.ts`
  及对应测试；`README.md` 和 `.env.example` 中的安全边界也必须保持一致。

## 开发与测试约定

- 使用 Deno 工具链，不要引入 `package.json` 或另一个包管理器。项目内相对导入保留
  `.ts` 后缀，外部依赖集中在 `deno.json`，锁文件是 `deno.lock`。
- 测试使用 `@std/testing/bdd` 和 `@std/assert`。优先通过接口和构造参数注入
  fake，不要为了测试导出内部私有状态。
- SQLite 单元测试优先用 `:memory:`；验证文件持久化时使用 `Deno.makeTempDir()`
  并在测试结束后清理。环境变量测试必须恢复原值。
- 并发测试使用受控 promise、fake client 或 fake timer 明确推进时序；不要用真实
  `sleep` 掩盖竞态。修改 runtime、orchestrator、output 或 lifecycle
  时同时覆盖失败、关闭和晚到回调路径。
- 先跑与改动同名的单个测试文件，再跑完整验证。例如：

```bash
deno test --allow-env --allow-read --allow-write --allow-run=codex src/orchestrator.test.ts
```

- 安装或更新依赖前，把本机 Deno/npm 源恢复为默认源，避免镜像地址写入锁文件。
  `Dockerfile` 中的 `NPM_CONFIG_REGISTRY` 是镜像构建期设置，不应改变
  `deno.lock`。

## 标准验证

提交前按改动风险执行下面的检查；文档或忽略规则变更至少运行前两项以及 diff 检查：

```bash
deno fmt --check
deno lint
deno task check
deno task test
deno task smoke
```

- 无参数 `deno fmt --check` 会递归进入本地
  `.worktrees/`。如果该目录存在，不要为了
  当前任务格式化其他工作树；改用下面的命令只检查当前 Git 工作区实际跟踪或新增的
  Markdown、JSON 和 TypeScript 文件：

```bash
git ls-files -co --exclude-standard -z -- '*.ts' '*.json' '*.md' | xargs -0 deno fmt --check
```

- `deno task smoke` 先在当前 workspace 的 `.data/` 下生成临时 App Server JSON
  schema，结构化验证 `TurnStartParams.additionalContext` 支持精确的
  `kind: "application"`，再验证本机 `codex app-server --stdio` 握手，并在成功或
  失败后尽最大努力清理临时目录。它不调用模型，也不连接企业微信，可作为默认集成
  烟测。
- `RUN_CODEX_TURN=1 deno task smoke-turn`
  会产生一次真实模型调用。只有用户明确要求真实集成验证时才运行，并在结果中说明它消耗了模型调用。
- 涉及 Dockerfile 或 Compose 时，另外运行 `docker compose config`；只有确实需要
  验证镜像时才执行构建。

## 敏感数据与本地状态

- `.env`、`.data/`、`.codegraph/`、`.superpowers/` 和 `logs/` 都是本地内容，
  不得提交。不要回显真实 `BOT_ID`、`BOT_SECRET`、Codex 登录信息、聊天标识或
  SQLite 内容。
- App Server 子进程环境会显式移除 `BOT_ID`、`BOT_SECRET` 和
  `WECOM_OWNER_USER_ID`，但 owner ID 仍通过 developer instructions 对模型可见，
  也可能出现在 argv 或 session metadata；如果 `.env` 位于 `CODEX_WORKSPACE` 内，
  Codex 仍可直接读取该文件。输出脱敏不是 Secret 隔离边界。
- `~/.codex` 和 `~/.agents` 包含高敏配置与凭据。Compose 会把它们挂进容器；不要在
  测试、日志或提交中复制其内容。
- 同一个 Bot ID 同时只能运行一个实例。不要并行启动 `deno task start` 与
  Compose，也不要在常规测试中连接真实企业微信机器人。
- `.codegraph/` 若存在，只把它当作本地代码索引：不要编辑或暂存。需要理解调用链时
  可优先使用 `codegraph explore`；目录不存在时不要为了普通任务主动生成索引。

## 当前 Compose 边界

不要只根据 README 假定宿主工作区和 SQLite 已被正确持久化。当前 `compose.yml`
的容器工作目录是 `/app`，默认 `CODEX_WORKSPACE=.` 也解析到
`/app`，但宿主仓库挂载在 `/home/bot/workspace`；状态库则写到
`/app/.data/bot.sqlite`，没有独立宿主卷。运行日志同样写到未挂载的
`/app/logs`。修改或宣称 Compose 的工作区编辑、状态或日志持久化行为之前，必须先用
实际容器路径验证。

容器由 Compose 保持前台运行，使用 `restart: unless-stopped` 和一分钟停止宽限期；
不要增加后台守护、PID 文件或额外日志包装层。宿主 Codex 配置引用的绝对路径或外部
命令，只有在容器内也存在时才会工作。
