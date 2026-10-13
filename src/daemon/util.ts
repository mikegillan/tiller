import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

/** Constant-time string comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** How much of a node's last assistant message the node lists (list_nodes, the mod's /tree) show. */
export const PREVIEW_CHARS = 200;

/** For `.catch(logError)` on fire-and-forget promises. */
export const logError = (err: unknown): void => console.error('orchestr8:', err);

/** The request body, or undefined once it passes `max` characters: then this has answered 413 and destroyed the request. */
export async function readBody(req: http.IncomingMessage, res: http.ServerResponse, max = 1_000_000): Promise<string | undefined> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) { res.writeHead(413).end(); req.destroy(); return undefined; }
  }
  return body;
}
