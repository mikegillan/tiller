// Starts a daemon on a temp home, spawns terminal nodes a and b, and drives `o8 attach` in a pty through the chords.
// Usage: npx tsx spike/attach-check.ts   (exits non-zero on failure; shuts the daemon down)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';

const home = mkdtempSync(join(tmpdir(), 'o8-attach-'));
const port = 7801;
const env = { ...process.env, O8_HOME: home, O8_PORT: String(port) } as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const daemon = spawn('node_modules/.bin/tsx', ['src/daemon/index.ts'], { env, stdio: 'ignore', detached: true });
let p: pty.IPty | undefined, out = '';
const wait = async (cond: () => boolean, what: string, ms = 15000) => {
  for (const t = Date.now(); !cond(); await sleep(50)) if (Date.now() - t > ms) throw new Error(`timeout: ${what}; output so far:\n${out}`);
};
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) throw new Error(`failed: ${what}\n${out}`); };
const chord = async (key: string) => { p!.write('\x1c'); await sleep(100); p!.write(key); };

try {
  await wait(() => existsSync(join(home, 'port')) && existsSync(join(home, 'admin-token')), 'daemon start');
  const token = readFileSync(join(home, 'admin-token'), 'utf8').trim();
  const api = async (tool: string, body: object) => (await fetch(`http://127.0.0.1:${port}/api/${tool}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json() as Promise<any>;
  const a = (await api('spawn', { kind: 'terminal', title: 'a', cwd: process.cwd() })).data.nodeId;
  const b = (await api('spawn', { kind: 'terminal', title: 'b', cwd: process.cwd() })).data.nodeId;
  await sleep(500);

  p = pty.spawn('node_modules/.bin/tsx', ['src/daemon/cli.ts', 'attach', a], { cols: 100, rows: 30, cwd: process.cwd(), env });
  p.onData((d) => { out += d; });
  const exited = new Promise<number>((r) => p!.onExit((e) => r(e.exitCode)));
  await wait(() => out.includes('Ctrl-\\ ? help'), 'attach header');

  p.write('echo IN-A\r');
  await wait(() => out.includes('IN-A'), 'IN-A');
  let mark = out.length;
  await chord('n');
  await wait(() => out.slice(mark).includes('[orchestr8] b ('), 'header for b');
  p.write('echo IN-B\r');
  await wait(() => out.slice(mark).includes('IN-B'), 'IN-B');
  await api('send', { nodeId: a, text: 'echo LATE-A' }); // may or may not deliver to a plain terminal; either way b's view must not show it
  await sleep(500);
  check(!out.slice(mark).includes('LATE-A') && !out.slice(mark).includes('IN-A'), 'in b: no output from a');

  mark = out.length;
  await chord('b');
  await wait(() => out.slice(mark).includes('IN-A'), 'a scrollback replay');
  check(out.slice(mark).includes('[orchestr8] a ('), 'back to a with replayed IN-A');

  mark = out.length;
  await chord('l');
  await wait(() => out.slice(mark).includes('> '), 'picker');
  const pick = out.slice(mark);
  check(/1\. \S+\s+\S+\s+a\b/.test(pick) && /2\. \S+\s+\S+\s+b\b/.test(pick), 'picker lists a and b');
  p.write('2\r');
  await wait(() => out.slice(mark).includes('[orchestr8] b ('), 'landed in b');
  check(true, 'picker 2 lands in b');

  await chord('d');
  const code = await exited;
  check(code === 0, `detach exits 0 (got ${code})`);
  void b;
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  p?.kill();
  process.kill(-daemon.pid!, 'SIGTERM'); // whole process group: tsx wraps the real daemon
}
