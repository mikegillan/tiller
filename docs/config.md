# Configuration

Tiller reads JSON config from two files: the project file `<repo>/.tiller/config.json` and the home file `~/.tiller/config.json` (under `TL_HOME` when set). Every key is optional. `tl config [--cwd P]` prints the effective value of every key for a directory and the file it came from, or `default`.

## Resolution

Each key resolves on its own, in this order: an explicit argument on the spawn (where the key has one), then the project file, then the home file, then the built-in default. The project file is the one in the node's directory; for a node in its own git worktree it is the main checkout's. Both files are read on every use, so an edit applies without restarting the daemon.

Keys in the `daemon` group are daemon-wide and come from the home file only. A `daemon` group in a project file is ignored with a warning.

## Bad files and bad keys

A file that does not parse as JSON is skipped as a whole, and the daemon logs one line naming it. Inside a file that parses, every group and the top level are strict: an unknown key (for example a misspelling, or a name that has since been renamed) and a key with an invalid value are each logged once and dropped, and the rest of the file still applies. The warning goes to the daemon's log (or to the terminal, for `tl config`) in the form `tiller: ignoring in <path>: <key>: <reason>`.

## Keys

The layer column says where a key may be set: "project, home" means either file, with the project file winning.

| Key | Type | Default | Layer | Meaning |
|---|---|---|---|---|
| `roles.orchestrator.model` | string | Claude's default | project, home | Model for an orchestrator spawned without one. |
| `roles.orchestrator.effort` | `low`, `medium`, `high`, `xhigh`, `max` | Claude's default | project, home | Effort (passed to claude as `--effort`) for an orchestrator spawned without one. |
| `roles.worker.model` | string | Claude's default | project, home | Model for a worker, or a node with role `none`, spawned without one. |
| `roles.worker.effort` | as above | Claude's default | project, home | Effort for a worker, or a node with role `none`, spawned without one. |
| `approvals.close` | `never`, `done`, `always` | `never` | project, home | Whether an agent's `close` skips the human's approval: always, only when every node in the batch is done, exited or has reported an outcome, or never. |
| `approvals.merge` | boolean | `false` | project, home | When true, an agent's `merge` does not ask the human. |
| `worktrees.isolation` | `none`, `worktree` | `none` | project, home | What a spawn of a Claude worker gets when it does not say. |
| `worktrees.branchPrefix` | string | `tl/` | project, home | A worktree's branch is this prefix followed by the node id. |
| `worktrees.include` | list of gitignore patterns | `.worktreeinclude` | project, home | Gitignored files copied into a new worktree; when absent, the repo's `.worktreeinclude` file is used. |
| `worktrees.mergeStyle` | `merge`, `squash`, `ff-only` | `merge` | project, home | How the merge verb brings a branch into its base. |
| `worktrees.setup` | list of shell commands | `[]` | project, home | Run in a new worktree before the agent starts. |
| `worktrees.teardown` | list of shell commands | `[]` | project, home | Run in a worktree before tiller removes it. |
| `worktrees.protected` | list of branch names | `["main", "master"]` | project, home | Branches a merge never goes into; the remote's default branch counts too. A worker spawned from one without a base gets a task branch. |
| `worktrees.taskBranch` | string containing `{slug}` | `tl/{slug}` | project, home | Name of the task branch made for such a worker; `{slug}` is its title in lower case with dashes. |
| `gate.command` | shell command | none | project, home | A check that must pass before a worker's `succeeded` report is recorded; no gate when unset. |
| `gate.retries` | integer, 0 or more | `2` | project, home | Further failed gate runs allowed before the outcome is recorded as failed. |
| `gate.timeoutMinutes` | positive number | `10` | project, home | Each gate run is stopped after this long. |
| `daemon.resumeOnStart` | boolean | `true` | home | Resume the nodes that were live when the daemon last went away. |
| `daemon.resumeMaxAgeDays` | number | `3` | home | Nodes idle longer than this are not resumed on start. |
| `daemon.sessionsKeepDays` | number | `14` | home | A session directory is deleted this long after its root closed. |
| `daemon.digestAfterMinutes` | number | `10` | home | A window regaining focus after this long with no focused window gets the away digest. |
| `daemon.maxLiveNodes` | integer | `20` | home | An agent's spawn is refused once this many nodes are live. |
| `daemon.maxWorking` | integer | `0` | home | Claude nodes working at once; past it a spawn is queued. 0 means no cap. |
| `notifications.kinds.needsYou` | `banner`, `sound`, `silent` | `sound` | project, home | How a node that needs approval or an answer is notified. |
| `notifications.kinds.errored` | as above | `sound` | project, home | How a turn that ended in an error is notified. |
| `notifications.kinds.done` | as above | `banner` | project, home | How a finished turn is notified. |
| `notifications.kinds.exited` | as above | `banner` | project, home | How an exited node is notified. |
| `notifications.treeDoneSummary` | boolean | `false` | project, home | Replace per-node done and exited notifications with one per tree once all its Claude nodes are done or exited. |
| `notifications.quietHours` | `"HH:MM-HH:MM"` | none | project, home | Local time span, which may cross midnight, during which only needs-you notifications are shown, without sound. |
| `limits.maxDepth` | integer | `3` | project, home | An agent's spawn is refused when the new node would sit more than this many levels below its root. |
| `limits.maxChildren` | integer | `8` | project, home | An agent's spawn is refused when the parent already has this many live children. |
| `limits.stallMinutes` | positive number | `5` | project, home | A working node with no hook event for this long is marked stalled and its parent is told. |
| `limits.maxMessagesPer10Min` | positive integer | `20` | project, home | Messages one node may send another in 10 minutes before further sends are refused as a likely loop. |

For notification levels, `sound` is a banner with a sound and `silent` sends nothing. The behaviour each key controls is described in the topic documents: [agent-roles.md](agent-roles.md) for roles, the gate and the spawn limits, [worktrees.md](worktrees.md) for the worktree keys and merge approval, [sessions.md](sessions.md) for resume, retention and the digest, [messaging.md](messaging.md) for the message limit and the working cap, and [frontends.md](frontends.md) for notifications.

## Example

```json
{
  "roles": { "orchestrator": { "model": "opus", "effort": "high" }, "worker": { "model": "sonnet", "effort": "medium" } },
  "approvals": { "close": "done" },
  "worktrees": { "isolation": "worktree", "setup": ["npm ci"] },
  "gate": { "command": "npm test" },
  "limits": { "stallMinutes": 10 }
}
```
