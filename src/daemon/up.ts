// Client-side helpers for `o8` / `o8 up`: find or start the daemon, pick the orchestrator for a directory.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeOrder } from '../shared/tree.js';

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

/** Run bin/<name> detached (survives this process and its terminal) with output appended to <home>/daemon.log; returns the log path. */
function detach(name: string, args: string[], home: string, port: number, env: NodeJS.ProcessEnv = process.env): string {
  mkdirSync(home, { recursive: true });
  const log = join(home, 'daemon.log');
  const fd = openSync(log, 'a');
  const bin = fileURLToPath(new URL(`../../bin/${name}`, import.meta.url));
  spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...env, O8_HOME: home, O8_PORT: String(port) } }).unref();
  return log;
}

/** Start bin/o8d detached, then wait for /health. Throws with the log tail on failure. */
export async function startDaemon(home: string, port: number, waitMs = 15_000): Promise<Health> {
  const log = detach('o8d', [], home, port);
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

/** Ids of the nodes that are not exited, parents before children: what `o8 reload` resumes after the restart. */
export const liveIds = (nodes: { id: string; parentId: string | null; exited?: boolean }[]): string[] =>
  treeOrder(nodes).filter((t) => !t.node.exited).map((t) => t.node.id);

/** `env` without a node's identity, so the CLI acts as the human and finds the daemon by O8_HOME and O8_PORT. */
export function humanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { O8_NODE_ID, O8_TOKEN_FILE, O8_ENDPOINT, ...rest } = env;
  return rest;
}

/** Hand `o8 reload` to a detached `o8 reload --resume-ids`, which outlives the terminal of the node that ran it. */
export const spawnReload = (home: string, port: number, ids: string[]): string =>
  detach('o8', ['reload', `--resume-ids=${ids.join(',')}`], home, port, humanEnv(process.env));
