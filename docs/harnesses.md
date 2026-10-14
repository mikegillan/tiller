# Agent harnesses

Tiller supports **Claude Code** and **Pi** as agent nodes, alongside plain terminals. The daemon,
UI, coordination tools, dependency queue, worktrees and outcome reporting are shared. Claude
Code is not required to run a Pi-only tree.

## Run Pi

Install and authenticate a compatible `pi` CLI on your PATH, then:

```sh
cd /path/to/repo
tl --harness pi
# Choose a model explicitly when desired:
tl new "Pi session" --harness pi --model openai/gpt-5 --prompt "Inspect this repository"
```

The adapter targets **`@earendil-works/pi-coding-agent` 1.2.x**, which has native HTTP MCP
registration and the `agent_settled` extension event. At startup it checks Pi's version and the
APIs it needs. Any other version, including older, newer and prerelease builds, makes the node
shut down instead of running half-connected. Each new Pi minor release therefore stops Pi nodes
at startup until the adapter is updated for it.

Pi uses its own provider credentials and subscriptions; Tiller supplies neither. Cost shows as 0
for providers that report none, such as `claude-bridge` on a subscription.

The spawn dialog also offers Pi. From another agent, use the existing `spawn` MCP tool:

```json
{ "kind": "agent", "harness": "pi", "title": "worker", "cwd": "/path/to/repo", "prompt": "Review the tests" }
```

Generic `agent` children inherit their parent's harness when `harness` is omitted. To mix CLIs,
select the harness explicitly. Legacy `kind: "claude"` remains Claude Code; terminal nodes do
not take a harness.

Tiller's `roles.*.model` and `roles.*.effort` defaults apply only to Claude Code. A Pi node uses
the model from the spawn (or its preset), or else Pi's own default from
`~/.pi/agent/settings.json`. Use model names the selected CLI accepts; `pi --list-models` lists
Pi's. An explicit `effort` becomes Pi's `--thinking`.

## Sessions

`tl send`, `tl read`, `tl transcript`, `tl resume`, `tl restart`, `tl followup`, dependency
launches and outcome reporting work with Pi nodes. Pi conversation files live under
`~/.tiller/sessions/<rootId>/agents/<nodeId>/<sessionId>.jsonl`. They survive node close and
follow session-directory retention, except that directories referenced by registered nodes are
not swept. A follow-up copies the conversation into the new node's own tree, so it no longer
depends on the old tree's retention; the source stays unchanged. The adapter README describes
[what the copy changes](../adapters/pi/README.md#load-it).

Tiller owns Pi's session lifecycle. Use Tiller's controls, not Pi's `/new`, `/resume`, `/fork` or
`/tree` commands, which the adapter cancels. Pi's `/reload` remains available.

## Messages

Messages to a Pi node go through the adapter's inbox bridge, never terminal paste. A message
counts as delivered only when Pi starts a turn whose prompt equals the sent text exactly. An
extension that rewrites input would therefore leave deliveries unconfirmed, and they would
retire after 60 seconds. A retired message is reported as `stalled` and not retryable, because
Pi may still run it late. Inspect the node (for example, for missing credentials) and do not
resend automatically. The adapter README has the [full delivery
protocol](../adapters/pi/README.md#inbox-claim-ack-steer).

## Worktrees and safety

Pi starts directly in the worktree Tiller created; it does not need Claude's `--worktree` flag
or workspace trust database. The `.claude/worktrees/<nodeId>` directory convention is kept so
Tiller's worktree reconciliation works the same way.

Repository-configured setup, teardown and completion-gate commands require explicit trust.
Without a Claude trust record, approve them from a **human terminal outside a Tiller node**:

```sh
tl trust --cwd /path/to/repo
# Remove Tiller's explicit opt-in:
tl untrust --cwd /path/to/repo
```

Trust authorizes the commands in the repository's `.tiller/config.json`, including future
changes, so inspect it before opting in. Trust also covers every directory below the trusted
one: trusting a parent folder trusts every repository under it, including ones cloned there
later. Trust is stored in `~/.tiller/trusted-projects.json`. Existing Claude trust is still
honored; `untrust` removes only Tiller's opt-in, not Claude's record. This trust controls
Tiller's repository commands, not Pi's own project-resource trust or permission policy.

The check that stops `tl trust` and `tl untrust` from running inside a node looks at
`TL_NODE_ID`. It is **advisory, not a sandbox or security boundary**: a same-user agent can unset
the variable or write the trust file directly. Pi's project trust and node-scoped HTTP
authentication do not constrain same-user local code either. To enforce separation, use OS
accounts, a sandbox or container, and narrowly scoped filesystem and credential access.

Pi has `--tools` and `--exclude-tools`, but this adapter does not map Tiller's preset tool
restrictions onto them yet. Claude `permissionMode`, preset `tools`, `disallowedTools` and
`maxTurns`, and session forking are rejected for Pi rather than silently weakened. Prompt-only
presets work; the restricted built-in presets (reviewer, researcher) cannot run on Pi.

## Adapter boundary

`src/daemon/harness.ts` defines `HarnessAdapter`: validation, capabilities, launch command,
working directory, transcript location and optional pre-launch storage preparation.
Claude's adapter wraps the existing launch logic;
Pi's adapter loads `adapters/pi/index.ts`. No runtime Pi package is installed with Tiller.

Coordination stays on the existing interfaces:

- **Tools:** HTTP MCP at `/mcp`, including `spawn`, `send`, `read`, `report_outcome`, and the rest.
- **Identity:** `TL_NODE_ID`, `TL_ENDPOINT`, `TL_TOKEN_FILE`; requests carry `Authorization:
  Bearer <node token>` and `X-TL-Node: <id>`. Never use the human/admin token in an agent adapter.
- **Lifecycle:** authenticated `POST /hook` and `POST /mod-event` feed the shared reducer.
- **Delivery:** `GET /inbox`, `POST /claim`, native prompt submission, then `POST /ack` only on
  observed acceptance. A busy agent leaves ordinary messages unclaimed/withdrawable; a steer
  aborts safely and submits once idle. A fire-and-forget CLI API return is not delivery proof.

To add Codex/OpenCode/another CLI: add its harness identifier and adapter, provide an equivalent
lifecycle/inbox bridge using that CLI's native API, and supply a transcript decoder. Declare
unsupported capabilities and reject unsupported restrictions. Do not duplicate the MCP tools
or implement arbitrary executable configuration as a shortcut.

See [the Pi adapter](../adapters/pi/README.md) for protocol mapping, compatibility and tests.
