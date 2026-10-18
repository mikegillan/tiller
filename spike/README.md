# Manual experiments

These scripts exercise real Claude sessions and local daemons. They are manual experiments, outside Vitest and the worker completion gate; they can incur API usage and create node state or processes. They are not required verification for a structural cleanup.

| Script | Purpose |
| --- | --- |
| `e2e.ts` | Real Claude launch, terminal interaction and lifecycle checks against a separately started daemon. |
| `e2e-orch.ts` | Real orchestrator/worker messaging and delivery receipts against a separately started daemon. |
| `restart-check.ts` | Queued-message survival across a daemon stop and restart; starts and stops its own daemon. |

Read each script's header and implementation before running it. Use a fresh, isolated `TL_HOME` and an unused `TL_PORT`, as described in the script. Do not point these experiments at the live daemon or an existing session home.

For automated verification, use the commands in [AGENTS.md](../AGENTS.md#verification). UI development without live agents is covered by the [mock daemon workflow](../ui/README.md#developing-without-the-daemon).
