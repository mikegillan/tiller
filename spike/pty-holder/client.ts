// Feasibility spike for the PTY holder (docs/design/pty-holder.md). `run` starts a detached holder, a first client that
// spawns a TUI in a PTY and streams it, SIGKILLs that client, then has a second client reattach: replay the ring into
// @xterm/headless, serialize the screen, resize, type, and check the child's pid never changed. Then it stops the holder
// and removes its temp directory. The claude scenario submits no prompt, so it costs no API usage.
//   npx tsx spike/pty-holder/client.ts run [claude|claude-busy|vim|flood] [settleMs]     RING_BYTES=16384 to test a truncated ring
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import xterm from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { buildChildEnv, classify } from '../../src/daemon/pty.js';
import { control, data, PROTOCOL, readFrames, type Frame } from './frame.js';
const { Terminal } = xterm;
const { SerializeAddon } = serialize;

const ID = 'n-spike';
const COLS = 120, ROWS = 40;
// claude-busy runs one cheap Haiku turn (API usage) so the ring holds a real turn's output; flood fills a 1 MiB ring.
const SCENARIOS: Record<string, [string, string[]]> = {
  claude: ['claude', []],
  'claude-busy': ['claude', ['--model', 'haiku', 'Print the integers from 1 to 400, one per line, as plain text. Do not use any tools.']],
  vim: ['vim', ['-u', 'NONE', '-N', '-n', '-c', 'r README.md']],
  flood: ['sh', ['-c', 'seq 1 300000; exec vim -u NONE -N -n -c "r README.md"']],
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tsx = (file: string, ...args: string[]) => [process.execPath, ['--import', 'tsx', new URL(file, import.meta.url).pathname, ...args]] as const;

/** A connected client: frames in, a headless terminal fed by the PTY's data frames. */
class Conn {
  term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  ser = new SerializeAddon();
  bytes = 0;
  lastDataAt = 0;
  private waiters: Array<(f: Frame) => boolean> = [];
  constructor(readonly sock: Socket) {
    this.term.loadAddon(this.ser);
    readFrames(sock, (f) => {
      if (f.kind === 'data') { this.bytes += f.bytes.length; this.lastDataAt = Date.now(); this.term.write(f.bytes); }
      this.waiters = this.waiters.filter((w) => !w(f));
    });
  }
  static open(dir: string): Promise<Conn> {
    return new Promise((res, rej) => { const s = createConnection(join(dir, 'holder.sock'), () => res(new Conn(s))).on('error', rej); });
  }
  /** Resolves with the next control message of type t. */
  next(t: string): Promise<Record<string, any>> {
    return new Promise((res) => this.waiters.push((f) => {
      if (f.kind === 'control' && (f.msg.t === t || f.msg.t === 'error')) { res(f.msg); return true; }
      return false;
    }));
  }
  send(msg: { t: string } & Record<string, unknown>): void { this.sock.write(control(msg)); }
  input(s: string): void { this.sock.write(data(ID, Buffer.from(s))); }
  parsed(): Promise<void> { return new Promise((r) => this.term.write('', r)); }
  lines(): string[] {
    const b = this.term.buffer.active, out: string[] = [];
    for (let y = b.baseY; y < b.baseY + this.term.rows; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
    return out;
  }
  /** Wait until no output has arrived for quietMs since the call (at most maxMs), then parse. */
  async quiet(quietMs = 1500, maxMs = 6000): Promise<void> {
    const from = Date.now();
    for (const end = from + maxMs; Date.now() < end && Date.now() - Math.max(from, this.lastDataAt) < quietMs;) await sleep(50);
    await this.parsed();
  }
}

async function hello(c: Conn): Promise<Record<string, any>> {
  c.send({ t: 'hello', version: PROTOCOL });
  const h = await c.next('hello');
  if (h.t === 'error') throw new Error(h.error);
  return h;
}

function childEnv(): Record<string, string> {
  const env = buildChildEnv({});
  for (const k of Object.keys(env)) if (k.startsWith('TL_')) delete env[k];
  return env;
}

/** First client: spawn the TUI, attach, and keep writing the screen it sees to a-screen.json until it is killed. */
async function start(dir: string, scenario: string): Promise<void> {
  const c = await Conn.open(dir);
  await hello(c);
  const cwd = new URL('../..', import.meta.url).pathname;
  const [file, args] = SCENARIOS[scenario] ?? SCENARIOS.claude;
  c.send({ t: 'spawn', id: ID, file, args, cwd, env: childEnv(), cols: COLS, rows: ROWS });
  const sp = await c.next('spawned');
  if (sp.t === 'error') throw new Error(sp.error);
  c.send({ t: 'attach', id: ID });
  console.log(JSON.stringify({ pid: sp.pid }));
  for (;;) {
    await sleep(250);
    await c.parsed();
    writeFileSync(join(dir, 'a-screen.json'), JSON.stringify({ bytes: c.bytes, lines: c.lines() }));
  }
}

/** Second client: reattach, replay, measure, resize, type. Prints one JSON result line. */
async function reattach(dir: string, scenario: string): Promise<void> {
  const t0 = performance.now();
  const c = await Conn.open(dir);
  const tConnect = performance.now();
  const h = await hello(c);
  const tHello = performance.now();
  const pty = h.ptys.find((p: { id: string }) => p.id === ID);
  c.send({ t: 'attach', id: ID });
  const replayed = await c.next('replayed');
  const tReplay = performance.now();
  await c.parsed();
  const tParsed = performance.now();
  const snapshot = c.ser.serialize({ scrollback: 0 });
  const tSerialized = performance.now();
  const before = JSON.parse(readFileSync(join(dir, 'a-screen.json'), 'utf8')) as { bytes: number; lines: string[] };
  const replayLines = c.lines();
  const matching = replayLines.filter((l, i) => l === before.lines[i]).length;

  // Resize nudge: a size change sends SIGWINCH, and the TUI repaints for the new size.
  const nudgeStart = c.bytes;
  c.send({ t: 'resize', id: ID, cols: 100, rows: 30 });
  c.term.resize(100, 30);
  await c.quiet();
  const afterResize = c.lines();

  const typed = 'hello from the reattached client';
  const inputStart = c.bytes;
  c.input(scenario === 'vim' || scenario === 'flood' ? `ggO${typed}\x1b` : typed);
  await c.quiet();
  const afterInput = c.lines();
  const h2 = await hello(c); // a fresh hello re-reads the holder's view of the pid
  console.log(JSON.stringify({
    holderPid: h.pid, ptyPid: pty?.pid, ptyPidAfter: h2.ptys.find((p: { id: string }) => p.id === ID)?.pid,
    ringBytes: replayed.bytes, firstClientBytes: before.bytes,
    ms: { connect: tConnect - t0, hello: tHello - tConnect, replay: tReplay - tHello, parse: tParsed - tReplay, serialize: tSerialized - tParsed, total: tSerialized - t0 },
    snapshotChars: snapshot.length,
    replayMatchesLines: `${matching}/${ROWS}`,
    classifyAfterReplay: classify(replayLines.slice(-15)), classifyAfterResize: classify(afterResize.slice(-15)),
    resizeRepaintBytes: inputStart - nudgeStart, inputEchoBytes: c.bytes - inputStart,
    typedVisible: afterInput.some((l) => l.includes(typed)),
    screens: { beforeKill: before.lines, afterReplay: replayLines, afterResize, afterInput },
  }));
  c.sock.destroy();
}

async function stop(dir: string): Promise<void> {
  const c = await Conn.open(dir);
  await hello(c);
  c.send({ t: 'shutdown' });
  await new Promise((r) => c.sock.on('close', r));
}

async function firstLine(child: ChildProcess): Promise<string> {
  const rl = createInterface({ input: child.stdout! });
  for await (const line of rl) { rl.close(); return line; }
  throw new Error('child printed nothing');
}

async function run(scenario: string, settleMs: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  const log = (s: string) => console.log(`[spike] ${s}`);
  let ptyPid = 0, holderPid = 0;
  try {
    // detached: setsid, so the holder has its own session and process group and outlives this process and its group.
    const [node, hargs] = tsx('./holder.ts', dir);
    const holder = spawn(node, hargs, { detached: true, stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
    holder.unref();
    holderPid = holder.pid!;
    for (let i = 0; i < 100; i++) { try { (await Conn.open(dir)).sock.destroy(); break; } catch { await sleep(100); } }
    log(`holder pid ${holderPid}, dir ${dir}`);

    const [, aargs] = tsx('./client.ts', 'start', dir, scenario);
    const a = spawn(node, aargs, { stdio: ['ignore', 'pipe', 'inherit'] });
    ptyPid = JSON.parse(await firstLine(a)).pid;
    log(`client A pid ${a.pid} spawned ${scenario} pid ${ptyPid}; letting it settle ${settleMs} ms`);
    await sleep(settleMs);
    a.kill('SIGKILL');
    await new Promise((r) => a.on('exit', r));
    log(`client A killed with SIGKILL; ${scenario} pid ${ptyPid} alive: ${alive(ptyPid)}`);

    const [, bargs] = tsx('./client.ts', 'reattach', dir, scenario);
    const b = spawn(node, bargs, { stdio: ['ignore', 'pipe', 'inherit'] });
    const r = JSON.parse(await firstLine(b));
    await new Promise((res) => b.on('exit', res));
    const { screens, ...summary } = r;
    writeFileSync(join(tmpdir(), `ph-${scenario}-screens.json`), JSON.stringify(screens, null, 1));
    console.log(JSON.stringify(summary, null, 2));
    log(`pid unchanged: ${r.ptyPid === ptyPid && r.ptyPidAfter === ptyPid && alive(ptyPid)}; screens in ${join(tmpdir(), `ph-${scenario}-screens.json`)}`);
  } finally {
    await stop(dir).catch((e: Error) => log(`stop failed: ${e.message}`));
    for (let i = 0; i < 40 && (alive(ptyPid) || alive(holderPid)); i++) await sleep(100);
    log(`after stop: pty alive ${ptyPid ? alive(ptyPid) : '-'}, holder alive ${alive(holderPid)}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs as a launchd job: start a holder (in its own session or in the job's process group), spawn a PTY, write pids. */
async function job(dir: string, group: string): Promise<void> {
  const [node, hargs] = tsx('./holder.ts', dir);
  const holder = spawn(node, hargs, { detached: group === 'setsid', stdio: 'ignore', env: process.env });
  holder.unref();
  for (let i = 0; i < 100; i++) { try { (await Conn.open(dir)).sock.destroy(); break; } catch { await sleep(100); } }
  const c = await Conn.open(dir);
  await hello(c);
  c.send({ t: 'spawn', id: ID, file: '/bin/sleep', args: ['600'], cwd: dir, env: childEnv(), cols: COLS, rows: ROWS });
  const sp = await c.next('spawned');
  writeFileSync(join(dir, 'pids.json'), JSON.stringify({ job: process.pid, holder: holder.pid, pty: sp.pid }));
  for (;;) await sleep(60_000);
}

/** Bootstrap a uniquely named temporary launchd job running `job`, boot it out, and check what survived. */
async function launchd(group: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  const label = `com.tiller.spike-ptyholder-${process.pid}-${group}`, domain = `gui/${process.getuid!()}`;
  const plistFile = join(dir, `${label}.plist`);
  const [node, jargs] = tsx('./client.ts', 'job', dir, group);
  const args = [node, ...jargs].map((a) => `<string>${a}</string>`).join('');
  writeFileSync(plistFile, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${new URL('../..', import.meta.url).pathname}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
<key>StandardOutPath</key><string>${dir}/job.log</string><key>StandardErrorPath</key><string>${dir}/job.log</string></dict></plist>`);
  const lc = (...a: string[]) => spawnSync('launchctl', a, { encoding: 'utf8' });
  let pids: { job: number; holder: number; pty: number } | undefined;
  try {
    const b = lc('bootstrap', domain, plistFile);
    if (b.status !== 0) throw new Error(`bootstrap: ${b.stderr}`);
    lc('kickstart', `${domain}/${label}`);
    for (let i = 0; i < 150 && !pids; i++) { try { pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')); } catch { await sleep(100); } }
    if (!pids) throw new Error(`job never wrote pids: ${readFileSync(join(dir, 'job.log'), 'utf8')}`);
    const bo = lc('bootout', `${domain}/${label}`);
    await sleep(2000);
    console.log(JSON.stringify({ group, bootout: bo.status, jobAlive: alive(pids.job), holderAlive: alive(pids.holder), ptyAlive: alive(pids.pty) }));
  } finally {
    if (lc('print', `${domain}/${label}`).status === 0) lc('bootout', `${domain}/${label}`);
    if (pids && alive(pids.holder)) await stop(dir).catch(() => {});
    for (const p of [pids?.pty, pids?.holder]) if (p && alive(p)) process.kill(p, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

const [mode, a1, a2] = process.argv.slice(2);
if (mode === 'run') await run(a1 ?? 'claude', Number(a2) || 8000);
else if (mode === 'job') await job(a1, a2);
else if (mode === 'launchd') { await launchd('setsid'); await launchd('same-group'); }
else if (mode === 'start') await start(a1, a2);
else if (mode === 'reattach') await reattach(a1, a2);
else if (mode === 'stop') await stop(a1);
else throw new Error('usage: client.ts run [claude|claude-busy|vim|flood] [settleMs] | launchd');
process.exit(0);
