<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="tiller" width="320">
  </picture>
</p>

# tiller

Tiller is a local daemon that runs several agent CLI sessions (Claude Code or Pi) as child processes, called nodes, and lets one of them, the orchestrator, spawn, message and watch the others. A root node (one with no parent) is an orchestrator; a node it spawns is a worker. The main front end is a native macOS app built with Tauri; the same UI runs in a browser. A Claude Code mod or Pi extension loaded into each agent node delivers messages and reports lifecycle events.

## Requirements

- macOS with the Xcode Command Line Tools (`xcode-select --install`); the native app is built with Tauri, which needs them.
- Node 24 and your chosen agent CLI on your PATH: `claude` (Claude Code), or compatible `pi` (`@earendil-works/pi-coding-agent` 1.2.x). See [docs/harnesses.md](docs/harnesses.md) for Pi setup and limitations.
- Rust, installed through Homebrew's rustup:

      brew install rustup
      /opt/homebrew/opt/rustup/bin/rustup-init -y

  Homebrew's rustup is keg-only, so `cargo` is not on your PATH by default. `bin/tl-app` adds `/opt/homebrew/opt/rustup/bin` itself; to run `npm run app:build` or `cargo` from your own shell, add that directory to your PATH (for example `export PATH=/opt/homebrew/opt/rustup/bin:$PATH` in `~/.zshrc`).
- Optional: `terminal-notifier` (`brew install terminal-notifier`), so clicking a macOS notification selects the node.

## Install

    npm install && npm link
    npm run app:build

`npm install && npm link` puts `tl` (the client), `tld` (the daemon in the foreground) and `tl-app` (the native app) on your PATH. `npm run app:build` builds the browser UI and then the unsigned app, `src-tauri/target/release/bundle/macos/Tiller.app`; the first build compiles the Rust dependencies and takes a few minutes. Without a built app, `tl` opens the browser UI instead, and `tl-app` runs the app in dev mode. Rebuild the app after pulling changes to `ui/` or `src-tauri/`.

## Use

- `tl` starts the daemon if it is not running and opens the app on the existing sessions (or the browser UI when the app is not built), like `code`. `tl .` or `tl ~/some/repo` (like `code .`) also finds, resumes or creates the orchestrator for that directory and opens the app on it. Without `up` or `app` in front, the path must start with `.`, `/` or `~`. `tl --new` always starts a fresh orchestrator, for the current directory unless a path is given.
- `cd ~/some/repo && tl --harness pi` uses Pi instead of Claude Code; the spawn dialog also offers Pi. Claude Code is not needed for a Pi-only tree.
- `tl stop` shuts the daemon down and closes every node; the nodes are not resumed on the next start.
- `tl reload` restarts the daemon on the current code and resumes the nodes that were live. Run it after pulling or editing daemon code.
- `tl autostart on|off|status` manages a launchd agent that starts the daemon at login and again after a crash.

Workers that edit code in parallel get their own git worktrees, each on a branch forked from a base branch. The base is a task branch, one per task, named after the repo's convention (`tl spawn --base feature/x`, or `base` on the spawn tool); when none is given and the checkout is on a protected branch (`main`, `master` or the remote's default), tiller makes one named `tl/<slug>` from the worker's title. Merges go into that base and never into a protected branch, so you push the task branch and open a pull request yourself. See [docs/worktrees.md](docs/worktrees.md).

`tl help` lists every command and flag.

## Where files live

Everything the daemon keeps is under `~/.tiller`, or `TL_HOME` when set: the node registry (`state.json`), per-node files under `nodes/<id>/`, the admin token `tl` uses, `config.json` ([docs/config.md](docs/config.md)), presets under `agents/` and the log `daemon.log`. Each tree of nodes has a session directory, `sessions/<rootId>/`, for notes and the event log ([docs/sessions.md](docs/sessions.md)). The daemon listens on 127.0.0.1, port 7788 unless `TL_PORT` says otherwise.

## Configuration

Tiller reads two JSON files, both optional: a per-repo file at `<repo>/.tiller/config.json`, which you commit so everyone who runs tiller in that repo gets the same behaviour, and a global file at `~/.tiller/config.json` for your own defaults across repos. Each key resolves on its own: the repo file wins over the global file, which wins over the built-in default. Keys in the `daemon` group (resume, retention, node caps) are daemon-wide and are read from the global file only. Both files are re-read on every use, so an edit applies without restarting the daemon. `tl config` prints the effective value of every key for the current directory and which file it came from.

A typical repo file sets the models for each role, gives workers their own worktrees with task branches named in the repo's convention, defines the check that must pass before a worker may report success, and lets the orchestrator close finished workers without asking:

```json
{
  "roles": { "orchestrator": { "model": "opus", "effort": "high" }, "worker": { "model": "sonnet", "effort": "medium" } },
  "worktrees": { "isolation": "worktree", "taskBranch": "feature/{slug}", "setup": ["npm ci"] },
  "gate": { "command": "npm test" },
  "approvals": { "close": "done" }
}
```

The same two levels hold for the text tiller gives agents: a repo can override the role prompts with `.tiller/orchestrator.md` and `.tiller/worker.md`, or globally with `~/.tiller/prompts/<role>.md`, and spawn presets (a named bundle of role text, model, effort, isolation and tool restrictions) live in `.tiller/agents/<name>.md` or `~/.tiller/agents/<name>.md`. Every key, its default and its level are listed in [docs/config.md](docs/config.md); prompts and presets are in [docs/agent-roles.md](docs/agent-roles.md).

## Known limits

- Anthropic can disable mods remotely, and `--bare` or `--safe-mode` drop them. The daemon and CLI still work then; messages are pasted into the terminal instead.
- Claude shows its trust dialog the first time it opens a new folder; attach and accept it.
- One daemon per user.
- With autostart on, a daemon started by `tl` or the app (when none was running) runs outside launchd, so a crash does not bring it back until the next `tl reload` or login.

## Tests

`npm test` (vitest), `npm run typecheck` and `npx tsc --noEmit -p ui/tsconfig.json` for the code; `claude plugin validate mod/` and `claude plugin test mod/` for the mod.

## Documentation

- [docs/config.md](docs/config.md): every config key, its default and which file it is read from.
- [docs/harnesses.md](docs/harnesses.md): harness adapters, Pi usage, compatibility and repository trust.
- [docs/messaging.md](docs/messaging.md): how messages between nodes are queued, delivered, steered and limited.
- [docs/agent-roles.md](docs/agent-roles.md): role prompts, presets, outcomes and the completion gate.
- [docs/worktrees.md](docs/worktrees.md): running workers in their own git worktrees and merging their work.
- [docs/sessions.md](docs/sessions.md): session directories, the event log, restart and resume.
- [docs/frontends.md](docs/frontends.md): the app, the browser UI, the in-session band and notifications.
- [PLAN.md](PLAN.md): the original design rationale; [docs/design/](docs/design/) holds the design documents for later features.
