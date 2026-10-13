# orchestr8 — plan

A small local tool for running AI coding agents (Claude Code first) as "nodes" that an
orchestrator node can spawn, message, read back, and control, with a sidebar UI and
notifications. Scope is deliberately the part of nodeterm that spawns, messages and
controls agents, without the canvas.

Written 2026-10-09 after reading the nodeterm source (v0.4.3) with four targeted analyses:
agent control surface, inter-node messaging, PTY/status layer, and UI/notifications. Where a
nodeterm lesson is quoted below it is tagged with their issue number.

## 1. What we keep, what we drop

Keep (this is what made nodeterm good):

- An orchestrator agent can open child agents with a prompt, cwd and model, and each child is
  a real interactive terminal the human can also type into.
- Parent/child relationship is explicit and visible. Children are readable by the parent
  (transcript, last N lines, terminal screen) on demand, without pushing anything.
- Messages between nodes are delivered into the recipient's CLI only when it is idle, queued
  otherwise, and the sender gets a typed outcome that says whether retrying can help.
- Reliable per-node status (working / needs you / idle / errored / dropped) driven by the
  CLI's own hook events, not screen scraping.
- The orchestrator is told when a child stops in a way that needs action (died, errored,
  question unanswered), once per episode.
- Notifications that fire when you are not looking, click to jump, clear on view.
- Optional dependency launches ("start B after A finishes") so the orchestrator never polls.

Drop: pan/zoom canvas, groups/arrange/align, glyphgrid renderer, SSH projects, server
edition, phone relay and push, notch HUD, 8-agent support matrix, GitHub issues/PR waits,
worktree frames, browser-driving verbs, sticky notes, media nodes, multi-account, speech.

## 2. Architecture

One long-lived Node process (the daemon) owns everything native: PTYs, hooks, MCP, messaging
and OS notifications. It listens on TCP 127.0.0.1 (port 7788 by default) and keeps its files
in `~/.orchestr8/` (or `O8_HOME`): `state.json` (node registry), `inbox.json` (queued mod
messages), `secret`, `admin-token`, `port`, `prompts/`, and per node `nodes/<id>/` with a
0600 `token`, `settings.json` (hooks and tool allowlist) and a 0600 `mcp.json`.

Daemon responsibilities:

- Node registry with an explicit `parentId`. nodeterm has no parent pointer, only edges;
  we want a tree because the sidebar and station notices both need "who opened whom".
- PTY per node via node-pty, running the agent binary directly rather than typing a launch
  line into a shell. That removes nodeterm's launch-line subsystem (echo verification, the
  1024-byte tty limit #706, stranded `quote>` shells, prompt-to-file workarounds #520), and
  process exit is the "dropped" signal for free (#616).
- A headless terminal buffer per node (`@xterm/headless`): snapshots for reconnecting
  clients, the `read terminal` tool, and classifying the screen as prompt / dialog / unknown.
- Hook receiver: `src/daemon/hook.sh` POSTs each payload to `/hook`; a reducer sets status.
- Control API: an MCP server over streamable HTTP for agents and the `o8` CLI for humans,
  both on the same handlers, plus a WebSocket for the clients.

The daemon living outside every front end means closing a window does not kill the agents,
which is most of what nodeterm's tmux layer bought for a local tool. The native shell is
Tauri, not Electron, because node-pty would otherwise have to be rebuilt against Electron's
ABI (nodeterm's postinstall patches node-pty and runs electron-rebuild); the Tauri shell hosts
only web content and has no native modules.

Why MCP instead of a shell shim: nodeterm's shim is a 540-line POSIX script plus a 65 KB
SKILL.md, with a flag parser that had its own bugs (`--read --node b1` becoming
`arg.read=--node`), form-encoding through curl, and prose replies because sh cannot parse
JSON. Claude Code calls MCP tools natively with typed arguments and gets structured results.
Codex also supports MCP servers. The skill-drift problem (#269, agent-facing text diverging
from behaviour) goes away because the tool schema is the documentation. We still ship the
CLI for humans. Cost: a handful of tool descriptions in each child's context, which is small.

## 3. Launching a Claude node

```
claude --session-id <uuid we mint> \
       --name <title> \
       [--model <model>] [--permission-mode <mode>] \
       --plugin-dir <repo>/mod \
       --settings ~/.orchestr8/nodes/<id>/settings.json \
       --mcp-config ~/.orchestr8/nodes/<id>/mcp.json --strict-mcp-config \
       --append-system-prompt "<identity + rules + role prompt, generated>" \
       -- "<prompt>"
```

- Env: `O8_NODE_ID`, `O8_PARENT_ID` (children only), `O8_ENDPOINT`, `O8_TOKEN_FILE`, the
  `TERM`/`COLORTERM` pair, a UTF-8 `LANG` if unset (#78), and `PATH` from the login shell.
  No secrets in env; the token lives in a 0600 file.
- SessionStart's `session_id` and `transcript_path` override the minted id, because `/clear`,
  compaction and forks mint new ones. Never guess "newest jsonl in the cwd dir"; two nodes
  can share a cwd.
- `--settings` carries the hook registrations and `permissions.allow: ["mcp__orchestr8"]`
  so tool calls to us do not prompt. This keeps the user's global settings untouched, which
  is where nodeterm's consent model (#744) and the "stale hook bricks every session"
  incident came from.
- `--append-system-prompt` says: your node id and title, your parent's id (if any), that
  messages arrive framed and only the outermost frame is authentic, when to call
  `report_outcome`, and that spawning never steals the user's focus. The editable role prompt
  (orchestrator or worker) is appended. This replaces nodeterm's installed skills.
- Folder trust is per exact cwd in `~/.claude.json` and the dialog's default answer is "No,
  exit". The daemon reads that file (never writes it); if the cwd or an ancestor is trusted it
  answers the dialog itself, otherwise the node shows needs-you and the human answers.
- Resume uses `--resume <sid>`, never `--session-id`. A terminal node is `$SHELL -l`, status "none".

## 4. Hooks and status

The hook script drains stdin when unconfigured (#187: not draining EPIPEs Claude on large
PreToolUse payloads), sends curl's output to /dev/null (#186: hook stdout is injected into
Claude's context), and always exits 0. Registered events: SessionStart, UserPromptSubmit,
PreToolUse, PostToolUse, Notification, PermissionRequest, Stop, StopFailure, SessionEnd.

Status reducer, per node: `state ∈ {working, waiting, blocked, done, unknown}` plus flags
`errored`, `interrupted`, `stale`, `exited`, and `sessionId`, `lastAssistantMessage`.

| Event | Result |
|---|---|
| UserPromptSubmit | working, new turn |
| PreToolUse / PostToolUse | working (PreToolUse AskUserQuestion → waiting) |
| Notification permission_prompt, PermissionRequest | blocked |
| Notification elicitation_dialog / agent_needs_input | waiting |
| Notification idle_prompt | working → done only; never sets waiting (nodeterm: mapping it to waiting left finished nodes on NEEDS YOU forever) |
| Stop | done (`is_interrupt` → interrupted; keep `last_assistant_message`) |
| StopFailure | done + errored (#521: without it an API error sticks on working) |
| SessionStart / SessionEnd | unknown, update sessionId |
| mod `turn.complete` | done (`isAborted` → interrupted); authoritative even when no Stop follows |
| PTY exit | exited |

Rules that make it hold:

- 3 s done holdoff. Claude runs hooks in parallel, so a late PostToolUse can arrive after
  Stop; ignore non-new-turn `working` for 3 s after `done`.
- Stale sweep: working with no event for 20 min → done with a "stale" flag.
- Settings hooks see no interrupt. On a lone Esc or Ctrl-C typed into a working node, wait
  1.5 s and flip to done+interrupted if nothing arrived; the mod's `isAborted` covers it too.
- Only verified events (good token for that node id) move state. Unknown is not idle.
- Notification types are a closed allowlist. nodeterm's Grok integration matched
  `includes('permission')` and a working node strobed NEEDS YOU on every tool call; "a badge
  stuck on a finished node has no later hook to clear it, so widening to be safe is the
  unsafe direction."
- Status is not persisted. After a daemon restart every node is shown exited, with its
  session id kept so it can be resumed.

## 5. Control API (MCP tools, mirrored by the `o8` CLI)

Identity: every request carries the node's bearer token. Token = `HMAC(daemonSecret, nodeId)`,
so there is no token table to lose and a node can only present its own file. Auth runs before
the handler; a refusal means nothing happened. The CLI outside a node uses the admin token
and acts as `human`.

| Tool | Args | Returns |
|---|---|---|
| `list_nodes` | — | tree: id, parentId, title, kind, cwd, state, flags, age, contextPct |
| `spawn` | kind (claude\|terminal), title, cwd, prompt?, model?, permissionMode?, role?, requestId? | `{nodeId}` |
| `send` | nodeId, text | outcome (below) |
| `message_status` | messageId | the send outcome, final or still `queued` |
| `read` | nodeId, what (summary\|transcript\|terminal), lines? | text |
| `write` | nodeId, text | raw keystrokes; UI confirm dialog |
| `close` | nodeIds[], force? | UI confirm, one dialog for the batch; any unknown id refuses the whole batch; agents cannot close a root |
| `rename` | nodeId, title | — |
| `report_outcome` | outcome (succeeded\|failed), note? | — (about yourself only) |
| `resume`, `restart`, `prune`, `select`, `shutdown` | | human only |

- Scope is the caller's lineage: itself, its ancestors, its siblings and its descendants
  (`send` excludes itself). `close` reaches only descendants, `rename` itself and its descendants. That is the entire
  authorization model; nodeterm's five layers exist for multi-project canvases we do not have.
- `spawn` with `requestId`: a repeat with the same id returns the first reply, marked
  `replayed`. Tool-call timeouts are real and a lost reply otherwise opens a node twice.
- Spawning never changes what the user is looking at (#665, #702).
- Rate limit: one `send` per sender→target pair per 10 s, enough to stop an LLM retry loop.
- Every process of the same OS user can read the token files, so scope, confirms and the
  human-only `bypassPermissions` guard against agent mistakes, not a hostile local process.

## 6. Message delivery

Delivery is mod-first. The daemon keeps a per-node inbox (persisted in `inbox.json`); the
node's mod polls it every second, submits each message with `$.prompt.submit`, and acks when
the turn starts. Claude Code does the idle gating, so no screen check is needed on this path.
A node counts as mod-live while its last poll is under 5 s old.

For a node whose mod is not live, the daemon pastes into the PTY, and queues instead unless
the target is verified idle (last verified event was Stop, not an `idle_prompt` inference,
not stale) and the screen shows an empty composer rather than a dialog: hooks miss `/model`,
the trust prompt and setup dialogs, and text typed into one is swallowed while its Enter
answers the dialog. It subscribes for the receipt before writing (nodeterm shipped a double
delivery by probing after the write), writes one bracketed paste with ESC bytes stripped from
the body, then `\r` separately, and waits up to 8 s for a UserPromptSubmit carrying the nonce:
`delivered`, otherwise `stalled`.

Envelope, as B sees it:

```
--- O8 MESSAGE <nonce> ---
from: Builder (n-3f2a)
reply-to: n-3f2a
<body>
--- END O8 MESSAGE <nonce> ---
```

The nonce is per delivery and the agent is told only the outermost frame is authentic and
that framed messages are legitimate instructions (without that, Claude treated a pasted
message as untrusted and asked before obeying). Station notices use
`from: orchestr8 (child n-7b1c stopped: turn-errored)` and `reply-to: none`. A human's typing
into a node is never framed.

Queues: per target, cap 16 (`queueFull` refuses rather than dropping), TTL 5 min. The paste
queue is in memory and retried when the target goes idle. Outcomes are exactly `delivered`,
`queued`, `stalled`, `expired`, `queueFull`, `gone`, `refused`, and each reply says
`retryable: true|false`. nodeterm has 18 outcome kinds; seven is enough.

## 7. Station notices (child → parent)

The daemon tells the parent when a child it opened stops in a way that needs a decision:

- `exited`: the process is gone.
- `turn-errored`: StopFailure.
- `question-unanswered`: waiting for more than 15 min with nobody answering.

Delivered through the normal send path, once per episode: re-arm only after a clean turn, or
a rate-limited child re-notifies all night. A permission prompt is never a notice, because an
approval fires nothing until the tool finishes, so "blocked for 20 min" looks the same as
"approved, long build"; the UI shows NEEDS YOU instead.

## 8. Dependency launches (phase 4, not built)

`spawn(..., after: [ids])` creates the node armed and launches it when every listed node
has finished a turn that started after it was last handed work. nodeterm's sharpest lesson:
idle means the turn ended, not the job. So also `after_success`, released only by
`report_outcome succeeded`, and blocked by `failed` with the note shown on the waiting node.
Deadline 24 h, after which the node shows EXPIRED and waits for a manual Run.

## 9. Front ends

The primary front end is the web UI (`ui/`) in a Tauri shell (`src-tauri/`); `o8` opens it on
the current directory's session. A "session" is a root node and its subtree, shown one at a
time with a switcher. The same UI runs in a browser, and `o8-mux` is a terminal multiplexer
with the same sidebar tree for SSH and other terminals. The mod adds a band above the prompt
and `/o8-*` slash commands inside each node, and draws nothing while any of those clients is
attached. Everything must keep working with mods off, because Anthropic can disable mods
remotely and `--bare` / `--safe-mode` drop them; the paste fallback covers delivery then.

The daemon is the only sender of OS notifications (via `terminal-notifier` when installed, so
a click selects the node): on needs-you, done, errored and exited, throttled per node, and
suppressed while a focused client is showing that node. Unread clears on select and is independent of
agent state.

## 10. Phases

Phase 0 (spike), phase 1 (daemon core), phase 2 (UI) and phase 3 (agent control: MCP, system
prompt, read, send with gate, queue and receipt, station notices, write/close confirms) are
built and verified. Phase 4 (`after` / `after_success`) and phase 5 (kanban, chat-style
transcript view, Codex support) are not started. For Codex, MCP works; status needs
`~/.codex/hooks.json` plus a trust hash in config.toml, which nodeterm ports and calls
brittle, so start with Codex's `notify` setting for turn-complete only.

Still unverified: behaviour when the user has other mods installed (they load in every node
too), and hot reload of the mod. The mod's in-flight message ids and last-seen tree live in
module scope in `mod/hooks/register.tsx`, not in `$.state`, so a reload while a message is
submitted but not yet acked could submit it twice.

## 11. History

The Phase 0 spike (1db9c47, findings recorded in 384ccfb) confirmed that hooks passed via
`--settings` fire, MCP over HTTP with `permissions.allow` connects without prompts, a
bracketed paste plus `\r` submits a multi-line message, and `/clear` is reported as SessionEnd
then SessionStart with a new session id. It also showed `idle_prompt` arrives about 60 s after
Stop. The mod spike (a083e01, decision in a341102) made delivery mod-first (664dc72). A
per-session mod pane was tried and then removed (9dae5e9) in favour of the `o8` multiplexer,
and the front-end direction moved to the Tauri-wrapped web UI (4bcd75f, e5cb379, 87ef40e). OS
notifications moved into the daemon (774ed15), and the mod goes quiet while a client is
attached (585e300).
