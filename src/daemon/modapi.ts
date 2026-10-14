import type http from 'node:http';
import { z } from 'zod';
import type { ChildView, ModEvent, NodeView } from '../shared/protocol.js';
import { treeOrder } from '../shared/tree.js';
import { ack, claim, HUMAN, inbox, markModLive, release, unconfirmed } from './messaging.js';
import type { NodeManager } from './manager.js';
import { PREVIEW_CHARS, readBody } from './util.js';

const modEvent = z.object({ event: z.enum(['turn.start', 'turn.complete', 'session.measure']), payload: z.record(z.string(), z.unknown()).default({}) });
const rateLimits = z.array(z.object({ kind: z.string().min(1).max(64), percentUsed: z.number().finite(), resetsAt: z.string().max(64).optional() })).max(16);

/** `root` (or every root) and its descendants depth-first (a root is depth 0); the row for `selfId`, if any, is marked self. */
function treeViews(manager: NodeManager, root?: NodeView, selfId?: string): ChildView[] {
  return treeOrder(manager.list(), root).map(({ node: n, depth }) => {
    const { status: s } = n;
    return {
      id: n.id, title: n.title, depth, ...(n.id === selfId ? { self: true } : {}), parentId: n.parentId, state: s.state, errored: s.errored, interrupted: s.interrupted, exited: s.exited,
      activity: s.activity, ageSec: Math.round((Date.now() - s.changedAt) / 1000), lastMessage: s.lastAssistantMessage?.slice(0, PREVIEW_CHARS),
      unread: n.unread, contextPct: s.contextPct,
    };
  });
}

/** The topmost ancestor of `id` (itself when it has no parent). */
const rootOf = (manager: NodeManager, id: string): NodeView | undefined => manager.view(manager.registry.lineage(id).at(-1)?.id ?? id);

/**
 * Routes the per-node mod uses (PLAN §14). Returns a handler that answers `true` once it has handled the request,
 * `false` for paths that are not mod routes. Authenticates like /hook via `authenticate`.
 */
export function modApi(manager: NodeManager, authenticate: (req: http.IncomingMessage) => string | undefined, onFocus: (from: string, id: string) => void, clients: () => string[]) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> => {
    const post = req.method === 'POST' && (path === '/ack' || path === '/claim' || path === '/release' || path === '/unconfirmed' || path === '/mod-event' || path === '/focus');
    if (!post && !(req.method === 'GET' && (path === '/inbox' || path === '/tree'))) return false;
    const caller = authenticate(req);
    if (!caller) { res.writeHead(401).end(); return true; }
    const json = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json', 'X-TL-Clients': clients().join(',') }).end(JSON.stringify(body));

    if (!post) {
      if (path === '/inbox') json(caller === HUMAN ? [] : inbox(manager, caller));
      else {
        // The human sees every root; a node sees its whole tree from the root.
        const top = rootOf(manager, caller);
        json(caller === HUMAN ? treeViews(manager) : top ? treeViews(manager, top, caller) : []);
      }
      return true;
    }
    const raw = await readBody(req, res);
    if (raw === undefined) return true;
    try {
      const body = JSON.parse(raw || '{}');
      if (path === '/ack') {
        const id = z.object({ id: z.string().min(1) }).parse(body).id;
        const ok = ack(manager, caller, id);
        if (process.env.TL_DEBUG) console.log(`ack ${caller.slice(0, 6)} ${id}${ok ? ' (delivered via inbox)' : ' (unknown)'}`);
      } else if (path === '/claim') {
        // 404: withdrawn or expired, so the mod must not submit it.
        if (!claim(manager, caller, z.object({ id: z.string().min(1) }).parse(body).id)) { res.writeHead(404).end(); return true; }
      } else if (path === '/release') {
        // 404: no longer queued (withdrawn, expired or retired), so there is nothing to hand back.
        if (!release(manager, caller, z.object({ id: z.string().min(1) }).parse(body).id)) { res.writeHead(404).end(); return true; }
      } else if (path === '/unconfirmed') {
        // Idempotent retirement of this authenticated node's claim only. Never marks delivered.
        unconfirmed(manager, caller, z.object({ id: z.string().min(1) }).parse(body).id);
      } else if (path === '/focus') {
        const id = z.object({ id: z.string().min(1) }).parse(body).id;
        if (caller !== HUMAN && rootOf(manager, caller)?.id !== rootOf(manager, id)?.id) { res.writeHead(403).end(); return true; }
        onFocus(caller, id);
      } else {
        const ev = modEvent.parse(body) as ModEvent;
        if (ev.event === 'session.measure') {
          // A malformed rateLimits is dropped; the node's context and cost still apply.
          const rl = rateLimits.safeParse(ev.payload.rateLimits);
          ev.payload.rateLimits = rl.success ? rl.data : undefined;
        }
        if (caller !== HUMAN) {
          markModLive(manager, caller);
          manager.applyModEvent(caller, ev);
        }
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return true;
  };
}
