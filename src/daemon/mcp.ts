import { fmtAge, shortEffort, shortModel, usageLine } from '../shared/format.js';
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type http from 'node:http';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { EFFORTS, ISOLATIONS, NODE_KINDS, ROLES, type NodeView } from '../shared/protocol.js';
import { treeOrder } from '../shared/tree.js';
import { loadConfig } from './config.js';
import { ADMIN_TOKEN_FILE } from './home.js';
import { closeRefusal, type NodeManager, type WorktreeReport } from './manager.js';
import { deliver, HUMAN, inScope, isDescendant, messageStatus, startNotices } from './messaging.js';
import { logError, PREVIEW_CHARS, readBody, safeEqual } from './util.js';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
const MAX_WRITE_CHARS = 2000;
const IDEMPOTENCY_MS = 24 * 3600_000;
const TRANSCRIPT_CAP = 200_000;

interface Ctx { manager: NodeManager; confirm: (text: string) => Promise<boolean>; focus: (from: string, id: string) => void; caller: string }
interface Out { text?: string; data?: unknown }

const outcomes = new Map<string, { outcome: 'succeeded' | 'failed'; note?: string; at: number }>();

// ---- helpers ----

function flags(v: NodeView): string[] {
  const s = v.status;
  return (['errored', 'interrupted', 'exited', 'stale'] as const).filter((f) => s[f]);
}

function summarize(v: NodeView, now: number) {
  return {
    id: v.id, parentId: v.parentId, title: v.title, kind: v.kind, cwd: v.cwd, state: v.status.state, flags: flags(v), exited: !!v.status.exited, createdAt: v.createdAt,
    age: fmtAge(now - v.createdAt), activity: v.status.activity, lastAssistantMessage: v.status.lastAssistantMessage?.slice(0, PREVIEW_CHARS),
    outcome: outcomes.get(v.id),
    model: v.status.model, effort: v.status.effort, contextPct: v.status.contextPct, contextTokens: v.status.contextTokens, contextWindow: v.status.contextWindow, costUsd: v.status.costUsd,
    worktree: v.worktree && { path: v.worktree.path, branch: v.worktree.branch, base: v.worktree.base, missing: !!v.worktree.missing },
  };
}

function modelInfo(n: ReturnType<typeof summarize>): string {
  const me = [n.model && shortModel(n.model), n.effort && shortEffort(n.effort)].filter(Boolean).join(' ');
  return [me, n.contextPct !== undefined && `ctx ${Math.round(n.contextPct)}%`].filter(Boolean).map((p) => ` · ${p}`).join('');
}

function tree(nodes: ReturnType<typeof summarize>[]): string {
  return treeOrder(nodes).map(({ node: n, depth }) => {
    const extra = [...n.flags, n.activity].filter(Boolean).join(', ');
    const branch = n.worktree ? ` ⎇ ${n.worktree.branch}${n.worktree.missing ? ' (worktree missing)' : ''}` : '';
    return `${'  '.repeat(depth)}- ${n.id} "${n.title}" [${n.kind}] ${n.state}${extra ? ` (${extra})` : ''} ${n.age}${modelInfo(n)}${branch}`;
  }).join('\n') || '(no nodes)';
}

/** One user/assistant transcript entry as text; tool calls become a one-line marker, tool results vanish. */
/** `o8 worktrees` output: one section per kind, with the commits and files a clean removed. */
function worktreeText(r: WorktreeReport): string {
  const unmerged = (n: number) => (n ? `, ${n} unmerged commit(s)` : '');
  const out = [
    ...r.nodes.map((n) => `node ${n.nodeId} "${n.title}" ${n.branch} from ${n.base} at ${n.path}${n.missing ? ' (missing)' : ''}`),
    ...r.orphans.map((o) => `orphan ${o.path} ${o.branch ?? '(detached)'} from ${o.base}${o.dirty.length ? `, ${o.dirty.length} uncommitted file(s)` : ''}${unmerged(o.unmerged.length)}${o.error ? ` (not removed: ${o.error})` : ''}`),
    ...r.kept.map((k) => `kept branch ${k.branch} in ${k.repo}${unmerged(k.unmerged.length)}`),
    ...r.removed.flatMap((x) => [`removed ${x.what}`, ...x.commits.map((c) => `  commit ${c}`), ...x.files.map((f) => `  file ${f}`)]),
  ];
  return out.join('\n') || '(no orchestr8 worktrees)';
}

function renderEntry(line: string): string | undefined {
  let e: { type?: string; message?: { content?: unknown } };
  try { e = JSON.parse(line); } catch { return undefined; }
  if (e?.type !== 'user' && e?.type !== 'assistant') return undefined;
  const c = e.message?.content;
  const blocks: Array<{ type?: string; text?: string; name?: string }> = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  const text = blocks.flatMap((b) => (b?.type === 'text' && b.text ? [b.text] : b?.type === 'tool_use' ? [`[tool: ${b.name}]`] : [])).join('\n').trim();
  return text ? `${e.type}: ${text}` : undefined;
}

function requireNode(m: NodeManager, id: string): NodeView {
  const v = m.view(id);
  if (!v) throw new Error(`no such node: ${id}`);
  return v;
}

function requireScope(c: Ctx, id: string): NodeView {
  const v = requireNode(c.manager, id);
  if (!inScope(c.manager, c.caller, id)) throw new Error(`refused: ${id} is outside your lineage (self, ancestors, siblings, descendants)`);
  return v;
}

const requireOwned = (c: Ctx, id: string, allowSelf: boolean): NodeView => {
  const v = requireNode(c.manager, id);
  if (c.caller !== HUMAN && !(allowSelf && id === c.caller) && !isDescendant(c.manager, c.caller, id)) {
    throw new Error(`refused: ${id} is not ${allowSelf ? 'you or ' : ''}one of your descendants`);
  }
  return v;
};

const who = (c: Ctx) => (c.caller === HUMAN ? 'The user' : `Node ${c.manager.view(c.caller)!.title} (${c.caller})`); // authenticate() guarantees the view

// ---- tools ----

function tool<S extends z.ZodRawShape>(description: string, shape: S, run: (c: Ctx, a: z.infer<z.ZodObject<S>>) => Promise<Out>) {
  return { description, shape, run: run as (c: Ctx, a: never) => Promise<Out> };
}

const spawned = new Map<string, { args: string; result: unknown; at: number }>();

const tools = {
  list_nodes: tool(
    `List the nodes you can see (yourself, your ancestors, siblings and descendants) as an indented tree plus JSON. The text starts with one line of account-level Claude usage (5-hour and 7-day rate-limit windows, percent used and reset time), which every node draws on. Each node has id, parentId, title, kind (claude or terminal), cwd, state (working, waiting, blocked, done, unknown, none), flags (errored, interrupted, exited, stale), age, current activity, its last assistant message truncated to ${PREVIEW_CHARS} characters, the outcome it reported through report_outcome, if any, and for a node with its own git worktree, worktree { path, branch, base, missing }. Use it to find node ids before calling send, read or close.`,
    {},
    async (c) => {
      const nodes = c.manager.list().filter((v) => inScope(c.manager, c.caller, v.id)).map((v) => summarize(v, Date.now()));
      return { text: `${usageLine(c.manager.usage)}\n${tree(nodes)}`, data: nodes };
    }),

  spawn: tool(
    'Open a new node as a child of yourself and return its id. kind "claude" starts a Claude Code agent that begins working on `prompt`; kind "terminal" starts a login shell. `cwd` must be an existing directory. Spawning never changes what the user is looking at. `role` picks the role prompt the node gets: "orchestrator", "worker" or "none"; by default a node you spawn is a worker. Omit `model` and `effort` to use the defaults for the role from the project config, if any. Omit `permissionMode` to inherit your own mode (recommended); pass one only when the child should be more restricted. isolation "worktree" (claude nodes only) gives the child its own git worktree at <main checkout>/.claude/worktrees/<id> on a new branch from the HEAD of the checkout `cwd` is in, which needs a repo with a commit that Claude already trusts, and the reply then carries worktree { path, branch, base }. Omitting isolation uses the project config (default "none"), so a child whose cwd is inside an existing worktree shares that tree. Pass a unique `requestId` so a retry after a timeout returns the original node (with replayed: true) instead of opening a second one; reusing a requestId with different arguments is an error.',
    {
      kind: z.enum(NODE_KINDS), title: z.string().min(1), cwd: z.string().min(1), prompt: z.string().optional(),
      model: z.string().optional(), effort: z.enum(EFFORTS).optional(), permissionMode: z.enum(PERMISSION_MODES).optional(), role: z.enum(ROLES).optional(), isolation: z.enum(ISOLATIONS).optional(), requestId: z.string().optional(),
    },
    async (c, { requestId, ...req }) => {
      if (req.permissionMode === 'bypassPermissions' && c.caller !== HUMAN) throw new Error('refused: only the human may spawn a node with permissionMode bypassPermissions');
      const now = Date.now();
      for (const [k, v] of spawned) if (now - v.at > IDEMPOTENCY_MS) spawned.delete(k);
      const key = `${c.caller}\0${requestId}`;
      const args = JSON.stringify(req);
      const prior = requestId ? spawned.get(key) : undefined;
      if (prior) {
        if (prior.args !== args) throw new Error(`requestId ${requestId} was already used with different arguments`);
        return { data: { ...(prior.result as object), replayed: true } };
      }
      const caller = c.caller === HUMAN ? undefined : c.manager.view(c.caller);
      const inherited = caller?.status.permissionMode ?? caller?.permissionMode;
      const permissionMode = req.permissionMode ?? (inherited === 'bypassPermissions' ? undefined : inherited); // bypass stays human-only
      const r = { ...req, permissionMode, parentId: c.caller === HUMAN ? null : c.caller };
      const view = c.manager.isolationFor(r) === 'worktree' ? await c.manager.spawnWorktree(r) : c.manager.spawn(r);
      const w = view.worktree;
      const result = w ? { nodeId: view.id, worktree: { path: w.path, branch: w.branch, base: w.base } } : { nodeId: view.id };
      if (requestId) spawned.set(key, { args, result, at: now });
      return { data: result };
    }),

  send: tool(
    'Send a message to another agent node (self excluded; scope is your parent, siblings, and descendants). The message reaches the target as a prompt inside a framed envelope that shows the target who sent it and where to reply. Delivery is normally queued and confirmed asynchronously: the reply has outcome "queued" and a messageId, and the target\'s plugin submits the message when the target is idle (up to 16 queued, for 5 minutes). Call message_status with the messageId to see when it becomes delivered. If the target has no plugin running, the message is instead pasted into its prompt when it is idle, and the reply may be delivered, stalled or queued. Other outcomes: delivered, stalled (pasted but not confirmed, do not resend blindly), expired, queueFull, gone, refused. Only one send per target per 10 seconds is accepted. Terminal nodes cannot receive messages; use write.',
    { nodeId: z.string().min(1), text: z.string().min(1) },
    async (c, a) => ({ data: await deliver(c.manager, c.caller, a.nodeId, a.text) })),

  message_status: tool(
    'Look up the current outcome of a message you sent, which is how you confirm a queued message was delivered: it returns the same result shape as send, with outcome queued until the message is delivered, stalled, expired or gone. Takes the messageId from the send reply.',
    { messageId: z.string().min(1) },
    async (c, a) => {
      const r = messageStatus(c.manager, c.caller, a.messageId);
      if (!r) throw new Error(`no queued message ${a.messageId} from you`);
      return { data: r };
    }),

  read: tool(
    'Read another node (yourself, your ancestors, siblings or descendants). what "summary" returns the last `lines` (default 30) user and assistant messages of a Claude node\'s conversation, with tool calls reduced to a "[tool: name]" marker; "transcript" returns the whole conversation (capped at the most recent 200 KB); "terminal" returns the last `lines` (default 60) rows of the node\'s screen and works for terminal nodes too.',
    { nodeId: z.string().min(1), what: z.enum(['summary', 'transcript', 'terminal']), lines: z.number().int().min(1).max(5000).optional() },
    async (c, a) => {
      const v = requireScope(c, a.nodeId);
      if (a.what === 'terminal') {
        const s = c.manager.session(a.nodeId);
        if (!s) throw new Error('node has no running process');
        await s.flush();
        return { text: s.screenTail(a.lines ?? 60).join('\n') };
      }
      const path = v.status.transcriptPath;
      if (!path) throw new Error('node has no transcript yet (not a Claude node, or it has not started); try what: "terminal"');
      const entries = (await readFile(path, 'utf8')).split('\n').flatMap((l) => renderEntry(l) ?? []);
      if (a.what === 'summary') return { text: entries.slice(-(a.lines ?? 30)).join('\n\n') };
      return { text: entries.join('\n\n').slice(-TRANSCRIPT_CAP) };
    }),

  write: tool(
    'Type raw keystrokes into another node\'s terminal (yourself, ancestors, siblings or descendants), for example to answer a prompt in a terminal node or press Enter. The human must approve each call in the UI; if they decline or nobody is watching you get {ok:false, reason:"denied"}. Text is limited to 2000 characters. For talking to an agent node use send, which is safer.',
    { nodeId: z.string().min(1), text: z.string().min(1).max(MAX_WRITE_CHARS) },
    async (c, a) => {
      const v = requireScope(c, a.nodeId);
      if (!c.manager.session(a.nodeId)) throw new Error('node has no running process');
      if (c.caller !== HUMAN && !(await c.confirm(`${who(c)} wants to type into ${v.title} (${v.id}): ${JSON.stringify(a.text)}`))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      c.manager.input(a.nodeId, a.text);
      return { data: { ok: true } };
    }),

  close: tool(
    'Close and delete nodes. Every id must exist and be a descendant of yours, otherwise the whole batch is refused and nothing is closed. Orchestrators (root nodes) cannot be closed by agents. The human approves the batch once in the UI; if they decline you get {ok:false, reason:"denied"}. The project config (closeWithoutConfirm in .orchestr8/config.json) can skip that approval: "always" skips it, "done" skips it when every node in the batch is done or has exited, and the default "never" always asks. A node with its own git worktree closes only when the tree is clean, its branch is merged and no other live node works in it; otherwise the batch is refused, nothing is closed, and the error says why. `worktree` decides instead for the whole batch: "keep" commits uncommitted changes as a WIP commit and keeps the branch, "discard" deletes the worktree and branch with any unmerged work, and always needs the human\'s approval.',
    { nodeIds: z.array(z.string().min(1)).min(1), force: z.boolean().optional(), worktree: z.enum(['keep', 'discard']).optional() },
    async (c, a) => {
      const views = a.nodeIds.map((id) => requireOwned(c, id, false));
      for (const v of views) {
        if (v.parentId !== null) continue; // only the human gets here with a root: requireOwned refuses agents
        if (!a.force) throw new Error(`refusing to close an orchestrator; use o8 kill --force ${v.id}`);
      }
      // Refusals come before the confirm and before closeWithoutConfirm: no setting turns a refused close into a close.
      const destroys: string[] = [];
      for (const v of views) {
        const check = await c.manager.worktreeCheck(v.id);
        if (!check) continue;
        const refusal = closeRefusal(check, a.worktree);
        if (refusal) throw new Error(views.length > 1 ? `${v.id}: ${refusal}` : refusal);
        if (a.worktree === 'discard') destroys.push(`${v.title}: discards ${check.unmerged.length} commit(s) and ${check.dirty.length} changed file(s) on ${v.worktree!.branch}`);
      }
      const list = views.map((v) => `${v.title} (${v.id})`).join(', ');
      const mode = c.caller === HUMAN ? undefined : loadConfig(c.manager.view(c.caller)!.cwd, c.manager.home).closeWithoutConfirm;
      const preapproved = a.worktree !== 'discard' && (mode === 'always' || (mode === 'done' && views.every((v) => v.status.exited || v.status.state === 'done')));
      const text = `${who(c)} wants to close ${views.length} node(s): ${list}${destroys.length ? `. This deletes their worktrees: ${destroys.join('; ')}` : ''}`;
      if (c.caller !== HUMAN && !preapproved && !(await c.confirm(text))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      const notes: string[] = [];
      for (const id of a.nodeIds) {
        const note = await c.manager.close(id, true, a.worktree); // roots were vetted above
        if (note) notes.push(`${id}: ${note}`);
      }
      return { data: { ok: true, closed: a.nodeIds, ...(notes.length ? { notes } : {}) } };
    }),

  resume: tool(
    'Relaunch an exited Claude node with its previous conversation. Only the human may call this.',
    { nodeId: z.string().min(1) },
    async (c, a) => {
      if (c.caller !== HUMAN) throw new Error('resume is only for the human');
      const r = await c.manager.resume(a.nodeId);
      if (!r.ok) throw new Error(r.error);
      return { data: { ok: true } };
    }),

  restart: tool(
    'Restart a node: kill its process and relaunch it with a fresh session, which clears its context. Its title, directory, model, effort and children are kept. Only the human may call this.',
    { nodeId: z.string().min(1) },
    async (c, a) => {
      if (c.caller !== HUMAN) throw new Error('restart is only for the human');
      const r = c.manager.restart(a.nodeId);
      if (!r.ok) throw new Error(r.error);
      return { data: { ok: true } };
    }),

  prune: tool(
    'Remove every exited node that has no live descendant (files and records). A node whose git worktree has uncommitted or unmerged work is kept and listed. Only the human may call this.',
    {},
    async (c) => {
      if (c.caller !== HUMAN) throw new Error('prune is only for the human');
      const { removed, kept } = await c.manager.prune();
      const keptText = kept.length ? `; kept ${kept.length} node(s) with worktree work:\n${kept.map((k) => `  ${k.id}: ${k.reason}`).join('\n')}` : '';
      return { text: `removed ${removed.length} exited node(s)${keptText}`, data: { ok: true, removed, kept } };
    }),

  worktrees: tool(
    'List orchestr8 git worktrees for the repo `cwd` is in (all known repos when omitted): node worktrees, orphans (a worktree with no node) and kept branches. clean "safe" removes the orphans and kept branches that are clean and merged; "force" removes all of them and reports the commits and files that went. Only the human may call this.',
    { cwd: z.string().min(1).optional(), clean: z.enum(['safe', 'force']).optional() },
    async (c, a) => {
      if (c.caller !== HUMAN) throw new Error('worktrees is only for the human');
      const r = await c.manager.worktrees(a);
      return { text: worktreeText(r), data: r };
    }),

  select: tool(
    'Make the web UI and app show a node (they switch to it). Only the human may call this.',
    { nodeId: z.string().min(1) },
    async (c, a) => {
      if (c.caller !== HUMAN) throw new Error('select is only for the human');
      requireNode(c.manager, a.nodeId);
      if (process.env.O8_DEBUG) console.log(`select ${a.nodeId}`);
      c.focus(HUMAN, a.nodeId);
      return { data: { ok: true } };
    }),

  shutdown: tool(
    'Stop the daemon: flush the registry, kill every node process and exit. The nodes are not resumed on the next start. Only the human may call this.',
    {},
    async (c) => {
      if (c.caller !== HUMAN) throw new Error('shutdown is only for the human');
      c.manager.shutdown({ clearLive: true });
      setTimeout(() => process.exit(0), 100); // after the reply is flushed
      return { text: 'daemon stopping', data: { ok: true, pid: process.pid } };
    }),

  rename: tool(
    'Change the title of yourself or one of your descendants.',
    { nodeId: z.string().min(1), title: z.string().min(1) },
    async (c, a) => {
      requireOwned(c, a.nodeId, true);
      c.manager.rename(a.nodeId, a.title);
      return { data: { ok: true } };
    }),

  report_outcome: tool(
    'Report how your own task ended: "succeeded" or "failed", with an optional short note. Call it once when your work is finished so whoever launched you can tell the difference between done and done well. It is about yourself only.',
    { outcome: z.enum(['succeeded', 'failed']), note: z.string().optional() },
    async (c, a) => {
      if (c.caller === HUMAN) throw new Error('report_outcome is only for agent nodes');
      outcomes.set(c.caller, { ...a, at: Date.now() });
      return { data: { ok: true } };
    }),
};

// ---- HTTP ----

/**
 * Handler for `/mcp` (MCP over stateless streamable HTTP) and `POST /api/<tool>` (the same tools as plain JSON, for the CLI).
 * Both authenticate with `Authorization: Bearer` + `X-O8-Node`. Node id `human` takes the admin token written to `<home>/admin-token`.
 */
export function mountMcp(manager: NodeManager, confirm: (text: string) => Promise<boolean>, focus: (from: string, id: string) => void): {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Write the admin token file. Call once the server is listening, so a daemon that fails to bind leaves the running daemon's token alone. */
  publishAdminToken: () => void;
  /** Caller id for a request's Bearer + X-O8-Node (`human` for the admin token), or undefined. */
  authenticate: (req: http.IncomingMessage) => string | undefined;
  /** Whether `token` is the admin token (the WebSocket clients authenticate with it). */
  isAdmin: (token: string) => boolean;
} {
  const adminFile = join(manager.home, ADMIN_TOKEN_FILE);
  let adminToken = ''; // kept across restarts, so attached clients re-authenticate after `o8 reload`
  try { adminToken = readFileSync(adminFile, 'utf8').trim(); } catch { /* first start: minted below */ }
  adminToken ||= randomBytes(32).toString('base64url');
  const publishAdminToken = () => {
    writeFileSync(adminFile, adminToken, { mode: 0o600 });
    chmodSync(adminFile, 0o600);
  };
  startNotices(manager);
  manager.on('removed', (id: string) => {
    outcomes.delete(id);
    for (const k of spawned.keys()) if (k.startsWith(`${id}\0`)) spawned.delete(k);
  });

  const isAdmin = (token: string) => safeEqual(token, adminToken);
  const authenticate = (req: http.IncomingMessage): string | undefined => {
    const id = String(req.headers['x-o8-node'] ?? '');
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (id === HUMAN) return isAdmin(bearer) ? id : undefined;
    return id && manager.view(id) && manager.verifyToken(id, bearer) ? id : undefined;
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, name: string, ctx: Ctx): Promise<void> {
    const reply = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[name];
    if (req.method !== 'POST' || !t) return void res.writeHead(404).end();
    const raw = await readBody(req, res);
    if (raw === undefined) return;
    try {
      const args = z.object(t.shape).parse(raw ? JSON.parse(raw) : {});
      reply(200, await t.run(ctx, args as never));
    } catch (err) {
      reply(400, { error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message });
    }
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const caller = authenticate(req);
    if (!caller) return void res.writeHead(401).end();
    const ctx: Ctx = { manager, confirm, focus, caller };
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path.startsWith('/api/')) return api(req, res, path.slice(5), ctx);

    const mcp = new McpServer({ name: 'orchestr8', version: '0.0.0' });
    for (const [name, t] of Object.entries(tools)) {
      mcp.registerTool(name, { description: t.description, inputSchema: t.shape }, async (args: unknown) => {
        try {
          const out = await t.run(ctx, args as never);
          const content = [out.text, out.data === undefined ? undefined : JSON.stringify(out.data)].flatMap((x) => (x === undefined ? [] : [{ type: 'text' as const, text: x }]));
          return { content };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(logError); mcp.close().catch(logError); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  };
  return { handler, publishAdminToken, authenticate, isAdmin };
}
