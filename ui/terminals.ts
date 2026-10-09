import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface Term { term: Terminal; fit: FitAddon }
const terms = new Map<string, Term>();

const DARK: ITheme = {
  background: '#0e1116', foreground: '#d8dee6', cursor: '#d8dee6', selectionBackground: '#2f4a73',
  black: '#1b212a', red: '#f85149', green: '#3fb950', yellow: '#e3b341', blue: '#5b9cf5', magenta: '#bc8cff', cyan: '#4cc9e0', white: '#c9d1d9',
  brightBlack: '#6e7a8a', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#f2cc60', brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#76e3ea', brightWhite: '#f0f4f8',
};
const LIGHT: ITheme = {
  background: '#ffffff', foreground: '#24292f', cursor: '#24292f', selectionBackground: '#b6d4fe',
  black: '#24292f', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700', blue: '#0550ae', magenta: '#8250df', cyan: '#0a7e8c', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#116329', brightYellow: '#7d4e00', brightBlue: '#0969da', brightMagenta: '#6639ba', brightCyan: '#1b7c83', brightWhite: '#8c959f',
};

const scheme = matchMedia('(prefers-color-scheme: light)');
const theme = () => (scheme.matches ? LIGHT : DARK);
scheme.addEventListener('change', () => terms.forEach(({ term }) => (term.options.theme = theme())));

export function getTerm(id: string): Term | undefined {
  return terms.get(id);
}

export function createTerm(id: string, el: HTMLElement): Term {
  // xterm 6 renders with the DOM renderer unless an addon is loaded, which keeps WKWebView happy.
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: theme(),
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
