// Real-daemon check of the tree pane: orchestrator spawns a worker, `o8 attach` at 160 cols, click into the worker, its pane still shows the root, click the root card to go back.
// Usage: npx tsx spike/tree-check.ts   (own daemon on 7792, home /tmp/o8-tree; cleans up after itself)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';

const home = '/tmp/o8-tree', port = 7792, cols = 160, rows = 50, repo = process.cwd();
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
  console.log('PANE ROWS:\n' + screen().map((l) => l.slice(88)).filter((l) => l.trim()).join('\n'));
  const paneRows = () => screen().map((l) => l.slice(88)).filter((l) => l.trim()).join('\n');
  const click = async (text: string) => { // SGR mouse press + release on the first cell of `text` inside the pane (columns 88+; 1-based coordinates)
    const y = screen().findIndex((l) => l.slice(88).includes(text)); if (y < 0) throw new Error(`no ${text} in pane\n${paneRows()}`);
    const x = 88 + screen()[y]!.slice(88).indexOf(text) + 2;
    p!.write(`\x1b[<0;${x};${y + 1}M`); await sleep(100); p!.write(`\x1b[<0;${x};${y + 1}m`); await sleep(800);
  };
  const assert = (ok: boolean, what: string) => { if (!ok) throw new Error(`assert: ${what}\n${paneRows()}`); };
  await sleep(2000); // the pane auto-opens at 160 columns; no /o8 needed
  console.log('ORCHESTRATOR PANE ROWS:\n' + paneRows());
  mark = raw.length;
  await click('worker');
  await wait(() => header().includes('worker'), 'click into worker', 20_000);
  console.log('HEADER 2:', header().trim());
  await wait(() => screen().some((l) => l.slice(88).includes('(you)')), 'worker pane shows (you)', 20_000);
  console.log('WORKER PANE ROWS:\n' + paneRows());
  const pr = paneRows().split('\n');
  const iOrch = pr.findIndex((l) => l.includes('orchestrator') && !l.includes('·')), iYou = pr.findIndex((l) => l.includes('(you)'));
  assert(iOrch >= 0 && iYou > iOrch, 'orchestrator card is above the worker card');
  assert(pr[iYou]!.includes('worker'), 'the (you) card is the worker');
  console.log('WORKER BAND:', screen().find((l) => l.includes('orchestr8 · '))?.slice(0, 90).trim());
  mark = raw.length;
  await click('orchestrator [');
  await wait(() => header().includes('orchestrator'), 'click root card returns to orchestrator', 20_000);
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
