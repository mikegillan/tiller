import { NodeManager } from './manager.js';
import { loginShellPath } from './pty.js';
import { startServer } from './server.js';

const port = Number(process.env.O8_PORT ?? 7788);
const manager = new NodeManager({ path: await loginShellPath() });
const server = await startServer(manager, { port });
console.log(`orchestr8 daemon listening. Open ${server.url}`);

function stop(): void {
  manager.shutdown();
  void server.close().finally(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
