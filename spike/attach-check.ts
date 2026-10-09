// Drives `o8 attach <id>` in a pty: echo round-trip, then detach chord. Usage: tsx spike/attach-check.ts <nodeId>
import * as pty from 'node-pty';

const id = process.argv[2];
const p = pty.spawn('npx', ['tsx', 'src/daemon/cli.ts', 'attach', id], { cols: 100, rows: 30, cwd: process.cwd(), env: process.env as Record<string, string> });
let out = '';
p.onData((d) => { out += d; });
const wait = async (cond: () => boolean, ms = 15000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error(`timeout; output so far:\n${out}`); await new Promise((r) => setTimeout(r, 50)); } };
const exited = new Promise<number>((r) => p.onExit((e) => r(e.exitCode)));

await wait(() => out.includes('press Ctrl-'));
p.write('echo ATTACHED-$((40+2))\r');
await wait(() => out.includes('ATTACHED-42'));
console.log('echo seen');
p.write('\x1c');
await new Promise((r) => setTimeout(r, 200));
p.write('d');
const code = await exited;
console.log('exit code', code, '| tail:', JSON.stringify(out.slice(-60)));
process.exit(code === 0 ? 0 : 1);
