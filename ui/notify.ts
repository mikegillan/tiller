import type { ServerMessage } from '../src/shared/protocol';
import { toast, type Tone } from './store';
import { IN_APP } from './url';

type Notify = Extract<ServerMessage, { t: 'notify' }>;

const TONE: Record<Notify['kind'], Tone> = { done: 'ok', needsYou: 'warn', errored: 'bad', exited: 'info' };

let ctx: AudioContext | undefined;
const lastNotified = new Map<string, number>();

/** At most one chime per node every 5 s. */
function throttled(id: string): boolean {
  const now = Date.now();
  if (now - (lastNotified.get(id) ?? 0) < 5000) return true;
  lastNotified.set(id, now);
  return false;
}

function tone(freq: number, at: number, dur: number) {
  const c = (ctx ??= new AudioContext());
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.15, c.currentTime + at);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + at + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur);
}

function chime(m: Notify) {
  if (m.kind === 'exited') return;
  try {
    void ctx?.resume();
    if (m.kind === 'done') { tone(880, 0, 0.15); tone(1175, 0.15, 0.25); }
    else { tone(330, 0, 0.2); tone(262, 0.25, 0.3); }
  } catch { /* audio unavailable */ }
}

export function handleNotify(m: Notify) {
  toast(m.body ? `${m.title}: ${m.body}` : m.title, m.id, TONE[m.kind]);
  // OS notifications come from the daemon. The app is silent here (terminal-notifier plays the sound); a browser tab chimes.
  if (!IN_APP && !throttled(m.id)) chime(m);
}

/** Browsers only allow audio to start from a user gesture. */
export function armOnFirstClick() {
  addEventListener('click', () => { ctx ??= new AudioContext(); }, { once: true });
}
