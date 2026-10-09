import { timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison for tokens. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** For `.catch(logError)` on fire-and-forget promises. */
export const logError = (err: unknown): void => console.error('orchestr8:', err);
