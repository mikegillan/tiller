# orchestr8

orchestr8 is a local daemon that runs several Claude Code sessions ("nodes") as child processes and lets one of them, the orchestrator, spawn, message and watch the others. The main front end is a native (Tauri) app, which `o8` opens; the same UI runs in a browser, and `o8-mux` is a terminal multiplexer for the terminal. A small Claude Code mod in each node delivers messages and adds a few slash commands.

The design is in [PLAN.md](PLAN.md).

## Requirements

- Node 24 and the `claude` CLI (Claude Code) on your PATH.
- Optional: `terminal-notifier` (`brew install terminal-notifier`), so clicking a macOS notification selects the node.

## Install

    npm install && npm link

This puts `o8` (client), `o8d` (daemon), `o8-mux` (terminal multiplexer) and `o8-app` (native app) on your PATH.

## Run

    cd ~/some/repo && o8

That one command starts the daemon if it is not running (detached, logging to `~/.orchestr8/daemon.log`), finds or creates (or resumes, if it exited) the orchestrator for the current directory, and opens the native app on it. If the app is already running it switches to that session. If the app has not been built it says so and opens the browser UI instead (see App below). `o8 --new` always starts a fresh orchestrator, and `--title T` and `--prompt P` set its title and first prompt. `o8 status` shows the daemon and node count, and `o8 stop` shuts the daemon down and closes all nodes.

The daemon remembers which nodes were live (in `state.json`), and when it starts it resumes them, parents first, after a crash, a kill, a reboot or `o8 reload`. It skips nodes that no longer exist, nodes whose worktree is missing and nodes idle for more than `resumeMaxAgeDays` (default 3), and logs one summary line. `o8 stop` is the "do not come back" switch: it clears that set, so the next start resumes nothing. Set `resumeOnStart` to false or change `resumeMaxAgeDays` in `~/.orchestr8/config.json` (the home file only; `o8 config` shows both).

`o8 autostart on` installs a launchd user agent (`~/Library/LaunchAgents/com.orchestr8.daemon.plist`) that starts the daemon at login, so the nodes come back after a reboot without opening the app, and starts it again if it crashes; `o8 stop` exits cleanly and launchd leaves it stopped. `o8 autostart off` removes it (stopping the daemon if launchd started it), and `o8 autostart status` says whether it is installed and loaded. Turning it on while a daemon is running leaves that daemon alone: the agent's first launch finds the port taken and exits, and the next `o8 reload` or login hands the daemon to launchd.

For the terminal version, run `o8-mux` (or `o8 mux`) in the directory instead; it does the same setup and attaches the multiplexer described below. `o8 attach <id>` opens the multiplexer on a specific node.

`o8d` is the same daemon in the foreground, for when you want its log in a terminal.

`o8 reload` restarts the daemon on the current code and resumes the nodes that were live; run it after pulling or editing daemon code. It works from inside a node's terminal too: a detached helper stops the daemon (keeping its live set), starts a new one (through launchd when autostart is on), which resumes the nodes itself, and logs each step to `daemon.log` with an `o8 reload:` prefix. If no daemon is running it just starts one.

`o8-mux` is a small terminal multiplexer. A rounded sidebar on the left shows the whole tree (connectors, a colored state glyph per node, an unread dot, age, the current activity, and `model · effort · ctx %` with token counts and cost when known); the rest of the terminal is the selected node's live screen, and what you type goes to it. Click a node in the sidebar to swap its screen in; the mouse wheel and clicks in the main area are forwarded to the node when it has asked for mouse reports. The sidebar footer shows the daemon status (red and reconnecting if the connection drops). The sidebar hides below 90 columns.

Controls apply to the selected node and are both clickable in the sidebar and available as keys after the prefix Ctrl-\: `n` new child (asks for a title; same folder, claude), `e` rename, `x` kill (asks y/n; refused on an orchestrator), `R` restart (asks y/n), `r` resume (exited nodes), `o` new orchestrator in this directory, `s` hide or show the sidebar, `?` help overlay. Navigation: `d` detach (leaves everything running), `j`/`k` next/previous node, `!` next node needing you, `b` back, `1`-`9` jump to the nth node, `l` then a number and Enter, Ctrl-\ twice sends a literal Ctrl-\. The terminal bell rings once (at most every 5 s per node) when a node you are not looking at needs you.

Inside a node you will see a one-line band above the prompt and the slash commands `/o8-list`, `/o8-spawn <title> :: <prompt>`, `/o8-send <id> <text>` and `/o8-read <id>`. The orchestrator also has MCP tools to do the same.

Other commands: `o8 ps` lists nodes, `o8 attach <id>` opens the multiplexer on a node, `o8 resume <id>` relaunches an exited node, `o8 kill <id...>` closes nodes, and `o8 restart <id>` relaunches a node with a fresh session.

Orchestrators (root nodes) are never closed by accident. Agents cannot close them, the UI and multiplexer offer Restart instead of Kill, and `o8 kill <id>` on a root refuses with a hint; `o8 kill --force <id>` (or a `force` flag on the websocket `close` message) overrides it. Restart kills the node's process and relaunches it under a new session id, so a Claude orchestrator starts with an empty context while keeping its id, title, directory, model, role and children. The previous session ids are kept on the node record (`previousSessions`, newest 10). Restart is human-only for MCP callers. `o8 help` lists the rest.

Messages between nodes are queued in the daemon and submitted as prompts by the receiving node's mod when it is idle, then confirmed. If a node's mod is not running, the daemon pastes the message into its terminal instead. When a child needs you or finishes, the orchestrator shows an in-session toast, but only when no app, browser or multiplexer client is attached.

## Role prompts

Every Claude node gets a role section appended to its system prompt, so it survives `/clear`. A root node (no parent) is an orchestrator and a node with a parent is a worker. The text comes from `~/.orchestr8/prompts/orchestrator.md` and `worker.md`, which the daemon writes on first start and never overwrites, so edit them freely. A file at `<repo>/.orchestr8/orchestrator.md` or `worker.md` wins for nodes whose directory is that repo. Files are read at each launch or resume, so edits apply to the next node you start. `--role orchestrator|worker|none` on `o8 new` and `o8 spawn` (and `role` on the MCP spawn tool) overrides the default; `none` omits the section. `o8 prompts` prints the paths in effect for the current directory.

A config file at `<repo>/.orchestr8/config.json`, falling back to `~/.orchestr8/config.json`, sets per-project defaults. All keys are optional: `{"roles": {"orchestrator": {"model": "opus", "effort": "high"}, "worker": {"model": "haiku", "effort": "low"}}, "closeWithoutConfirm": "never"}`. Each key resolves on its own, from an explicit spawn argument, then the repo file, then the home file, then the built-in default. `roles` picks the model and effort (`low`, `medium`, `high`, `xhigh` or `max`, passed to claude as `--effort`) for a node spawned without them, by role (`none` counts as worker), and the node keeps them across restarts. `closeWithoutConfirm` lets an agent's `close` skip the human's approval: `always` skips it, `done` skips it when every node in the batch is done or has exited, and `never` (the default) always asks. The file is read on each use, so edits apply without restarting the daemon; a malformed file is logged and skipped. `o8 config [--cwd P]` prints the effective values and which file each came from.

## Worktrees

A Claude worker can run in its own git worktree, so parallel workers never edit the same checkout. Spawn with isolation `worktree` (`o8 spawn --worktree`, `o8 new --worktree`, or `isolation: "worktree"` on the MCP `spawn` tool). The daemon creates `<main checkout>/.claude/worktrees/<nodeId>` on branch `o8/<nodeId>` from the HEAD of the checkout the spawn's `cwd` is in, copies the gitignored files listed in `.worktreeinclude` (such as `.env` or `node_modules/`), and starts `claude --worktree <nodeId>` from the main checkout so Claude keeps the agent inside the worktree. The repo needs at least one commit and must already be trusted by Claude (run `claude` in it once). A child spawned without isolation into a worktree path shares that worktree.

To bring the work back, merge the branch with git as usual. Closing the node then removes the worktree and deletes the branch, but only when the tree is clean, the branch is merged and no other live node works in it; otherwise the close is refused with the counts. `o8 kill <id> --keep-branch` commits any changes as a WIP commit, removes the directory and keeps the branch; `--discard` deletes both. Prune keeps worktree nodes with unmerged work. `o8 worktrees` lists node worktrees, orphans (worktrees left by a crash) and kept branches; `o8 worktrees clean` removes those that are clean and merged, and `--force` removes them all and prints the commits and files that went. On start the daemon removes orphans that hold no work and reports the rest.

The `worktrees` key in the config file has three settings: `isolation` (`none` or `worktree`, default `none`) is used when a spawn of a claude worker does not say; `branchPrefix` (default `o8/`) starts each branch name; `include` (a list of gitignore patterns) replaces `.worktreeinclude` for orchestr8's worktrees. For a worktree node the project file is read from the main checkout.

The daemon hides `.claude/worktrees/` from `git status` through `.git/info/exclude`, which ripgrep also honours, but test runners, linters and other tools that glob the tree do not. Exclude `**/.claude/worktrees/**` in them; this repo does so in `vitest.config.ts`.

## Browser UI (optional)

    npm run ui:build

then open the URL `o8d` prints.

## App (macOS)

A small Tauri v2 shell that hosts the browser UI in a native window and shows the number of blocked or waiting nodes as the Dock badge. Requirements: Rust via Homebrew rustup, with `export PATH=/opt/homebrew/opt/rustup/bin:$PATH` in the shell that builds it, and a built UI (`npm run ui:build`).

    npm run app:build    # unsigned src-tauri/target/release/bundle/macos/orchestr8.app
    bin/o8-app           # just opens that app (`o8` also picks the session); or runs `npm run app:dev` if it is not built

On launch the app finds the daemon the way `o8` does (`O8_PORT`, then `~/.orchestr8/port`, then 7788). If none answers it starts `bin/o8d` detached, using the repo path that `o8` records in `~/.orchestr8/repo` the last time it started a daemon, then opens the UI with the admin token. The daemon keeps running when the app quits.

Notifications: the daemon is the only sender of macOS notifications, so the app, the browser and the terminal never double up. When a node needs approval, asks a question, finishes, fails a turn or exits, the daemon posts one notification titled with the node (subtitle: its session, when different) whose body says what it needs, for example `Needs approval: Bash touch /tmp/x`. It stays quiet when a focused window (app, browser tab or `o8` multiplexer) has that node selected, and sends at most one per node and kind every 5 seconds. With `terminal-notifier` installed (`brew install terminal-notifier`), notifications replace the node's previous one, play a sound for needs-you and errors, and clicking one runs `o8 select <id>`, which shows the node in the app (opening it if built). Without it the daemon falls back to `osascript` notifications, which cannot be clicked. The browser UI keeps its toasts, tab-title badge and a chime; the multiplexer rings its terminal bell only when the app is not connected.

## State

Everything lives in `~/.orchestr8` (override with `O8_HOME`): the node registry, per-node settings and tokens, and the admin token used by `o8`. `O8_PORT` changes the port (default 7788). `O8_TERMINAL_BUNDLE` overrides the app a notification click activates when the native app is not connected (otherwise derived from `TERM_PROGRAM`); `O8_TERMINAL_NOTIFIER` overrides the `terminal-notifier` path.

## Known limits

- Anthropic can disable mods remotely, and `--bare` or `--safe-mode` drop them. The daemon and CLI still work then; messages fall back to pasting into the terminal.
- Claude shows its trust dialog the first time it opens a new folder; attach and accept it.
- One daemon per user.
- With autostart on, a daemon started by `o8` or the app (when none was running) runs outside launchd, so a crash does not bring it back, until the next `o8 reload` or login.

Tests: `npm test`, `npm run typecheck`, `claude plugin validate mod`.
