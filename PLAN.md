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

One long-lived Node process (the daemon) and a browser UI. No Electron.

```
~/.orchestr8/
  state.json          node registry (ids, parent, title, cwd, sessionId, lastSeen)
  sock/control.sock   unix socket: hook receiver + MCP + HTTP control API
  hooks/claude.sh     the one shared hook script
  nodes/<id>/token    per-node 0600 bearer token
  nodes/<id>/mcp.json per-node --mcp-config (points at the socket, carries the token)
  nodes/<id>/settings.json  per-node --settings (hooks + tool allowlist)
```

Daemon responsibilities:

- Node registry with an explicit `parentId`. nodeterm has no parent pointer, only edges;
  we want a tree because the sidebar and station notices both need "who opened whom".
- PTY per node via node-pty. We exec the agent binary directly as the PTY program
  (`claude …`), not a shell that we type a launch line into. This removes nodeterm's whole
  launch-line subsystem: echo verification, the 1024-byte tty line limit (#706), stranded
  `quote>` shells, and prompt-to-file workarounds (#520). The prompt is argv, and ARG_MAX on
  macOS is about 1 MB. Process exit is also our "dropped" signal for free, so no liveness
  polling (#616).
- A headless terminal buffer per node (`@xterm/headless`) fed from the PTY. It serves
  scrollback to a reconnecting UI, backs the `read terminal` tool, and lets us classify the
  bottom of the screen as prompt / dialog / unknown before typing into a pane.
- Hook receiver: Claude Code POSTs lifecycle events through the hook script; a reducer turns
  them into node status.
- Control API: the same operations exposed two ways, an MCP server over streamable HTTP for
  agents, and a tiny CLI (`o8`) for humans and scripts. Both hit the same handlers.
- WebSocket to the UI: node tree, status, terminal data, notifications.
- Persistence: `state.json` only. Durable queues and ledgers are deferred (see §8).

Why no Electron: node-pty must be rebuilt against Electron's ABI (nodeterm's postinstall
patches node-pty and runs electron-rebuild) and packaging is a project of its own. A browser
tab on localhost gets native macOS notifications through the Web Notifications API and can
focus itself on click. The daemon living outside the UI also means closing the tab does not
kill the agents, which is most of what nodeterm's tmux layer bought for a local tool. If a
dock badge or tray ever matters, wrap the same UI in Electron or Tauri later.

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
       --model <model> \
       --permission-mode <mode> \
       --settings ~/.orchestr8/nodes/<id>/settings.json \
       --mcp-config ~/.orchestr8/nodes/<id>/mcp.json --strict-mcp-config \
       --append-system-prompt "<identity + rules, generated>" \
       "<prompt>"
```

- Env injected: `O8_NODE_ID`, `O8_TOKEN_FILE`, `TERM=xterm-256color`, `COLORTERM=truecolor`,
  a UTF-8 `LANG` if unset (#78, and Claude falls back to ASCII box drawing without it), and
  `PATH` probed once from the login shell. No secrets in env or argv; the token lives in a
  0600 file. nodeterm learned this after a world-readable app bearer in `/proc/<pid>/cmdline`.
- `--session-id` lets us know the transcript path up front:
  `~/.claude/projects/<cwd with / and . replaced by ->/<sessionId>.jsonl`. The SessionStart
  hook carries `session_id` and `transcript_path` and overrides this, because `/clear`,
  compaction and forks mint new ids. Never use "newest jsonl in the cwd dir" as a fallback; it
  is wrong when two nodes share a cwd.
- `--settings` carries the hook registrations and `permissions.allow: ["mcp__orchestr8__*"]`
  so tool calls to us do not prompt. This keeps the user's global settings untouched, which
  is where nodeterm's consent model (#744) and the "stale hook bricks every session"
  incident came from. To verify in the spike: hooks passed via `--settings` fire. Fallback
  if not: one guarded global entry
  `if [ -r ~/.orchestr8/hooks/claude.sh ]; then sh …; else cat >/dev/null; fi`, exactly as
  nodeterm does, installed once with a confirm.
- `--append-system-prompt` is generated from the same source as the tool schema. It says:
  your node id and title, your parent's id (if any), that messages arrive framed and only the
  outermost frame is authentic, when to call `report_outcome`, and that spawning never steals
  the user's focus. This replaces the installed skills.
- Resume (daemon restart, or user action): `claude --resume <sid>` plus the same settings and
  mcp-config, never `--session-id`. Check `<sid>.jsonl` exists first; nodeterm found 20 of 108
  panes stranded on "No conversation found".
- Plain terminal node: `$SHELL -l` with the same env, no hooks, status "none".

## 4. Hooks and status

Hook script (`hooks/claude.sh`, about 15 lines):

1. Exit 0 immediately if `O8_NODE_ID` is unset, after draining stdin (#187: not draining
   EPIPEs Claude on large PreToolUse payloads).
2. Read the token from `O8_TOKEN_FILE`.
3. `curl --unix-socket … -H "Authorization: Bearer …" -H "X-O8-Node: $O8_NODE_ID"
   -H "X-O8-Event: $EVENT" --data-binary @- http://o8/hook` in the background, all stdout
   and stderr to /dev/null (#186: hook stdout is injected into Claude's context).
4. Always exit 0.

Events registered: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification,
PermissionRequest, Stop, StopFailure, SessionEnd. SubagentStart/Stop later.

Status reducer, per node: `state ∈ {working, waiting, blocked, done, unknown}` plus flags
`errored`, `interrupted`, `exited`, and `sessionId`, `lastEventAt`, `lastAssistantMessage`.

| Event | Result |
|---|---|
| UserPromptSubmit | working, new turn |
| PreToolUse / PostToolUse | working (PreToolUse AskUserQuestion → waiting) |
| Notification permission_prompt, PermissionRequest | blocked |
| Notification elicitation_dialog / agent_needs_input | waiting |
| Notification idle_prompt | leaves working only; never sets waiting (nodeterm: mapping it to waiting left finished nodes on NEEDS YOU forever) |
| Stop | done (`is_interrupt` → interrupted; keep `last_assistant_message`) |
| StopFailure | done + errored (#521: without it an API error sticks on working) |
| SessionStart / SessionEnd | unknown, update sessionId |
| PTY exit | exited |

Rules that make it hold:

- 3 s done holdoff. Claude runs hooks in parallel, so a late PostToolUse can arrive after
  Stop; ignore non-new-turn `working` for 3 s after `done`.
- Stale sweep: working with no event for 20 min → done with a "stale" flag.
- Interrupts fire no hook at all (measured by nodeterm on 2.1.285). On a lone Esc or Ctrl-C
  typed into a working node, wait 1.5 s and flip to done+interrupted if nothing arrived.
  Add the transcript `[Request interrupted by user]` marker check in a later pass.
- Only verified events (good token for that node id) move state. Unknown is not idle.
- Notification types are a closed allowlist. nodeterm's Grok integration matched
  `includes('permission')` and a working node strobed NEEDS YOU on every tool call; "a badge
  stuck on a finished node has no later hook to clear it, so widening to be safe is the
  unsafe direction."
- Status is not persisted across daemon restarts. Restore only `lastSeen`; show unknown.

## 5. Control API (MCP tools, mirrored by the `o8` CLI)

Identity: every request carries the node's bearer token. Token = `HMAC(daemonSecret, nodeId)`,
so there is no token table to lose and a node can only present its own file. Auth runs before
the handler; a refusal means nothing happened.

| Tool | Args | Returns |
|---|---|---|
| `list_nodes` | — | tree: id, parentId, title, kind, cwd, state, flags, age, contextPct |
| `spawn` | kind (claude\|terminal), title, cwd, prompt, model?, permissionMode?, after?: [ids], requestId | `{nodeId, queued}` |
| `send` | nodeId, text | outcome (below) |
| `read` | nodeId, what (summary\|transcript\|terminal), lines? | text |
| `write` | nodeId, text | raw keystrokes; UI confirm dialog |
| `close` | nodeIds[] | UI confirm, one dialog for the batch; any unknown id refuses the whole batch |
| `rename` | nodeId, title | — |
| `report_outcome` | outcome (succeeded\|failed), note? | — (about yourself only) |

- A child may read any node in its lineage (parent, siblings, own children). The parent may
  read all descendants. `send` follows the same scope. That is the entire authorization
  model; nodeterm's five layers exist for multi-project canvases we do not have.
- `spawn` with `requestId`: a repeat with the same id returns the first reply, prefixed
  `replayed`. Tool-call timeouts are real and a lost reply otherwise opens a node twice.
- Spawning never changes what the user is looking at (#665, #702). The new node appears in
  the sidebar with an unread marker.
- Rate limit: one `send` per sender→target pair per 10 s. Enough to stop an LLM retry loop.

## 6. Message delivery

When A sends to B (a Claude node):

1. Cheap checks first, in order of permanence: not in scope → `refused`; B exited → `gone`;
   B not verified idle → queue. "Verified idle" means the last verified event was Stop, not an
   `idle_prompt`-only inference (a node blocked on approval looks idle at the prompt), and
   not stale or restored.
2. Screen check from the headless buffer: bottom lines show Claude Code's composer prompt
   line, not a dialog footer ("Enter to confirm", "Esc to cancel", folder-trust prompt).
   Hooks miss `/model`, the trust prompt and setup dialogs; text typed into one of those is
   swallowed and its Enter answers the dialog (the trust prompt's default is "No, exit").
   Dialog → queue.
3. Subscribe for the receipt before writing (nodeterm shipped a double delivery because a
   fast target answered during the post-write probe and the sender saw `stalled`).
4. Write one bracketed paste `ESC[200~ <envelope> ESC[201~` then `\r` as a separate write.
   Strip every ESC byte from the body so it cannot close the paste frame. Serialize all
   writes to a PTY, including the UI's own keystrokes, through one per-node lock.
5. Wait up to 8 s for a verified UserPromptSubmit from B → `delivered`; otherwise `stalled`.

Envelope, as B sees it:

```
--- O8 MESSAGE <nonce> ---
from: Builder (n-3f2a)
reply-to: n-3f2a
<body>
--- END O8 MESSAGE <nonce> ---
```

The nonce is per delivery and the agent is told only the outermost frame is authentic.
Station notices use `from: orchestr8 (child n-7b1c stopped: turn-errored)` and
`reply-to: none`. A human's typing into a node is never framed.

Queue: in-memory, per target, cap 16 (`queueFull` refuses rather than dropping), TTL 5 min,
flushed on B's next Stop by re-running every check. Expiry tells the sender. Outcomes are
exactly: `delivered`, `queued`, `stalled`, `expired`, `queueFull`, `gone`, `refused`, and each
reply says `retryable: true|false`. nodeterm has 18 outcome kinds; six is enough.

Known residual risk nodeterm documents as unfixable from hooks: a human's half-typed draft
in an idle composer gets the message appended and submitted with it. Mitigation: the
screen check refuses when the composer line is non-empty.

## 7. Station notices (child → parent)

The daemon tells the parent when a child it opened stops in a way that needs a decision:

- `exited`: the process is gone.
- `turn-errored`: StopFailure.
- `question-unanswered`: waiting for more than 15 min with nobody answering.

Delivered as a framed message to the parent through the normal send path, so it lands when
the parent is idle. Once per episode: re-arm only after the child completes a successful
turn, or a rate-limited child re-notifies all night. A permission prompt is never a notice:
an approval given in the child's own pane fires nothing until the tool finishes, so "blocked
for 20 min" is indistinguishable from "approved, long build". The UI shows NEEDS YOU for
that instead.

## 8. Dependency launches (phase 4)

`spawn(..., after: [ids])` creates the node armed and launches it when every listed node
has finished a turn that started after it was last handed work. nodeterm's sharpest lesson:
idle means the turn ended, not the job. So also `after_success`, released only by
`report_outcome succeeded`, and blocked by `failed` with the note shown on the waiting node.
Deadline 24 h, after which the node shows EXPIRED and waits for a manual Run.

Defer persistence of reports, holds and the queue. v1 states plainly that a daemon restart
drops queued messages and armed waits. If persisted later: bind entries to the session id
they were addressed to, expire by wall clock, and remove from disk before the write attempt.

## 9. UI

Left sidebar:

- Tree grouped by parent. Row: status dot (working pulsing, needs-you red, done, errored,
  exited, unknown grey), title, agent glyph, age in state ("3m"), unread dot, context %.
- Sort within a group by last transition; a click clears the glow but never moves the row.
- Collapsed parents show counts (2 needs you · 1 unread).
- ⌘K palette to jump by title. ⌘1..9 for the first nine nodes.

Main pane: the selected node's terminal (one `@xterm/xterm` instance per node, kept mounted
and hidden by visibility, never `display:none`, refit on show) with a header: title, model,
state badge, cwd, git branch, context pill, Resume / Close buttons. The context pill shows
nothing unless a trustworthy denominator exists (read from the transcript's usage records).

Notifications:

- Fire on `done`, `blocked`, `waiting`, `errored`, `exited`. Not on message received or
  child spawned (those are unread markers only).
- OS notification only when the document is hidden or unfocused; click focuses the tab and
  selects the node. Two chimes (done, needs-you), 5 s per-node throttle.
- Unread clears on select. Read state is independent of agent state.

Kanban (phase 5): three columns, cards are nodes, drag or `assign` tool moves them. `done`
never moves a card; a turn ending is not the work ending. Chat-style transcript view
(phase 5, Claude only) as a per-node toggle; the terminal stays the default.

## 10. Phases

Phase 0, spike (1–2 days). The design rests on four assumptions; verify each with a throwaway
script before building:

1. Hooks passed via `--settings <file>` fire for an interactive session.
2. `--mcp-config` with a streamable-HTTP server over a unix socket (or 127.0.0.1 with a
   per-node header) connects, and `permissions.allow` suppresses tool prompts.
3. A bracketed paste plus `\r` written to a node-pty running Claude submits a multi-line
   message cleanly, and UserPromptSubmit fires.
4. `--session-id` yields the expected transcript path and `/clear` is reported by SessionStart.

Phase 1, daemon core: registry + state.json, PTY spawn/exit, headless buffer, hook receiver +
reducer, WebSocket protocol, `o8` CLI (`spawn`, `list`, `close`). Test: reducer table and
holdoff with recorded hook payloads.

Phase 2, UI: sidebar tree, terminal pane, header, notifications, palette.

Phase 3, agent control: MCP server, system-prompt generation, `read`, `send` with gate +
queue + receipt, station notices, `write`/`close` confirms. Test: delivery gate decisions
against a fixture of status snapshots; envelope escaping.

Phase 4: `after` / `after_success` / `report_outcome`, resume on daemon restart.

Phase 5: kanban, chat view, Codex (MCP works; status needs `~/.codex/hooks.json` plus a
trust hash in config.toml, which nodeterm ports Codex's hash for and calls brittle. Start
with Codex's `notify` setting for turn-complete only).

## 11. Dependencies

Daemon: `node-pty`, `ws`, `@xterm/headless`, `@modelcontextprotocol/sdk` (+ `zod`).
UI: `react`, `@xterm/xterm`, `@xterm/addon-fit`, `vite`. Dev: `typescript`, `tsx`, `vitest`.
Node 24 (installed). No tmux (not installed, not needed).

## 12. nodeterm leftovers on this machine

Still present after the uninstall: nodeterm hook entries in `~/.claude/settings.json`
(guarded, so harmless, but 11 references), `~/.nodeterm/`, `~/Library/Application
Support/node-terminal/`, and the two skills in `~/.claude/skills/` that Claude sessions still
see. Worth removing before this tool installs its own.

## 13. Phase 0 results (2026-10-09)

All four assumptions passed (`spike/claude-spike.ts`, Claude Code 2.1.295). Findings that
change the build:

- Folder trust is per exact cwd in `~/.claude.json` (`projects[cwd].hasTrustDialogAccepted`)
  and the dialog's default answer is "No, exit". Policy: on spawn the daemon reads that file
  (never writes it); if the cwd or any ancestor is trusted it answers the dialog itself (wait
  for the "Enter to confirm" footer, send Down then Enter); otherwise the node shows
  needs-you and the human answers in the terminal.
- A pasted message arrives in the `prompt` field wrapped in a pasted-content tag, and Claude
  treated it as untrusted text and asked for confirmation before obeying. The generated
  system prompt must state that framed O8 messages are legitimate instructions from other
  nodes or the daemon. Match deliveries by nonce substring, never by whole-string equality.
- `idle_prompt` arrives about 60 s after Stop, confirming it must never mean "waiting".
- `/clear` fires SessionEnd (reason clear) then SessionStart (source clear) with a new
  session id and transcript path.
- Normal Stop carries no `is_interrupt`; interrupt detection stays on the key-press timer.
- Read the screen from the viewport bottom rows, not up to the cursor. Idle composer is an
  empty prompt line under a rule that ends with the node's name; while working, a spinner
  line and the composer are both visible, so the screen never proves idle on its own.
- Hook payload fields seen: all events carry `session_id`, `transcript_path`, `cwd`;
  SessionStart adds `source`, `model`; UserPromptSubmit `prompt`, `prompt_id`; tool events
  `tool_name`, `tool_input`, `tool_use_id`; Stop `last_assistant_message`; Notification
  `notification_type`, `message`; SessionEnd `reason`. Raw samples: `.orchestr8-dev/events.json`.
