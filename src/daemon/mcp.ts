import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type http from 'node:http';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { NodeView } from '../shared/protocol.js';
import type { NodeManager } from './manager.js';
import { deliver, HUMAN, inScope, isDescendant, messageStatus, startNotices } from './messaging.js';
import { logError, safeEqual } from './util.js';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
const MAX_WRITE_CHARS = 2000;
const IDEMPOTENCY_MS = 24 * 3600_000;
const MAX_BODY = 1_000_000;
const TRANSCRIPT_CAP = 200_000;

interface Ctx { manager: NodeManager; confirm: (text: string) => Promise<boolean>; caller: string }
interface Out { text?: string; data?: unknown }

const outcomes = new Map<string, { outcome: 'succeeded' | 'failed'; note?: string; at: number }>();

// ---- helpers ----

const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3600_000)}h`);

function flags(v: NodeView): string[] {
  const s = v.status;
  return (['errored', 'interrupted', 'exited', 'stale'] as const).filter((f) => s[f]);
}

function summarize(v: NodeView, now: number) {
  return {
    id: v.id, parentId: v.parentId, title: v.title, kind: v.kind, cwd: v.cwd, state: v.status.state, flags: flags(v),
    age: age(now - v.createdAt), activity: v.status.activity, lastAssistantMessage: v.status.lastAssistantMessage?.slice(0, 200),
    outcome: outcomes.get(v.id),
  };
}

function tree(nodes: ReturnType<typeof summarize>[]): string {
  const known = new Set(nodes.map((n) => n.id));
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of nodes.filter((x) => (known.has(x.parentId ?? '') ? x.parentId : null) === parent)) {
      const extra = [...n.flags, n.activity].filter(Boolean).join(', ');
      lines.push(`${'  '.repeat(depth)}- ${n.id} "${n.title}" [${n.kind}] ${n.state}${extra ? ` (${extra})` : ''} ${n.age}`);
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n') || '(no nodes)';
}

/** One user/assistant transcript entry as text; tool calls become a one-line marker, tool results vanish. */
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

const who = (c: Ctx) => (c.caller === HUMAN ? 'The user' : `Node ${c.manager.view(c.caller)?.title ?? ''} (${c.caller})`.replace('  ', ' '));

// ---- tools ----

function tool<S extends z.ZodRawShape>(description: string, shape: S, run: (c: Ctx, a: z.infer<z.ZodObject<S>>) => Promise<Out>) {
  return { description, shape, run: run as (c: Ctx, a: never) => Promise<Out> };
}

const spawned = new Map<string, { args: string; result: unknown; at: number }>();

export const tools = {
  list_nodes: tool(
    'List the nodes you can see (yourself, your ancestors, siblings and descendants) as an indented tree plus JSON. Each node has id, parentId, title, kind (claude or terminal), cwd, state (working, waiting, blocked, done, unknown, none), flags (errored, interrupted, exited, stale), age, current activity, its last assistant message truncated to 200 characters, and the outcome it reported through report_outcome, if any. Use it to find node ids before calling send, read or close.',
    {},
    async (c) => {
      const nodes = c.manager.list().filter((v) => inScope(c.manager, c.caller, v.id)).map((v) => summarize(v, Date.now()));
      return { text: tree(nodes), data: nodes };
    }),

  spawn: tool(
    'Open a new node as a child of yourself and return its id. kind "claude" starts a Claude Code agent that begins working on `prompt`; kind "terminal" starts a login shell. `cwd` must be an existing directory. Spawning never changes what the user is looking at. Pass a unique `requestId` so a retry after a timeout returns the original node (with replayed: true) instead of opening a second one; reusing a requestId with different arguments is an error.',
    {
      kind: z.enum(['claude', 'terminal']), title: z.string().min(1), cwd: z.string().min(1), prompt: z.string().optional(),
      model: z.string().optional(), permissionMode: z.enum(PERMISSION_MODES).optional(), requestId: z.string().optional(),
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
      const view = c.manager.spawn({ ...req, parentId: c.caller === HUMAN ? null : c.caller });
      const result = { nodeId: view.id };
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
    'Close and delete nodes. Every id must exist and be a descendant of yours, otherwise the whole batch is refused and nothing is closed. The human approves the batch once in the UI; if they decline you get {ok:false, reason:"denied"}.',
    { nodeIds: z.array(z.string().min(1)).min(1) },
    async (c, a) => {
      const views = a.nodeIds.map((id) => requireOwned(c, id, false));
      const list = views.map((v) => `${v.title} (${v.id})`).join(', ');
      if (c.caller !== HUMAN && !(await c.confirm(`${who(c)} wants to close ${views.length} node(s): ${list}`))) {
        return { data: { ok: false, reason: 'denied' } };
      }
      for (const id of a.nodeIds) c.manager.close(id);
      return { data: { ok: true, closed: a.nodeIds } };
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
export function mountMcp(manager: NodeManager, confirm: (text: string) => Promise<boolean>): {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Write the admin token file. Call once the server is listening, so a daemon that fails to bind leaves the running daemon's token alone. */
  publishAdminToken: () => void;
  /** Caller id for a request's Bearer + X-O8-Node (`human` for the admin token), or undefined. */
  authenticate: (req: http.IncomingMessage) => string | undefined;
} {
  const adminToken = randomBytes(32).toString('base64url');
  const adminFile = join(manager.home, 'admin-token');
  const publishAdminToken = () => {
    writeFileSync(adminFile, adminToken, { mode: 0o600 });
    chmodSync(adminFile, 0o600);
  };
  startNotices(manager);
  manager.on('removed', (id: string) => {
    outcomes.delete(id);
    for (const k of spawned.keys()) if (k.startsWith(`${id}\0`)) spawned.delete(k);
  });

  const authenticate = (req: http.IncomingMessage): string | undefined => {
    const id = String(req.headers['x-o8-node'] ?? '');
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (id === HUMAN) return safeEqual(bearer, adminToken) ? id : undefined;
    return id && manager.view(id) && manager.verifyToken(id, bearer) ? id : undefined;
  };

  async function api(req: http.IncomingMessage, res: http.ServerResponse, name: string, ctx: Ctx): Promise<void> {
    const reply = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const t = (tools as Record<string, (typeof tools)[keyof typeof tools]>)[name];
    if (req.method !== 'POST' || !t) return void res.writeHead(404).end();
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return void res.writeHead(413).end();
    }
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
    const ctx: Ctx = { manager, confirm, caller };
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
  return { handler, publishAdminToken, authenticate };
}
