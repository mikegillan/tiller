# Codex account quota integration

This branch contains the normalizer only because the Codex bridge is not in its
baseline. Integrate these hooks in `adapters/codex/bridge.ts` after bringing this
branch onto the Codex/profile integration baseline:

```ts
import { CodexUsage } from './usage.js';
// On CodexBridge:
private readonly accountUsage = new CodexUsage();
```

After `initialize` / `initialized`, perform one read on the existing RPC connection.
Do not start an extra app-server, thread, or turn. It must not block bridge startup
or fail the bridge if the account does not support rate-limit reads:

```ts
void this.rpc.request('account/rateLimits/read', {})
  .then((v) => this.client.modEvent('session.measure', {
    usageReports: this.accountUsage.reports(v),
  }))
  .catch(() => {}); // unavailable quotas do not prevent an agent from running
```

In the existing notification handler (before turn-specific branches):

```ts
} else if (p.method === 'account/rateLimits/updated') {
  await this.client.modEvent('session.measure', {
    usageReports: this.accountUsage.reports(v),
  });
```

The manager derives tool identity from the authenticated node. It accepts `codex`
when the integration branch adds it to `Harness`, with no other registry edits.
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

Discovery is local filesystem evidence, refreshed at most once per minute when
requested. Authentication is unknown until a quota report arrives. Pi does not
expose provider account quotas through the current adapter. Unknown accounts are
isolated by reporting node; identified account/provider/pool reports may be shared
only between nodes that actually reported that identity. Reports survive node
exit/removal and websocket reconnects for the daemon lifetime, but not daemon
restart. No background provider polling or inference is performed.
