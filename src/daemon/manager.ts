import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { NEEDS_YOU_STATES, type AgentState, type Diff, type GitState, type ModEvent, type NodeKind, type NodeStatus, type NodeView, type Effort, type Isolation, type Role, type Usage, type Worktree } from '../shared/protocol.js';
import { loadConfig, type Limits, type MergeStyle } from './config.js';
import { homeDir } from './home.js';
import { claudeLaunch, ensurePrompts, roleFor, terminalLaunch, writeNodeFiles, type LaunchInput, type LaunchSpec } from './launch.js';
import { pruneIds } from '../shared/prune.js';
import { dayKey } from '../shared/spend.js';
import { treeOrder } from '../shared/tree.js';
import { flushInbox } from './messaging.js';
import { NodeRegistry } from './nodes.js';
import { buildChildEnv, PtySession } from './pty.js';
import { logError, safeEqual } from './util.js';
import * as wt from './worktree.js';
import { interruptKeyPressed, interruptTimeout, ptyExited, reduce, stall, sweep, turnComplete, type HookEvent } from './status.js';

const MAX_PREVIOUS_SESSIONS = 10;
const INTERRUPT_MS = 1500;
const SWEEP_MS = 60_000;
const TRUST_WATCH_MS = 20_000;
const TRUST_BLOCKED_ACTIVITY = 'Trust dialog: answer it in the terminal';
/** The marker (U+276F) Claude draws in front of the selected option of a dialog. */
const SELECTED = String.fromCodePoint(0x276f);
const DEFAULT_SIZE = { cols: 120, rows: 40 };
/** Main checkouts in which this daemon has created worktrees, so reconciliation finds them after a lost record. */
const REPOS_FILE = 'worktree-repos.json';
/** How long close waits for a killed worktree node to exit, so Claude's lock on the worktree belongs to a dead pid. */
const EXIT_WAIT_MS = 3000;
/** After an edit, wait this long for more before recomputing a worktree's git state. */
const GIT_DEBOUNCE_MS = 3000;
const GIT_EDIT_TOOLS = ['Edit', 'Write', 'Bash'];
/** Limit for each worktree setup or teardown command. */
const SETUP_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A node's state before any hook arrives: a Claude node is unknown until SessionStart; a terminal has no agent state. */
const initialState = (kind: NodeKind): AgentState => (kind === 'claude' ? 'unknown' : 'none');
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

/** What stands between a node's worktree and its removal. */
export interface WorktreeCheck { dirty: string[]; unmerged: string[]; sharing: string[] }

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Why closing a worktree node must not go ahead, or undefined. Another live node working inside the tree always
 * refuses; uncommitted files or unmerged commits refuse unless the close says keep or discard. Short and action first:
 * the mux cuts it to 60 characters.
 */
export function closeRefusal(c: WorktreeCheck, mode?: 'keep' | 'discard'): string | undefined {
  const unsafe = !mode && (c.dirty.length > 0 || c.unmerged.length > 0);
  const sharing = c.sharing.length ? `in use by ${c.sharing.join(', ')}` : '';
  if (!unsafe) return sharing ? `worktree ${sharing}; close those nodes first` : undefined;
  const msg = `worktree kept: ${count(c.dirty.length, 'dirty file')}, ${count(c.unmerged.length, 'unmerged commit')}; close with keep or discard`;
  return sharing ? `${msg}; ${sharing}` : msg;
}

export interface WorktreeReport {
  nodes: { nodeId: string; title: string; repo: string; path: string; branch: string; base: string; missing?: boolean }[];
  /** Worktrees with this daemon's marker but no node, left by a crash between creating the worktree and saving the record. */
  orphans: { nodeId: string; repo: string; path: string; branch?: string; base: string; dirty: string[]; unmerged: string[]; error?: string }[];
  /** <prefix>n-<hex> branches with neither a worktree nor a node, such as those kept by close with keep. */
  kept: { repo: string; branch: string; unmerged: string[] }[];
  /** What a clean removed, with the commits and uncommitted files that went with it. */
  removed: { what: string; commits: string[]; files: string[] }[];
}

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

/**
 * Whether `claude --worktree` will start in `repo`. Interactively it exits with "Workspace trust not yet accepted" unless
 * trust is recorded for the repo itself: with 2.1.296 a trusted ancestor did not count when the repo had its own entry.
 */
export function trustedForWorktree(repo: string, claudeJson: unknown): boolean {
  return (claudeJson as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | null)?.projects?.[repo]?.hasTrustDialogAccepted === true;
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
  effort?: Effort;
  permissionMode?: string;
  role?: Role;
  parentId?: string | null;
  isolation?: Isolation;
  /** Set for the human's spawns (web UI, app, mux, admin token), which skip the spawn caps. */
  byHuman?: boolean;
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
 *   'usage'   (u: Usage)                  a node reported account-level rate limits
 */
export class NodeManager extends EventEmitter {
  readonly home: string;
  readonly registry: NodeRegistry;
  /** Newest account-level rate limits from any node. Not persisted: the next measure after a restart refills it. */
  usage?: Usage;
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
  /** Worktree nodes being closed or merged; the two exclude each other. */
  private busy = new Map<string, 'closing' | 'merging'>();
  private gits = new Map<string, GitState>();
  private gitTimers = new Map<string, NodeJS.Timeout>();
  /** The branch tip and time of each node's last merge: a squashed branch counts as merged until it moves. */
  private merged = new Map<string, { tip: string; at: number }>();
  /** Worktree setups in progress, so close can stop one. */
  private setups = new Map<string, { abort: AbortController; done: Promise<void> }>();
  /** Nodes whose setup has not succeeded yet, with the prompt to launch them with once it does; restart retries it. */
  private needsSetup = new Map<string, string | undefined>();
  /** Ids that were live when the daemon last went away, until resumeLive has dealt with them. */
  private pendingResume: Set<string>;
  /** Set by shutdown: the live set is then frozen, so the PTYs' exits do not empty it. */
  private stopped = false;

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
    this.pendingResume = new Set(this.registry.live);
    // Nodes from a previous run have no process; they can be resumed.
    for (const n of this.registry.list()) {
      this.statuses.set(n.id, { state: initialState(n.kind), exited: true, sessionId: n.sessionId, transcriptPath: n.transcriptPath, changedAt: Date.now() });
      this.refreshGit(n.id).catch(logError);
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
    if (!rec || !status) return undefined;
    const s = status.model || !rec.model ? status : { ...status, model: rec.model };
    const git = this.gits.get(id);
    return { ...rec, status: git ? { ...s, git } : s, unread: this.unread.has(id) };
  }

  list(): NodeView[] {
    return this.registry.list().flatMap((n) => this.view(n.id) ?? []);
  }

  /** The live PTY, for readers such as the MCP layer. Undefined once the process is gone or the node closed. */
  session(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  // ---- lifecycle ----

  /** The request's isolation, else the config default for a claude node whose role is worker or none. */
  isolationFor(req: SpawnRequest): Isolation {
    if (req.isolation) return req.isolation;
    if (req.kind !== 'claude' || roleFor(req.role, req.parentId ?? null) === 'orchestrator') return 'none';
    return loadConfig(req.cwd, this.home).worktrees.isolation;
  }

  /** Throw when an agent's spawn would pass limits.maxDepth, maxChildren or maxLiveNodes (from req.cwd's config). */
  private checkLimits(req: SpawnRequest): void {
    if (req.byHuman) return;
    const parentId = req.parentId ?? null;
    const { maxDepth, maxChildren, maxLiveNodes } = loadConfig(req.cwd, this.home).limits;
    const refuse = (cap: keyof Limits, value: number, what: string) => {
      throw new Error(`refused: limits.${cap} is ${value} and ${what}; reuse an idle worker (send it the work) or close finished ones`);
    };
    const depth = parentId === null ? 0 : this.registry.lineage(parentId).length + 1;
    if (depth > maxDepth) refuse('maxDepth', maxDepth, `the new node would be ${depth} levels below the root`);
    const children = this.registry.list().filter((n) => n.parentId === parentId && this.sessions.has(n.id)).length;
    if (parentId !== null && children >= maxChildren) refuse('maxChildren', maxChildren, `${parentId} has ${children} live children`);
    if (this.sessions.size >= maxLiveNodes) refuse('maxLiveNodes', maxLiveNodes, `${this.sessions.size} nodes are live`);
  }

  /** Spawn a node without a worktree. A spawn that resolves to isolation "worktree" goes through spawnWorktree. */
  spawn(req: SpawnRequest): NodeView {
    if (this.isolationFor(req) === 'worktree') throw new Error('a worktree spawn is asynchronous: call spawnWorktree');
    this.checkLimits(req);
    const parentId = req.parentId ?? null;
    // Unset model or effort: the config's value for the node's role (role none counts as worker), recorded so restart keeps it.
    const defaults = req.kind === 'claude' ? loadConfig(req.cwd, this.home).roles[roleFor(req.role, parentId) === 'orchestrator' ? 'orchestrator' : 'worker'] : {};
    const model = req.model ?? defaults.model, effort = req.effort ?? defaults.effort;
    const rec = this.registry.create({
      parentId, kind: req.kind, title: req.title, cwd: req.cwd,
      model, effort, permissionMode: req.permissionMode, role: req.role,
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

  /**
   * Spawn a Claude node in its own worktree, <main checkout>/.claude/worktrees/<id> on branch <prefix><id>, branched
   * from the HEAD of the checkout req.cwd is in. The repo must have a commit and be trusted by Claude. Any failure
   * removes the worktree and branch and discards the record.
   */
  async spawnWorktree(req: SpawnRequest): Promise<NodeView> {
    if (req.kind !== 'claude') throw new Error('isolation "worktree" is for claude nodes only');
    this.checkLimits(req);
    const repo = await wt.mainCheckout(req.cwd);
    const { base, baseSha } = await wt.headInfo(req.cwd);
    if (!trustedForWorktree(repo, readClaudeJson())) throw new Error(`refusing isolation "worktree": Claude does not trust ${repo} yet; run claude once in ${repo} to trust it`);
    const config = loadConfig(repo, this.home); // the main checkout's file, whichever branch req.cwd has checked out
    const parentId = req.parentId ?? null;
    const defaults = config.roles[roleFor(req.role, parentId) === 'orchestrator' ? 'orchestrator' : 'worker'];
    const rec = this.registry.create({
      parentId, kind: 'claude', title: req.title, cwd: req.cwd,
      model: req.model ?? defaults.model, effort: req.effort ?? defaults.effort, permissionMode: req.permissionMode, role: req.role,
      sessionId: randomUUID(),
    });
    const path = join(repo, wt.WORKTREES_DIR, rec.id);
    const worktree: Worktree = { repo, path, branch: config.worktrees.branchPrefix + rec.id, base, baseSha };
    this.registry.update(rec.id, { cwd: path, worktree });
    let added = false;
    try {
      this.rememberRepo(repo); // first, so startup reconciliation looks here even if a crash loses the record
      await wt.add(repo, path, worktree.branch, baseSha);
      added = true;
      await wt.writeMarker(path, { home: this.home, nodeId: rec.id, base, baseSha });
      await wt.ensureExcluded(repo);
      this.registry.flush(); // a crash from here on leaves a record, not an orphan
      await wt.copyIncluded(repo, path, config.worktrees.include);
      this.writeFiles(rec.id);
      this.statuses.set(rec.id, { state: initialState('claude'), sessionId: rec.sessionId, changedAt: Date.now() });
      const setup = this.worktreeCommands(repo, 'setup');
      if (setup.length) this.setupThenLaunch(rec.id, worktree, setup, req.prompt); // in the background: it may take minutes
      else this.launch(rec.id, req.prompt, false);
    } catch (err) {
      if (added) await this.teardown(rec.id, worktree).then(() => wt.remove(repo, path, true)).then(() => wt.deleteBranch(repo, worktree.branch)).catch(logError);
      this.discard(rec.id);
      throw err;
    }
    this.refreshGit(rec.id).catch(logError);
    return this.emitNode(rec.id)!;
  }

  /**
   * Merge a worktree node's branch into its base in the project's style (worktrees.merge). Refused, with nothing changed,
   * while the node is working, closing or setting up, when its tree has uncommitted files, or when the branch conflicts
   * with base (the error names the paths).
   */
  /** A worktree node's changes since it branched, committed or not. */
  async diff(id: string): Promise<Diff> {
    const rec = this.registry.get(id);
    if (!rec) throw new Error(`no such node: ${id}`);
    if (!rec.worktree) throw new Error(`${id} has no worktree of its own to diff`);
    return wt.diff(rec.worktree);
  }

  async merge(id: string): Promise<{ base: string; sha: string; style: MergeStyle }> {
    const rec = this.registry.get(id);
    if (!rec) throw new Error(`no such node: ${id}`);
    const w = rec.worktree;
    if (!w) throw new Error(`${id} has no worktree of its own to merge`);
    const s = this.statuses.get(id)!;
    if (s.state === 'working' && !s.exited) throw new Error(`refusing to merge while ${id} is working; wait until its turn ends`);
    if (this.setups.has(id)) throw new Error('worktree setup is running');
    if (this.busy.has(id)) throw new Error(`${id} is already ${this.busy.get(id)}`);
    this.busy.set(id, 'merging');
    try {
      await this.refreshGit(id).catch(logError);
      const dirty = existsSync(w.path) ? await wt.dirtyFiles(w.path) : [];
      if (dirty.length) throw new Error(`merge refused, nothing changed: ${count(dirty.length, 'uncommitted file')} in the worktree; commit them first`);
      const style = loadConfig(w.repo, this.home).worktrees.merge;
      const subject = style === 'squash' ? `${rec.title} (squashed from ${w.branch})` : `Merge branch '${w.branch}': ${rec.title}`;
      const sha = await wt.mergeInto(w.repo, w.branch, w.base, style, subject);
      this.merged.set(id, { tip: await this.branchTip(w), at: Date.now() });
      return { base: w.base, sha, style };
    } finally {
      this.busy.delete(id);
      await this.refreshGit(id).catch(logError);
    }
  }

  /** Relaunch an exited Claude node with `claude --resume`. Fails if the transcript or the node's worktree is gone. */
  async resume(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const rec = this.registry.get(id);
    if (!rec) return { ok: false, error: 'No such node' };
    if (rec.kind !== 'claude') return { ok: false, error: 'Only Claude nodes can be resumed' };
    if (this.sessions.get(id)) return { ok: false, error: 'Node is still running' };
    if (this.setups.has(id)) return { ok: false, error: 'worktree setup is running' };
    if (this.needsSetup.has(id)) return { ok: false, error: 'worktree setup has not succeeded; restart runs it again' };
    if (rec.worktree) {
      // Without its worktree, claude --resume carries on in the main checkout with no isolation.
      const w = rec.worktree;
      const listed = existsSync(w.path) && (await wt.listWorktrees(w.repo).catch(() => [])).some((e) => e.path === w.path);
      this.setMissing(id, !listed);
      if (!listed) return { ok: false, error: 'worktree missing' };
      if (this.sessions.get(id)) return { ok: false, error: 'Node is still running' };
    }
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
    if (rec.worktree && !existsSync(rec.worktree.path)) return { ok: false, error: 'worktree missing' }; // --worktree would make a fresh one
    if (this.setups.has(id)) return { ok: false, error: 'worktree setup is running' };
    const old = this.statuses.get(id)?.sessionId ?? rec.sessionId;
    clearTimeout(this.interruptTimers.get(id));
    const s = this.sessions.get(id);
    this.sessions.delete(id); // first, so the exit callback ignores it
    this.liveChanged();
    s?.kill();
    this.lastHookAt.delete(id);
    const sessionId = rec.kind === 'claude' ? randomUUID() : undefined;
    this.registry.update(id, { sessionId, transcriptPath: undefined, previousSessions: [...(rec.previousSessions ?? []), ...(old ? [old] : [])].slice(-MAX_PREVIOUS_SESSIONS) });
    this.statuses.set(id, { state: initialState(rec.kind), sessionId, activity: 'restarting', changedAt: Date.now() });
    try {
      this.writeFiles(id);
      this.emit('data', id, '\x1bc'); // reset attached screens before the new process draws
      if (rec.worktree && this.needsSetup.has(id)) this.setupThenLaunch(id, rec.worktree, this.worktreeCommands(rec.worktree.repo, 'setup'), this.needsSetup.get(id));
      else this.launch(id, undefined, false);
    } catch (err) {
      this.setStatus(id, { ...this.statuses.get(id)!, state: initialState(rec.kind), exited: true, activity: undefined, changedAt: Date.now() }, false);
      return { ok: false, error: (err as Error).message };
    }
    this.emitNode(id);
    return { ok: true };
  }

  /**
   * Close and delete a node. A root (orchestrator) is refused unless `force`; use restart to clear one instead.
   * For a node that owns a worktree, `worktree` picks what happens to it: by default the close is refused, with the node
   * left running, unless the tree is clean and its branch merged; "keep" commits any changes as WIP and keeps the branch;
   * "discard" deletes both. Either way it is refused while another live node works inside the tree. Returns a note
   * when a branch is kept.
   */
  async close(id: string, force = false, worktree?: 'keep' | 'discard'): Promise<string | undefined> {
    const rec = this.registry.get(id);
    if (!force && rec?.parentId === null) throw new Error('refusing to close an orchestrator: restart it instead, or force the close');
    if (rec?.worktree) return this.closeWorktreeNode(id, rec.title, rec.worktree, worktree);
    this.kill(id);
    if (!this.registry.get(id)) return undefined;
    this.discard(id);
    this.emit('removed', id);
    return undefined;
  }

  private async closeWorktreeNode(id: string, title: string, w: Worktree, mode?: 'keep' | 'discard'): Promise<string | undefined> {
    if (this.busy.has(id)) throw new Error(`${id} is already ${this.busy.get(id)}`);
    this.busy.set(id, 'closing');
    try {
      await this.refreshGit(id).catch(logError);
      const refusal = closeRefusal((await this.worktreeCheck(id))!, mode);
      if (refusal) throw new Error(refusal);
      const setup = this.setups.get(id);
      setup?.abort.abort();
      await setup?.done;
      const s = this.kill(id);
      if (s && !s.exited) await new Promise<void>((done) => { s.onExit(() => done()); setTimeout(done, EXIT_WAIT_MS).unref(); });
      let note: string | undefined;
      try {
        note = await this.removeWorktree(id, title, w, mode);
      } catch (err) {
        this.setStatus(id, { ...this.statuses.get(id)!, exited: true, activity: (err as Error).message, changedAt: Date.now() }, false);
        throw err;
      }
      this.discard(id);
      this.emit('removed', id);
      return note;
    } finally {
      this.busy.delete(id);
    }
  }

  /** Kill the node's process, if any, and forget it; returns the session it had. */
  private kill(id: string): PtySession | undefined {
    const s = this.sessions.get(id);
    clearTimeout(this.interruptTimers.get(id));
    this.sessions.delete(id); // first, so the exit callback ignores it
    this.liveChanged();
    s?.kill();
    return s;
  }

  /** Close every exited node with no live descendant. A node whose worktree is not safe to remove is kept, with the reason. */
  async prune(): Promise<{ removed: string[]; kept: { id: string; reason: string }[] }> {
    const removed: string[] = [], kept: { id: string; reason: string }[] = [];
    for (const id of pruneIds(this.list())) {
      try {
        await this.close(id, true); // exited only, so never a live orchestrator
        removed.push(id);
      } catch (err) {
        kept.push({ id, reason: (err as Error).message });
      }
    }
    return { removed, kept };
  }

  /** Uncommitted files, unmerged commits and other live nodes inside the node's worktree; undefined when it owns none. */
  async worktreeCheck(id: string): Promise<WorktreeCheck | undefined> {
    const w = this.registry.get(id)?.worktree;
    if (!w) return undefined;
    const sharing = this.registry.list().filter((n) => n.id !== id && this.sessions.has(n.id) && inside(n.cwd, w.path)).map((n) => n.id);
    if (!existsSync(w.path)) return { dirty: [], unmerged: [], sharing }; // missing: close keeps an unmerged branch, so nothing is lost
    const [dirty, unmerged] = await Promise.all([wt.dirtyFiles(w.path), wt.unmergedCommits(w.repo, w.branch, w.base, w.baseSha)]);
    // A squash merge leaves the branch's own commits outside base; it still counts as merged until the branch moves.
    return { dirty, unmerged: unmerged.length && (await this.mergedAt(id, w)) ? [] : unmerged, sharing };
  }

  /**
   * Reconcile worktrees with the registry, for every repo this daemon has used (or only the one `cwd` is in): drop git's
   * entries for deleted directories, mark nodes whose worktree is missing, and list orphans and kept branches.
   * clean "startup" removes orphans that are clean and have no commits; "safe" removes orphans and kept branches that are
   * clean and merged; "force" removes them all. Nothing inside a live node's cwd is removed.
   */
  async worktrees(opts: { cwd?: string; clean?: 'startup' | 'safe' | 'force' } = {}): Promise<WorktreeReport> {
    const repos = opts.cwd ? [await wt.mainCheckout(opts.cwd)]
      : [...new Set([...this.knownRepos(), ...this.registry.list().flatMap((n) => (n.worktree ? [n.worktree.repo] : []))])];
    const report: WorktreeReport = { nodes: [], orphans: [], kept: [], removed: [] };
    for (const repo of repos) {
      if (!existsSync(repo)) continue;
      try { await this.reconcileRepo(repo, opts.clean, report); } catch (err) { if (opts.cwd) throw err; logError(err); }
    }
    return report;
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
    if (next.state !== prev.state) this.registry.update(nodeId, { lastActiveAt: now });
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
    const e = event.hook_event_name;
    if (e === 'Stop' || e === 'StopFailure') this.refreshGit(nodeId).catch(logError);
    else if (e === 'PostToolUse' && GIT_EDIT_TOOLS.includes(String(event.tool_name)) && rec.worktree) this.refreshGitSoon(nodeId);
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
      this.refreshGit(nodeId).catch(logError);
    } else if (ev.event === 'session.measure') {
      const { context, cost, rateLimits } = ev.payload;
      if (rateLimits?.length) { // empty off a subscription or before the first reading: keep the last report
        this.usage = { rateLimits, nodeId, at: now };
        this.emit('usage', this.usage);
      }
      if (cost) this.addSpend(nodeId, cost.usd, prev.costUsd, now);
      this.setStatus(nodeId, { ...prev, contextPct: context?.percent ?? prev.contextPct, contextTokens: context?.tokens ?? prev.contextTokens, contextWindow: context?.window ?? prev.contextWindow, costUsd: cost?.usd ?? prev.costUsd });
    }
  }

  /**
   * Resume the nodes that were live when the daemon last went away, parents first. Skips nodes that no longer exist, have
   * lost their worktree or have been idle longer than resumeMaxAgeDays; then forgets the set, so it holds only nodes that
   * come up again. Returns a one-line summary.
   */
  async resumeLive(): Promise<string> {
    const ids = this.pendingResume;
    const { resumeOnStart, resumeMaxAgeDays } = loadConfig(null, this.home);
    let summary = 'nothing to resume';
    if (ids.size && !resumeOnStart) summary = `resumeOnStart is off; not resuming ${count(ids.size, 'node')}`;
    else if (ids.size) {
      const cutoff = Date.now() - resumeMaxAgeDays * 86_400_000;
      const skipped = [...ids].filter((id) => !this.registry.get(id)).map((id) => `${id} (no such node)`);
      let resumed = 0;
      for (const { node: n } of treeOrder(this.registry.list())) {
        if (!ids.has(n.id)) continue;
        if ((n.lastActiveAt ?? n.createdAt) < cutoff) { skipped.push(`${n.id} (idle over ${resumeMaxAgeDays} days)`); continue; }
        const r = await this.resume(n.id);
        if (r.ok) resumed++;
        else skipped.push(`${n.id} (${r.error})`);
      }
      summary = `resumed ${resumed}, skipped ${skipped.length}${skipped.length ? `: ${skipped.join(', ')}` : ''}`;
    }
    this.pendingResume = new Set();
    this.liveChanged();
    return `resume on start: ${summary}`;
  }

  /**
   * Flush the registry and the message inbox, and kill every PTY. The live set is kept for resume on next start, unless
   * `clearLive` (an explicit stop: do not come back).
   */
  shutdown(opts: { clearLive?: boolean } = {}): void {
    this.stopped = true;
    if (opts.clearLive) this.registry.setLive([]);
    clearInterval(this.sweepTimer);
    for (const t of [...this.interruptTimers.values(), ...this.gitTimers.values()]) clearTimeout(t);
    for (const s of this.setups.values()) s.abort.abort();
    for (const s of this.sessions.values()) s.kill();
    this.registry.flush();
    flushInbox(this);
  }

  // ---- internals ----

  private nodeDir(id: string): string { return join(this.home, 'nodes', id); }

  /** Save the ids with a live process (plus any not yet resumed) with the registry. Call after every change to sessions. */
  private liveChanged(): void {
    if (!this.stopped) this.registry.setLive([...new Set([...this.pendingResume, ...this.sessions.keys()])]);
  }

  /** Token, hook-headers, settings.json and mcp.json for a node; mcp.json embeds the current endpoint. */
  private writeFiles(id: string): void {
    const dir = this.nodeDir(id);
    const token = this.tokenFor(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
    writeFileSync(join(dir, 'hook-headers'), `Authorization: Bearer ${token}\nX-O8-Node: ${id}\n`, { mode: 0o600 }); // read by hook.sh via curl -H @file
    writeNodeFiles(dir, { nodeId: id, endpoint: this.endpoint, token, worktree: !!this.registry.get(id)?.worktree });
  }

  private async removeWorktree(id: string, title: string, w: Worktree, mode?: 'keep' | 'discard'): Promise<string | undefined> {
    if (!existsSync(w.path)) {
      await wt.prune(w.repo);
      if (!(await wt.branchExists(w.repo, w.branch))) return undefined;
      if (mode === 'discard' || (!mode && !(await wt.unmergedCommits(w.repo, w.branch, w.base, w.baseSha)).length)) {
        await wt.deleteBranch(w.repo, w.branch);
        return undefined;
      }
      return `worktree was missing; kept branch ${w.branch}`;
    }
    if (mode === 'keep' && (await wt.dirtyFiles(w.path)).length) {
      await wt.git(w.path, ['add', '-A']);
      await wt.git(w.path, ['commit', '-q', '--no-verify', '-m', `WIP: orchestr8 node "${title}" (${id})`]);
    } else if (!mode) {
      const c = (await this.worktreeCheck(id))!; // again: the agent may have written something before it died
      if (c.dirty.length || c.unmerged.length) throw new Error(`worktree kept: changed during close (${c.dirty.length} uncommitted file(s), ${c.unmerged.length} unmerged commit(s))`);
    }
    await wt.unlockForRemoval(w.repo, w.path, id);
    await this.teardown(id, w);
    await wt.remove(w.repo, w.path, mode === 'discard');
    if (mode === 'keep') return `kept branch ${w.branch}`;
    await wt.deleteBranch(w.repo, w.branch); // merged (checked above) or discarded
    return undefined;
  }

  private async reconcileRepo(repo: string, clean: 'startup' | 'safe' | 'force' | undefined, r: WorktreeReport): Promise<void> {
    await wt.prune(repo);
    const entries = await wt.listWorktrees(repo);
    const live = (path: string) => this.registry.list().some((n) => this.sessions.has(n.id) && inside(n.cwd, path));
    for (const e of entries.filter((x) => x.path.startsWith(join(repo, wt.WORKTREES_DIR) + sep))) {
      const marker = await wt.readMarker(e.path);
      if (!marker || marker.home !== this.home || this.registry.get(marker.nodeId)?.worktree) continue; // not ours, or a node's
      const dirty = await wt.dirtyFiles(e.path);
      // A detached orphan has no branch to compare; only force removes it.
      const unmerged = e.branch ? await wt.unmergedCommits(repo, e.branch, marker.base, marker.baseSha) : ['(detached HEAD)'];
      const safe = !dirty.length && !!e.branch && (clean === 'startup' ? !(await wt.hasCommits(repo, e.branch, marker.baseSha)) : !unmerged.length);
      const orphan = { nodeId: marker.nodeId, repo, path: e.path, branch: e.branch, base: marker.base, dirty, unmerged };
      if (clean && (clean === 'force' || safe) && !live(e.path)) {
        try {
          await wt.unlockForRemoval(repo, e.path, marker.nodeId);
          await this.teardown(marker.nodeId, { repo, path: e.path, base: marker.base });
          await wt.remove(repo, e.path, clean === 'force');
          if (e.branch) await wt.deleteBranch(repo, e.branch);
          r.removed.push({ what: `worktree ${e.path}${e.branch ? ` and branch ${e.branch}` : ''}`, commits: unmerged, files: dirty });
          continue;
        } catch (err) {
          r.orphans.push({ ...orphan, error: (err as Error).message });
          continue;
        }
      }
      r.orphans.push(orphan);
    }
    for (const n of this.registry.list()) {
      if (n.worktree?.repo !== repo) continue;
      this.setMissing(n.id, !entries.some((e) => e.path === n.worktree!.path));
      const w = this.registry.get(n.id)!.worktree!;
      r.nodes.push({ nodeId: n.id, title: n.title, repo, path: w.path, branch: w.branch, base: w.base, missing: w.missing });
    }
    const prefix = loadConfig(repo, this.home).worktrees.branchPrefix;
    const used = new Set([...entries.flatMap((e) => (e.branch ? [e.branch] : [])), ...this.registry.list().flatMap((n) => (n.worktree ? [n.worktree.branch] : []))]);
    const head = await wt.headInfo(repo);
    for (const branch of await wt.branches(repo, prefix)) {
      if (used.has(branch) || !/^n-[0-9a-f]{8}$/.test(branch.slice(prefix.length))) continue;
      // The node and its recorded base are gone, so judge against the main checkout's HEAD.
      const unmerged = await wt.unmergedCommits(repo, branch, 'HEAD', head.baseSha);
      if (clean === 'force' || (clean === 'safe' && !unmerged.length)) {
        await wt.deleteBranch(repo, branch);
        r.removed.push({ what: `branch ${branch} in ${repo}`, commits: unmerged, files: [] });
      } else {
        r.kept.push({ repo, branch, unmerged });
      }
    }
  }

  private setMissing(id: string, missing: boolean): void {
    const w = this.registry.get(id)?.worktree;
    if (!w || !!w.missing === missing) return;
    const { missing: _, ...rest } = w;
    this.registry.update(id, { worktree: missing ? { ...rest, missing } : rest });
    this.emitNode(id);
  }

  /** Recompute a worktree node's git state and re-emit the node when it changed. */
  private async refreshGit(id: string): Promise<void> {
    const w = this.registry.get(id)?.worktree;
    if (!w) return;
    const missing = !existsSync(w.path);
    const none = { ahead: 0, behind: 0, additions: 0, deletions: 0 };
    const [counts, dirty, mergedAt] = await Promise.all([
      wt.branchExists(w.repo, w.branch).then(async (b) => (b ? { ...(await wt.aheadBehind(w.repo, w.branch, w.base, w.baseSha)), ...(await wt.diffStat(w)) } : none)),
      missing ? [] : wt.dirtyFiles(w.path),
      this.mergedAt(id, w),
    ]);
    if (!this.registry.get(id)) return; // closed meanwhile
    const next: GitState = { branch: w.branch, base: w.base, ...counts, dirty: dirty.length, ...(missing ? { missing } : {}), ...(mergedAt ? { mergedAt } : {}) };
    if (JSON.stringify(next) === JSON.stringify(this.gits.get(id))) return;
    this.gits.set(id, next);
    this.emitNode(id);
  }

  private refreshGitSoon(id: string): void {
    clearTimeout(this.gitTimers.get(id));
    const t = setTimeout(() => { this.gitTimers.delete(id); this.refreshGit(id).catch(logError); }, GIT_DEBOUNCE_MS);
    t.unref();
    this.gitTimers.set(id, t);
  }

  private branchTip = (w: Worktree) => wt.git(w.repo, ['rev-parse', '--verify', '-q', `refs/heads/${w.branch}`]).then((s) => s.trim(), () => '');

  /** When the node's branch was last merged, if it has not moved since; a moved branch forgets the merge. */
  private async mergedAt(id: string, w: Worktree): Promise<number | undefined> {
    const m = this.merged.get(id);
    if (!m) return undefined;
    if ((await this.branchTip(w)) === m.tip) return m.at;
    this.merged.delete(id);
    return undefined;
  }

  /** The configured setup or teardown commands for a repo, or none when Claude does not trust it (trustPolicy is not auto). */
  private worktreeCommands(repo: string, kind: 'setup' | 'teardown'): string[] {
    const cmds = loadConfig(repo, this.home).worktrees[kind];
    return cmds.length && trustPolicy(repo, readClaudeJson()) === 'auto' ? cmds : [];
  }

  private worktreeEnv(id: string, w: Pick<Worktree, 'repo' | 'path' | 'base'>): Record<string, string> {
    return buildChildEnv({ PATH: this.path, O8_NODE_ID: id, O8_WORKTREE: w.path, O8_REPO: w.repo, O8_BASE: w.base });
  }

  /**
   * Run the worktree setup commands in the background, each shown as the node's activity, then launch with `prompt`. A
   * failure leaves the node exited and errored, pointing at setup.log; restart runs the setup again.
   */
  private setupThenLaunch(id: string, w: Worktree, cmds: string[], prompt: string | undefined): void {
    const abort = new AbortController();
    const log = join(this.nodeDir(id), 'setup.log');
    const show = (patch: Partial<NodeStatus>, notify = false) => this.setStatus(id, { ...this.statuses.get(id)!, ...patch, changedAt: Date.now() }, notify);
    this.needsSetup.set(id, prompt);
    const done = wt.runCommands(cmds, {
      cwd: w.path, env: this.worktreeEnv(id, w), log, timeout: SETUP_TIMEOUT_MS, signal: abort.signal,
      onStart: (cmd) => show({ state: 'unknown', activity: `setting up worktree: ${cmd}` }),
    }).then(() => {
      if (abort.signal.aborted || !this.registry.get(id)) return;
      this.needsSetup.delete(id);
      this.statuses.set(id, { state: initialState('claude'), sessionId: this.statuses.get(id)?.sessionId, changedAt: Date.now() });
      this.launch(id, prompt, false);
      this.emitNode(id);
    }).catch((err: Error) => {
      if (abort.signal.aborted || !this.registry.get(id)) return; // closed or shut down meanwhile
      show({ state: 'done', errored: true, exited: true, activity: `worktree setup failed: ${err.message}; see ${log}` }, true);
    }).finally(() => this.setups.delete(id));
    this.setups.set(id, { abort, done });
  }

  /** Best effort: run the teardown commands in a worktree about to be removed. A failure is logged and never blocks removal. */
  private async teardown(id: string, w: Pick<Worktree, 'repo' | 'path' | 'base'>): Promise<void> {
    if (!existsSync(w.path)) return;
    const dir = this.nodeDir(id);
    for (const cmd of this.worktreeCommands(w.repo, 'teardown')) {
      await wt.runCommands([cmd], { cwd: w.path, env: this.worktreeEnv(id, w), log: existsSync(dir) ? join(dir, 'setup.log') : undefined, timeout: SETUP_TIMEOUT_MS }).catch(logError);
    }
  }

  private knownRepos(): string[] {
    try {
      const v: unknown = JSON.parse(readFileSync(join(this.home, REPOS_FILE), 'utf8'));
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }

  private rememberRepo(repo: string): void {
    const repos = this.knownRepos();
    if (!repos.includes(repo)) writeFileSync(join(this.home, REPOS_FILE), JSON.stringify([...repos, repo], null, 2));
  }

  private discard(id: string): void {
    this.registry.remove(id);
    this.statuses.delete(id);
    this.unread.delete(id);
    this.lastHookAt.delete(id);
    clearTimeout(this.gitTimers.get(id));
    for (const m of [this.gits, this.gitTimers, this.merged, this.needsSetup]) m.delete(id);
    rmSync(this.nodeDir(id), { recursive: true, force: true });
  }

  private launch(id: string, prompt: string | undefined, resume: boolean): void {
    const rec = this.registry.get(id)!;
    const owner = rec.worktree ? undefined : this.registry.list().find((n) => n.id !== id && n.worktree && this.sessions.has(n.id) && inside(rec.cwd, n.worktree.path));
    const input: LaunchInput = {
      nodeId: id, nodeDir: this.nodeDir(id), endpoint: this.endpoint, path: this.path,
      title: rec.title, parentId: rec.parentId, home: this.home, cwd: rec.cwd, role: rec.role, sessionId: this.statuses.get(id)?.sessionId ?? rec.sessionId ?? '',
      resume, prompt, model: rec.model, effort: rec.effort, permissionMode: rec.permissionMode, worktree: rec.worktree, sharesWorktreeOf: owner?.id,
    };
    const spec: LaunchSpec = rec.kind === 'claude' ? claudeLaunch(input) : terminalLaunch(input, this.shell);
    const cwd = rec.worktree?.repo ?? rec.cwd; // claude adopts the worktree itself through --worktree, or re-enters it on --resume
    const s = PtySession.spawn({ ...spec, cwd, ...DEFAULT_SIZE });
    this.sessions.set(id, s);
    this.registry.update(id, { lastActiveAt: Date.now() });
    this.liveChanged();
    s.onData((d) => this.emit('data', id, d));
    s.onExit(() => {
      if (this.sessions.get(id) !== s) return;
      this.sessions.delete(id);
      this.liveChanged();
      const prev = this.statuses.get(id)!;
      this.markUnread(id);
      this.setStatus(id, ptyExited(prev, Date.now()), false);
      this.emit('notify', { id, kind: 'exited', title: rec.title } satisfies NotifyEvent);
      this.refreshGit(id).catch(logError);
    });
    if (rec.kind === 'claude') this.watchTrust(id, s, cwd).catch(logError);
  }

  /**
   * Watch a fresh Claude screen for the folder-trust dialog; answer it only if policy allows. The dialog's
   * heading scrolls out of the viewport, so match on the option text and footer instead.
   */
  private async watchTrust(id: string, s: PtySession, cwd: string): Promise<void> {
    const auto = trustPolicy(cwd, readClaudeJson()) === 'auto';
    let downAt = 0;
    for (const end = Date.now() + TRUST_WATCH_MS; Date.now() < end; await sleep(250)) {
      if (s.exited || this.sessions.get(id) !== s || this.lastHookAt.has(id)) return;
      await s.flush();
      const lines = s.screenTail(30);
      const screen = lines.join('\n');
      if (!screen.includes('Yes, I trust this folder') || !screen.includes('Enter to confirm')) continue;
      if (!auto) {
        const prev = this.statuses.get(id)!;
        this.setStatus(id, { ...prev, state: 'blocked', activity: TRUST_BLOCKED_ACTIVITY, changedAt: Date.now() });
        return;
      }
      // The dialog draws before it takes keys, so a Down can be lost, and Enter on the default "No, exit" quits
      // Claude. Confirm only once Yes shows selected; repeat a Down that has not landed after a second.
      if (lines.some((l) => l.trimStart().startsWith(`${SELECTED} `) && l.includes('Yes, I trust this folder'))) {
        await s.write('\r');
        return;
      }
      if (Date.now() - downAt >= 1000) {
        await s.write('\x1b[B');
        downAt = Date.now();
      }
    }
  }

  /**
   * Add to the record's spend what the session spent since its last measure. A session's cost counts from zero, so a
   * figure below the last one means a new session (restart or resume) and counts whole.
   */
  private addSpend(id: string, usd: number, last: number | undefined, now: number): void {
    const rec = this.registry.get(id);
    const delta = last !== undefined && usd >= last ? usd - last : usd;
    if (!rec || !(delta > 0)) return;
    const day = dayKey(now);
    const today = rec.spentToday?.day === day ? rec.spentToday.usd : 0;
    this.registry.update(id, { spentUsd: (rec.spentUsd ?? 0) + delta, spentToday: { day, usd: today + delta } });
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [id, prev] of this.statuses) {
      const cwd = this.registry.get(id)?.cwd ?? null;
      const stalled = prev.state === 'working' ? stall(prev, now, loadConfig(cwd, this.home).limits.stallMinutes * 60_000) : prev;
      this.setStatus(id, sweep(stalled, now));
    }
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
