# Tiller Pi adapter

A [Pi](https://pi.dev) extension that makes an interactive `pi` CLI process a first-class
[Tiller](../../README.md) node. It mirrors the Claude Code mod in `mod/` but uses Pi's extension
API instead of Claude hooks.

The extension is a thin bridge: it forwards Pi lifecycle data to the Tiller daemon and delivers
Tiller inbox messages into Pi. It does **not** reinterpret permissions, change the tool set, or
spawn processes.

```
 adapters/pi/
   index.ts      extension factory (loaded by pi)
   bridge.ts     inbox poll / claim / submit / ack / steer state machine
   client.ts     Tiller HTTP client (node-scoped bearer auth)
   config.ts     TL_* environment parsing + unsupported-restriction rejection
   lifecycle.ts  pure Pi-event -> Tiller /hook and /mod-event mappers
   types.ts      structural subset of the Pi API (no runtime dependency on Pi)
   *.test.ts     vitest coverage for the pure helpers and the bridge
```

## Load it

The daemon launches Pi with an explicit session file and the extension path, e.g.:

```sh
TL_NODE_ID=n-abc123 \
TL_ENDPOINT=http://127.0.0.1:7654 \
TL_TOKEN_FILE=<home>/nodes/n-abc123/token \
TL_SESSION_ID=<tiller-session-uuid> \
pi --extension <repo>/adapters/pi \
  --session <home>/sessions/<rootId>/agents/n-abc123/<tiller-session-uuid>.jsonl
```

`TL_SESSION_ID` is the daemon-minted Tiller session id. The bridge reports it as `session_id`,
never Pi's own header session UUID, because the node record, transcript path and resume all key
off the Tiller id.

You can also try it without a daemon:

```sh
pi --extension ./adapters/pi
```

Without `TL_NODE_ID` the extension loads but does nothing (the same inert contract as the Claude
mod). Pi loads the directory through `jiti`, so no build step is required.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `TL_NODE_ID` | yes | Node id; sent as `X-TL-Node`. Presence enables the bridge. |
| `TL_ENDPOINT` | yes | Daemon base URL, e.g. `http://127.0.0.1:7654`. |
| `TL_TOKEN_FILE` | yes | File holding the node bearer token (0600). |
| `TL_SESSION_ID` | no | The daemon-minted Tiller session id reported as `session_id`. Missing means unmanaged. |
| `TL_PARENT_ID` | no | Recorded but not otherwise used by the bridge. |
| `TL_SESSION_DIR` | no | Tiller session directory; not used by the bridge itself. |
| `TL_PI_POLL_MS` | no | Inbox poll interval in ms, `>= 100`. Default `1000`. |
| `TL_PI_HOOK_TOOLS` | no | `1`/`true`/`yes`/`on` to forward tool activity as `/hook`. |
| `TL_PI_MCP_EXPOSURE` | no | MCP exposure for `tiller`: `direct` (default), `codemode`, `deferred`, `hidden`. |

### Rejected settings

The adapter cannot enforce Pi permission or tool restrictions safely, so it refuses to activate
when it sees any of these (and leaves Pi's own permissions untouched):

`TL_PERMISSION_MODE`, `TL_APPROVAL_MODE`, `TL_ALLOWED_TOOLS`, `TL_TOOLS`,
`TL_DISALLOWED_TOOLS`, `TL_EXCLUDE_TOOLS`, `TL_MAX_TURNS`, `TL_SANDBOX`,
`TL_BYPASS_PERMISSIONS`.

The daemon should reject these before spawning a Pi node. `findUnsupportedRestrictions()` in
`config.ts` is exported so daemon code can share the same list. This is a fail-closed choice: the
bridge stays inert rather than running with weaker safety than the operator asked for.

## Protocol mapping

All calls use `Authorization: Bearer <token>` and `X-TL-Node: <nodeId>`.

| Pi event / API | Tiller call | Notes |
|---|---|---|
| `session_start` | `POST /hook` `SessionStart` | `session_id` (`TL_SESSION_ID`), `transcript_path` (from `--session`), `model`. |
| `session_start` | `pi.registerMcpServer("tiller", …)` | HTTP MCP at `<endpoint>/mcp`, node-scoped headers. Gated: a build without `registerMcpServer` fails closed. |
| `before_agent_start` (`user`) | `POST /hook` `UserPromptSubmit` | The actual prompt Pi accepted; also the only source of bridge acceptance, so a void `sendUserMessage` return is never treated as delivered. |
| `agent_start` | `POST /mod-event` `turn.start` | Once per run (`{ text, turnId }`, informational), not per model turn. |
| `turn_end` | `POST /mod-event` `session.measure` | Context usage + cumulative session cost. |
| `agent_settled` | `POST /mod-event` `turn.complete` | The authoritative, final boundary. `aborted`, `durationMs`, `answer`, `usage.model`, and the final `stopReason` mapped to `reason` (`answer` / `aborted` / `error`). |
| `agent_settled` | `POST /mod-event` `session.measure` | See above. |
| `ui_prompt_start` | `POST /hook` `Notification` | `confirm` → `permission_prompt` (blocked); other kinds → `elicitation_dialog` (waiting). Only during an active run. |
| `ui_prompt_end` | `POST /hook` `PostToolUse` | Returns the node to working; paired with a mapped start (nested dialogs are counted). |
| `tool_execution_start` / `_end` | `POST /hook` `PreToolUse` / `PostToolUse` | Only with `TL_PI_HOOK_TOOLS`. Pi tool names/fields are mapped to the Claude names the daemon's reducer reads; the raw name stays in `pi_tool_name`. |
| `session_shutdown` (`quit`) | `POST /hook` `SessionEnd` | Await the queued hooks, then dispose the HTTP client. Other shutdown reasons replace the runtime and a new `session_start` follows. |
| poll loop | `GET /inbox`, `POST /claim`, `POST /ack` | See below. |

Every hook and mod-event is serialized through one in-process queue and awaited, so
`SessionStart` can never race the first turn's `turn.start` / `UserPromptSubmit`.

### Inbox, claim, ack, steer

On every poll (`pollOnce`, one in flight at a time):

1. A claimed message is submitted (or, if it was already submitted, its ack is retried).
2. `GET /inbox` is fetched.
3. At most **one immediate next** message is claimed: the oldest while idle, or a single `steer`
   while busy. Everything behind it stays in the daemon (unclaimed) so its sender can still
   withdraw it. A claimed steer aborts the running turn and is delivered once Pi reports idle.
4. A message claimed while idle is submitted in the same cycle.

`POST /claim` returning `404` means the message was withdrawn or expired, so it is skipped and
the next message becomes the immediate one. Non-steer submissions pass `deliverAs: "followUp"` as
a race guard: if Pi became busy between the idle check and the submit, the message queues instead
of being rejected.

`sendUserMessage` is fire-and-forget in Pi: a void return is **not** evidence Pi accepted the
prompt, because Pi can reject the input asynchronously or consume it without ever starting a run.
The bridge therefore tracks `submitted` (the call was made, so the message must never be sent
again) and `accepted` (a matching `before_agent_start` started a run with that exact prompt)
separately. It marks the message submitted **before** calling `sendUserMessage`, because Pi can
dispatch `before_agent_start` synchronously from inside that call; a synchronous throw resets the
marker only when the prompt was not accepted in the meantime. Only acceptance acks the message and
releases the queue. A submit Pi never accepts is retained and is retried only when the send call
itself threw. If the daemon drops a submitted-but-unaccepted message (TTL, restart, close), the
bridge clears it after two consecutive inbox misses and reports it as expired. A later message
(including a steer) is not claimed until the held one clears, so ordering and no-duplicate safety
are kept.

## Pi API compatibility

Target: `@earendil-works/pi-coding-agent` **1.2.x**. The adapter relies on:

- `pi.on("session_start" | "session_before_switch" | "session_before_fork" |
  "session_before_tree" | "session_shutdown" | "before_agent_start" | "agent_start" |
  "model_select" | "turn_start" | "turn_end" | "agent_end" | "agent_settled" |
  "ui_prompt_start" | "ui_prompt_end" | "tool_execution_start" | "tool_execution_end")`
- `pi.registerMcpServer` / `pi.unregisterMcpServer` (HTTP MCP config)
- `pi.sendUserMessage(content, { deliverAs })`
- `ctx.isIdle()`, `ctx.abort()`, `ctx.getContextUsage()`, `ctx.sessionManager.getSessionId() /
  getSessionFile() / getEntries()`, `ctx.model`, `ctx.ui.notify`, `ctx.shutdown()`

The bridge checks these before it registers the MCP server or reads the token. A Pi build missing
`registerMcpServer`, `sendUserMessage`, `pi.on`, `ctx.isIdle` or `ctx.abort` is refused with an
error and `ctx.shutdown()` rather than left running as a half node. This is the same fail-closed
posture as the unsupported-restriction check.

`agent_settled` is the final boundary (`docs/extensions.md`): unlike `agent_end`, no automatic
retry, compaction, or queued continuation follows, so `turn.complete` is reported there.

`types.ts` declares the exact structural subset used. There is **no runtime import** from the Pi
packages, which keeps the main Tiller package free of a Pi dependency and lets the bridge be
tested with a fake Pi. `package.json` lists the Pi package as a peer dependency for packaging,
not as a runtime dependency.

## Develop

Tests and typechecking run from the repository root:

```sh
npx vitest run adapters/pi
npx tsc -p adapters/pi/tsconfig.json
```

The suite covers config parsing and restriction rejection, the HTTP client, the lifecycle
mappers, and the bridge state machine (idle delivery, daemon-held messages, steer abort, poll
non-overlap, timer cleanup, send retry/drop, ack failure) with an injectable fake Pi and fetch.

### Managed sessions are protected

For a node launched by the daemon (`TL_SESSION_ID` set), Pi's own `/new`, `/resume`, `/fork` and
`/tree` would move the session id or file out from under the daemon, so `session_before_switch`,
`session_before_fork` and `session_before_tree` cancel them with a warning. If a Pi build ignores
the cancel and a `new`/`resume`/`fork` `session_start` still arrives, the bridge reports the error
and calls `ctx.shutdown()` instead of letting the managed UUID point at a different conversation.
`/reload` is still allowed: it restarts the extension runtime in place with the same session file.

## Limitations

- Turn text for `turn.start` is the most recent user prompt seen by the extension; Pi's
  `agent_start` event does not carry it.
- `session.measure.cost` is derived from session entries the way Pi's `getSessionStats()` does.
  It is a snapshot; `rateLimits` are not available in Pi and are never reported.
- `turn.complete.reason` is `answer`, `aborted` or `error`: the final assistant message's
  `stopReason` (`aborted`/`error`) is mapped at `agent_settled`. Pi does not expose a distinct
  `refusal` reason.
- A claimed message whose submission fails before acceptance is retried at most 5 times, then
  dropped (it cannot be un-claimed). A message Pi accepted but whose `/ack` failed is kept and its
  ack retried; it is never submitted again. A submitted-but-unaccepted message Pi never runs is
  retained (never re-sent) until the daemon drops it, then cleared as expired.
- `POST /focus` and the `tl-*` slash commands from the Claude mod are not ported here; the bridge
  only covers lifecycle, messaging, and MCP registration.
- The extension assumes the daemon supplies the session file via `--session`. It reads the path
  back from `ctx.sessionManager.getSessionFile()` rather than constructing it.
