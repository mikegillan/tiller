# Agent harnesses

Tiller supports **Claude Code** and **Pi** as agent nodes, alongside plain terminals. The daemon,
UI, orchestration tools, dependency queue, worktrees and outcome reporting are shared. Claude
Code is not required to run a Pi-only tree.

## Run Pi

Install and authenticate a compatible `pi` CLI on your PATH, then:

```sh
cd /path/to/repo
tl --harness pi
# Choose a model explicitly when desired:
tl new "Pi session" --harness pi --model openai/gpt-5 --prompt "Inspect this repository"
```

Compatibility target: **`@earendil-works/pi-coding-agent` 1.2.x**, which has native HTTP MCP
registration and the `agent_settled` extension event. Other Pi distributions/older versions
are not interchangeable automatically; the bridge checks the public host `VERSION` for stable
1.2.x and required APIs, then shuts down an incompatible/unknown node. Registering an event handler
alone cannot prove the build emits the required events. Pi uses its own provider credentials/subscriptions; Tiller supplies neither.

The spawn dialog also offers Pi. From another agent, use the existing `spawn` MCP tool:

```json
{ "kind": "agent", "harness": "pi", "title": "worker", "cwd": "/path/to/repo", "prompt": "Review the tests" }
```

Generic `agent` children inherit their parent's harness when `harness` is omitted. To mix CLIs,
select the harness explicitly. Legacy `kind: "claude"` remains Claude Code; terminal nodes do
not take a harness. The existing `roles.*.model` and `roles.*.effort` defaults apply only to
Claude Code. Pi keeps its own model/thinking defaults unless a preset or explicit spawn
argument overrides them. Use model names accepted by the selected CLI (`pi --list-models`
lists Pi's choices). Pi maps explicit `effort` to `--thinking`.

`tl send`, `tl read`, `tl transcript`, `tl resume`, `tl restart`, `tl followup`, dependency
launches and outcome reporting work with Pi nodes. Pi conversation files live under
`~/.tiller/sessions/<rootId>/agents/<nodeId>/<sessionId>.jsonl`, survive node close, and are
subject to session-directory retention. Follow-up copies the conversation (and recorded prior
sessions still present) into the new node's tree before launch; closing it does not leave its
archive dependent on an older tree's retention clock. The source archive stays unchanged.
Tiller updates the copied session header's cwd to the selected workspace, including the main
checkout fallback for a removed worktree, because Pi resumes in its header cwd. Session IDs
and cumulative-cost continuity are preserved. Existing cross-tree live records are adopted on
next launch; transcripts already swept cannot be recovered. Directories referenced by
registered nodes are not swept. Tiller owns Pi's session lifecycle: use its controls, not Pi's `/new`, `/resume`, `/fork`
or `/tree` commands. Pi `/reload` remains available.

## Worktrees and safety

Pi starts directly in the worktree Tiller created; it does not need Claude's `--worktree` flag
or workspace trust database. The existing `.claude/worktrees/<nodeId>` directory convention is
retained for compatibility with Tiller's worktree reconciliation.

Repository-configured setup/teardown and completion-gate commands require explicit trust.
Without a Claude trust record, approve them from a **human terminal outside a Tiller node**:

```sh
tl trust --cwd /path/to/repo
# Remove Tiller's explicit opt-in:
tl untrust --cwd /path/to/repo
```

Trust authorizes commands in the repository's `.tiller/config.json`, including future changes;
inspect it before opting in. Trust applies to descendants and is stored in
`~/.tiller/trusted-projects.json`. Existing Claude trust is still honored for backward
compatibility; `untrust` removes only Tiller's opt-in, not that separate record. This trust
controls Tiller's repo commands, not Pi's own project-resource trust or permission policy.

The `tl trust`/`tl untrust` `TL_NODE_ID` check is **advisory UX, not a sandbox or security boundary**.
A same-user agent can unset the variable or write the trust file directly. To enforce separation,
use OS accounts, a sandbox/container, and narrowly scoped filesystem/credential access.

Pi does **not** implement Claude `permissionMode`, preset `tools`/`disallowedTools`/`maxTurns`,
or Tiller session forking. These requests are rejected rather than silently weakened. Prompt-
only presets work; built-in restricted reviewer/researcher presets may require replacement.

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

Pi requires its native inbox bridge, so messages are queued there even before its first poll;
Tiller never tries Claude-composer terminal-paste heuristics on a Pi node. Claimed messages
without confirmed acceptance retire after 60 seconds as `stalled`, nonretryable, rather than being
resent or falsely delivered. `/unconfirmed` releases the queue even while inbox TTL is renewed.
Inspect the node (for example, missing credentials) and **do not resend automatically**: the old
prompt may still run late. Reload/restart never replays an inherited native claim. Pi MCP server
names are fresh and node-scoped to avoid silent overrides by file-configured `tiller` entries.

To add Codex/OpenCode/another CLI: add its harness identifier and adapter, provide an equivalent
lifecycle/inbox bridge using that CLI's native API, and supply a transcript decoder. Declare
unsupported capabilities and reject unsupported restrictions. Do not duplicate the MCP tools
or implement arbitrary executable configuration as a shortcut.

See [the Pi adapter](../adapters/pi/README.md) for protocol mapping, compatibility and tests.
