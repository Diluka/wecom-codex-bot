# Subagent Status Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render named Codex subagent lifecycle states in the parent WeCom
progress stream without exposing subagent content.

**Architecture:** Preserve subagent thread metadata from `thread/started`, parse
collaboration lifecycle items into normalized status updates, and hold a
runtime-only registry keyed by parent thread and child thread. The runtime waits
for a readable child name when possible, then emits a new `SUBAGENT` activity
into the existing parent turn pipeline; it never reads child messages or writes
child state to SQLite.

**Tech Stack:** Deno, TypeScript, Codex App Server JSON-RPC, WeCom streaming
replies, Deno BDD tests.

## Global Constraints

- Display-name precedence is `agentNickname`, then thread `name`, then
  `agentRole`, then the first 8 code units of the child thread ID.
- If a nickname or title exists together with a role, render the name followed
  by the role in parentheses.
- Do not send child prompts, reasoning, tool output, process text, messages, or
  final answers.
- Map `pendingInit` to `已启动`; `running`, `started`, and `interacted` to
  `正在工作`; `interrupted` and `shutdown` to `已取消`; `completed` to `已完成`;
  `errored` and `notFound` to `失败`.
- Suppress consecutive duplicate states for the same child and parent turn;
  state transitions remain visible.
- Hold a non-terminal state until name metadata arrives; emit a terminal state
  with the short-ID fallback if its name is still unavailable.
- Keep all state in memory and clear it when the parent turn completes, is lost,
  or the App Server exits.
- Add `SUBAGENT` to the existing `OUTPUT_LEVEL_*` and `OUTPUT_LABEL_*` system;
  it must not participate in `OUTPUT_FORMAT_TOOL` aggregation.

---

### Task 1: Preserve and Normalize Subagent Protocol Data

**Files:**

- Modify: `src/codex-app-server.ts:26-28,507-511`
- Modify: `src/codex-events.ts:1-236`
- Modify: `src/codex-app-server.test.ts:311-412`
- Modify: `src/codex-events.test.ts:1-246`

**Interfaces:**

- Consumes: raw App Server `thread/started`, `item/started`, and
  `item/completed` notifications.
- Produces: `ThreadStartedEvent` with optional child-thread metadata and
  `describeSubagentStatusUpdates(notification): SubagentStatusUpdate[]`.

- [ ] **Step 1: Write failing protocol and adapter tests**

Extend the existing `thread/started` fixture so the callback is expected to
receive all four optional fields:

```ts
{
  threadId: "child-1",
  parentThreadId: "parent-1",
  agentNickname: "amber-otter",
  agentRole: "reviewer",
  name: "Review API",
}
```

Add adapter tests for these two notifications:

```ts
describeSubagentStatusUpdates({
  method: "item/started",
  params: {
    threadId: "parent-1",
    turnId: "turn-1",
    item: {
      type: "collabAgentToolCall",
      receiverThreadIds: ["child-1", "child-2"],
      agentsStates: { "child-1": { status: "pendingInit" } },
    },
  },
});
// child-1 -> starting; child-2 -> starting

describeSubagentStatusUpdates({
  method: "item/completed",
  params: {
    threadId: "parent-1",
    turnId: "turn-1",
    item: {
      type: "subAgentActivity",
      agentThreadId: "child-1",
      kind: "interrupted",
    },
  },
});
// child-1 -> cancelled
```

Also cover `agentsStates` values for `running`, `completed`, `errored`,
`shutdown`, and an unknown value. Assert that unknown values yield no update and
that each returned update retains the parent `threadId` and `turnId`.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
deno test --allow-env --allow-read --allow-write --allow-run=codex \
  src/codex-app-server.test.ts src/codex-events.test.ts
```

Expected: the new expectations fail because `ThreadStartedEvent` only contains
`threadId` and no subagent-status adapter exists.

- [ ] **Step 3: Implement the minimal protocol model and status parser**

In `src/codex-app-server.ts`, extend the public event without making metadata
mandatory:

```ts
export interface ThreadStartedEvent {
  threadId: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  name?: string;
}
```

When handling `thread/started`, extract only non-empty strings from
`params.thread` and emit the matching optional properties with `threadId`.

In `src/codex-events.ts`, export these exact types and function:

```ts
export type SubagentStatus =
  | "starting"
  | "working"
  | "cancelled"
  | "completed"
  | "failed";

export interface SubagentStatusUpdate {
  threadId?: string;
  turnId?: string;
  agentThreadId: string;
  status: SubagentStatus;
}

export function describeSubagentStatusUpdates(
  notification: CodexNotification,
): SubagentStatusUpdate[];
```

Use only `collabAgentToolCall` and `subAgentActivity` items. For a collaboration
item, create a `starting` update for every `receiverThreadIds` entry and convert
each `agentsStates[childId].status` through the global mapping. For a subagent
activity item, convert `started` and `interacted` to `working`, and
`interrupted` to `cancelled`. Return an empty array for missing IDs, unsupported
item types, and unknown values. Do not alter the existing generic `TOOL`
adaptation.

- [ ] **Step 4: Run focused tests and static checking**

Run:

```bash
deno test --allow-env --allow-read --allow-write --allow-run=codex \
  src/codex-app-server.test.ts src/codex-events.test.ts
deno check main.ts
```

Expected: both test files pass and `deno check` exits 0.

- [ ] **Step 5: Commit the protocol layer**

Run:

```bash
git add src/codex-app-server.ts src/codex-events.ts \
  src/codex-app-server.test.ts src/codex-events.test.ts
git commit -m "feat(protocol): expose subagent status events"
```

### Task 2: Route Named Statuses Through the Parent Output Stream

**Files:**

- Modify: `src/activity-event.ts:1-16`
- Modify: `src/output-settings.ts:1-102`
- Modify: `src/codex-runtime.ts:1-612`
- Modify: `src/output-pipeline.test.ts:1-275`
- Modify: `src/codex-runtime.test.ts:1-440`
- Modify: `src/config.test.ts:1-240`
- Modify: `README.md:39-63`

**Interfaces:**

- Consumes: `ThreadStartedEvent`, `SubagentStatusUpdate`, and the existing
  `ActivityEvent` callback passed to `CodexRuntime.startTurn`.
- Produces: parent-turn events shaped as
  `{ tag: "SUBAGENT", body: "display name：Chinese status", itemId: childThreadId, delivery: "progress" }`.

- [ ] **Step 1: Write failing runtime and output-setting tests**

Add a runtime test that starts `parent-1/turn-1`, sends an `item/started`
`collabAgentToolCall` for `child-1`, then sends this metadata callback:

```ts
client.callbacks.onThreadStarted?.({
  threadId: "child-1",
  parentThreadId: "parent-1",
  agentNickname: "amber-otter",
  agentRole: "reviewer",
});
```

Assert that the parent callback receives, in order:

```ts
[
  {
    tag: "SUBAGENT",
    body: "amber-otter (reviewer)：已启动",
    itemId: "child-1",
    threadId: "parent-1",
    turnId: "turn-1",
    delivery: "progress",
  },
  {
    tag: "SUBAGENT",
    body: "amber-otter (reviewer)：正在工作",
    itemId: "child-1",
    threadId: "parent-1",
    turnId: "turn-1",
    delivery: "progress",
  },
  {
    tag: "SUBAGENT",
    body: "amber-otter (reviewer)：已完成",
    itemId: "child-1",
    threadId: "parent-1",
    turnId: "turn-1",
    delivery: "progress",
  },
];
```

Drive the last two states using `subAgentActivity.kind: "started"` and
`agentsStates: { "child-1": { status: "completed" } }`. Re-send `started` and
assert no duplicate event. Add a separate terminal-without-metadata case that
produces `child-no：已完成` from `child-no-name`.

In `src/output-pipeline.test.ts`, assert that `SUBAGENT` renders as
`[subagent] amber-otter：正在工作` by default, becomes `amber-otter：正在工作`
when its label is hidden, and is `null` when `OUTPUT_LEVEL_SUBAGENT` is `off`.
In `src/config.test.ts`, assert `parseOutputSettings` accepts
`OUTPUT_LEVEL_SUBAGENT` and `OUTPUT_LABEL_SUBAGENT`.

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
deno test --allow-env --allow-read --allow-write --allow-run=codex \
  src/codex-runtime.test.ts src/output-pipeline.test.ts src/config.test.ts
```

Expected: tests fail because `SUBAGENT` is not an output tag and runtime has no
child metadata/status registry.

- [ ] **Step 3: Implement runtime-only association, rendering, and
      configuration**

Add `"SUBAGENT"` to `OUTPUT_TAGS`; do not add it to tool-format aggregation.
Keep its defaults inherited from `DEFAULT_OUTPUT_SETTINGS`, making it visible
under the current deployment's unset global output level.

In `CodexRuntime`, add an in-memory registry keyed by parent thread ID and child
thread ID. Each record stores the parent turn ID, optional `agentNickname`,
`agentRole`, `name`, latest normalized status, and last emitted status. Wire
`onThreadStarted` in `#callbacks` and merge child metadata using
`parentThreadId`. For each `describeSubagentStatusUpdates(event)` result,
associate it with the parent notification IDs and update the registry.

Use these helper signatures:

```ts
#handleThreadStarted(token: object, event: ThreadStartedEvent): void
#recordSubagentStatus(
  parentThreadId: string,
  parentTurnId: string,
  update: SubagentStatusUpdate,
): void
#emitSubagentStatus(
  parentThreadId: string,
  childThreadId: string,
): void
```

`#emitSubagentStatus` must wait for a display name for non-terminal states. For
`completed`, `cancelled`, or `failed`, it must fall back to
`childThreadId.slice(0, 8)` when no metadata is available. It must route the
event through `#routeActivity` so existing late-event protection and buffering
still apply. Emit status labels exactly as `已启动`, `正在工作`, `已取消`,
`已完成`, and `失败`.

Clear child records for a completed parent turn in `#completeTurn`, clear
records for all lost turns in `#resolveActiveTurnsAsLost`, and clear all records
in `#clearBufferedEvents`.

Update the README output-tag table to list `SUBAGENT` as child-agent lifecycle
status and state that it does not expose child content.

- [ ] **Step 4: Run focused tests, formatting, and the full suite**

Run:

```bash
deno fmt --check
deno lint
deno task check
deno test --allow-env --allow-read --allow-write --allow-run=codex \
  src/codex-runtime.test.ts src/output-pipeline.test.ts src/config.test.ts
deno task test
```

Expected: all commands exit 0; the full suite reports every test passing.

- [ ] **Step 5: Commit the observable status feature**

Run:

```bash
git add README.md src/activity-event.ts src/output-settings.ts src/codex-runtime.ts \
  src/output-pipeline.test.ts src/codex-runtime.test.ts src/config.test.ts
git commit -m "feat(output): show named subagent statuses"
```

### Task 3: Review the Complete Branch and Prepare the Pull Request

**Files:**

- Review: `docs/superpowers/specs/2026-07-31-subagent-status-design.md`
- Review: `docs/superpowers/plans/2026-07-31-subagent-status.md`
- Review: all files changed by Tasks 1 and 2

**Interfaces:**

- Consumes: complete branch diff from `master` to `codex/subagent-status`.
- Produces: verified branch ready to push and a pull request that describes the
  status-only boundary.

- [ ] **Step 1: Inspect the complete diff against the approved scope**

Run:

```bash
git diff --check master...HEAD
git diff --stat master...HEAD
git diff master...HEAD
```

Verify that no SQLite schema, child-content forwarding, child-thread RPC reads,
or changes to final-answer delivery are included.

- [ ] **Step 2: Request an independent code review**

Create a review package with the branch merge base:

```bash
MERGE_BASE=$(git merge-base master HEAD)
/home/diluka/OneDrive/.agents/skills/subagent-driven-development/scripts/review-package \
  "$MERGE_BASE" HEAD
```

Dispatch a read-only reviewer using
`/home/diluka/OneDrive/.agents/skills/requesting-code-review/code-reviewer.md`
with the generated package, the approved specification, and this plan. Require
the reviewer to inspect event ordering, per-turn cleanup, status duplication,
the no-content boundary, and the unchanged parent final-answer path. Resolve
every Critical or Important finding and rerun the covering focused tests for
each fix.

- [ ] **Step 3: Re-run completion verification**

Run:

```bash
deno fmt --check
deno lint
deno task check
deno task test
git status --short
```

Expected: quality checks and tests pass; the working tree is clean apart from
the saved plan document if it has intentionally not yet been committed.

- [ ] **Step 4: Commit the implementation plan if it remains uncommitted**

Run:

```bash
git add docs/superpowers/plans/2026-07-31-subagent-status.md
git commit -m "docs(subagents): add implementation plan"
```

- [ ] **Step 5: Push and open the pull request**

Run:

```bash
git push -u origin codex/subagent-status
PR_BODY_FILE=$(mktemp)
printf '%s\n' \
  '## What changed' \
  '- Shows each subagent by its readable Codex name and lifecycle status.' \
  '- Keeps updates in the parent WeCom progress stream.' \
  '' \
  '## Deliberate boundary' \
  '- Does not forward subagent prompts, messages, tool output, or final answers.' \
  '- Does not persist subagent state.' > "$PR_BODY_FILE"
gh pr create --base master --head codex/subagent-status \
  --title "feat(output): show named subagent statuses" \
  --body-file "$PR_BODY_FILE"
```

The PR body must state that it adds only child names and lifecycle statuses,
retains existing parent final answers, and deliberately excludes child
message/content forwarding and persistence.
