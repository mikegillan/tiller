// The daemon is the only sender of OS notifications: one per node and kind, titled with the node, saying what it needs.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { dndActive, type Dnd, type NodeView } from '../shared/protocol.js';
import type { Notifications, NotifyLevel } from './config.js';
import type { NotifyEvent } from './manager.js';

const THROTTLE_MS = 5000;
const APP_BUNDLE = 'dev.orchestr8.app';

export interface Content { title: string; subtitle?: string; body: string; sound: boolean }

const firstLine = (s: string | undefined, max = 120) => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, max) ?? '';
const withText = (label: string, text: string) => (text ? `${label}: ${text}` : label);

/** What to show for `node` reaching `kind`. `root` is the session (root node) title. */
export function content(node: NodeView, kind: NotifyEvent['kind'], root?: string): Omit<Content, 'sound'> {
  const { state, activity, lastAssistantMessage: msg } = node.status;
  const subtitle = root && root !== node.title ? root : undefined;
  let body: string;
  if (kind === 'needsYou' && state === 'waiting') body = withText('Asks', activity?.replace(/^question: /, '') || firstLine(msg));
  else if (kind === 'needsYou') body = withText('Needs approval', activity?.replace(/^needs approval: /, '') ?? '');
  else if (kind === 'done') body = withText('Finished', firstLine(msg));
  else if (kind === 'errored') body = withText('Turn failed', firstLine(msg));
  else body = 'Exited';
  return { title: node.title, subtitle, body };
}

/** Whether local time `now` falls in `spec` ("HH:MM-HH:MM", start inclusive, end exclusive; may run across midnight). */
export function inQuietHours(spec: string, now: Date): boolean {
  const [start, end] = spec.split('-').map((t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  const t = now.getHours() * 60 + now.getMinutes();
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

/** How to show `kind` under the notifications config, and which setting decided it. */
export function decide(kind: NotifyEvent['kind'], cfg: Notifications, now: Date): { level: NotifyLevel; why: string } {
  if (cfg.failuresOnly && kind !== 'needsYou' && kind !== 'errored') return { level: 'silent', why: 'failuresOnly' };
  const level = cfg.kinds[kind];
  if (level === 'silent') return { level, why: `kinds.${kind}` };
  if (cfg.quietHours && inQuietHours(cfg.quietHours, now)) return kind === 'needsYou' ? { level: 'banner', why: 'quietHours' } : { level: 'silent', why: 'quietHours' };
  return { level, why: `kinds.${kind}` };
}

export interface NotifierDeps {
  view(id: string): NodeView | undefined;
  /** The whole tree `id` belongs to, root first. */
  tree(id: string): NodeView[];
  /** The notifications config that applies to node `id`. */
  config(id: string): Notifications;
  dnd(): Dnd;
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
  /** Where each sent or suppressed notification is reported; defaults to console.log (the daemon log). */
  log?(line: string): void;
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

const finished = (v: NodeView) => v.status.exited || v.status.state === 'done';
const failed = (v: NodeView) => !!v.status.errored || v.outcome?.outcome === 'failed';

/**
 * Returns the 'notify' listener. Nothing is sent for a muted node, during do not disturb, or for a node a focused client
 * is looking at; then the notifications config picks banner, sound or silent; at most one per node and kind every 5 s.
 * With treeDoneSummary, done and exited are replaced by one notification once the whole tree is finished.
 */
export function createNotifier(d: NotifierDeps): (n: NotifyEvent) => void {
  const last = new Map<string, number>();
  /** Roots whose finish has been announced, until one of their nodes is seen unfinished again. */
  const announced = new Set<string>();
  const log = d.log ?? console.log;
  const post = (id: string, kind: NotifyEvent['kind'], key: string, c: Omit<Content, 'sound'>, now: number) => {
    const say = (what: string) => log(`notify ${id} ${key}: ${what}`);
    if (d.view(id)?.muted) return say('suppressed (muted)');
    if (dndActive(d.dnd(), now)) return say('suppressed (do not disturb)');
    if (d.watchers(id) > 0) return say('suppressed (watched)');
    const { level, why } = decide(kind, d.config(id), new Date(now));
    if (level === 'silent') return say(`suppressed (${why})`);
    const k = `${id}:${key}`;
    if (now - (last.get(k) ?? -Infinity) < THROTTLE_MS) return say('suppressed (throttled)');
    last.set(k, now);
    const { file, args } = notifyArgs({ ...c, sound: level === 'sound' }, id, d);
    d.run(file, args);
    say(`sent ${level} (${why})`);
  };
  return (n) => {
    const node = d.view(n.id);
    if (!node) return;
    const now = (d.now ?? Date.now)();
    const tree = d.tree(n.id);
    const root = tree[0] ?? node;
    if (d.config(n.id).treeDoneSummary) {
      const agents = tree.filter((v) => v.kind === 'claude'); // a plain terminal never finishes
      if (!agents.length || !agents.every(finished)) announced.delete(root.id);
      // An exit after the tree was announced (a node quitting once done) is not a new finish.
      else if (n.kind !== 'needsYou' && (n.kind !== 'exited' || !announced.has(root.id))) {
        announced.add(root.id);
        const bad = agents.filter(failed).length;
        post(root.id, 'done', 'tree', { title: root.title, body: `tree ${root.title} finished: ${agents.length - bad} succeeded, ${bad} failed` }, now);
      }
      if ((n.kind === 'done' || n.kind === 'exited') && node.kind === 'claude') return log(`notify ${n.id} ${n.kind}: suppressed (treeDoneSummary)`);
    }
    post(n.id, n.kind, n.kind, content(node, n.kind, root.title), now);
  };
}

/** First executable named `name` on `path`, else undefined. */
export function findBin(name: string, path: string): string | undefined {
  return path.split(delimiter).map((dir) => join(dir, name)).find((f) => existsSync(f));
}

export const runDetached = (file: string, args: string[]) => { execFile(file, args, () => {}).unref(); };
