# orchestr8 mod

Per-node Claude Code mod. It does nothing unless `O8_NODE_ID` is set (with `O8_ENDPOINT`, `O8_TOKEN_FILE`, optional `O8_PARENT_ID`).
Every second it polls the daemon: `/children` feeds the pane, band and toasts, and `/inbox` messages are delivered with
`$.prompt.submit` and then acked. It forwards `turn.start`, `turn.complete` and `session.measure` to `/mod-event`.
It draws a one-line band above the prompt, the `/o8` pane (the node itself first, then each descendant as a bordered card colored by state with a clickable title, short id, age and a line of activity), toasts, and macOS notifications for children that need you or error.
The daemon loads it by launching `claude --plugin-dir <repo>/mod ...` with the O8_* variables in the environment.
Commands: `/o8` (open pane), `/o8-list`, `/o8-spawn <title> :: <prompt>`, `/o8-send <nodeId> <text>`, `/o8-read <nodeId>`.
The last four call the daemon's `POST /api/<tool>` with the node's token and print the text result.
Clicking a card (or pressing its digit hotkey while the pane has focus: click the pane first, or Ctrl+X then Tab) POSTs `/focus {id}`; the daemon broadcasts it and an `o8 attach` client showing that node switches to the target. In a child, the band's `↑ parent` button does the same for the parent.
Source is TypeScript under `hooks/`: `register.tsx` holds everything that uses `$`; `api.ts`, `notify.ts`, `commands.ts`, `pane.tsx` and `band.tsx` are pure helpers (the validator forbids passing `$` to imported functions).
Check with `claude plugin validate mod/` and `claude plugin test mod/`; exercise with `npx tsx spike/mod-prod-spike.ts` (fake daemon) and `npx tsx spike/click-check.ts` (real daemon, node-pty).
OS notifications use `osascript`, whose clicks open Finder; `brew install terminal-notifier` makes a click focus your terminal (the daemon derives the app from its own `TERM_PROGRAM`, or `O8_TERMINAL_BUNDLE`, and passes it to nodes as `O8_TERMINAL_BUNDLE`).
