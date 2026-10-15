# Front ends and notifications

All front ends are clients of the same daemon, so closing one never stops the agents. A session, in the front ends, is one tree shown at a time, with a switcher between trees.

## The native app (macOS)

The app is a small Tauri v2 shell that hosts the browser UI in a native window and shows the number of blocked or waiting nodes as the Dock badge. To build it you need the Xcode Command Line Tools and Rust through Homebrew's rustup (how to install both is in the [README](../README.md)), with `export PATH=/opt/homebrew/opt/rustup/bin:$PATH` in the shell that builds it. The build runs `npm run ui:build` first, so the app always ships the current UI.

    npm run app:build    # unsigned src-tauri/target/release/bundle/macos/Tiller.app
    bin/tl-app           # opens that app, or runs `npm run app:dev` if it is not built

`tl` opens the app, or brings a running app to the front; `tl .` (or `tl <path>`) opens it on that directory's orchestrator, or switches a running app to it. On launch the app finds the daemon the way `tl` does (`TL_PORT`, then `~/.tiller/port`, then 7788). If none answers, it starts `bin/tld` detached, using the repo path that `tl` records in `~/.tiller/repo` the last time it started a daemon, then opens the UI with the admin token. The daemon keeps running when the app quits.

The app has a menu bar item: a dot that is green when nothing needs you, amber when a node is waiting or blocked, and red when a node's turn errored. Its menu lists the nodes that need you (clicking one selects it), Open tiller, and Do not disturb 1 h.

In the app, the New session dialog has a Choose… button beside Working directory that opens the native folder picker; the browser UI has only the text field, because a web page cannot read a folder's path.

## The browser UI

`npm run ui:build` writes the UI to `ui/dist`; the daemon then serves it at the URL `tld` prints, which carries the admin token. It is the same UI the app shows: a sidebar with the tree, each node's live terminal, a last-message panel with the node's reported outcome, a Diff tab for worktree nodes in which you can add line comments and send them to the node as one message, and a status bar with today's total spend, the number of queued spawns and the do-not-disturb control. Each node's row shows its spend summed across its sessions, with the subtree total (Σ) on nodes with children. The browser keeps its own toasts, a tab-title badge and a chime. `ui/README.md` covers developing the UI against a mock daemon.

## Inside a node: the band and slash commands

The tiller mod draws a one-line band above Claude's prompt: in a child, `↑ parent` and `⌂ root` buttons, which switch an attached client to that node, and the child that needs you, if any. It also shows in-session toasts when a child needs you, finishes or errors. The mod draws none of this while the app or a browser is attached, because their sidebars already show it.

The mod adds four slash commands: `/tl-list`, `/tl-spawn <title> :: <prompt>`, `/tl-send <id> <text>` and `/tl-read <id>`. They call the same handlers as the MCP tools every Claude node has. How the mod works is described in `mod/README.md`.

## OS notifications

The daemon is the only sender of macOS notifications, so the app and the browser never double up. When a node needs approval, asks a question, finishes, fails a turn or exits, the daemon posts one notification titled with the node (its session as the subtitle, when different) whose body says what it needs, for example `Needs approval: Bash touch /tmp/x`. It stays quiet when a focused window (app or browser tab) has that node selected, and sends at most one per node and kind every 5 seconds.

With `terminal-notifier` installed, a notification replaces the node's previous one, plays a sound where its level says so, and clicking it runs `tl select <id>`, which shows the node in the app (opening it if it is built). Without it the daemon uses `osascript` notifications, which cannot be clicked. `TL_TERMINAL_NOTIFIER` overrides the `terminal-notifier` path, and `TL_TERMINAL_BUNDLE` overrides the app a click activates when the native app is not connected (otherwise it is derived from `TERM_PROGRAM`). terminal-notifier 3.1.0 has no time-sensitive option, and its `-ignoreDnD` is documented as usually doing nothing, so needs-you notifications are not marked time-sensitive. Its `-action` buttons are not used either: they keep the process waiting for an answer, and the useful action, approving, would answer for the human.

The `notifications` config keys set the level for each kind (needs-you, errored, done and exited), a per-tree summary in place of per-node done notifications, and quiet hours; they are listed in [config.md](config.md). During quiet hours everything is silent except needs-you, which becomes a banner without sound. With `treeDoneSummary`, one notification, "tree <title> finished: N succeeded, M failed", replaces the per-node done and exited ones once every Claude node of the tree is done or exited; failed means the turn errored or the node reported a failed outcome. The daemon log has one line per notification, sent or suppressed and why.

## Mute and do not disturb

`tl mute <id>` and `tl unmute <id>`, or the bell button on a row, stop and restore one node's notifications; a muted row shows a crossed-out bell, and the mute is kept across restarts. `tl dnd [on|off|1h|30m]`, the "do not disturb 1 h" button in the status bar or the menu bar item stop all notifications until turned off, or for the time given. Do not disturb is not kept across a daemon restart. The status bar shows the time left, and the Dock badge still counts.
