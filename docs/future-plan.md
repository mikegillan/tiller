# Future plan

Planned work, ranked by value for the cost, as of 2026-10-19. Most items are ideas taken from [herdr](https://herdr.dev), an agent-aware terminal multiplexer that keeps agent CLIs running in a background server.

Tiller's distinct part is the coordination layer above the terminals: the node tree, the inbox with delivery receipts, reported outcomes, worktree merges, completion gates and approvals. Herdr has none of that; agents there drive each other by typing into panes and reading screens. Herdr is stronger at the layer underneath, keeping terminals alive and knowing each agent's state. The items below make that layer more reliable so the coordination on top does not break. Estimates are rough.

## 1. Restarts that do not interrupt agents (in progress)

`tl reload` and `tl update` stop the daemon, which kills every PTY (`Manager.shutdown`); the new daemon resumes the live set (`resumeLive`). A node that was mid-turn comes back idle, and nothing tells it to continue, so a worker can stall halfway through an edit until someone notices. Releases ship several times a day and the updater checks often, so this happens often.

- **Stage A: drain and re-prompt (a day or two).** Before an update or reload restarts the daemon, it waits until no node is working, holding new message deliveries and spawns so nodes settle, with a way to restart at once anyway. After the restart, each node whose turn was cut off gets a message from the daemon saying so and asking it to check its state and continue.
- **Stage B: a long-lived PTY holder (one to two weeks).** A small process that rarely changes owns the PTYs and agent processes; the coordination daemon connects to it, so the daemon can restart without killing any agent. Herdr's `update --handoff` and the tmux server and client split are the models. It starts with a design and a feasibility spike (`docs/design/pty-holder.md`).

## 2. `tl explain <id>`

Print why a node shows its state: its recent hook events with times, the stall timer, its queued messages and their receipts, the trust-dialog watch and its gate. Herdr has `agent explain` for the same purpose. It makes the daemon's state machine visible and targets recurring bugs: the trust dialog missed on tall terminals, stalls and duplicate deliveries. About a day.

## 3. Screen-matched "blocked" detection beside hooks

Herdr matches the bottom of each screen against known approval and question prompts. Tiller already keeps a headless terminal per node and does this once, for Claude's trust dialog (`watchTrust` in `src/daemon/manager.ts`). Generalising it into rules per harness would catch prompts that fire no hook, such as an expired login, a rate-limit choice, or a Codex or Pi approval. Hooks stay authoritative; the screen only fills their silences. An agent stuck on a prompt nobody sees is the most expensive failure in a tree of agents, because whoever waits on it waits indefinitely. Two to three days; it should also fix the tall-terminal trust bug.

## 4. `tl attach <id>`

Attach the current terminal to a node's PTY over the existing WebSocket, with a key to detach. This lets you use tiller from any terminal, including over SSH from another machine, without the app. One to two days.

## 5. Remote machines

Herdr's `machine add <host>` shows several machines' agents in one window. First step: document forwarding the daemon's port over SSH and opening the UI with its token URL, which should already work because the UI is a web page (not yet tried). A view across several daemons is worth building only once agents run on two machines at the same time.

## 6. Event hooks

Commands declared in config that run on daemon events: an outcome reported, a node blocked, a merge, an update available. Herdr's plugins have event hooks of this kind (for example `worktree.created`). It is the cheapest route to phone or chat notifications without building each integration. Build it when there is a concrete integration to serve.

## 7. Linux

The daemon's macOS-specific code is mostly `src/daemon/autostart.ts` (launchd) and `src/daemon/notifier.ts` (osascript). The daemon plus the browser UI on Linux is probably a few days. Worth it once someone needs it. Windows is a larger port, roughly a week.

## Not planned

- **Many agent CLIs through screen scraping.** Herdr detects 22 CLIs this way. A node that cannot take inbox messages or report outcomes is a second-class worker in tiller; add real adapters one at a time, as with Pi and Codex.
- **A terminal multiplexer interface.** Tabs, splits, keybindings, link handlers and a plugin marketplace belong to a different product.
- **Driving agents by typing into their terminals.** The inbox with receipts already does this better.
- **Replaying pane history after a restart.** Tiller resumes each agent's own conversation instead.
