# Sessions, restart and resume

A tree is a root node and everything under it. This document covers what survives a restart of a node, of the daemon or of the machine, and how. The design behind the session directory is in [design/artifacts-plan.md](design/artifacts-plan.md).

## Session directories

Each tree gets a directory, `~/.tiller/sessions/<rootId>/`, created when the root launches. Every node in the tree has its path in the environment variable `TL_SESSION_DIR`, a sentence in its system prompt telling it to keep notes that must outlive its context there, with `handoff.md` as the current state of the work, and permission to write there without prompting. The directory is keyed by the root's id, not by Claude's session id, so it survives a node restart, `tl reload` and a reboot, unlike Claude's own scratchpad under `/tmp`. A `meta.json` in it records the root's title, directory and creation time, so the files remain identifiable after the root is gone.

`tl sessions` lists the directories with title, age, size and whether the root is closed, and `tl sessions path [id]` prints a tree's directory (by default this node's, or the orchestrator's for the current directory).

## Cleanup

When a root is closed, its `meta.json` gets `closedAt`. On daemon start and once a day, the daemon deletes the directories whose root closed more than `daemon.sessionsKeepDays` (default 14) ago, and those whose root is gone and that nothing has written to for that long. `tl sessions clean` runs that sweep now.

## The event log

The daemon appends one JSON line per event to `events.jsonl` in the tree's directory: spawn, close, state changes, report_outcome, each send with its outcome, withdraw, restart, resume, merge, the arming, queueing, release and launch of held spawns, and a cost snapshot at most once a minute per node. `tl log [id] [--since 2h] [--follow]` prints it; a non-root id shows only that node's events.

## The away digest

When the app or a browser tab regains focus after more than `daemon.digestAfterMinutes` (default 10) with no focused window, it gets a "While you were away" card built from the event log. It lists, per node, what still needs you, what errored or failed and what finished, with the outcome lines; clicking a row selects the node.

## Restarting a node

`tl restart <id>` (also the Restart action in the app) kills a node's process and relaunches it under a new Claude session id, so a Claude node starts with an empty context while keeping its id, title, directory, model, effort, role and children. The previous session ids are kept on the node record as `previousSessions` (the newest 10). `--prompt T` (or the text field in the app's Restart dialog) gives the restarted node a first prompt; without one, a node whose tree has a `handoff.md` is told to read it first. Agents cannot restart nodes.

Orchestrators are protected from being closed by accident. Agents cannot close them, the app offers Restart instead of Kill for them, and `tl kill <id>` on a root refuses with a hint; `tl kill --force <id>` overrides that.

`tl resume <id>` relaunches an exited Claude node with its previous conversation (`claude --resume`).

## History, follow-up and fork

Closing a Claude node (close, kill, prune, or closing its root) appends one line for it to `archive.jsonl` in the tree's session directory: its title, directory, model, effort, role, first prompt, session ids, transcript path, last message, reported outcome, spend, and for a worktree node its branch with what close did to it (merged into its base, kept with a WIP commit, or discarded). A one-line `brief` (at most 200 characters) sums up what the node did and how it ended, from its outcome's summary or note, else its last message, else its first prompt, followed by the branch's fate. Terminal nodes, and Claude nodes that never launched, are not archived. The archive goes with the session directory when the sweep deletes it. Agents can write to the session directory, so `archive.jsonl` is advisory data: the daemon takes a line's tree from the directory it sits in, never from the line, but trusts the rest of it (such as the transcript path).

`tl history [--root ID] [QUERY]` lists the closed nodes, newest first, of one tree or all, keeping those whose title, first prompt or last message contains QUERY. The agents' `history` tool lists their own tree's in the same terse form, so an orchestrator can find a closed worker; its `read` tool reads a closed node of its own tree too. `tl transcript <id> [--session SID]` prints a live or closed node's conversation; SID picks one of its earlier sessions, read from the same directory as the current transcript, since Claude keeps every session of a project there.

`tl followup <id> --prompt P [--title T]` continues a closed node's session as a new node (`claude --resume <session> -- P`), with the same title unless T is given, and the same model, effort and role. It goes under the closed node's parent while that is live, else it becomes a root; it starts in the closed node's directory, or in the main checkout when that was a worktree since removed. The new node records `followupOf`. A second follow-up of the same session is refused while the first is live.

`tl spawn --fork ID ...` (the `fork` argument of the spawn tool) starts a new Claude node from a copy of another node's conversation (`claude --resume <session> --fork-session --session-id <new>`), then gives it the prompt; the source keeps its own session. The source may be live or closed, but must have started a session; an agent may fork only a node in its scope or a closed node of its own tree. The directory defaults to the source's, and the new node records `forkOf`.

## Resume on daemon start

The daemon records which nodes are live in `state.json`. When it starts, after a crash, a kill, a reboot or `tl reload`, it resumes them, parents first. It skips nodes that no longer exist, nodes whose worktree is missing and nodes idle for more than `daemon.resumeMaxAgeDays` (default 3), and logs one summary line. Setting `daemon.resumeOnStart` to false turns this off. `tl stop` is the "do not come back" switch: it clears the live set, so the next start resumes nothing.

`tl reload` works from inside a node's terminal too: a detached helper stops the daemon (keeping its live set) and starts a new one, which resumes the nodes itself. Each step is logged to `daemon.log` with a `tl reload:` prefix. If no daemon is running it just starts one.

## Autostart

`tl autostart on` installs a launchd user agent, `~/Library/LaunchAgents/com.tiller.daemon.plist`, that starts the daemon at login, so the nodes come back after a reboot without opening the app, and starts it again if it crashes; `tl stop` exits cleanly and launchd leaves it stopped. With autostart on, `tl reload` starts the new daemon through launchd. `tl autostart off` removes the agent (stopping the daemon if launchd started it), and `tl autostart status` says whether it is installed and loaded. Turning it on while a daemon is running leaves that daemon alone: the agent's first launch finds the port taken and exits, and the next `tl reload` or login hands the daemon to launchd.

## Moving from orchestr8 (one time)

Tiller was called orchestr8, with the CLI `o8`, the daemon `o8d`, the home `~/.orchestr8` and the launchd agent `com.orchestr8.daemon`. The first start of the renamed code cannot be a plain reload from the old daemon: the old daemon has to stop on its old home before the new code moves that home, and `bin/o8` no longer exists once the rename is merged. The new code handles the move itself. Whatever first creates the home (the daemon at start, `tl reload` or `tl` starting the daemon, `tl autostart on`) renames `~/.orchestr8` to `~/.tiller` when `~/.tiller` does not exist yet, and logs one line; the state, sessions, admin token, config.json and prompts come along. A `TL_HOME` other than `~/.tiller` is never filled from `~/.orchestr8`. `tl reload` and `tl autostart on` refuse to act while a daemon on another home holds the port, and name its pid.

After merging, from the main checkout:

1. With autostart on (the old agent installed): run `bin/tl autostart on`. It removes `~/Library/LaunchAgents/com.orchestr8.daemon.plist` and boots out the old agent, which sends the old daemon SIGTERM, so it keeps its live set. It then moves the home, installs `com.tiller.daemon` and starts `bin/tld` through launchd, which resumes the nodes that were live under `TL_*` variables and the `tiller` MCP server. If the old daemon was not started by launchd, the command stops with `daemon pid N uses home ~/.orchestr8`: run `kill N` (SIGTERM keeps the live set; `bin/o8 stop` would clear it) and run `bin/tl autostart on` again.
2. Without autostart: run `kill N`, where N is the pid from `curl -s http://127.0.0.1:7788/health`, then `bin/tl reload`, which starts `bin/tld`, moves the home first, and resumes the nodes.
3. Check with `bin/tl status` (home `~/.tiller`) and `bin/tl autostart status`.

Then rebuild the app with `npm run app:build`: it is now `Tiller.app` with the identifier `dev.tiller.app`, so its window state and stored key start fresh, and the old `orchestr8.app` bundle can be deleted. If the CLI was installed with `npm link`, run `npm link` again so `tl`, `tld` and `tl-app` are on the PATH; the old `o8` links then dangle and can be removed. Worktree branches made before the rename keep their `o8/` names and still merge and close normally, but `tl worktrees` only lists kept branches under the new `tl/` prefix, and worktrees orphaned before the move carry the old marker and home, so they are not cleaned automatically.
