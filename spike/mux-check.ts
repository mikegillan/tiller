// Real-daemon check of the sidebar client: orchestrator spawns a worker, `tl attach` in a 160x45 pty, click the worker row, type /tl-list into it, Ctrl-\ b back, Ctrl-\ d exits.
// Usage: npx tsx spike/mux-check.ts   (own daemon on 7795, home /tmp/tl-mux; cleans up after itself)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';

const home = '/tmp/tl-mux', port = 7795, cols = 160, rows = 45, repo = process.cwd(), SB = 30;
rmSync(home, { recursive: true, force: true });
const env = { ...process.env, TL_HOME: home, TL_PORT: String(port), TL_DEBUG: '1' } as Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const daemon = spawn('node_modules/.bin/tsx', ['src/daemon/index.ts'], { env, stdio: 'ignore', detached: true });
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const lines = () => { const b = term.buffer.active; return Array.from({ length: rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? ''); };
const side = () => lines().map((l) => l.slice(0, SB)), main = () => lines().map((l) => l.slice(SB + 1));
const dump = () => lines().map((l, i) => String(i + 1).padStart(2) + ' ' + l).join('\n');
const hasMain = (s: string) => main().some((l) => l.includes(s));
const selectedRow = () => { const b = term.buffer.active; for (let y = 0; y < rows; y++) { const c = b.getLine(b.baseY + y)?.getCell(3); if (c?.isBgPalette() && c.getBgColor() === 236) return side()[y]!; } return ''; };
let p: pty.IPty | undefined, code = 1, raw = '', exit: number | undefined;
const wait = async (f: () => boolean, what: string, ms = 120_000) => { for (const t = Date.now(); !f(); await sleep(200)) if (Date.now() - t > ms) throw new Error(`timeout: ${what}\n${dump()}`); };
const assert = (ok: boolean, what: string) => { if (!ok) throw new Error(`assert: ${what}\n${dump()}`); console.log('ok:', what); };
const api = async (tool: string, body: unknown, token: string) => (await (await fetch(`http://127.0.0.1:${port}/api/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-TL-Node': 'human', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;

try {
  await wait(() => existsSync(join(home, 'port')) && existsSync(join(home, 'admin-token')), 'daemon');
  const token = readFileSync(join(home, 'admin-token'), 'utf8').trim();
  const prompt = "Using the tiller MCP tools: spawn one claude child titled 'worker' with cwd " + repo + " and the prompt 'Reply READY, then wait.'. Then reply with one line: SPAWNED. Do nothing else.";
  const orch = (await api('spawn', { kind: 'claude', title: 'orchestrator', cwd: repo, prompt }, token)).data.nodeId as string;
  p = pty.spawn('node_modules/.bin/tsx', ['src/daemon/cli.ts', 'attach', orch], { name: 'xterm-256color', cols, rows, cwd: repo, env });
  p.onData((d) => { raw += d; term.write(d); });
  p.onExit((e) => { exit = e.exitCode; });
  await wait(() => side().some((l) => l.includes('orchestrator')) && side().some((l) => l.includes('worker')) && hasMain('SPAWNED'), 'sidebar lists both nodes and orchestrator replied');
  await sleep(1500);
  assert(side().some((l) => /[●!✓·○].*orchestrator/.test(l)) && side().some((l) => /└─ .*worker/.test(l)), 'sidebar shows glyphs and the tree connector');
  const pl = lines().findIndex((l) => l.indexOf('❯') >= SB);
  assert(pl >= 0, `prompt box ❯ in the main region at column ${pl >= 0 ? lines()[pl]!.indexOf('❯') : '-'}`);
  console.log('SCREEN 1 (orchestrator selected):\n' + dump());
  const wy = side().findIndex((l) => l.includes('worker'));
  const click = async (y: number) => { p!.write(`\x1b[<0;5;${y + 1}M`); await sleep(80); p!.write(`\x1b[<0;5;${y + 1}m`); };
  await click(wy);
  await wait(() => selectedRow().includes('worker') && !hasMain('SPAWNED') && hasMain('Claude Code'), 'click on the worker row moves the highlight and swaps in the worker screen');
  p.write('/tl-list'); await sleep(500); p.write('\r');
  await wait(() => main().some((l) => l.includes('orchestrator')), 'typed /tl-list reached the worker (its screen lists nodes)', 60_000);
  await sleep(1000);
  console.log('SCREEN 2 (worker selected, after /tl-list):\n' + dump());
  p.write('\x1c'); await sleep(100); p.write('b');
  await wait(() => selectedRow().includes('orchestrator') && hasMain('SPAWNED'), 'Ctrl-\\ b returns to the orchestrator');
  p.write('\x1c'); await sleep(100); p.write('d');
  await wait(() => exit !== undefined, 'exit');
  assert(exit === 0, 'Ctrl-\\ d exits 0');
  assert(raw.endsWith('\x1b[?1049l'), 'output ends with alternate screen off');
  code = 0;
} catch (e) { console.log('FAIL', (e as Error).message); }
finally {
  try { p?.kill(); } catch {}
  if (existsSync(join(home, 'admin-token'))) {
    const t = readFileSync(join(home, 'admin-token'), 'utf8').trim();
    const ids = ((await api('list_nodes', {}, t).catch(() => ({}))).data ?? []).map((n: any) => n.id);
    if (ids.length) await api('close', { nodeIds: ids }, t).catch(() => {});
  }
  try { process.kill(-daemon.pid!, 'SIGTERM'); } catch {}
  await sleep(1500);
  process.exit(code);
}
