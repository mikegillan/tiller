import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_TOKEN_FILE, daemonPort, PORT_FILE, REPO_FILE } from './home.js';
import { terminalBundleFor } from './launch.js';
import { createNotifier, findBin, runDetached } from './notifier.js';
import { NodeManager } from './manager.js';
import { loginShellPath } from './pty.js';
import { startServer } from './server.js';
import { logError } from './util.js';

const path = await loginShellPath();
const manager = new NodeManager({ path });
const server = await startServer(manager, { port: daemonPort(manager.home) }).catch((err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Another daemon has the port, such as when `o8 autostart on` loads the agent beside a running one. Exit 0 so
  // launchd's KeepAlive (relaunch only on failure) leaves it at that.
  console.log(`port ${daemonPort(manager.home)} is in use: another daemon is running; exiting`);
  process.exit(0);
});
const o8 = fileURLToPath(new URL('../../bin/o8', import.meta.url));
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
manager.on('notify', createNotifier({
  view: (id) => manager.view(id),
  rootTitle: (id) => (manager.registry.lineage(id).at(-1) ?? manager.registry.get(id))?.title,
  watchers: server.watchers,
  appConnected: server.appConnected,
  terminalNotifier: process.env.O8_TERMINAL_NOTIFIER ?? findBin('terminal-notifier', `${path}:/opt/homebrew/bin:/usr/local/bin`),
  terminalBundle: process.env.O8_TERMINAL_BUNDLE ?? terminalBundleFor(process.env.TERM_PROGRAM),
  // A click runs this under sh with a bare PATH, so hand it the daemon's home and PATH.
  onClick: (id) => `O8_HOME=${sq(manager.home)} PATH=${sq(path)} ${sq(o8)} select ${id}`,
  run: runDetached,
}));
writeFileSync(join(manager.home, PORT_FILE), `${server.port}\n`); // lets `o8` find the daemon without O8_PORT
writeFileSync(join(manager.home, REPO_FILE), fileURLToPath(new URL('../..', import.meta.url))); // lets the Tauri app find bin/o8d
if (process.env.O8_DEBUG) manager.on('hook', (id, ev) => console.log(`${new Date().toISOString().slice(11, 23)} hook ${id.slice(0, 6)} ${JSON.stringify({ e: ev.hook_event_name, err: ev.error, tool: ev.tool_name, type: ev.notification_type, prompt: (ev.prompt_id as string | undefined)?.slice(0, 6), msg: ev.message, mode: ev.permission_mode })}`));
console.log(`orchestr8 daemon listening. Open ${manager.endpoint}/?k=${readFileSync(join(manager.home, ADMIN_TOKEN_FILE), 'utf8')}\nhome: ${manager.home}`);

// Clear worktrees a crash left with no work in them and report the rest; then resume the nodes that were live.
manager.worktrees({ clean: 'startup' }).then((r) => {
  for (const x of r.removed) console.log(`removed orphaned ${x.what}`);
  if (r.orphans.length || r.kept.length) console.log(`${r.orphans.length} orphaned worktree(s) and ${r.kept.length} kept branch(es): see o8 worktrees`);
}).catch(logError).then(() => manager.resumeLive()).then(console.log, logError);

// Delete expired session directories now and once a day.
const sweepSessions = () => { try { for (const id of manager.sweepSessions()) console.log(`removed expired session directory ${id}`); } catch (err) { logError(err); } };
sweepSessions();
setInterval(sweepSessions, 86_400_000).unref();

process.on('unhandledRejection', logError);

function stop(): void {
  manager.shutdown();
  server.close().catch(logError).finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
