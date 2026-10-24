# A long-lived PTY holder

Status: design and feasibility spike, 2026-10-19. Nothing here is implemented in `src/`. This is stage B of item 1 in [future-plan.md](../future-plan.md); stage A (drain and re-prompt) is being built separately and remains the fallback.

## Summary

Today the daemon owns every PTY (pseudo-terminal) and every agent process, so `tl reload`, `tl update`, a crash or launchd stopping the job kills every agent, and the next daemon resumes their conversations with `claude --resume` or the adapters' equivalents. Resuming loses whatever was in flight: the current turn, running tool calls, Claude's background shells and subagents.

The proposal is a small Node process, the holder, that owns the PTY masters and the agent processes and keeps a byte ring of recent output per PTY. The daemon becomes its only client over a Unix socket under `TL_HOME`. The daemon keeps everything else, including the headless xterm screen per node, so `PtySession`'s interface barely changes. When the daemon restarts, the new one connects to the holder, replays each ring into a fresh headless terminal, nudges the size so full-screen programs repaint, and adopts the running processes.

The spike in [spike/pty-holder/](../../spike/pty-holder/) shows this works with real Claude Code: a client was killed with SIGKILL, a new client reattached in about 8 ms (about 40 ms for a full 1 MiB ring), the child's pid never changed, and typed input reached Claude's composer afterwards. A holder started in its own session survived launchd booting out the job that started it; one left in the job's process group did not.

The recommendation is to build it, in the phases below, in about two weeks of work. The parts that need the most care are not the holder itself (120 lines in the spike, plus 44 for framing) but the daemon gap, during which agents' hooks and inbox calls fail, and reconstructing each adopted node's status.

## Boundary

### What uses `PtySession` today

Everything goes through `NodeManager` (`src/daemon/manager.ts`) and the `rt.session` field of each node's runtime. The uses are:

- **Spawn.** `launch()` calls `PtySession.spawn` with the adapter's file, args, env, cwd and the default size (`manager.ts`, in `launch`).
- **Output.** `onData` feeds the headless terminal inside `PtySession`, then `launch()` re-emits it as the manager's `data` event, which `server.ts` sends to attached UI clients. For native harnesses (Pi, Codex) `launch()` also keeps the last 8 KiB of output to find an adapter refusal or an `Error:` line when the process exits.
- **Exit.** `onExit` (code only) drives `ptyExited`, the native error message, the exited notification and a git refresh. `closeWorktreeNode` waits on `onExit`; `exited` is read in several places.
- **Input.** `manager.input` calls `write` (string or latin1 Buffer), with interrupt-key detection before it. Message delivery (`messaging.ts`, `attempt`) calls `paste`, which writes a bracketed paste, waits 150 ms and writes a carriage return, serialized with other writes by a lock.
- **Size.** `manager.resize` and `manager.attach` call `resize`, which resizes both the PTY and the headless terminal.
- **Screen.** `attach` calls `flush` then `snapshot` (the visible screen serialized with attributes, plus the SGR mouse encoding the serialize addon omits). The MCP `read` tool calls `screenTail`. Delivery calls `classifyScreen` and `composerText` after `flush`. `watchTrust` polls `screenTail(30)` and answers Claude's folder-trust dialog with `write('\r')` and `write('\x1b[B')`.
- **Stop.** `kill()` (SIGHUP through node-pty) in `NodeManager.kill` and `shutdown`; `terminate()` (kill, then wait up to 7 s for the exit) when changing harness.
- **Identity.** `pid` is exposed; nothing in the daemon persists it today.

### What moves and what stays

The holder owns only what must outlive the daemon:

- the PTY master file descriptors and the child processes (it is their parent, so it receives their exit status);
- a ring of the most recent output bytes per PTY (1 MiB by default);
- each PTY's current size, its exit code and signal once it exits, and opaque metadata the daemon gives it at spawn (node id and launch id).

The daemon keeps everything else: the headless xterm and serialize addon per node, the mouse-encoding tracking, the paste lock and its 150 ms delay, the trust watch, the native error tail (now fed from the replayed ring too), hooks, MCP, the inbox, the registry, worktrees and the UI server. Keeping the terminal emulation in the daemon keeps the holder small and stable: xterm upgrades, screen classification and serialization fixes ship with ordinary daemon releases.

`PtySession` becomes a facade with the same public methods, backed by a holder connection instead of node-pty. `spawn` becomes asynchronous (it waits for the holder's `spawned` reply), which is the one interface change `launch()` has to absorb.

### Holder API

All messages are on one socket. Control frames carry JSON; data frames carry raw bytes for one PTY. Production messages should carry a request id (`req`) so replies can be matched; the spike relies on ordering instead.

Daemon to holder:

- `hello {version, build}`: must be first. The holder answers `hello {version, build, pid, ptys}` where `ptys` lists every PTY with its id, metadata, pid, size, ring size, start time and exit status if it has exited. A holder that does not speak `version` answers `error` and closes.
- `spawn {id, meta, file, args, cwd, env, cols, rows}`: answers `spawned {id, pid}` or `error`.
- `attach {id}`: sends the whole ring as one data frame, then `replayed {id, bytes, truncated, cols, rows, exit?}`, then live output. The replay and the subscription happen in one turn of the holder's event loop, so no output is lost between them or sent twice.
- `detach {id}`, `resize {id, cols, rows}`, `kill {id, signal}`.
- `release {id}`: forget an exited PTY whose exit the daemon has recorded. The holder keeps exited PTYs until released, so a daemon that was down when a child exited still learns its exit status and the output tail.
- `shutdown`: kill every PTY and exit. Used by `tl stop` and by the holder-upgrade fallback.
- Data frames to the holder are input for that PTY.

Holder to daemon, unprompted: data frames for attached PTYs and `exit {id, code, signal}`.

## Transport

- **Socket.** `TL_HOME/holder.sock`, created with umask 0177 so it is 0600 from the start (the spike also chmods it), inside the 0700 home. macOS limits a socket path to 104 bytes; `~/.tiller/holder.sock` is well under, but a long custom `TL_HOME` can exceed it. In that case use `$TMPDIR/tiller-<hash of TL_HOME>.sock` in a 0700 directory, and record the chosen path in `TL_HOME/holder.json` with the holder's pid and build.
- **Authentication.** File permissions are the access control, as for the daemon's other files in `TL_HOME`. The holder could additionally check the peer's uid with `getpeereid`, but Node does not expose it, and the 0600 socket already restricts connections to the same user.
- **Framing.** A u32 big-endian length, a u8 kind and a body (`spike/pty-holder/frame.ts`). Data bodies are a u16 id length, the id and the bytes. node-pty runs with `encoding: null`, so the holder stores and forwards exact bytes and the daemon decodes UTF-8 in its xterm. This also makes ring truncation safe at the byte level.
- **Backpressure.** The holder never stops reading a PTY because of the daemon; a stalled agent is worse than a lost screen update. Output always goes into the ring. If the socket's unsent queue passes 8 MiB, the holder drops the connection, and the daemon reconnects and replays, which loses nothing that matters because the ring holds the current screen. Input from the daemon is small, and node-pty queues writes itself.
- **One client.** A new `hello` replaces the previous connection, which the holder closes. A daemon whose connection is replaced must treat that as fatal and exit, so two daemons never drive the same PTYs. During a reload the old daemon is already exiting.
- **Reconnection.** The daemon reconnects with a short backoff when the socket closes. If it cannot reconnect within a few seconds, it treats the holder as crashed (below).
- **Versioning.** `version` is the protocol number; `build` is a hash of the holder's source. A daemon accepts any holder whose protocol it speaks, so most daemon releases keep the running holder. When a release needs a new holder, the daemon takes the fallback below.

## Reattach

On reattach the daemon creates a fresh headless terminal at the size the holder reports, sends `attach`, writes the replay into the terminal and waits for xterm's write callback before using the screen.

A ring that has wrapped starts mid-stream: possibly inside an escape sequence, and without whatever drew parts of the screen earlier. The spike measured what that does to Claude. With a 4 KiB ring after a 14 KB turn, the replayed screen kept the text but lost both rules around the composer, so `classify()` returned `unknown`, which would block message delivery. One real size change made Claude repaint its live region (1.4 KB of output), after which `classify()` returned `prompt` again. With the full turn in the ring, the replay matched the screen the first client last saw on all 40 rows.

So the daemon should always nudge after a replay: resize to a different size and back, or to the size the UI last asked for when it differs. Setting the same size does nothing, because the kernel sends SIGWINCH only when the size changes. The spike tested one real size change (120x40 to 100x30), not a one-row change and back; the implementation should test the smaller nudge, and if Claude coalesces the two resizes, wait for output between them.

What the replay cannot restore: scrollback older than the ring, and terminal modes set by sequences that fell out of it, such as the SGR mouse encoding `PtySession` tracks. A full-screen program resends its modes only on some events, so a node whose mouse mode is lost would need the user to interact before mouse reporting works again. This is minor for Claude, which runs in the main screen.

Ring size: 1 MiB per PTY. Measured output sizes are small: Claude's idle start screen was 1.8 KB and a turn that printed 400 lines was 14 KB. A 1 MiB replay of a flood of output took about 40 ms end to end, almost all of it xterm parsing, so twenty nodes with full rings reattach in under a second and the holder uses about 20 MiB.

## Process lifetime

**Starting the holder.** The daemon starts it at boot when no holder answers on the socket, detached with `setsid` (Node's `spawn(..., { detached: true })`), stdio to `TL_HOME/holder.log`, cwd `/` so it pins no directory. It is not a launchd job. Its parent exits eventually and it is reparented to launchd, which is fine.

**launchd.** The plist written by `src/daemon/autostart.ts` does not set `AbandonProcessGroup`, so when launchd stops the job it kills the job's process group. The spike checked this with a temporary job (`client.ts launchd`, label `com.tiller.spike-ptyholder-<pid>-<mode>`, booted out and removed afterwards): a holder in its own session and its PTY child survived `launchctl bootout`; a holder left in the job's process group was killed, and its child died with it because the PTY master closed. Agents are already safe from this today because node-pty puts each child in its own session. So `setsid` is necessary and sufficient; setting `AbandonProcessGroup` is not needed and would also leave other helpers behind. At logout macOS terminates all the user's processes, so the holder and agents end then, and the next daemon resumes as today.

**Daemon exit.** SIGTERM, `tl reload` and `tl update` make the daemon flush the registry and inbox and exit without killing PTYs. The live set stays as it is. The daemon must stop writing to PTYs before it exits, since a delivery paste cut in half would leave text in a composer; stage A's drain already holds deliveries during a planned restart.

**`tl stop`.** The `shutdown` API, which `tl stop` calls, clears the live set as today and sends the holder `shutdown`, which kills every PTY (SIGHUP, then SIGKILL after a timeout) and exits. That keeps `tl stop` meaning "stop the agents".

**A daemon that never comes back.** The holder keeps its PTYs while no daemon is connected, for a grace period (proposed: 15 minutes, set in config). After that it kills them and exits, and the next daemon resumes the live set as today. Without the bound, removing tiller or a daemon that crash-loops would leave agents running with no coordination.

**Changing the holder.** This should be rare, since the holder has no tiller logic. When a daemon finds a holder whose protocol it does not speak, or a release marks the holder as requiring replacement, it falls back to today's path: stage A's drain, then holder `shutdown`, then a new holder, then `resumeLive`. The cost is the same interruption as today, only on those releases.

**Running from a copy.** `tl update` runs `git checkout` and `npm ci`, which deletes and reinstalls `node_modules`, including node-pty's native module and the `spawn-helper` binary node-pty runs on every spawn (`node_modules/node-pty/lib/unixTerminal.js`). A holder running from the checkout would fail to spawn during an install and could then load mismatched files. So the daemon installs the holder into `TL_HOME/holder/<build>/` (the holder script plus a copy of node-pty's `lib/` and native build) and runs it from there; Node 24 runs the TypeScript directly with type stripping, or the holder can be built to one JavaScript file. Old builds are deleted when no holder runs from them.

**A holder crash.** When the holder dies, its PTY masters close and the kernel sends SIGHUP to each child's session, so the agents exit, as the launchd test showed. The daemon sees the socket close, cannot reconnect, marks every attached node exited, starts a new holder and resumes the nodes that were live, which is what a daemon crash does today. A child that ignores SIGHUP could survive as an orphan, so the daemon should persist each PTY's pid and, after a holder crash, send SIGKILL to the process group of any that are still alive (node-pty makes each child a session and group leader, so the group id is its pid).

## The daemon gap

Between the old daemon exiting and the new one listening, every agent call to `TL_ENDPOINT` fails. The gap should be a few seconds at most (daemon start time was not measured here), but every client must survive it without losing or duplicating work. Today these failures happen only at startup or in a crash, so the clients were written for that. What each does now, from reading the code (not reproduced):

- **Claude hooks** (`src/daemon/hook.sh`) run `curl --max-time 5` in the background and always exit 0. A failed hook is dropped. A lost `Stop` hook leaves the node shown as working; a lost `UserPromptSubmit` loses a delivery receipt. **Needs a retry:** retry for up to about 60 s with a one-second backoff in the same background subshell. Order between concurrent hooks is already not guaranteed; if that matters, spool failed hooks to a file in the launch directory that the daemon drains on reattach.
- **Claude mod** (`mod/hooks/register.tsx`) polls `/tree` and `/inbox` every second and logs failures, which is fine. But when `POST /ack` fails after `$.prompt.submit`, the message stays in the inbox, comes back on the next poll marked claimed, and the daemon's `claim` accepts it again for Claude (the "never replay an ambiguous claim" rule applies only to native inboxes), so the message is submitted twice. **Needs a fix:** keep submitted-but-unacked ids and retry only the ack, as the Pi bridge does. This is a latent bug today too. Forwarded `turn.start` and `turn.complete` events are swallowed on failure and need the same retry as hooks.
- **Pi adapter** (`adapters/pi/`) catches and logs every call, retries release, unconfirmed and ack until they succeed, and never resubmits. Only hooks and turn events sent during the gap are lost; they need the same retry.
- **Codex adapter** (`adapters/codex/bridge.ts`) used to await hook and measure calls inside its event queue without a catch, so a rejection reached `fatal` and a daemon restart during a Codex turn killed the session. **Fixed:** these reports now retry every second for up to 60 s (holding the event queue, so order is kept), then are logged and dropped; `fatal` remains for an ambiguous `turn/start` and Codex errors. Receipts already retry on the next poll.
- **MCP.** Claude, Pi and Codex call `/mcp` over HTTP. The daemon's transport is stateless (`sessionIdGenerator: undefined` in `src/daemon/mcp.ts`), so there is no MCP session to lose; a tool call during the gap fails and the agent sees a tool error. Whether Claude Code marks a server failed after errors is not verified and should be tested.
- **Tokens and credential generations.** Node tokens are an HMAC of the node id and its `credentialGeneration` with the secret in `TL_HOME/secret`, which is created once and reused (`src/daemon/node-tokens.ts`). Generations are persisted on the node record and change only on create and harness change. So a new daemon accepts every adopted process's existing token, and the launch files (`token`, `hook-headers`, `mcp.json` under `nodes/<id>/launches/<generation>/`) stay valid. Adoption must not call `writeFiles`, which belongs to a launch; resume rewrites `mcp.json`, adoption does not. A process whose generation was rotated by a harness change in progress is already being terminated and fails verification, as today.
- **Endpoint.** `TL_ENDPOINT` is fixed in each process's environment, so the new daemon must listen on the same port. If it cannot bind that port, it must not adopt: it should fall back to the resume path.

## Reconciliation

At startup, after loading the registry and before `resumeLive`:

1. Connect to the holder, starting one if none answers. Read the `hello` list.
2. For each PTY whose metadata names a node in the registry and whose launch id matches the node's current launch (credential generation plus a per-launch counter recorded on the record at spawn), adopt it: create the facade, attach, replay, nudge, and remove the node from the pending-resume set.
3. Set the adopted node's status from what can be known. Runtime status is in memory today and is lost with the daemon. Use the screen: `prompt` means idle, `dialog` means blocked, anything else means working, with the existing stall sweep as the safety net. Hooks retried after the gap then correct it. Persisting the last status with the registry would give a better starting point for working nodes (turn start, activity) and is cheap. The trust watch is skipped for adopted nodes.
4. A PTY that exited while the daemon was down is handled as if the daemon had seen the exit: replay its ring for the native error tail, apply `ptyExited`, then `release` it. It is not resumed.
5. A PTY with no matching node, or from an older launch, is killed and released.
6. Live-set nodes with no PTY in the holder (a new holder after a crash or upgrade) go through `resumeLive` as today.

## Plan and effort

The estimate is about two weeks of focused work (nine to twelve days), in phases that can each ship:

1. **Gap hardening (one to two days).** Hook retry in `hook.sh`, the mod's ack retry, retries for the mod's and Pi's turn events, and non-fatal hook calls in the Codex adapter. This fixes the duplicate-delivery and Codex-crash paths that exist today and helps stage A as well.
2. **Holder and protocol (two to three days).** Production version of the spike: request ids, `release`, `detach`, the grace timer, `holder.json`, installing into `TL_HOME/holder/<build>/`, logging. Vitest tests with temporary homes: spawn and replay, reconnect after a client is killed, exit while no client is connected, version mismatch, socket permissions, a dropped slow client.
3. **Daemon integration behind a setting (two to three days).** `PtySession` backed by the holder, asynchronous spawn in `launch()`, SIGTERM detaching instead of killing, `tl stop` shutting the holder down, a `daemon.ptyHolder` setting defaulting to off.
4. **Reconciliation and fallbacks (two days).** Adoption at startup, status from the screen, exits while down, holder crash handling with the process-group sweep, the holder-upgrade fallback through stage A.
5. **Dogfooding and default on (one to two days).** Use it for real `tl reload` and `tl update` cycles with several live Claude, Pi and Codex nodes, update `docs/sessions.md` and the lifecycle docs, then turn it on by default.

What to test beyond unit tests, with temporary homes and ports:

- A `tl reload` while a Claude node is mid-turn and running a long Bash command: the turn completes, the `Stop` hook lands after the gap, and the node ends idle with its outcome.
- A message delivery during the gap: delivered exactly once.
- `tl update` with an `npm ci` that changes node-pty: the running holder keeps working and new spawns succeed.
- A launchd-managed daemon stopped with `launchctl kickstart -k` and with `bootout`: agents survive.
- `tl stop`: every agent exits and the holder exits.
- Killing the holder with SIGKILL: agents exit and the daemon resumes them.
- A daemon that stays down past the grace period: the holder kills the agents and exits, and the next start resumes them.

## Risks

- **Status after adoption is a guess.** A node adopted mid-turn has no turn start and no activity until its next hook. Persisting status and retrying hooks reduce this; the stall sweep catches the rest.
- **Unsupervised agents.** During the gap and up to the grace period, agents run without the daemon. Their hooks fail and messages wait, which is acceptable for seconds and is bounded for longer outages.
- **Mid-operation restarts.** A delivery paste or a harness change interrupted by the daemon exiting can leave a node in a half state. Stage A's drain covers planned restarts; crashes keep today's risk.
- **Two daemons.** The single-client rule and the port check prevent two daemons from driving the same PTYs, but this needs a test.
- **Holder bugs are expensive.** A holder crash ends every agent at once, as a daemon crash does today. Keeping it at a few hundred lines with no tiller logic is the mitigation.

## Alternatives

- **Passing PTY file descriptors to the new daemon (SCM_RIGHTS).** Node's `net` module cannot send arbitrary file descriptors over a Unix socket; `child_process` can pass net handles only between a parent and its child over the IPC channel, and a restarted daemon is not the old daemon's child. node-pty can only create PTYs, not adopt an existing master descriptor. Even with a native addon to pass and adopt the descriptors, the new daemon would not be the agents' parent and could not collect their exit statuses, and a crashed daemon cannot hand anything over. Rejected.
- **tmux, dtach or abduco as the holder.** None is installed on this machine or by macOS, so each adds a dependency to install and track. tmux would work through control mode (`tmux -CC`), and `capture-pane` gives a screen on reattach, but it puts its own terminal emulator between the agent and the daemon, sets `TERM` to its own value (Claude Code changes its rendering inside tmux), and needs a parser for control mode's escaped output. dtach and abduco hold one session per process and keep no screen to replay. A Node holder of a few hundred lines that reuses node-pty, which tiller already ships, is the smaller dependency.
- **Keeping kill and resume plus stage A.** This costs nothing more. But a drain has to wait for every node to be idle, which can take a long time with long-running workers, or interrupt them anyway, and every restart still kills what Claude cannot resume: running tool calls, background shells, background subagents and monitors. With releases several times a day this stays visible. Stage A remains worth having as the fallback for holder upgrades and as the behavior while the holder setting is off.

## Open questions

- Is a 15-minute grace period for a missing daemon right, and should it be configurable?
- Should runtime status be persisted with the registry so adopted nodes start with their real state, or is the screen guess plus hook retry enough?
- Hook retry or a hook spool: is ordering between hooks important enough to justify the spool?
- Does Claude Code tolerate MCP tool-call failures during the gap without marking the tiller server failed for the rest of the session? This needs a test with a real session.
- Does the one-row resize nudge make Claude repaint as reliably as the larger resize the spike used?
