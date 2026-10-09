# orchestr8 mod

Per-node Claude Code mod. It does nothing unless `O8_NODE_ID` is set (with `O8_ENDPOINT`, `O8_TOKEN_FILE`, optional `O8_PARENT_ID`).
Every second it polls the daemon: `/children` feeds the pane, band and toasts, and `/inbox` messages are delivered with
`$.prompt.submit` and then acked. It forwards `turn.start`, `turn.complete` and `session.measure` to `/mod-event`.
It draws a one-line band above the prompt, a children pane, toasts, and macOS notifications for children that need you or error.
The daemon loads it by launching `claude --plugin-dir <repo>/mod ...` with the O8_* variables in the environment.
Commands: `/o8` (open pane), `/o8-list`, `/o8-spawn <title> :: <prompt>`, `/o8-send <nodeId> <text>`, `/o8-read <nodeId>`.
The last four call the daemon's `POST /api/<tool>` with the node's token and print the text result.
Check with `claude plugin validate mod/`; exercise with `npx tsx spike/mod-prod-spike.ts`.
