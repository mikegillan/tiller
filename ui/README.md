# orchestr8 UI

React + xterm.js front-end for the orchestr8 daemon. It speaks the WebSocket protocol in `src/shared/protocol.ts`.

## Commands

- `npm run ui:build` writes the static UI to `ui/dist`; the daemon serves it at `/?k=<token>`.
- `npm run ui:dev` starts Vite with hot reload and proxies `/ws` to the daemon at 127.0.0.1:7788 (override with `O8_WS`).
- `npx vitest run ui` runs the unit tests (tree building, session selection, context thresholds, age formatting).
- `npx tsc --noEmit -p ui/tsconfig.json` type-checks.

## Developing without the daemon

The mock daemon has three sessions (one with a blocked node and a pending command, one with an errored node, one idle), an exited node, and mixed models and context usage. Spawn, rename, resume, close and prune work in memory, and a confirm request arrives 15 seconds after connecting. History has four closed nodes across two trees; every Claude node has a fake transcript ("daemon" and the closed "auth refactor" have two sessions), and follow-up and fork make new nodes.

    node ui/mock-server.mjs                                  # ws on :7789, token "mock"
    O8_WS=http://127.0.0.1:7789 npm run ui:dev               # then open the printed URL with ?k=mock

After `npm run ui:build` the mock also serves the built UI: open `http://127.0.0.1:7789/?k=mock`. Set `O8_MOCK_PORT` to change the port.

## URL and keyboard

- `?k=<token>` is stored in localStorage and removed from the address bar. `?node=<id>` selects that node and its session; the UI keeps it in step with the selection.
- Cmd+K jump to any node, Cmd+1..9 select the Nth row of the current session, Cmd+0 focus the sidebar tree.
- With the tree focused: j/k or arrows move, h/l collapse and expand.

## Layout

Styles are four plain files (`theme.css` holds the variables and the light theme for `prefers-color-scheme`). `store.ts` holds all state; `tree.ts` and `sessions.ts` are the pure logic the tests cover. Icons are inline SVG in `icons.tsx`.
