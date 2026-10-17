# Codex account quota integration

`adapters/codex/bridge.ts` reads account quotas once when the native UI attaches
and starts inbox polling. The read runs without blocking startup. Account quota
notifications are handled before thread filtering because they are account-scoped.
Both paths publish through the bridge's shutdown-deadline wrapper; usage transport
failures never stop the agent. A completed background read is not published after
shutdown begins.

`readCodexUsage` issues exactly one read on the existing RPC connection, with a
2-second deadline. Invoke it without `await` so it never blocks startup. It never
starts an app-server, thread or turn, and returns `{ usageUnavailable: true }` on
RPC failure, timeout, or a response without reportable quota windows. Publishing
that measure retains prior snapshots and marks them stale/unavailable. Publishing
must also be caught separately so HTTP telemetry failures cannot call the bridge's
fatal handler. There is no automatic retry or recurring quota probe.

`CodexUsage.measure(payload)` returns `{ usageReports }` for real quota windows,
or `{ usageUnavailable: true }` for unavailable data. `reports(payload)` remains
available for normalization alone. Keep one instance for the bridge lifetime so
sparse updates preserve unrelated pools and account identity; a reported account
switch clears prior-account pool state. Neither method fabricates model-specific
quotas or converts token counts, credits or dollar balances into quota use.

The manager derives tool identity from the authenticated node, including Codex.
The native generated protocol was inspected locally with:

```sh
codex app-server generate-ts --out /tmp/tiller-usage-codex-protocol
```

Relevant generated contracts: `v2/GetAccountRateLimitsResponse.ts`,
`v2/AccountRateLimitsUpdatedNotification.ts`, `v2/RateLimitSnapshot.ts`,
`v2/RateLimitWindow.ts`, and `v2/SpendControlLimitSnapshot.ts`. Read responses
support `rateLimitsByLimitId`, fallback `rateLimits`, and optional `accountId`.
Rolling updates are sparse and omit account metadata. `normalModelSlug` describes
a quota alias and does not prove a model-exclusive quota. Unix reset timestamps
are seconds. Credits and dollar balances are not quota percentages.

Discovery automatically checks the daemon launch PATH even with no live nodes.
Opening the overview or choosing Rescan runs at most three `--version` probes,
concurrently, with 1.5-second deadlines and 16 KiB output limits. Results are
cached for one minute and concurrent requests coalesce. Failed probes remain
detected tools with an explicit version-check failure. Authentication is unknown until a quota report arrives. Pi does not
expose provider account quotas through the current adapter. Unknown accounts are
isolated by reporting node; identified account/provider/pool reports may be shared
only between nodes that actually reported that identity. Reports survive node
exit/removal and websocket reconnects for the daemon lifetime, but not daemon
restart. No background provider polling or inference is performed.

Each normalized window carries `windowId` and `observedAt`. Sparse notifications
keep the original observation time on cached windows, so the daemon can merge a
shared account's reports without regressing a newer reading from another agent.
Nullable IDs resolve to a known mirror pool or the single unambiguous known pool.
Sparse null spend metadata is retained; a full-read null emits timestamped
`removedWindows` entries so the registry removes that window and rejects older
cached copies. Read failures remain scoped to the reporting node; healthy nodes
sharing an identified account retain their available snapshot.

Removed nodes lose their source bindings. At most one newest unidentified closed
snapshot per tool is retained; unidentified accounts are never combined. Known
accounts retain their pools, and context-only measures do not broadcast snapshots.
Expired reset windows display “reset passed · awaiting report” with no old percent.

Claude Code 2.1.302 was inspected locally (read-only native binary): its mod
`session.measure` normalization currently emits `five_hour`, `seven_day`, and
`spend_limit` for gateway usage. Native Opus/Sonnet windows exist elsewhere but are
not emitted by that conversion. If explicit `seven_day_opus` / `seven_day_sonnet`
windows arrive, Tiller labels their family pools and filters unrelated families
from the selected-agent bar. It does not infer exact-model quotas from model names.
