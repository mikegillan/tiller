// Real-daemon check of the pane click path: orchestrator spawns a worker, `o8 attach` at 160 cols, /o8, hotkey 1 switches to the worker.
// Usage: npx tsx spike/click-check.ts   (own daemon on 7791, home /tmp/o8-click; cleans up after itself)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';

const home = '/tmp/o8-click', port = 7791, cols = 160, rows = 50, repo = process.cwd();
rmSync(home, { recursive: true, force: true });
const env = { ...process.env, O8_HOME: home, O8_PORT: String(port), O8_DEBUG: '1' } as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const daemon = spawn('node_modules/.bin/tsx', ['src/daemon/index.ts'], { env, stdio: 'ignore', detached: true });
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const screen = () => { const b = term.buffer.active; return Array.from({ length: rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? ''); };
const has = (s: string) => screen().some((l) => l.includes(s));
let p: pty.IPty | undefined, code = 1;
const wait = async (f: () => boolean, what: string, ms = 120_000) => { for (const t = Date.now(); !f(); await sleep(200)) if (Date.now() - t > ms) throw new Error(`timeout: ${what}\n${screen().join('\n')}`); };
let raw = '', mark = 0; // the attach header is drawn once and then painted over by the node's redraw, so read it from the raw stream
const header = () => /\[orchestr8\] [^\x1b\r\n]*Ctrl-\\ \? help/.exec(raw.slice(mark))?.[0] ?? '';

try {
  await wait(() => existsSync(join(home, 'port')) && existsSync(join(home, 'admin-token')), 'daemon');
  const token = readFileSync(join(home, 'admin-token'), 'utf8').trim();
  const prompt = "Using the orchestr8 MCP tools: spawn one claude child titled 'worker' with cwd " + repo + " and the prompt 'Reply READY, then wait.'. Then reply with one line: SPAWNED. Do nothing else.";
  const r = await (await fetch(`http://127.0.0.1:${port}/api/spawn`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-O8-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'claude', title: 'orchestrator', cwd: repo, prompt }) })).json() as any;
  const orch = r.data.nodeId as string;
  p = pty.spawn('node_modules/.bin/tsx', ['src/daemon/cli.ts', 'attach', orch], { name: 'xterm-256color', cols, rows, cwd: repo, env });
  p.onData((d) => { raw += d; term.write(d); });
  await wait(() => header().includes('orchestrator'), 'attach header');
  console.log('HEADER 1:', header().trim());
  await wait(() => has('SPAWNED') && has('2 nodes'), 'worker spawned and listed in pane');
  p.write('/o8'); await sleep(500); p.write('\r'); await sleep(3000);
  console.log('PANE ROWS:\n' + screen().map((l) => l.slice(90)).filter((l) => l.trim()).join('\n'));
  const click = async (text: string) => { // SGR mouse press + release on the first screen cell of `text` (1-based cols and rows)
    const y = screen().findIndex((l) => l.includes(text)); if (y < 0) throw new Error(`no ${text} on screen`);
    const x = screen()[y]!.indexOf(text) + 2;
    p!.write(`\x1b[<0;${x};${y + 1}M`); await sleep(100); p!.write(`\x1b[<0;${x};${y + 1}m`); await sleep(800);
  };
  await click('orchestr8 2 nodes'); // a click on the pane gives it the focus; hotkeys then apply
  mark = raw.length;
  if (process.env.CLICK) await click('worker ['); else p.write('1'); // CLICK=1 clicks the row instead of using the hotkey
  await wait(() => header().includes('worker'), 'switch to worker', 20_000);
  console.log('HEADER 2:', header().trim());
  console.log('WORKER BAND:', screen().find((l) => l.includes('orchestr8 · '))?.slice(0, 90).trim());
  mark = raw.length;
  p.write('\x1c'); await sleep(100); p.write('b');
  await wait(() => header().includes('orchestrator'), 'back to orchestrator', 20_000);
  console.log('HEADER 3:', header().trim());
  code = 0;
} catch (e) { console.log('FAIL', (e as Error).message); }
finally {
  try { p?.kill(); } catch {}
  if (existsSync(join(home, 'admin-token'))) {
    const t = readFileSync(join(home, 'admin-token'), 'utf8').trim();
    const nodes = await (await fetch(`http://127.0.0.1:${port}/api/list_nodes`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'X-O8-Node': 'human', 'Content-Type': 'application/json' }, body: '{}' })).json().catch(() => ({})) as any;
    const ids = (nodes.data ?? []).map((n: any) => n.id);
    if (ids.length) await fetch(`http://127.0.0.1:${port}/api/close`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'X-O8-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeIds: ids }) }).catch(() => {});
  }
  try { process.kill(-daemon.pid!, 'SIGTERM'); } catch {}
  await sleep(1500);
  process.exit(code);
}
