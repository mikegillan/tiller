// Minimal PTY holder: owns PTYs and their child processes, keeps a byte ring per PTY, and serves one client at a time
// over a Unix socket (<dir>/holder.sock, mode 0600). A new connection replaces the old one. See docs/design/pty-holder.md.
//   npx tsx spike/pty-holder/holder.ts <dir>     (normally started detached by client.ts)
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import * as nodePty from 'node-pty';
import { control, data, PROTOCOL, readFrames } from './frame.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: holder.ts <dir>');
const SOCK = join(dir, 'holder.sock');
const RING_BYTES = Number(process.env.RING_BYTES) || 1 << 20;
const MAX_QUEUED = 8 << 20; // a client this far behind is dropped; it reconnects and replays the ring

interface Held { pty: nodePty.IPty; ring: Buffer[]; ringBytes: number; cols: number; rows: number; exit?: { code: number; signal?: number } }
const held = new Map<string, Held>();
let client: Socket | undefined;
const attached = new Set<string>();
const log = (s: string) => console.log(`${new Date().toISOString()} holder ${process.pid}: ${s}`);

function send(buf: Buffer): void {
  if (!client) return;
  if (client.writableLength > MAX_QUEUED) { log('client too far behind; dropping it'); client.destroy(); return; }
  client.write(buf);
}

function spawnPty(m: { id: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }): number {
  if (held.has(m.id)) throw new Error(`pty ${m.id} exists`);
  // encoding null: onData delivers Buffers, so the ring holds the exact bytes and UTF-8 is decoded by the client.
  const pty = nodePty.spawn(m.file, m.args, { name: 'xterm-256color', cwd: m.cwd, env: m.env, cols: m.cols, rows: m.rows, encoding: null });
  const h: Held = { pty, ring: [], ringBytes: 0, cols: m.cols, rows: m.rows };
  held.set(m.id, h);
  pty.onData((d) => {
    const b = d as unknown as Buffer;
    h.ring.push(b);
    h.ringBytes += b.length;
    while (h.ringBytes - h.ring[0].length >= RING_BYTES) h.ringBytes -= h.ring.shift()!.length;
    if (attached.has(m.id)) send(data(m.id, b));
  });
  pty.onExit(({ exitCode, signal }) => {
    h.exit = { code: exitCode, signal };
    log(`pty ${m.id} pid ${pty.pid} exited ${exitCode}${signal ? ` signal ${signal}` : ''}`);
    send(control({ t: 'exit', id: m.id, ...h.exit }));
  });
  log(`spawned ${m.id} pid ${pty.pid}: ${m.file} ${m.args.join(' ')}`);
  return pty.pid;
}

function serve(sock: Socket): void {
  let greeted = false;
  readFrames(sock, (f) => {
    if (f.kind === 'data') { if (greeted) held.get(f.id)?.pty.write(f.bytes); return; }
    const m = f.msg as Record<string, any>;
    try {
      if (!greeted && m.t !== 'hello') throw new Error('expected hello');
      switch (m.t) {
        case 'hello': {
          if (m.version !== PROTOCOL) { sock.end(control({ t: 'error', error: `holder speaks protocol ${PROTOCOL}` })); return; }
          if (client && client !== sock) { log('new client replaces the old one'); client.destroy(); }
          client = sock;
          attached.clear();
          greeted = true;
          const ptys = [...held].map(([id, h]) => ({ id, pid: h.pty.pid, cols: h.cols, rows: h.rows, bufferBytes: h.ringBytes, exit: h.exit }));
          sock.write(control({ t: 'hello', version: PROTOCOL, pid: process.pid, ptys }));
          return;
        }
        case 'spawn': sock.write(control({ t: 'spawned', id: m.id, pid: spawnPty(m as never) })); return;
        case 'attach': {
          // Replay and subscribe in one turn of the event loop, so no output falls between them or lands in both.
          const h = held.get(m.id);
          if (!h) throw new Error(`no pty ${m.id}`);
          const replay = Buffer.concat(h.ring);
          sock.write(data(m.id, replay));
          sock.write(control({ t: 'replayed', id: m.id, bytes: replay.length, cols: h.cols, rows: h.rows, exit: h.exit }));
          attached.add(m.id);
          return;
        }
        case 'resize': {
          const h = held.get(m.id);
          if (h && !h.exit) { h.pty.resize(m.cols, m.rows); h.cols = m.cols; h.rows = m.rows; }
          return;
        }
        case 'kill': held.get(m.id)?.pty.kill(m.signal); return;
        case 'release': if (held.get(m.id)?.exit) held.delete(m.id); return; // the client has recorded the exit
        case 'shutdown': shutdown(); return;
        default: throw new Error(`unknown message ${m.t}`);
      }
    } catch (err) {
      sock.write(control({ t: 'error', error: (err as Error).message }));
    }
  });
  sock.on('close', () => { if (client === sock) { client = undefined; attached.clear(); log('client gone'); } });
  sock.on('error', () => {});
}

function shutdown(): void {
  log('shutting down: killing every pty');
  for (const h of held.values()) if (!h.exit) h.pty.kill();
  server.close();
  try { unlinkSync(SOCK); } catch {}
  setTimeout(() => process.exit(0), 500);
}

const server = createServer(serve);
async function listen(): Promise<void> {
  if (existsSync(SOCK)) {
    // A socket that answers belongs to a running holder; one that refuses is left over from a crash.
    const live = await new Promise<boolean>((res) => {
      const c = createConnection(SOCK, () => { c.destroy(); res(true); }).on('error', () => res(false));
    });
    if (live) { log('another holder is running'); process.exit(1); }
    unlinkSync(SOCK);
  }
  process.umask(0o177); // the socket is created 0600; the chmod below is belt and braces
  server.listen(SOCK, () => { chmodSync(SOCK, 0o600); log(`listening on ${SOCK}, ring ${RING_BYTES} bytes`); });
}
process.on('SIGTERM', shutdown);
process.on('SIGHUP', () => log('ignoring SIGHUP'));
await listen();
