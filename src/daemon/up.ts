// Client-side helpers for `tl` / `tl up`: find or start the daemon, pick the orchestrator for a directory.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { agentMatches, agentStatus, kickstart } from './autostart.js';
import type { UpdateStatus } from '../shared/protocol.js';
import { harnessFor, isAgentKind, type Harness, type NodeKind } from '../shared/protocol.js';

export interface Health { ok: true; pid: number; home: string; version: string; sha?: string }

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

/**
 * The directory `tl up` works on, as a realpath: `path` (relative to `cwd`, `~` for the home directory), else `cwd`
 * when a directory-only flag was given, else undefined (just open the app). Throws when it is not a directory.
 */
export function upDir(path: string | undefined, dirFlag: boolean, cwd: string, home = homedir()): string | undefined {
  if (path === undefined && !dirFlag) return undefined;
  const p = resolve(cwd, (path ?? '.').replace(/^~(?=$|\/)/, home));
  let real: string;
  try { real = realpathSync(p); } catch { throw new Error(`no such directory: ${p}`); }
  if (!statSync(real).isDirectory()) throw new Error(`not a directory: ${p}`);
  return real;
}

export interface OrchestratorCandidate { id: string; title: string; kind: string; harness?: Harness; parentId: string | null; cwd: string; exited?: boolean; createdAt: number }

/** Whether a candidate is an agent node on `harness` (legacy records without a harness are claude). */
const onHarness = (n: OrchestratorCandidate, harness: Harness) =>
  isAgentKind(n.kind as NodeKind) && harnessFor(n) === harness;

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

/** Detached updater retains the reviewed release across the daemon restart. */
export function spawnUpdate(home: string, port: number, expected: UpdateStatus, onExit: (code: number | null) => void): string {
  const log = join(home, 'update.log');
  const fd = openSync(log, 'a');
  try {
    const child = spawn(fileURLToPath(new URL('../../bin/tl', import.meta.url)), ['update', '--detached'], {
      detached: true, stdio: ['pipe', fd, fd], env: { ...humanEnv(process.env), TL_HOME: home, TL_PORT: String(port) },
    });
    child.stdin!.on('error', () => {}); // Spawn failure is reported by the child's error handler.
    child.stdin!.end(JSON.stringify(expected));
    child.once('exit', onExit);
    child.once('error', () => onExit(1));
    child.unref();
  } finally { closeSync(fd); }
  return log;
}

/** SIGTERM preserves live nodes; keep launchd ownership when enabled. */
export async function restartDaemon(home: string, port: number, expectedSha?: string, say: (s: string) => void = () => {}): Promise<void> {
  const old = await findDaemon(port);
  if (old) {
    if (old.home !== home) throw new Error('refusing to stop a daemon from another home');
    say(`stopping daemon pid ${old.pid}`);
    process.kill(old.pid, 'SIGTERM');
    for (const end = Date.now() + 10_000; await findDaemon(port); await sleep(200))
      if (Date.now() > end) throw new Error(`daemon pid ${old.pid} did not stop`);
  }
  const agent = agentStatus().loaded && agentMatches(home, port);
  if (agent) kickstart();
  const h = await (agent ? waitForDaemon(port, join(home, 'daemon.log')) : startDaemon(home, port));
  if (h.home !== home || (expectedSha && h.sha !== expectedSha)) throw new Error(`restarted daemon does not report expected commit ${expectedSha}`);
  say(`started daemon pid ${h.pid}${agent ? ' through launchd' : ''}; it resumes the nodes that were live`);
}
