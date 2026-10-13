// The daemon is the only sender of OS notifications: one per node and kind, titled with the node, saying what it needs.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { NodeView } from '../shared/protocol.js';
import type { NotifyEvent } from './manager.js';

const THROTTLE_MS = 5000;
const APP_BUNDLE = 'dev.orchestr8.app';

export interface Content { title: string; subtitle?: string; body: string; sound: boolean }

const firstLine = (s: string | undefined, max = 120) => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, max) ?? '';
const withText = (label: string, text: string) => (text ? `${label}: ${text}` : label);

/** What to show for `node` reaching `kind`. `root` is the session (root node) title. */
export function content(node: NodeView, kind: NotifyEvent['kind'], root?: string): Content {
  const { state, activity, lastAssistantMessage: msg } = node.status;
  const subtitle = root && root !== node.title ? root : undefined;
  const sound = kind === 'needsYou' || kind === 'errored';
  let body: string;
  if (kind === 'needsYou' && state === 'waiting') body = withText('Asks', activity?.replace(/^question: /, '') || firstLine(msg));
  else if (kind === 'needsYou') body = withText('Needs approval', activity?.replace(/^needs approval: /, '') ?? '');
  else if (kind === 'done') body = withText('Finished', firstLine(msg));
  else if (kind === 'errored') body = withText('Turn failed', firstLine(msg));
  else body = 'Exited';
  return { title: node.title, subtitle, body, sound };
}

export interface NotifierDeps {
  view(id: string): NodeView | undefined;
  rootTitle(id: string): string | undefined;
  /** Clients looking at the node right now. */
  watchers(id: string): number;
  appConnected(): boolean;
  /** Absolute path of terminal-notifier, if installed. */
  terminalNotifier?: string;
  /** macOS bundle id of the daemon's terminal, activated on click when no app is connected. */
  terminalBundle?: string;
  /** Shell command run on click, given the node id. */
  onClick(id: string): string;
  run(file: string, args: string[]): void;
  now?(): number;
}

export function notifyArgs(c: Content, id: string, d: Pick<NotifierDeps, 'terminalNotifier' | 'terminalBundle' | 'appConnected' | 'onClick'>): { file: string; args: string[] } {
  if (!d.terminalNotifier) {
    const q = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;
    return { file: 'osascript', args: ['-e', `display notification ${q(c.body)} with title ${q(c.title)}${c.subtitle ? ` subtitle ${q(c.subtitle)}` : ''}`] };
  }
  const activate = d.appConnected() ? APP_BUNDLE : d.terminalBundle;
  return {
    file: d.terminalNotifier,
    args: [
      '-title', c.title, ...(c.subtitle ? ['-subtitle', c.subtitle] : []), '-message', c.body, '-group', id,
      ...(c.sound ? ['-sound', 'default'] : []), ...(activate ? ['-activate', activate] : []), '-execute', d.onClick(id),
    ],
  };
}

/** Returns the 'notify' listener. Skips nodes a focused client is looking at; at most one per node and kind every 5 s. */
export function createNotifier(d: NotifierDeps): (n: NotifyEvent) => void {
  const last = new Map<string, number>();
  return (n) => {
    const node = d.view(n.id);
    if (!node || d.watchers(n.id) > 0) return;
    const key = `${n.id}:${n.kind}`, now = (d.now ?? Date.now)();
    if (now - (last.get(key) ?? -Infinity) < THROTTLE_MS) return;
    last.set(key, now);
    const { file, args } = notifyArgs(content(node, n.kind, d.rootTitle(n.id)), n.id, d);
    d.run(file, args);
  };
}

/** First executable named `name` on `path`, else undefined. */
export function findBin(name: string, path: string): string | undefined {
  return path.split(delimiter).map((dir) => join(dir, name)).find((f) => existsSync(f));
}

export const runDetached = (file: string, args: string[]) => { execFile(file, args, () => {}).unref(); };
