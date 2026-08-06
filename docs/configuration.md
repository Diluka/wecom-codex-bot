# 配置参考

机器人从项目根目录的 `.env` 读取配置。可以先复制模板：

```bash
cp .env.example .env
```

配置只在进程启动时读取，修改后需要重启服务。

## 基础配置

| 变量                  | 必填 | 默认值 | 说明                                     |
| --------------------- | ---- | ------ | ---------------------------------------- |
| `BOT_ID`              | 是   | -      | 企业微信智能机器人的 Bot ID              |
| `BOT_SECRET`          | 是   | -      | 企业微信智能机器人的 Secret              |
| `WECOM_OWNER_USER_ID` | 否   | 未配置 | 获得 owner 策略的企业微信 sender user ID |
| `CODEX_WORKSPACE`     | 是   | -      | Codex 实际工作的目录                     |
| `LOG_LEVEL`           | 否   | `info` | 运行日志级别：`info` 或 `debug`          |

`.env.example` 把 `CODEX_WORKSPACE` 设为
`.`。它支持绝对路径与相对路径；相对路径按机器人进程的当前工作目录解析。标准
`deno task start` 从仓库根启动时，`.`
就是机器人仓库本身。解析后的路径必须是已经存在的目录。

机器人只把解析后的 workspace 作为 Codex
`cwd`。模型、推理强度、审批、沙盒和网络继续使用 Codex 自身配置。

`WECOM_OWNER_USER_ID` 会先校验原始值。包含控制符或 Unicode
行/段分隔符的值视为未配置；其余值去除普通首尾空格后，与 sender user ID
进行区分大小写的精确匹配。权限含义见[安全边界](security.md)。

## 输出模型

活动输出由三组设置共同决定：

1. `OUTPUT_LEVEL*` 决定正文保留多少。
2. `OUTPUT_LABEL*` 决定是否显示 `[tag]` 前缀。
3. `OUTPUT_FORMAT_TOOL` 决定逐项显示工具，还是只保留 App Server reasoning
   summary。

私聊使用 `OUTPUT_*`。群聊先继承这套默认配置，再应用 `OUTPUT_GROUP_*` 覆盖。

### 输出级别

| 值        | 行为                                                                       |
| --------- | -------------------------------------------------------------------------- |
| `off`     | 隐藏该标签的活动内容                                                       |
| `line`    | 每个来源流保留第一个非空逻辑行，最多 160 个 Unicode 码点；截断时追加 `...` |
| `excerpt` | 每个来源流保留前 800 个 Unicode 码点；截断时追加 `...`                     |
| `full`    | 保留完整活动正文                                                           |

全局级别：

```dotenv
OUTPUT_LEVEL=full
OUTPUT_GROUP_LEVEL=
```

标签级覆盖使用统一格式：

```text
OUTPUT_LEVEL_<TAG>
OUTPUT_GROUP_LEVEL_<TAG>
```

支持的标签：

| 标签          | 内容                                         |
| ------------- | -------------------------------------------- |
| `QUEUE`       | 消息提交与排队状态                           |
| `TURN`        | turn 开始、完成或终止状态                    |
| `TOOL`        | 工具调用的启动与完成                         |
| `TOOL_RESULT` | 命令、进程、文件或 MCP 等工具结果增量        |
| `CONTENT`     | reasoning summary 或过程性内容               |
| `PLAN`        | Codex 计划                                   |
| `WARNING`     | App Server 警告                              |
| `ERROR`       | Codex 或机器人错误                           |
| `SHUTDOWN`    | 关闭时的中断状态                             |
| `SUBAGENT`    | 子代理启动、工作和终止状态，不包含子代理正文 |

例如，只显示工具生命周期首行，并隐藏工具结果：

```dotenv
OUTPUT_LEVEL=off
OUTPUT_LEVEL_TOOL=line
OUTPUT_LEVEL_TOOL_RESULT=off
OUTPUT_FORMAT_TOOL=individual
```

### 标签样式

`show` 添加机器人生成的 `[tag]` 前缀，`hide` 只移除前缀并保留正文。

```dotenv
OUTPUT_LABEL=show
OUTPUT_LABEL_TOOL=hide
OUTPUT_GROUP_LABEL=
OUTPUT_GROUP_LABEL_TOOL=
```

标签级变量格式：

```text
OUTPUT_LABEL_<TAG>
OUTPUT_GROUP_LABEL_<TAG>
```

### 工具输出格式

| 值           | 行为                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `individual` | 分别显示每次工具调用的生命周期；正文仍由 `TOOL` 与 `TOOL_RESULT` 级别控制 |
| `summary`    | 隐藏普通工具生命周期与结果，只保留 App Server 提供的 reasoning summary    |

```dotenv
OUTPUT_FORMAT_TOOL=individual
OUTPUT_GROUP_FORMAT_TOOL=
```

`summary` 会在对应的 `turn/start` 请求中启用 `summary: "auto"`，然后把
`item/reasoning/summaryTextDelta` 作为 `CONTENT`
输出。它不会根据工具名称、命令或结果生成替代摘要；App Server 没有返回 summary
时，工具活动保持静默。

reasoning summary 仍服从 `OUTPUT_LEVEL_CONTENT` 与 `OUTPUT_LABEL_CONTENT`。同一
summary section 会原位刷新当前 stream 的活动尾块；新 section
接替时，上一段会收束为固定的“已完成上一阶段，继续处理中…”提示。

### 群聊继承顺序

输出级别和标签按下面的顺序取最终值：

```text
群聊标签级覆盖
  > 群聊全局覆盖
  > 私聊/默认标签级配置
  > 私聊/默认全局配置
  > 内置默认值
```

工具格式按下面的顺序取值：

```text
OUTPUT_GROUP_FORMAT_TOOL > OUTPUT_FORMAT_TOOL > individual
```

群聊变量全部留空时，群聊与私聊逐项使用相同配置。

## 常用配置

### 完整展示工具过程

```dotenv
OUTPUT_LEVEL=full
OUTPUT_LABEL=show
OUTPUT_FORMAT_TOOL=individual
```

### 只显示无标签的过程摘要

```dotenv
OUTPUT_LEVEL=off
OUTPUT_LEVEL_CONTENT=full
OUTPUT_LABEL_CONTENT=hide
OUTPUT_FORMAT_TOOL=summary
```

### 群聊安静，保留警告与错误

```dotenv
OUTPUT_GROUP_LEVEL=off
OUTPUT_GROUP_LEVEL_WARNING=line
OUTPUT_GROUP_LEVEL_ERROR=full
```

### 私聊完整、群聊只显示摘要

```dotenv
OUTPUT_LEVEL=full
OUTPUT_FORMAT_TOOL=individual

OUTPUT_GROUP_LEVEL=off
OUTPUT_GROUP_LEVEL_CONTENT=full
OUTPUT_GROUP_LABEL_CONTENT=hide
OUTPUT_GROUP_FORMAT_TOOL=summary
```

## 始终可见的消息

direct 消息不经过活动级别与标签过滤。即使全局设置为
`off`，下面这些内容仍会发送：

- 最终回答
- `/help`、`/status`、`/model`、`/effort`、`/stop` 等命令回复
- 不支持消息类型的提示
- App Server 用户输入请求
- 直接失败消息

## 已停用的旧变量

`CODEX_INTERMEDIATE_OUTPUT` 和 `CODEX_STATUS_DETAIL`
会被静默忽略。现有部署可以删除它们，并使用 `OUTPUT_*` 配置输出行为。
