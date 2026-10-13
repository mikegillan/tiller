// Client-side helpers for `o8` / `o8 up`: find or start the daemon, pick the orchestrator for a directory.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Health { ok: true; pid: number; home: string; version: string }

/** GET /health; undefined if nothing answers within `timeoutMs`. */
export async function findDaemon(port: number, timeoutMs = 500): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as Health;
    return res.ok && body.ok ? body : undefined;
  } catch { return undefined; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start bin/o8d detached (survives this process and its terminal), then wait for /health. Throws with the log tail on failure. */
export async function startDaemon(home: string, port: number, waitMs = 15_000): Promise<Health> {
  mkdirSync(home, { recursive: true });
  const log = join(home, 'daemon.log');
  const fd = openSync(log, 'a');
  const bin = fileURLToPath(new URL('../../bin/o8d', import.meta.url));
  const child = spawn(bin, [], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, O8_HOME: home, O8_PORT: String(port) } });
  child.unref();
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(200)) {
    const h = await findDaemon(port);
    if (h) { console.log(`started daemon (pid ${h.pid}), log ${log}`); return h; }
  }
  const tail = readFileSync(log, 'utf8').split('\n').slice(-20).join('\n');
  throw new Error(`daemon did not come up on port ${port}; last log lines:\n${tail}`);
}

export interface OrchestratorCandidate { id: string; title: string; kind: string; parentId: string | null; cwd: string; exited?: boolean; createdAt: number }

/** The newest top-level Claude node for `cwd` (already a realpath): live ones when `exited` is false, exited ones (resumable) when true. */
export function pickOrchestrator<T extends OrchestratorCandidate>(nodes: T[], cwd: string, exited = false): T | undefined {
  return nodes
    .filter((n) => n.kind === 'claude' && n.parentId === null && n.cwd === cwd && !!n.exited === exited)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}
