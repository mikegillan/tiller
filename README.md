# orchestr8

orchestr8 is a local daemon that runs several Claude Code sessions ("nodes") as child processes and lets one of them, the orchestrator, spawn, message and watch the others. Your own terminal stays the main interface, extended by a small Claude Code mod; a browser UI exists as an optional second view.

The design is in [PLAN.md](PLAN.md).

## Requirements

- Node 24 and the `claude` CLI (Claude Code) on your PATH.
- Optional: `terminal-notifier` (`brew install terminal-notifier`), so clicking a macOS notification focuses your terminal.

## Install

    npm install && npm link

This puts `o8` (client) and `o8d` (daemon) on your PATH.

## Run

In one terminal, start the daemon:

    o8d

In another, start an orchestrator session in a repo and attach to it:

    o8 new orchestrator --cwd ~/some/repo

Inside that session you will see a one-line band above the prompt, a children pane opened with `/o8`, and the slash commands `/o8-list`, `/o8-spawn <title> :: <prompt>`, `/o8-send <id> <text>` and `/o8-read <id>`. The orchestrator also has MCP tools to do the same.

Other commands: `o8 ps` lists nodes, `o8 attach <id>` shows a node's terminal (type into it, answer its permission prompts; Ctrl-\ then d detaches, n/p next/previous node, ! next node needing you, b back, l list, 1-9 jump, ? help), `o8 resume <id>` relaunches an exited node, `o8 kill <id...>` closes nodes. `o8 help` lists the rest.

Messages between nodes are queued in the daemon and submitted as prompts by the receiving node's mod when it is idle, then confirmed. If a node's mod is not running, the daemon pastes the message into its terminal instead. When a child needs you or finishes, the orchestrator shows a toast and a macOS notification.

## Browser UI (optional)

    npm run ui:build

then open the URL `o8d` prints.

## State

Everything lives in `~/.orchestr8` (override with `O8_HOME`): the node registry, per-node settings and tokens, and the admin token used by `o8`. `O8_PORT` changes the port (default 7788). `O8_TERMINAL_BUNDLE` overrides the notification target app, which otherwise comes from `TERM_PROGRAM`.

## Known limits

- Anthropic can disable mods remotely, and `--bare` or `--safe-mode` drop them. The daemon and CLI still work then; messages fall back to pasting into the terminal.
- Claude shows its trust dialog the first time it opens a new folder; attach and accept it.
- One daemon per user.

Tests: `npm test`, `npm run typecheck`, `claude plugin validate mod`.
