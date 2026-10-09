import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalBundleFor } from './launch.js';
import { createNotifier, findBin, runDetached } from './notifier.js';
import { NodeManager } from './manager.js';
import { loginShellPath } from './pty.js';
import { startServer } from './server.js';
import { logError } from './util.js';

const port = Number(process.env.O8_PORT ?? 7788);
const path = await loginShellPath();
const manager = new NodeManager({ path });
const server = await startServer(manager, { port });
const o8 = fileURLToPath(new URL('../../bin/o8', import.meta.url));
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
manager.on('notify', createNotifier({
  view: (id) => manager.view(id),
  rootTitle: (id) => {
    let n = manager.registry.get(id);
    for (let p = n && manager.registry.get(n.parentId ?? ''); p; p = manager.registry.get(p.parentId ?? '')) n = p;
    return n?.title;
  },
  watchers: server.watchers,
  appConnected: server.appConnected,
  terminalNotifier: process.env.O8_TERMINAL_NOTIFIER ?? findBin('terminal-notifier', `${path}:/opt/homebrew/bin:/usr/local/bin`),
  terminalBundle: process.env.O8_TERMINAL_BUNDLE ?? terminalBundleFor(process.env.TERM_PROGRAM),
  // A click runs this under sh with a bare PATH, so hand it the daemon's home and PATH.
  onClick: (id) => `O8_HOME=${sq(manager.home)} PATH=${sq(path)} ${sq(o8)} select ${id}`,
  run: runDetached,
}));
writeFileSync(join(manager.home, 'port'), `${server.port}\n`); // lets `o8` find the daemon without O8_PORT
writeFileSync(join(manager.home, 'repo'), fileURLToPath(new URL('../..', import.meta.url))); // lets the Tauri app find bin/o8d
if (process.env.O8_DEBUG) manager.on('hook', (id, ev) => console.log(`${new Date().toISOString().slice(11, 23)} hook ${id.slice(0, 6)} ${JSON.stringify({ e: ev.hook_event_name, err: ev.error, tool: ev.tool_name, type: ev.notification_type, prompt: (ev.prompt_id as string | undefined)?.slice(0, 6), msg: ev.message, mode: ev.permission_mode })}`));
console.log(`orchestr8 daemon listening. Open ${server.url}\nhome: ${manager.home}`);

process.on('unhandledRejection', logError);

function stop(): void {
  manager.shutdown();
  server.close().catch(logError).finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
