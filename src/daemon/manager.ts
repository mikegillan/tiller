import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NEEDS_YOU_STATES, type AgentState, type ModEvent, type NodeKind, type NodeStatus, type NodeView, type Role } from '../shared/protocol.js';
import { homeDir } from './home.js';
import { claudeLaunch, ensurePrompts, terminalLaunch, writeNodeFiles, type LaunchInput, type LaunchSpec } from './launch.js';
import { pruneIds } from '../shared/prune.js';
import { flushInbox } from './messaging.js';
import { NodeRegistry } from './nodes.js';
import { PtySession } from './pty.js';
import { logError, safeEqual } from './util.js';
import { interruptKeyPressed, interruptTimeout, ptyExited, reduce, sweep, turnComplete, type HookEvent } from './status.js';

const MAX_PREVIOUS_SESSIONS = 10;
const INTERRUPT_MS = 1500;
const SWEEP_MS = 60_000;
const TRUST_WATCH_MS = 20_000;
const TRUST_BLOCKED_ACTIVITY = 'Trust dialog: answer it in the terminal';
const DEFAULT_SIZE = { cols: 120, rows: 40 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A node's state before any hook arrives: a Claude node is unknown until SessionStart; a terminal has no agent state. */
const initialState = (kind: NodeKind): AgentState => (kind === 'claude' ? 'unknown' : 'none');

/**
 * Whether we may answer Claude's folder-trust dialog for `cwd`. Only when ~/.claude.json already
 * records trust for the cwd or one of its ancestors; otherwise the human has to decide.
 */
export function trustPolicy(cwd: string, claudeJson: unknown): 'auto' | 'manual' {
  const projects = (claudeJson as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | null)?.projects;
  if (!projects || typeof projects !== 'object') return 'manual';
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (projects[dir]?.hasTrustDialogAccepted === true) return 'auto';
    if (dirname(dir) === dir) return 'manual';
  }
}

function readClaudeJson(): unknown {
  try { return JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')); } catch { return null; }
}

/** Fallback for where Claude keeps a session's transcript: the real path of cwd with every non-alphanumeric character replaced by -. */
function transcriptFor(cwd: string, sessionId: string): string {
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* keep the path as given */ }
  return join(homedir(), '.claude', 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

export interface SpawnRequest {
  kind: NodeKind;
  title: string;
  cwd: string;
  prompt?: string;
  model?: string;
  permissionMode?: string;
  role?: Role;
  parentId?: string | null;
}

export interface ManagerOptions {
  /** Defaults to O8_HOME, then ~/.orchestr8. */
  home?: string;
  /** Shell for terminal nodes. Defaults to $SHELL, then /bin/sh. */
  shell?: string;
  /** PATH handed to children (from loginShellPath()). Defaults to this process's PATH. */
  path?: string;
}

export interface NotifyEvent { id: string; kind: 'done' | 'needsYou' | 'errored' | 'exited'; title: string; body?: string }

/**
 * Owns the registry, the live PTYs and the per-node status. Events (node:events):
 *   'node'    (view: NodeView)            created or changed
 *   'removed' (id: string)
 *   'hook'    (id: string, event: HookEvent)  every accepted hook, before status is updated
 *   'data'    (id: string, data: string)  raw PTY output
 *   'notify'  (n: NotifyEvent)
 */
export class NodeManager extends EventEmitter {
  readonly home: string;
  readonly registry: NodeRegistry;
  /** Base URL of the daemon, set by the server once it knows its port. */
  endpoint = '';
  /** Whether any connected UI client has node `id` selected; set by the server. A selected node never turns unread. */
  isSelected: (id: string) => boolean = () => false;
  private shell: string;
  private path: string;
  private secret: Buffer;
  private sessions = new Map<string, PtySession>();
  private statuses = new Map<string, NodeStatus>();
  private unread = new Set<string>();
  private lastHookAt = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout;
  private interruptTimers = new Map<string, NodeJS.Timeout>();

  constructor(opts: ManagerOptions = {}) {
    super();
    this.home = opts.home ?? homeDir();
    this.shell = opts.shell ?? process.env.SHELL ?? '/bin/sh';
    this.path = opts.path ?? process.env.PATH ?? '';
    mkdirSync(join(this.home, 'nodes'), { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700); // mkdir's mode does not apply to a directory that already existed
    ensurePrompts(this.home);
    this.secret = this.loadSecret();
    this.registry = new NodeRegistry(join(this.home, 'state.json'));
    this.registry.load();
    // Nodes from a previous run have no process; they can be resumed.
    for (const n of this.registry.list()) {
      this.statuses.set(n.id, { state: initialState(n.kind), exited: true, sessionId: n.sessionId, transcriptPath: n.transcriptPath, changedAt: Date.now() });
    }
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_MS);
    this.sweepTimer.unref();
  }

  private loadSecret(): Buffer {
    const file = join(this.home, 'secret');
    try {
      return readFileSync(file);
    } catch {
      const fresh = randomBytes(32);
      try {
        writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
        return fresh;
      } catch {
        return readFileSync(file); // another process created it first
      }
    }
  }

  // ---- tokens ----

  tokenFor(nodeId: string): string {
    return createHmac('sha256', this.secret).update(nodeId).digest('hex');
  }

  verifyToken(nodeId: string, token: string): boolean {
    return safeEqual(token, this.tokenFor(nodeId));
  }

  // ---- queries ----

  view(id: string): NodeView | undefined {
    const rec = this.registry.get(id);
    const status = this.statuses.get(id);
    return rec && status ? { ...rec, status: status.model || !rec.model ? status : { ...status, model: rec.model }, unread: this.unread.has(id) } : undefined;
  }

  list(): NodeView[] {
    return this.registry.list().flatMap((n) => this.view(n.id) ?? []);
  }

  /** The live PTY, for readers such as the MCP layer. Undefined once the process is gone or the node closed. */
  session(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  // ---- lifecycle ----

  spawn(req: SpawnRequest): NodeView {
    const rec = this.registry.create({
      parentId: req.parentId ?? null, kind: req.kind, title: req.title, cwd: req.cwd,
      model: req.model, permissionMode: req.permissionMode, role: req.role,
      sessionId: req.kind === 'claude' ? randomUUID() : undefined,
    });
    try {
      this.writeFiles(rec.id);
      this.statuses.set(rec.id, { state: initialState(req.kind), sessionId: rec.sessionId, changedAt: Date.now() });
      this.launch(rec.id, req.prompt, false);
    } catch (err) {
      this.discard(rec.id);
      throw err;
    }
    return this.emitNode(rec.id)!;
  }

  /** Relaunch an exited Claude node with `claude --resume`. Fails if the transcript is gone. */
  resume(id: string): { ok: true } | { ok: false; error: string } {
    const rec = this.registry.get(id);
    if (!rec) return { ok: false, error: 'No such node' };
    if (rec.kind !== 'claude') return { ok: false, error: 'Only Claude nodes can be resumed' };
    if (this.sessions.get(id)) return { ok: false, error: 'Node is still running' };
    const status = this.statuses.get(id)!;
    const sessionId = status.sessionId ?? rec.sessionId;
    if (!sessionId) return { ok: false, error: 'No session to resume' };
    const transcript = status.transcriptPath ?? rec.transcriptPath ?? transcriptFor(rec.cwd, sessionId);
    if (!existsSync(transcript)) return { ok: false, error: `No conversation to resume (missing ${transcript})` };
    this.lastHookAt.delete(id);
    try {
      this.writeFiles(id); // the port, and so the endpoint in mcp.json, may have changed since the node was created
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    this.statuses.set(id, { state: 'unknown', sessionId, transcriptPath: transcript, changedAt: Date.now() });
    try {
      this.launch(id, undefined, true);
    } catch (err) {
      this.statuses.set(id, { ...status, exited: true, changedAt: Date.now() });
      return { ok: false, error: (err as Error).message };
    }
    this.emitNode(id);
    return { ok: true };
  }

  /**
   * Kill the node's process and relaunch it with the same record under a fresh session id, so a Claude node starts with
   * an empty context. Children and parentId are untouched; the old session ids are kept in previousSessions.
   */
  restart(id: string): { ok: true } | { ok: false; error: string } {
    const rec = this.registry.get(id);
    if (!rec) return { ok: false, error: 'No such node' };
    const old = this.statuses.get(id)?.sessionId ?? rec.sessionId;
    clearTimeout(this.interruptTimers.get(id));
    const s = this.sessions.get(id);
    this.sessions.delete(id); // first, so the exit callback ignores it
    s?.kill();
    this.lastHookAt.delete(id);
    const sessionId = rec.kind === 'claude' ? randomUUID() : undefined;
    this.registry.update(id, { sessionId, transcriptPath: undefined, previousSessions: [...(rec.previousSessions ?? []), ...(old ? [old] : [])].slice(-MAX_PREVIOUS_SESSIONS) });
    this.statuses.set(id, { state: initialState(rec.kind), sessionId, activity: 'restarting', changedAt: Date.now() });
    try {
      this.writeFiles(id);
      this.emit('data', id, '\x1bc'); // reset attached screens before the new process draws
      this.launch(id, undefined, false);
    } catch (err) {
      this.setStatus(id, { ...this.statuses.get(id)!, state: initialState(rec.kind), exited: true, activity: undefined, changedAt: Date.now() }, false);
      return { ok: false, error: (err as Error).message };
    }
    this.emitNode(id);
    return { ok: true };
  }

  /** Close and delete a node. A root (orchestrator) is refused unless `force`; use restart to clear one instead. */
  close(id: string, force = false): void {
    if (!force && this.registry.get(id)?.parentId === null) throw new Error('refusing to close an orchestrator: restart it instead, or force the close');
    const s = this.sessions.get(id);
    clearTimeout(this.interruptTimers.get(id));
    this.sessions.delete(id); // first, so the exit callback ignores it
    s?.kill();
    if (!this.registry.get(id)) return;
    this.discard(id);
    this.emit('removed', id);
  }

  /** Close every exited node with no live descendant; returns the removed ids. */
  prune(): string[] {
    const ids = pruneIds(this.list());
    for (const id of ids) this.close(id, true); // exited only, so never a live orchestrator
    return ids;
  }

  rename(id: string, title: string): void {
    if (this.registry.update(id, { title })) this.emitNode(id);
  }

  /** A client selected `id`, which clears its unread flag. */
  select(id: string): void {
    if (this.unread.delete(id)) this.emitNode(id);
  }

  input(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const status = this.statuses.get(id)!;
    if (interruptKeyPressed(status, data)) {
      // Esc / Ctrl-C ends a turn without a Stop hook. If no hook shows up, call it interrupted.
      const sentAt = Date.now();
      clearTimeout(this.interruptTimers.get(id));
      const timer = setTimeout(() => {
        this.interruptTimers.delete(id);
        const cur = this.statuses.get(id);
        if (cur && (this.lastHookAt.get(id) ?? 0) < sentAt) this.setStatus(id, interruptTimeout(cur, Date.now()));
      }, INTERRUPT_MS);
      timer.unref();
      this.interruptTimers.set(id, timer);
    }
    s.write(data).catch(logError);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows);
  }

  /** Resize to the viewer and return the visible screen serialized with attributes. */
  async attach(id: string, cols: number, rows: number): Promise<string> {
    const s = this.sessions.get(id);
    if (!s) return '';
    s.resize(cols, rows);
    await s.flush();
    return s.snapshot();
  }

  applyHook(nodeId: string, event: HookEvent): void {
    const rec = this.registry.get(nodeId);
    const prev = this.statuses.get(nodeId);
    if (!rec || !prev) return;
    const now = Date.now();
    this.lastHookAt.set(nodeId, now);
    this.emit('hook', nodeId, event);
    const next = reduce(prev, event, now);
    if (event.hook_event_name === 'SessionStart' && next.sessionId && next.sessionId !== rec.sessionId) {
      this.registry.update(nodeId, { sessionId: next.sessionId });
    }
    if (event.hook_event_name === 'SessionStart' && next.transcriptPath && next.transcriptPath !== rec.transcriptPath) {
      this.registry.update(nodeId, { transcriptPath: next.transcriptPath });
    }
    if (next.permissionMode && next.permissionMode !== rec.permissionMode) {
      this.registry.update(nodeId, { permissionMode: next.permissionMode });
    }
    this.setStatus(nodeId, next);
  }

  /** Apply an event from the node's mod. turn.start carries nothing we need. */
  applyModEvent(nodeId: string, ev: ModEvent): void {
    const prev = this.statuses.get(nodeId);
    if (!prev) return;
    const now = Date.now();
    if (process.env.O8_DEBUG) console.log(`${new Date(now).toISOString().slice(11, 23)} mod ${nodeId.slice(0, 6)} ${ev.event} ${JSON.stringify(ev.payload).slice(0, 300)}`);
    if (ev.event === 'turn.complete') {
      const model = ev.payload.usage?.model;
      const base = typeof model === 'string' && model !== prev.model ? { ...prev, model } : prev;
      this.setStatus(nodeId, turnComplete(base, now, ev.payload));
    } else if (ev.event === 'session.measure') {
      const { context, cost } = ev.payload;
      this.setStatus(nodeId, { ...prev, contextPct: context?.percent ?? prev.contextPct, contextTokens: context?.tokens ?? prev.contextTokens, contextWindow: context?.window ?? prev.contextWindow, costUsd: cost?.usd ?? prev.costUsd });
    }
  }

  /** Flush the registry and the message inbox, and kill every PTY. */
  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const t of this.interruptTimers.values()) clearTimeout(t);
    for (const s of this.sessions.values()) s.kill();
    this.registry.flush();
    flushInbox(this);
  }

  // ---- internals ----

  private nodeDir(id: string): string { return join(this.home, 'nodes', id); }

  /** Token, hook-headers, settings.json and mcp.json for a node; mcp.json embeds the current endpoint. */
  private writeFiles(id: string): void {
    const dir = this.nodeDir(id);
    const token = this.tokenFor(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
    writeFileSync(join(dir, 'hook-headers'), `Authorization: Bearer ${token}\nX-O8-Node: ${id}\n`, { mode: 0o600 }); // read by hook.sh via curl -H @file
    writeNodeFiles(dir, { nodeId: id, endpoint: this.endpoint, token });
  }

  private discard(id: string): void {
    this.registry.remove(id);
    this.statuses.delete(id);
    this.unread.delete(id);
    this.lastHookAt.delete(id);
    rmSync(this.nodeDir(id), { recursive: true, force: true });
  }

  private launch(id: string, prompt: string | undefined, resume: boolean): void {
    const rec = this.registry.get(id)!;
    const input: LaunchInput = {
      nodeId: id, nodeDir: this.nodeDir(id), endpoint: this.endpoint, path: this.path,
      title: rec.title, parentId: rec.parentId, home: this.home, cwd: rec.cwd, role: rec.role, sessionId: this.statuses.get(id)?.sessionId ?? rec.sessionId ?? '',
      resume, prompt, model: rec.model, permissionMode: rec.permissionMode,
    };
    const spec: LaunchSpec = rec.kind === 'claude' ? claudeLaunch(input) : terminalLaunch(input, this.shell);
    const s = PtySession.spawn({ ...spec, cwd: rec.cwd, ...DEFAULT_SIZE });
    this.sessions.set(id, s);
    s.onData((d) => this.emit('data', id, d));
    s.onExit(() => {
      if (this.sessions.get(id) !== s) return;
      this.sessions.delete(id);
      const prev = this.statuses.get(id)!;
      this.markUnread(id);
      this.setStatus(id, ptyExited(prev, Date.now()), false);
      this.emit('notify', { id, kind: 'exited', title: rec.title } satisfies NotifyEvent);
    });
    if (rec.kind === 'claude') this.watchTrust(id, s, rec.cwd).catch(logError);
  }

  /**
   * Watch a fresh Claude screen for the folder-trust dialog; answer it only if policy allows. The dialog's
   * heading scrolls out of the viewport, so match on the option text and footer instead.
   */
  private async watchTrust(id: string, s: PtySession, cwd: string): Promise<void> {
    const auto = trustPolicy(cwd, readClaudeJson()) === 'auto';
    for (const end = Date.now() + TRUST_WATCH_MS; Date.now() < end; await sleep(250)) {
      if (s.exited || this.sessions.get(id) !== s || this.lastHookAt.has(id)) return;
      await s.flush();
      const screen = s.screenTail(30).join('\n');
      if (!screen.includes('Yes, I trust this folder') || !screen.includes('Enter to confirm')) continue;
      if (auto) {
        await s.write('\x1b[B');
        await sleep(300);
        await s.write('\r');
      } else {
        const prev = this.statuses.get(id)!;
        this.setStatus(id, { ...prev, state: 'blocked', activity: TRUST_BLOCKED_ACTIVITY, changedAt: Date.now() });
      }
      return;
    }
  }

  private sweepStale(): void {
    for (const [id, prev] of this.statuses) this.setStatus(id, sweep(prev, Date.now()));
  }

  /** Store a new status, broadcast it, and notify on transitions into done / blocked / waiting. */
  private setStatus(id: string, next: NodeStatus, notify = true): void {
    const prev = this.statuses.get(id);
    if (!prev || next === prev) return;
    this.statuses.set(id, next);
    let kind: NotifyEvent['kind'] | undefined;
    if (notify && next.state !== prev.state) {
      if (next.state === 'done') kind = next.errored ? 'errored' : 'done';
      else if (NEEDS_YOU_STATES.includes(next.state)) kind = 'needsYou';
    }
    if (kind) this.markUnread(id);
    this.emitNode(id);
    if (kind) {
      const title = this.registry.get(id)?.title ?? id;
      this.emit('notify', { id, kind, title, body: (next.lastAssistantMessage ?? next.activity)?.slice(0, 200) } satisfies NotifyEvent);
    }
  }

  private markUnread(id: string): void {
    if (!this.isSelected(id)) this.unread.add(id);
  }

  private emitNode(id: string): NodeView | undefined {
    const v = this.view(id);
    if (v) this.emit('node', v);
    return v;
  }
}
