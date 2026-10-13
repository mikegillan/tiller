# Sessions, restart and resume

A tree is a root node and everything under it. This document covers what survives a restart of a node, of the daemon or of the machine, and how. The design behind the session directory is in [design/artifacts-plan.md](design/artifacts-plan.md).

## Session directories

Each tree gets a directory, `~/.orchestr8/sessions/<rootId>/`, created when the root launches. Every node in the tree has its path in the environment variable `O8_SESSION_DIR`, a sentence in its system prompt telling it to keep notes that must outlive its context there, with `handoff.md` as the current state of the work, and permission to write there without prompting. The directory is keyed by the root's id, not by Claude's session id, so it survives a node restart, `o8 reload` and a reboot, unlike Claude's own scratchpad under `/tmp`. A `meta.json` in it records the root's title, directory and creation time, so the files remain identifiable after the root is gone.

`o8 sessions` lists the directories with title, age, size and whether the root is closed, and `o8 sessions path [id]` prints a tree's directory (by default this node's, or the orchestrator's for the current directory).

## Cleanup

When a root is closed, its `meta.json` gets `closedAt`. On daemon start and once a day, the daemon deletes the directories whose root closed more than `daemon.sessionsKeepDays` (default 14) ago, and those whose root is gone and that nothing has written to for that long. `o8 sessions clean` runs that sweep now.

## The event log

The daemon appends one JSON line per event to `events.jsonl` in the tree's directory: spawn, close, state changes, report_outcome, each send with its outcome, withdraw, restart, resume, merge, the arming, queueing, release and launch of held spawns, and a cost snapshot at most once a minute per node. `o8 log [id] [--since 2h] [--follow]` prints it; a non-root id shows only that node's events.

## The away digest

When the app or a browser tab regains focus after more than `daemon.digestAfterMinutes` (default 10) with no focused window, it gets a "While you were away" card built from the event log. It lists, per node, what still needs you, what errored or failed and what finished, with the outcome lines; clicking a row selects the node.

## Restarting a node

`o8 restart <id>` (also the Restart action in the app and the multiplexer) kills a node's process and relaunches it under a new Claude session id, so a Claude node starts with an empty context while keeping its id, title, directory, model, effort, role and children. The previous session ids are kept on the node record as `previousSessions` (the newest 10). `--prompt T` (or the text field in the app's Restart dialog) gives the restarted node a first prompt; without one, a node whose tree has a `handoff.md` is told to read it first. Agents cannot restart nodes.

Orchestrators are protected from being closed by accident. Agents cannot close them, the app and the multiplexer offer Restart instead of Kill for them, and `o8 kill <id>` on a root refuses with a hint; `o8 kill --force <id>` overrides that.

`o8 resume <id>` relaunches an exited Claude node with its previous conversation (`claude --resume`).

## Resume on daemon start

The daemon records which nodes are live in `state.json`. When it starts, after a crash, a kill, a reboot or `o8 reload`, it resumes them, parents first. It skips nodes that no longer exist, nodes whose worktree is missing and nodes idle for more than `daemon.resumeMaxAgeDays` (default 3), and logs one summary line. Setting `daemon.resumeOnStart` to false turns this off. `o8 stop` is the "do not come back" switch: it clears the live set, so the next start resumes nothing.

`o8 reload` works from inside a node's terminal too: a detached helper stops the daemon (keeping its live set) and starts a new one, which resumes the nodes itself. Each step is logged to `daemon.log` with an `o8 reload:` prefix. If no daemon is running it just starts one.

## Autostart

`o8 autostart on` installs a launchd user agent, `~/Library/LaunchAgents/com.orchestr8.daemon.plist`, that starts the daemon at login, so the nodes come back after a reboot without opening the app, and starts it again if it crashes; `o8 stop` exits cleanly and launchd leaves it stopped. With autostart on, `o8 reload` starts the new daemon through launchd. `o8 autostart off` removes the agent (stopping the daemon if launchd started it), and `o8 autostart status` says whether it is installed and loaded. Turning it on while a daemon is running leaves that daemon alone: the agent's first launch finds the port taken and exits, and the next `o8 reload` or login hands the daemon to launchd.
