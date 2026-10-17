# Working on Tiller

Tiller runs Claude Code, Pi and Codex sessions as child processes of a local Node.js daemon. A React UI is shared by the browser and the macOS Tauri app.

## Repository map

- `src/daemon/`: node lifecycle (`manager.ts`, `nodes.ts`, `pty.ts`), HTTP/WebSocket server (`server.ts`), CLI (`cli.ts`), agent tools (`mcp.ts`), messaging, worktrees, sessions and updates.
- `src/shared/`: daemon/UI contracts in `protocol.ts` and shared pure helpers.
- `adapters/pi/` and `adapters/codex/`: harness bridges; `src/daemon/harness.ts` defines the adapter boundary and launch policy. Each adapter has its own README.
- `mod/`: Claude Code plugin. See `mod/README.md` for hook restrictions and its separate test runner.
- `ui/`: React + xterm.js; `store.ts` holds shared UI state, `theme.css` holds theme variables, and `icons.tsx` holds inline SVG icons. See `ui/README.md` for the mock daemon and browser development workflow.
- `src-tauri/`: native Rust app shell and Tauri configuration.
- `docs/`: behavior and configuration references. Start with `docs/harnesses.md`, `docs/messaging.md`, `docs/worktrees.md` or `docs/sessions.md` for the affected subsystem. `PLAN.md` and `docs/design/` contain design rationale; check current code and behavior docs when plans differ.

## Setup and development

Use Node.js 24+ and npm from the repository root. `npm ci` installs the locked dependencies; keep lifecycle scripts enabled because `postinstall` fixes the macOS `node-pty` spawn helper. Native app development also needs Rust and Xcode Command Line Tools; see `README.md` for setup.

- `npm run ui:dev`: Vite with hot reload; `/ws` proxies to the daemon at `127.0.0.1:7788`, or `TL_WS` when set.
- `npm run ui:build`: build static assets into `ui/dist/`.
- `npm run app:dev`: run the Tauri development shell.
- `npm run app:build`: build the macOS app, including the UI build.

The default daemon uses `~/.tiller` and port 7788. For manual daemon experiments, use a separate `TL_HOME` and `TL_PORT` so they do not share live node state. `bin/setup` also installs tools, links the checkout and builds the app; use `npm ci` for dependency setup alone.

## Verification

Run checks appropriate to the changed area from the repository root:

| Area | Command |
| --- | --- |
| Daemon, shared code, Codex and Pi adapters | `npm run typecheck` |
| UI and its shared imports | `npx --no-install tsc --noEmit -p ui/tsconfig.json` |
| Vitest suite (daemon, shared, adapters, UI) | `npm test` |
| Focused Vitest run, for example messaging | `npm test -- src/daemon/messaging.test.ts` |
| Claude mod | `claude plugin validate mod/` and `claude plugin test mod/` |
| Release helpers | `node --test scripts/release-test.mjs` |
| Native Rust app | `cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml` |

Tests generally live beside their source as `*.test.ts` or `*.test.tsx`. Keep daemon integration tests isolated with temporary homes and ephemeral ports, as in `src/daemon/server.test.ts`. Vitest deliberately runs files serially: some tests create real git repositories and child processes. `mod/` tests run only through the Claude plugin runner.

`.github/workflows/ci.yml` is the CI reference: it checks types, Vitest, release helpers, the production UI build and Rust on macOS. `.tiller/config.json` defines a separate worker completion gate (root and UI typechecks plus Vitest); it does not cover every CI check.

## Conventions and boundaries

- TypeScript is strict and uses ES modules. Match nearby formatting (daemon/UI code generally uses single quotes and semicolons; Pi uses double quotes). NodeNext code uses `.js` import specifiers for local TypeScript modules; the Pi adapter uses `.ts` specifiers and a separate tsconfig.
- Keep daemon/UI message contracts in `src/shared/protocol.ts`. Preserve the distinction between Tiller session IDs and harness-native conversation IDs when changing adapters or persistence.
- Keep coordination, scope checks and delivery receipts in the daemon; adapters bridge native lifecycle events and inbox delivery. Consult the adapter READMEs before changing acceptance/acknowledgment behavior.
- In the Claude mod, code using `$` belongs in `mod/hooks/register.tsx`; imported helpers cannot receive `$`. The mod cannot import `src/shared/`.
- Update the relevant behavior docs when changing CLI, configuration, messaging or lifecycle behavior. For release/updater changes, read `docs/releases.md` and the updater sections of `README.md`.
