# Proactive Subagent Delegation Design

## Goal

Allow the Codex instance behind the WeCom bot to decide when subagents would
materially improve a task, including for conversations already bound to a
persistent thread.

## Context

The bot currently omits reasoning effort from `turn/start`. A persistent thread
therefore keeps its earlier `xhigh` setting and receives the built-in
`explicitRequestOnly` multi-agent policy, even after the user's global Codex
configuration changes to `ultra`.

Current Codex App Server schemas mark `multiAgentMode` as deprecated and
ignored. They identify `effort: "ultra"` on `turn/start` as the supported way to
enable proactive multi-agent behavior. A turn-level effort override also
becomes the default for subsequent turns on the same thread.

## Design

`CodexAppServerClient.startTurn()` will add `effort: "ultra"` to every
`turn/start` request. This is deliberately applied at the turn boundary rather
than at thread creation so it upgrades existing persisted threads on their next
message as well as new threads.

The bridge will not inject a prompt about subagents and will not send the
deprecated `multiAgentMode` field. App Server remains responsible for deciding
whether a particular task benefits from delegation and for orchestrating child
threads.

## Alternatives Considered

1. Send `multiAgentMode: "proactive"`: rejected because the current protocol
   accepts the field only for compatibility and ignores it.
2. Add a developer instruction telling Codex to spawn agents: rejected because
   it duplicates runtime policy in prompt text and can drift from Codex's
   supported behavior.
3. Require `/new` after restarting the bot: rejected because it discards useful
   conversation history and does not repair already persisted threads.

## Error Handling

If the selected model or provider rejects `ultra`, `turn/start` will fail through
the existing RPC error path. The orchestrator already reports start failures to
the conversation and keeps the thread binding intact. No fallback to a less
capable effort is added because that would silently restore the restriction this
change is intended to remove.

## Testing And Documentation

The existing App Server request-shape test will assert that `turn/start` carries
`effort: "ultra"`. The test must fail before the implementation is changed and
pass afterward. README configuration text will document that model, sandbox,
approval, and network behavior still come from Codex config while reasoning
effort is pinned to Ultra to permit proactive delegation.

## Non-Goals

- Adding a WeCom UI for browsing or switching child-agent threads.
- Changing the bot's concurrency or latest-wins behavior.
- Defining custom agent roles or models.
- Allowing subagents to create nested subagents.
