> Built differently: the merge and squash styles write their result with `git commit-tree` and then fast-forwards the base's checkout, instead of running `git merge --no-ff` there; the config keys became `worktrees.mergeStyle` and `approvals.merge`; of phase 3 only the per-node diff view was built. See [../worktrees.md](../worktrees.md) for current behaviour.

# orchestr8 — a git worktree per worker node (design)

Written 2026-10-13 by node n-e622b9c4 ("plan: worktrees"). Design only; nothing in the repo was changed. Restored from the orchestrator's context after a reboot cleared /tmp.

Sources: README.md, PLAN.md, `src/daemon/manager.ts`, `launch.ts`, `nodes.ts`, `mcp.ts`, `cli.ts`, `server.ts`, `modapi.ts`, `src/shared/protocol.ts`, `src/shared/prune.ts`, `ui/NodeRow.tsx`, `ui/Bits.tsx`, `src/client/sidebar.ts`, the `src/daemon/config.ts` per-project config, the research notes `features-merged.md` (theme 1) and `features-session-managers.md`, and the Claude Code docs pages `worktrees`, `common-workflows` and `hooks`. Claude Code on this machine is 2.1.296, git is 2.54.0.

The behaviour this design depends on was checked in a throwaway repo under a scratch directory, with real `claude -p` runs. Section 12 lists what that covered and what it did not.

## What the experiments established

1. `claude --worktree <name>` creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`. It takes a `git worktree lock` whose reason reads `claude session <name> (pid N start …)`, and it writes a `CLAUDE_BASE` file into `.git/worktrees/<name>/`. A `-p` run leaves the lock in place after it exits. Unless `.claude/` is ignored, the main checkout then shows `?? .claude/` in `git status`.
2. **The daemon can create the worktree with plain git and Claude will adopt it.** `git worktree add -b o8/n-b .claude/worktrees/n-b feat` and then `claude --worktree n-b`: Claude ran inside that directory on branch `o8/n-b`, the branch name the daemon chose, and locked it. It also enforced isolation: a `Write` to a file in the main checkout was refused with "This session is isolated in the worktree … Edit the worktree copy of this file instead of the shared-checkout path." A marker file the daemon wrote into `.git/worktrees/n-b/` survived the adoption.
3. `claude --resume <sid>` launched from the main checkout puts the session back into that daemon-created worktree. `claude --session-id <new> --worktree <name>` reopens the existing worktree at its current tip, which is the restart case. Both runs had `worktree.baseRef: "head"` set through `--settings`.
4. **If the worktree directory has been deleted, `--resume` keeps going in the main checkout with no isolation.** It prints "continuing in the current directory without worktree isolation. The worktree binding has been cleared." The daemon therefore has to check that the worktree exists before it resumes a node.
5. Launching `claude --worktree c1` from inside another worktree, p1, put c1 at the main checkout's `.claude/worktrees/c1`, not nested inside p1. Its base was p1's HEAD because baseRef was `head`.
6. Plain git behaviour: `git worktree remove` refuses a locked tree, and refuses a tree with modified or untracked (but not ignored) files; a tree whose only extra files were ignored, such as `.env`, was removed without complaint. `git branch -d` refuses a branch that is checked out in a worktree. After `rm -rf` on a worktree, `git worktree list` marks it `prunable` and `git worktree prune` clears the entry, but the branch stays. `git clean -dx` in the main checkout skips worktrees; only `git clean -ffdx` would delete them.
7. `git ls-files --others --ignored --exclude-from=.worktreeinclude --directory`, intersected with `git ls-files --others --ignored --exclude-standard --directory`, gives exactly the set "matches the include file and is gitignored". Same semantics as Claude's own `.worktreeinclude`.
8. In this repo, `vitest.config.ts` extends `configDefaults.exclude`, which is only node_modules and .git, so `npm test` in the main checkout would also collect test files from inside `.claude/worktrees/*/` without an exclude.

## 1. Goals and non-goals

Goal: a worker can be spawned into its own git worktree and branch, so parallel workers never edit the same checkout. The human and the orchestrator can see what each worker changed and bring it back into the base branch, and nothing is left behind afterwards.

The owner's "clean" made concrete, each testable:

- **No orphans.** Every worktree under `<repo>/.claude/worktrees/` that carries an orchestr8 marker for this daemon home belongs to a node in the registry. Daemon start finds and reports the ones that do not.
- **No stale branches.** An `o8/<id>` branch is deleted when its node's work is merged or discarded. One is kept only when the human chose "keep branch", and `o8 worktrees` lists every kept branch.
- **Predictable place.** A node's worktree is always `<main checkout>/.claude/worktrees/<nodeId>` on branch `o8/<nodeId>`.
- **Lifecycle parity.** Spawn, close, prune, restart, resume, daemon shutdown, crash, reboot and manual deletion each have one defined effect on the worktree and the branch (section 5).
- **Clear merge-back.** One supported path in the first slice: the branch is an ordinary git branch, and close recognises when it has been merged. A daemon `merge` verb follows in phase 2.
- **Nothing surprising in the main checkout.** No untracked `.claude/` entry, no edits to tracked files such as `.gitignore`, and no worker edits leaking into the main checkout (Claude enforces this). The main checkout's files change only when the human or orchestrator explicitly merges.
- **Never lose work silently.** No path removes a worktree with uncommitted changes, or deletes a branch with unmerged commits, unless the caller explicitly discards.

Non-goals: phone integration and permission changes, a diff viewer (theme 3, which this unlocks), PR and CI panels, non-git version control, isolation for terminal nodes in the first slice, best-of-N.

## 2. Disk layout and naming

**Inside the repo, at `<main checkout>/.claude/worktrees/<nodeId>`, on branch `o8/<nodeId>`.**

- The path is Claude Code's own convention and the only place `claude --worktree <name>` will adopt an existing worktree from; adopting is what turns on Claude's isolation checks.
- The main checkout's root is resolved from any cwd as the first `worktree` line of `git worktree list --porcelain`. Every worktree, nested ones included, lands flat under that one directory.
- The branch is `o8/<nodeId>`; the node id already has the form `n-<8 hex>`. A title slug would go stale on rename; show the title next to the branch in the UI instead.
- **Hiding it:** the daemon appends `/.claude/worktrees/` to `$(git rev-parse --git-common-dir)/info/exclude` the first time it creates a worktree in a repo. ripgrep (and so Claude's Grep and Glob) honours it; test runners and other globbing tools do not, so each repo excludes `.claude/worktrees/**` in those tools.
- **Mapping a path to a node:** the basename is the node id. The daemon also writes `.git/worktrees/<nodeId>/o8-node` containing `{"home", "nodeId", "base", "baseSha"}`. Reconciliation uses `home` so a test daemon with a temporary O8_HOME never treats the real daemon's worktrees as orphans. Claude's own worktrees have no marker and are never touched.

Alternatives rejected: `~/.orchestr8/worktrees/…` (Claude will not adopt it; `EnterWorktree` outside `.claude/worktrees/` asks for approval every time, so no enforcement) and a sibling directory (same loss, least predictable).

**Base ref:** the HEAD of the checkout the spawn's `cwd` points at, at spawn time. The daemon records the symbolic name (`base`) and `baseSha`. The node's generated settings set `worktree.baseRef: "head"` so Claude never resets an adopted worktree.

## 3. The spawn surface

**MCP `spawn`** gains `isolation: "none" | "worktree"`, default `"none"`. With `"worktree"`, `kind` must be `claude`; `cwd` must be inside a git work tree with at least one commit; any directory in the main checkout means "branch from the main checkout's HEAD", and the caller's own worktree path means "branch from my HEAD". The reply gains `worktree: { path, branch, base }`. `requestId` replay keeps working.

**The `o8` CLI** adds `o8 spawn … --worktree`, `o8 new <title> --worktree`, `o8 worktrees` (node worktrees, orphans, kept branches), `o8 worktrees clean [--force]`, `o8 kill <id> --keep-branch | --discard`, and `o8 merge <id>` in phase 2.

**WebSocket:** `spawn` gains `isolation?`; `close` gains `worktree?: 'keep' | 'discard'`; phase 2 adds `{ t: 'merge'; id }`.

**What cwd means.** `NodeRecord.cwd` becomes the worktree path. The PTY starts in `worktree.repo` (the main checkout) with `--worktree <nodeId>` added; that is the launch shape for which resume and restart re-enter correctly.

**Who creates the worktree:** the daemon, with plain git; Claude adopts it. Reasons: the daemon chooses the branch name; the base can be any ref; the include copy and setup finish before the agent starts; the daemon writes its own marker. A `WorktreeCreate` hook was rejected because it fires for the node's own subagent worktrees too and Claude refuses hook-created directories inside a repository.

**Children share the parent's worktree by default.** A spawn with `isolation` omitted runs in whatever `cwd` it is given. A child spawned with `isolation: "worktree"` and the parent's worktree as cwd gets a new tree branched from the parent's HEAD, with `base` set to the parent's branch, and merges back into the parent's branch.

## 4. Making a fresh worktree usable

**Gitignored files: reuse `.worktreeinclude` at the main checkout root.** Same semantics as Claude's own; the daemon does the copy with `cp -cR` on macOS (APFS clonefile, copy-on-write) and a plain recursive copy elsewhere; symlinks copied as links.

**Setup and teardown commands** live in `.orchestr8/config.json` (project, then home):

```json
{ "worktrees": { "setup": ["npm ci --prefer-offline"], "teardown": ["docker compose down"] } }
```

Read from the main checkout root. Run with `sh -c` in the worktree with `O8_NODE_ID`, `O8_WORKTREE`, `O8_REPO`, `O8_BASE` and the daemon's login PATH. Output to the node's dir as `setup.log`; 10-minute timeout per command.

- Setup runs after the include copy and before Claude launches; the node shows `activity: "setting up worktree: npm ci"` with state unknown. On failure the node shows exited and errored with the activity pointing at setup.log; the worktree is kept; restart retries setup; close removes everything.
- Teardown runs before removal on every removal path, best effort: a failure is logged but does not block removal.
- Security: commands run only when `trustPolicy(repo)` returns `auto`; otherwise skipped and said so on the node.

### 4.1 Config keys

All under `worktrees` in `.orchestr8/config.json`, precedence spawn argument, project file, home file, defaults; for a worktree node the project file is read from the main checkout root. Keys: `isolation` ("none" default; workers only), `branchPrefix` ("o8/"), `include` (patterns; absent falls back to `.worktreeinclude`), `setup` and `teardown` (project list replaces the home list), `merge` ("merge" no-ff default, "squash", "ff-only"), `mergeWithoutConfirm` (false; no spawn override). Deliberately no worktree root key.

Spawn becomes asynchronous for worktree nodes; all git calls go through `execFile` with a timeout.

## 5. Lifecycle table

"Safe" means: the worktree is clean, the branch is merged into its base, and no live node other than the owner has its cwd inside the tree.

| Event | Worktree | Branch | Node shows |
|---|---|---|---|
| **spawn** | exclude line if missing; `git worktree add -b o8/<id> <repo>/.claude/worktrees/<id> <baseSha>`; marker; immediate registry flush; include copy; setup; `claude --worktree <id>`. Any git failure removes worktree and branch and discards the record. | created at baseSha | setting up…, then normal; branch in the row |
| **close** (default) | check safe before killing (a refused close leaves the node running); if safe: kill, check again, teardown, unlock a `claude session <id>` lock, `git worktree remove`. If the second check fails: keep and mark "worktree kept: changed during close". | `-d` (or `-D` after the daemon's own merged check) | removed; refusal names dirty count, unmerged count, sharing nodes, offers keep or discard |
| **close, keep** | only check that no other node uses the tree; uncommitted changes committed as `WIP: orchestr8 node "<title>" (<id>)` with `git add -A && git commit --no-verify`; then removed | kept, listed by `o8 worktrees` | removed |
| **close, discard** | teardown, unlock, `git worktree remove --force` | `-D` | removed; agents only via the close confirm, whose text says what is destroyed |
| **prune** | safe ones removed as close; others skipped in place | as close | reply lists kept nodes; never discards |
| **restart** | untouched; `--session-id <new> --worktree <id>`; setup not re-run unless it failed | untouched | as today |
| **resume** | refuse with "worktree missing" if the directory is gone or unlisted; else `--resume <sid>` from the main checkout | untouched | as today, or missing |
| **daemon shutdown / crash / reboot** | left in place; stale lock with a dead pid; a crash between add and flush leaves a marker with no record, reported as an orphan | kept | exited and resumable |
| **human rm -rf / git worktree remove** | detected at daemon start and on refresh; `git worktree prune` | kept (may hold the only copy) | worktree missing; resume refused; close deletes the branch if merged, else keeps it and says so; phase 3 may offer recreate |
| **human deletes the branch** | impossible while the worktree exists | — | — |
| **/exit inside the node** | PTY exits; if Claude's exit prompt removed the tree this becomes the missing row | whatever Claude did | exited, possibly missing |

## 6. Cleanliness guarantees

**Orphan detection on daemon start.** `~/.orchestr8/worktree-repos.json` lists main-checkout roots the daemon has created worktrees in. For each existing repo: `git worktree prune`; parse `git worktree list --porcelain`; each entry under `.claude/worktrees/` with an `o8-node` marker whose `home` is this daemon's: known node fine, else orphan; registry nodes with `worktree` set but no entry: missing; `o8/n-*` branches with neither a worktree nor a node: kept branches. An orphan that is clean with no commits beyond `baseSha` is removed automatically (after unlocking a dead `claude session` lock); everything else is listed by `o8 worktrees` and in a status-bar notice.

**Definitions.** Dirty: `git status --porcelain` prints anything (ignored files do not count). Merged: `git merge-base --is-ancestor o8/<id> <base>`, or no commits beyond `baseSha`, or every commit in `git cherry <base> o8/<id>` is `-`; after a phase-2 merge `mergedAt` on the node counts too. Locked by someone else: any lock reason other than `claude session <id>` with a dead pid; never removed.

**Force path:** close discard, `o8 kill --discard`, `o8 worktrees clean --force`; each prints the commits (`git log --oneline base..branch`) and dirty files that will go; still runs teardown; still refuses while another live node's cwd is inside.

**Branch deletion:** delete when merged; `-D` only on discard; otherwise keep only when asked, never silently.

## 7. Merge-back

Options: merge into base (no-ff, squash, ff-only); rebase (done by the worker in its own tree on instruction); open a PR (human, phase 3); cherry-pick (not offered; detected via `git cherry`); discard (close discard).

**Phase 1:** no daemon verb; merge with git, then close sees merged and removes.

**Phase 2, `merge`:**
- Preconditions: worktree clean (worker committed), node not working.
- Conflict check without touching files: `git merge-tree --write-tree --name-only <base> o8/<id>`; exit 1 returns `{ ok: false, conflicts: [paths] }` and nothing changes; the reply suggests sending the worker a rebase instruction.
- Applying: if `base` is checked out in the main checkout or a parent's worktree, that checkout must be clean, else refuse "main checkout has uncommitted changes"; then `git merge --no-ff --no-edit o8/<id>` there. If `base` is not checked out anywhere: `git commit-tree` on the merge-tree result plus `git update-ref refs/heads/<base> <new> <old>` (atomic; no working tree touched).
- Afterwards: set `mergedAt`; row shows "merged"; `o8 merge --close` merges then closes.
- Who runs it: the human (Merge button on the row and the exited card, `o8 merge <id>`); the orchestrator through a `merge` MCP tool scoped to descendants behind the same human confirm as close, with `worktrees.mergeWithoutConfirm`; never the worker on its own branch.

## 8. What the UI, sidebar and agents see

`GitState = { branch, base, ahead, behind, dirty, missing?, mergedAt? }` per worktree node: `ahead`/`behind` from `git rev-list --left-right --count <base>...o8/<id>`; `dirty` from `git status --porcelain` line count. Refresh on worktree creation, Stop and `turn.complete`, debounced 3 s on PostToolUse for Edit, Write and Bash, PTY exit, before close or merge, daemon start. Lives on `NodeStatus` (not persisted); node re-emitted on change.

- Web UI: `NodeMeta` gains a leading `⎇ o8/n-3f2a ↑3 ●2`; a has-changes marker when `ahead + dirty > 0` and the node is done or exited; "merged" once `mergedAt` is set; `missing` in the warning colour; close dialog gains Keep branch and Discard.
- Mux sidebar: prepend `⎇↑3●2` to the meta line, dropped first under width pressure.
- list_nodes: `worktree: { path, branch, base, ahead, behind, dirty, missing, merged }`; text tree appends `⎇ o8/n-3f2a ↑3 dirty`.
- /tree ChildView: `branch?`, `ahead?`, `dirty?`.

## 9. Role prompt changes

`ensurePrompts` never overwrites an edited role file, so the mechanics go in the generated preamble in `systemPrompt()`, added only when the node owns or shares a worktree:

> You are working in a git worktree at `<path>` on branch `o8/<id>`, branched from `<base>` at `<sha7>`. The main checkout at `<repo>` belongs to the user and to other nodes. Never edit files there, even if your brief names paths under it: use the same repo-relative path inside your worktree. Commit your work on your branch with clear messages before you report success, and leave `git status` clean. Do not merge, push, switch branches or rebase unless asked; your parent integrates your branch.

A sharing child gets "You share the worktree of node X; coordinate before editing files it is editing."

The **orchestrator default prompt** gains, for new installs and as a README note for existing ones:

> Spawn with isolation "worktree" when workers edit files in parallel; leave it off for read-only or strictly sequential work, or to let a follow-up worker share a tree. Write briefs with repo-relative paths. When a worker reports success, review with `git diff <base>...<branch>` or `read`, then merge (or ask the user to). On a conflict, send the worker a rebase instruction rather than resolving it yourself. Close merged workers.

The worker default prompt needs nothing new.

## 10. Phased build order

**Phase 1 (built):** isolation on spawn and CLI; `NodeRecord.worktree`; daemon-created worktree, marker, exclude line, include copy, `baseRef: "head"`; launch with `--worktree`; close and prune safety with keep and discard; resume guard; startup reconciliation and `o8 worktrees`; preamble; static branch in rows and list_nodes; vitest exclude; merge-back is "merge with git, then close".

**Phase 2:** live GitState in rows, /tree and list_nodes; has-changes and merged markers; `merge` via merge-tree through UI, CLI and MCP with confirm; setup and teardown from config gated on trust; the orchestrator prompt text.

**Phase 3:** `o8 pr <id>` (human only); recreate a missing worktree from its kept branch; optional `base` ref on spawn; terminal-node isolation; the per-node diff view reading `base...branch`.

## 11. Decisions (all taken as recommended)

D1 in-repo `.claude/worktrees/<id>`; D2 opt-in per spawn, config default later; D3 base is HEAD of the spawn cwd's checkout; D4 keep makes a WIP commit then removes the directory; D5 no-ff merge commits, `worktrees.merge` to switch; D6 orchestrator merges behind confirm, `worktrees.mergeWithoutConfirm` to skip.

## 12. Risks and open questions

- Verified by experiment: adoption and enforcement; resume re-entry and restart reopen; deleted tree makes resume unisolated; nested launch lands flat; lock format; git refusal and prune behaviour; include intersection; vitest picks up worktree tests.
- Not verified interactively: trust must be recorded for the repo itself (confirmed during phase 1: an ancestor's trust did not count); what Claude does to an adopted tree on SIGHUP (assumed: nothing but a stale lock); whether `/exit` shows the keep-or-remove prompt; whether `"fresh"` could reset an adopted tree (avoided via `baseRef: "head"` in the node settings).
- Tools that glob the main checkout see `.claude/worktrees/*`; per-repo exclude needed.
- Planted git config: a worker can reach `.git/config` through Bash; the daemon could pass `-c filter.<name>.smudge=` overrides like Claude does; undecided.
- Disk and time: APFS clones are cheap; `npm ci` per worker is not; sparse paths unconfirmed.
- Squash merges done outside orchestr8 with more than one commit are not detected as merged; close refuses and the human uses discard.
- Claude's periodic sweep keeps worktrees it did not create (documented, not observed over time).
- A sharing child whose owner closes: close refuses while the child is live; an exited sharing child's resume should report "worktree missing".
