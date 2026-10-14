> Built differently: retention is the home-only key `daemon.sessionsKeepDays`; the handoff instruction is in the preamble rather than the role prompt, and only a restart (not a fresh root launch) is pointed at handoff.md; `tl sessions clean` takes no root id; and the directory also holds an event log that feeds an away digest, which this draft did not plan. See [../sessions.md](../sessions.md) for current behaviour.

# Session artifacts: design draft (2026-10-13)

Problem: orchestrators and workers keep notes, briefs, audits and design docs in Claude Code's per-session scratchpad,
`/private/tmp/claude-<uid>/<project-slug>/<sessionId>/scratchpad`. macOS clears /private/tmp on reboot, and on 2026-10-13
a reboot deleted a design doc and a feature list mid-project. There is a second, quieter loss: `tl restart` mints a new
session id (manager.ts restart, previousSessions), so a restarted orchestrator gets a new, empty scratchpad even without a
reboot, and each worker has its own scratchpad that its parent never sees unless the brief names the path.

## 1. Kinds of artifacts and their readers

- Plan and handoff notes (the current goal, decisions made, what is in flight, next steps). Read by the same
  orchestrator after restart, reload or reboot. Lives as long as the session tree; not worth committing.
- Briefs and worker results (long briefs, audit reports, research notes). Read by the worker it was written for, by the
  parent that integrates it, and occasionally by the human. Lives as long as the tree, then a short grace period.
- Design documents and decisions the project will keep living with (for example worktrees-plan.md). Read by a later
  orchestrator on the same repo and by the human. These deserve to be committed, under `docs/`, once the owner accepts them.
- Throwaway intermediates (test output, scripts, downloaded files). Read by the node that made them only. These stay
  in Claude Code's own scratchpad, and losing them on reboot is fine.
- Small durable facts (owner preferences, priorities). Already handled by the memory directory; not a home for documents.

## 2. Where they live

Options considered:

- Redirect Claude Code's scratchpad. The docs (code.claude.com/docs/en/claude-directory.md, "Session scratchpad
  directory", and env-vars.md) say the only control is `CLAUDE_CODE_TMPDIR`, which replaces `/tmp` as the base of
  `claude-<uid>/<project>/<session-id>/scratchpad`; there is no settings.json key, and Claude deletes the scratchpad
  with its transcript after `cleanupPeriodDays` (default 30). The docs also say the scratchpad exists only for claude.ai
  sign-in sessions. The variable moves Claude's whole temp tree, not just the scratchpad: background task output, sandbox
  TMPDIR and socket paths (the binary warns about socket path length under it), so a persistent location would also
  accumulate every task log. The path stays keyed by session id, so restart would still lose the notes. Rejected:
  leave Claude's scratchpad as the ephemeral tier it is.
- Repo-local ignored directory, `.tiller/scratch/`. Survives reboot and is easy to find, but every worker worktree
  has its own checkout, so workers would write into their worktree copy and the files would vanish when the worktree is
  removed; it also pollutes the user's repo and needs an ignore rule in each repo. Rejected.
- Plain `docs/` in the repo. Right for accepted designs, wrong for work in progress (workers in worktrees again see
  their own copy, and half-finished notes would show in `git status`). Kept, but only as the promotion target.
- Daemon-owned per-tree directory. Recommended.

Recommended layout, all under the daemon home (`~/.tiller`, or `TL_HOME`):

    ~/.tiller/sessions/<rootId>/            one per orchestrator tree, 0700, created when the root is spawned
    ~/.tiller/sessions/<rootId>/handoff.md  the orchestrator's living plan and handoff note (conventional name)
    ~/.tiller/sessions/<rootId>/meta.json   { rootId, title, cwd, createdAt, closedAt? } so the files outlive the registry
    ~/.tiller/sessions/<rootId>/<anything>.md  briefs, audits, research, design drafts; flat, named by the writer

Every node in the tree gets `TL_SESSION_DIR=<that path>` in nodeEnv (launch.ts), computed by walking parentId to the
root, and the preamble in systemPrompt gets one sentence: "Your tree's shared, persistent artifact directory is
$TL_SESSION_DIR (<path>): keep plans, briefs, reports and design drafts there, not in the scratchpad; designs worth
keeping go to docs/ in the repo once accepted." The path is absolute and outside every worktree, so a worker in a
worktree and its parent see the same files. Keying by rootId, not session id, is what makes restart safe.
Workers need `--add-dir` (or a permissions rule in the node's settings.json) for the directory so writes there do not
prompt; writeNodeFiles already writes per-node settings, so this is one more entry.

## 3. Lifecycle and garbage collection

- Created on spawn of a root (or lazily on the first launch of a root that lacks one, which covers existing nodes).
- Kept across restart, reload, resume, daemon crash and reboot: it is in the home directory, not /tmp.
- When the root is closed (force close or prune), the daemon writes `closedAt` into meta.json and keeps the directory
  for 14 days, then deletes it. Closing a worker deletes nothing; its files belong to the tree.
- Age sweep on daemon start and once a day: delete a directory whose root is gone from the registry and whose
  closedAt (or, failing that, the newest file mtime) is older than 14 days. A directory whose root is still registered
  is never swept, however old. Config key `sessionsKeepDays` (home file only, like resumeMaxAgeDays), default 14.
- No size cap in the first slice. These are text files written by agents; `tl sessions` shows sizes so a runaway is
  visible. Revisit if a tree ever exceeds, say, 50 MB.
- `tl sessions` lists each directory: root id, title, cwd, live or closed-since, file count, size.
  `tl sessions clean` deletes the closed ones now; `tl sessions clean <rootId>` deletes one (refused for a live root
  without `--force`). `tl sessions path [<rootId>]` prints the path, for `cd` or an editor.

Survives a reboot: everything under ~/.tiller/sessions. Deliberately ephemeral: Claude's scratchpad under
/private/tmp (intermediates only) and a worktree's untracked files.

## 4. How a restarted orchestrator finds its notes

The preamble line above is the main mechanism: it is part of the appended system prompt, so it survives /clear,
restart and resume. The orchestrator role prompt (DEFAULT_PROMPTS.orchestrator) gets one more sentence: "Keep
$TL_SESSION_DIR/handoff.md current: the goal, decisions, what each live worker is doing, and next steps; read it first
when you start with no context." On `restart` and on a fresh launch of a root whose handoff.md exists, the daemon puts
one line in the first prompt: "Read <path>/handoff.md before anything else; it is your own handoff note." It should
point at the file, not paste its contents, so a large note does not crowd the first turn and the file stays the single
source. A resume (same session, context intact) gets nothing extra.

## 5. Smallest first slice

1. sessionDir(rootId) helper in home.ts, mkdir on launch of any node in a tree, `TL_SESSION_DIR` in nodeEnv, the
   preamble sentence, the role-prompt sentence, and the settings permission for the directory. About 30 lines plus a
   test that a worker's env names its root's directory. Small.
2. The handoff pointer in restart's first prompt. About 10 lines. Small.
3. meta.json, closedAt on root close, the 14-day sweep on start, and `tl sessions` / `clean`. About 80 lines plus a
   sweep test. Small to medium; can follow a few days later, since without it directories only accumulate slowly.

Promotion to `docs/` stays a manual step the orchestrator proposes to the human; no automation.

## Owner decisions

- Retention after the root closes: 14 days (recommended) or delete at once on close.
- Restart prompt: point at handoff.md automatically (recommended) or leave it to the role prompt alone.
- Location: daemon home (recommended) versus a repo-local ignored directory, if the owner would rather see the files
  beside the code.
