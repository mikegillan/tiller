import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface Term { term: Terminal; fit: FitAddon }
const terms = new Map<string, Term>();

export function getTerm(id: string): Term | undefined {
  return terms.get(id);
}

export function createTerm(id: string, el: HTMLElement): Term {
  const term = new Terminal({
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0d1117', foreground: '#d0d7de' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  const t = { term, fit };
  terms.set(id, t);
  return t;
}

export function disposeTerm(id: string) {
  terms.get(id)?.term.dispose();
  terms.delete(id);
}
