# orchestr8 mod

Per-node Claude Code mod. It does nothing unless `O8_NODE_ID` is set (with `O8_ENDPOINT`, `O8_TOKEN_FILE`, optional `O8_PARENT_ID`).
Every second it polls the daemon: `/tree` (the caller's whole tree, root first) feeds the band and toasts, and `/inbox` messages are delivered with
`$.prompt.submit` and then acked. It forwards `turn.start`, `turn.complete` and `session.measure` to `/mod-event`.
It draws a one-line band above the prompt (in a child, `↑ parent` and `⌂ root` buttons; the needs-you child), and in-session toasts for children that need you, finish or error. The tree and node controls live in the `o8` sidebar client, not in Claude.
The mod is silent while an orchestr8 client is attached. Every `/tree` and `/inbox` response carries `X-O8-Clients: app,browser,mux` (the kinds of authenticated ws clients now connected, empty when none); when it is non-empty the mod keeps a `quiet` state atom true, the `AbovePrompt` hook passes through, and it makes no toasts and no `$.ui.log` lines, because the client's sidebar already shows all of it. Inbox delivery, acks, event forwarding and slash commands carry on. When the last client disconnects the band and toasts return, and the first diff after that is a baseline so changes made while quiet are not replayed.
The daemon loads it by launching `claude --plugin-dir <repo>/mod ...` with the O8_* variables in the environment.
Commands: `/o8-list`, `/o8-spawn <title> :: <prompt>`, `/o8-send <nodeId> <text>`, `/o8-read <nodeId>`.
The four call the daemon's `POST /api/<tool>` with the node's token and print the text result.
The band's `↑ parent` and `⌂ root` buttons POST `/focus {id}` (any node in the same tree); the daemon broadcasts it and an `o8` client showing that node switches to the target.
Source is TypeScript under `hooks/`: `register.tsx` holds everything that uses `$`; `api.ts`, `notify.ts`, `commands.ts` and `band.tsx` are pure helpers (the validator forbids passing `$` to imported functions).
Check with `claude plugin validate mod/` and `claude plugin test mod/`; exercise with `npx tsx spike/mod-prod-spike.ts` (fake daemon) and `npx tsx spike/mux-check.ts` (real daemon, node-pty).
The mod sends no OS notifications: the daemon is the single sender (see the repo README), so the app and the terminal never both notify.
