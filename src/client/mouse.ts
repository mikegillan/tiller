// SGR (1006) mouse reports: ESC [ < button ; x ; y (M press/motion | m release). Coordinates are 1-based.
export interface Mouse { b: number; x: number; y: number; press: boolean }
export type Piece = { text: string } | { mouse: Mouse };

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Split one stdin chunk into mouse reports and everything else, in order. */
export function parseInput(s: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of s.matchAll(SGR)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ mouse: { b: +m[1]!, x: +m[2]!, y: +m[3]!, press: m[4] === 'M' } });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

/** Button bits: 0-2 button, 32 motion, 64 wheel. */
export const isWheel = (m: Mouse) => (m.b & 64) !== 0;
export const isLeftPress = (m: Mouse) => m.press && (m.b & 99) === 0;

/** The report as the node expects it, with x moved left by `dx` columns (the sidebar offset). */
export const encode = (m: Mouse, dx = 0) => `\x1b[<${m.b};${m.x - dx};${m.y}${m.press ? 'M' : 'm'}`;
