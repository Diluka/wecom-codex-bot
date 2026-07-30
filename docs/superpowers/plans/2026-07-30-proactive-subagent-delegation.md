# Proactive Subagent Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the WeCom bot's Codex turns proactively choose subagents by always
starting turns at Ultra reasoning effort.

**Architecture:** Keep the public `CodexAppServerClient` API unchanged. Add the
supported `effort: "ultra"` protocol field at the existing `turn/start`
boundary, so App Server upgrades both new and resumed persistent threads on
their next turn. Document this deliberate override next to the bot's
configuration model.

**Tech Stack:** Deno 2, TypeScript, Codex App Server JSON-RPC, Deno BDD tests.

## Global Constraints

- Use `effort: "ultra"`; do not send deprecated `multiAgentMode`.
- Preserve all existing thread, turn, and prompt APIs.
- Do not alter child-agent UI, latest-wins behavior, or subagent nesting rules.
- Prove the JSON-RPC request shape with the existing fake App Server test.
- Keep the documentation in Chinese, matching the README.

---

### Task 1: Send Ultra Effort For Every Codex Turn

**Files:**

- Modify: `src/codex-app-server.test.ts:252-268`
- Modify: `src/codex-app-server.ts:264-270`
- Modify: `README.md:23-24`

**Interfaces:**

- Consumes: `CodexAppServerClient.startTurn(threadId: string, text: string)`.
- Produces: A `turn/start` JSON-RPC request whose `params.effort` is the literal
  string `"ultra"`; callers retain the same method signature and return value.

- [ ] **Step 1: Write the failing request-shape assertion**

  In the existing
  `uses increasing RPC ids and only the allowed thread and turn overrides` test,
  add this expected field to the `turn/start` request:

  ```ts
  effort: "ultra",
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run:

  ```bash
  deno test --allow-env --allow-read --allow-write --allow-run=codex src/codex-app-server.test.ts
  ```

  Expected: the request-shape assertion fails because the actual `turn/start`
  parameters do not yet contain `effort`.

- [ ] **Step 3: Add the minimal protocol field**

  In `CodexAppServerClient.startTurn()`, add the literal field to the existing
  request parameters:

  ```ts
  cwd: this.#cwd,
  effort: "ultra",
  ```

  Do not change the method signature or add `multiAgentMode`.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run the command from Step 2 again.

  Expected: the App Server client test file reports no failures.

- [ ] **Step 5: Document the deliberate effort override**

  Replace the README configuration sentence with this literal Markdown:

  <pre>
  `CODEX_WORKSPACE` 支持相对路径，按机器人项目目录解析。机器人将解析后的 `cwd`
  传给 Codex，并在每个 turn 上显式设置 `effort: "ultra"`，使 Codex 可在任务适合时主动
  使用子代理。审批、沙盒、网络、模型等其余行为仍使用现有 Codex config。
  </pre>

- [ ] **Step 6: Run all repository verification**

  ```bash
  deno task check
  deno task test
  deno task smoke
  deno fmt --check
  deno lint
  ```

  Expected: every command exits with code 0. `deno task smoke` validates only
  the local App Server handshake and does not invoke a model turn.

- [ ] **Step 7: Commit the task**

  ```bash
  git add src/codex-app-server.ts src/codex-app-server.test.ts README.md
  git commit -m "feat: enable proactive Codex subagents"
  ```
