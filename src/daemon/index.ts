import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeManager } from './manager.js';
import { loginShellPath } from './pty.js';
import { startServer } from './server.js';
import { logError } from './util.js';

const port = Number(process.env.O8_PORT ?? 7788);
const manager = new NodeManager({ path: await loginShellPath() });
const server = await startServer(manager, { port });
writeFileSync(join(manager.home, 'port'), `${server.port}\n`); // lets `o8` find the daemon without O8_PORT
if (process.env.O8_DEBUG) manager.on('hook', (id, ev) => console.log(`hook ${id.slice(0, 6)} ${JSON.stringify(ev).slice(0, 400)}`));
console.log(`orchestr8 daemon listening. Open ${server.url}`);

process.on('unhandledRejection', logError);

function stop(): void {
  manager.shutdown();
  server.close().catch(logError).finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
