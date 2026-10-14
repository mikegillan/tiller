// Client-side helpers for `tl` / `tl up`: find or start the daemon, pick the orchestrator for a directory.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { harnessFor, isAgentKind, type Harness, type NodeKind } from '../shared/protocol.js';

export interface Health { ok: true; pid: number; home: string; version: string }

/** GET /health; undefined if nothing answers within `timeoutMs`. */
export async function findDaemon(port: number, timeoutMs = 500): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as Health;
    return res.ok && body.ok ? body : undefined;
  } catch { return undefined; }
}

/** Run bin/<name> detached (survives this process and its terminal) with output appended to <home>/daemon.log; returns the log path. */
function detach(name: string, args: string[], home: string, port: number, env: NodeJS.ProcessEnv = process.env): string {
  mkdirSync(home, { recursive: true });
  const log = join(home, 'daemon.log');
  const fd = openSync(log, 'a');
  const bin = fileURLToPath(new URL(`../../bin/${name}`, import.meta.url));
  spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...env, TL_HOME: home, TL_PORT: String(port) } }).unref();
  return log;
}

/** Start bin/tld detached, then wait for /health. Throws with the log tail on failure. */
export const startDaemon = (home: string, port: number, waitMs = 15_000): Promise<Health> => waitForDaemon(port, detach('tld', [], home, port), waitMs);

/** Wait for a daemon that is starting, with its output in `log`, to answer /health. Throws with the log tail on failure. */
export async function waitForDaemon(port: number, log: string, waitMs = 15_000): Promise<Health> {
  for (const end = Date.now() + waitMs; Date.now() < end; await sleep(200)) {
    const h = await findDaemon(port);
    if (h) { console.log(`started daemon (pid ${h.pid}), log ${log}`); return h; }
  }
  const tail = readFileSync(log, 'utf8').split('\n').slice(-20).join('\n');
  throw new Error(`daemon did not come up on port ${port}; last log lines:\n${tail}`);
}

export interface OrchestratorCandidate { id: string; title: string; kind: string; harness?: Harness; parentId: string | null; cwd: string; exited?: boolean; createdAt: number }

/** Whether a candidate is an agent node on `harness` (legacy records without a harness are claude). */
const onHarness = (n: OrchestratorCandidate, harness: Harness) =>
  isAgentKind(n.kind as NodeKind) && harnessFor({ kind: n.kind as NodeKind, harness: n.harness }) === harness;

/**
 * The newest top-level agent node for `cwd` (already a realpath) on `harness` (default claude): live ones when
 * `exited` is false, exited ones (resumable) when true.
 */
export function pickOrchestrator<T extends OrchestratorCandidate>(nodes: T[], cwd: string, exited = false, harness: Harness = 'claude'): T | undefined {
  return nodes
    .filter((n) => onHarness(n, harness) && n.parentId === null && n.cwd === cwd && !!n.exited === exited)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** `env` without a node's identity, so the CLI acts as the human and finds the daemon by TL_HOME and TL_PORT. */
export function humanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TL_NODE_ID, TL_TOKEN_FILE, TL_ENDPOINT, ...rest } = env;
  return rest;
}

/** Hand `tl reload` to a detached `tl reload --detached`, which outlives the terminal of the node that ran it. */
export const spawnReload = (home: string, port: number): string => detach('tl', ['reload', '--detached'], home, port, humanEnv(process.env));
