import type http from 'node:http';
import { z } from 'zod';
import type { ChildView, ModEvent, NodeView } from '../shared/protocol.js';
import { ack, HUMAN, inbox, markModLive } from './messaging.js';
import type { NodeManager } from './manager.js';

const MAX_BODY = 1_000_000;
const modEvent = z.object({ event: z.enum(['turn.start', 'turn.complete', 'session.measure', 'notified']), payload: z.record(z.string(), z.unknown()).default({}) });

/** Descendants of the caller, depth-first, depth counted from the caller (children of the caller are depth 1). */
function childViews(manager: NodeManager, caller: string): ChildView[] {
  const all = manager.list();
  const kids = (id: string | null) => all.filter((n) => n.parentId === id);
  const out: ChildView[] = [];
  const walk = (n: NodeView, depth: number) => {
    const { status: s } = n;
    out.push({
      id: n.id, title: n.title, depth, state: s.state, errored: s.errored, interrupted: s.interrupted, exited: s.exited,
      activity: s.activity, ageSec: Math.round((Date.now() - s.changedAt) / 1000), lastMessage: s.lastAssistantMessage?.slice(0, 200),
      unread: n.unread, contextPct: s.contextPct,
    });
    for (const k of kids(n.id)) walk(k, depth + 1);
  };
  // The human sees every root (depth 0); a node sees only what hangs below it.
  if (caller === HUMAN) for (const r of kids(null)) walk(r, 0);
  else for (const k of kids(caller)) walk(k, 1);
  return out;
}

/**
 * Routes the per-node mod uses (PLAN §14). Returns a handler that answers `true` once it has handled the request,
 * `false` for paths that are not mod routes. Authenticates like /hook via `authenticate`.
 */
export function modApi(manager: NodeManager, authenticate: (req: http.IncomingMessage) => string | undefined) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> => {
    const post = req.method === 'POST' && (path === '/ack' || path === '/mod-event');
    if (!post && !(req.method === 'GET' && (path === '/inbox' || path === '/children'))) return false;
    const caller = authenticate(req);
    if (!caller) { res.writeHead(401).end(); return true; }
    const json = (body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    if (!post) {
      if (path === '/inbox') json(caller === HUMAN ? [] : inbox(manager, caller));
      else json(childViews(manager, caller));
      return true;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return true; }
    }
    try {
      const body = JSON.parse(raw || '{}');
      if (path === '/ack') {
        const id = z.object({ id: z.string().min(1) }).parse(body).id;
        const ok = ack(manager, caller, id);
        if (process.env.O8_DEBUG) console.log(`ack ${caller.slice(0, 6)} ${id}${ok ? ' (delivered via inbox)' : ' (unknown)'}`);
      } else {
        const ev = modEvent.parse(body) as ModEvent;
        if (caller !== HUMAN) {
          markModLive(manager, caller);
          if (ev.event === 'notified') { if (process.env.O8_DEBUG) console.log(`mod ${caller.slice(0, 6)} notified: ${JSON.stringify(ev.payload)}`); }
          else manager.applyModEvent(caller, ev);
        }
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return true;
  };
}
