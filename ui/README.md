# orchestr8 UI

1. `npm run ui:build` writes the static UI to `ui/dist` (the daemon serves it at `/?k=<token>`).
2. `npm run ui:dev` starts Vite; it proxies `/ws` to the daemon at 127.0.0.1:7788.
3. Without the daemon: `node ui/mock-server.mjs`, then run Vite with `O8_WS=http://127.0.0.1:7789 npm run ui:dev`.
4. Open the printed Vite URL with `?k=mock` (the mock accepts only that token).
5. Tests and types: `npx vitest run ui` and `npx tsc --noEmit -p ui/tsconfig.json`.
