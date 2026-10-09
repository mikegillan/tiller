// The client's copy of one node's screen: a headless terminal, plus the row-diff that repaints it into the real terminal.
import xterm from '@xterm/headless';
import type { IBufferCell, IBufferLine } from '@xterm/headless';
const { Terminal } = xterm;

const fgCode = (c: IBufferCell) => {
  const v = c.getFgColor();
  return c.isFgRGB() ? `38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}` : c.isFgPalette() ? (v < 8 ? `${30 + v}` : v < 16 ? `${90 + v - 8}` : `38;5;${v}`) : '';
};
const bgCode = (c: IBufferCell) => {
  const v = c.getBgColor();
  return c.isBgRGB() ? `48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}` : c.isBgPalette() ? (v < 8 ? `${40 + v}` : v < 16 ? `${100 + v - 8}` : `48;5;${v}`) : '';
};
const attrs = (c: IBufferCell) =>
  [c.isBold() && '1', c.isDim() && '2', c.isItalic() && '3', c.isUnderline() && '4', c.isInverse() && '7', c.isStrikethrough() && '9', fgCode(c), bgCode(c)]
    .filter(Boolean).join(';');

/** One buffer row as text with SGR attributes: `cols` cells, empty cells as spaces, a wide character's second cell skipped. */
export function renderRow(line: IBufferLine | undefined, cols: number, cell: IBufferCell): string {
  let out = '', cur = '';
  for (let x = 0; x < cols; x++) {
    const c = line?.getCell(x, cell);
    if (!c) { out += ' '; continue; }
    if (c.getWidth() === 0) continue;
    const a = attrs(c);
    if (a !== cur) { out += `\x1b[0${a && ';'}${a}m`; cur = a; }
    out += c.getChars() || ' ';
  }
  return cur ? out + '\x1b[0m' : out;
}

export class NodeScreen {
  readonly term: InstanceType<typeof Terminal>;
  private prev: string[] = [];
  private cell: IBufferCell;
  cursorVisible = true;
  /** The node asked for mouse reports (DECSET 1000/1002/1003). */
  mouse = false;
  /** True once something was written; the first frame after a switch waits for the snapshot. */
  dirty = false;

  constructor(public cols: number, public rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    this.cell = this.term.buffer.active.getNullCell();
  }

  write(data: string): void {
    for (const m of data.matchAll(/\x1b\[\?25([hl])/g)) this.cursorVisible = m[1] === 'h';
    for (const m of data.matchAll(/\x1b\[\?100[023]([hl])/g)) this.mouse = m[1] === 'h';
    this.dirty = true;
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols; this.rows = rows;
    this.term.resize(cols, rows);
    this.prev = [];
  }

  /** Forget what is on the real terminal, so the next frame repaints every row. */
  invalidate(): void { this.prev = []; }

  /** Resolves when everything written so far has been parsed. */
  settle(): Promise<void> { return new Promise((r) => this.term.write('', r)); }

  /** Cursor-addressed text for the rows that changed since the last frame; `x0` is the 1-based screen column of the region. */
  frame(x0: number): string {
    const buf = this.term.buffer.active;
    let out = '';
    for (let y = 0; y < this.rows; y++) {
      const row = renderRow(buf.getLine(buf.baseY + y), this.cols, this.cell);
      if (row === this.prev[y]) continue;
      this.prev[y] = row;
      out += `\x1b[${y + 1};${x0}H${row}`;
    }
    return out;
  }

  /** Move the real cursor onto the node's cursor and show it if the node shows its own. */
  cursor(x0: number): string {
    const b = this.term.buffer.active;
    return `\x1b[${Math.min(b.cursorY, this.rows - 1) + 1};${Math.min(b.cursorX, this.cols - 1) + x0}H${this.cursorVisible ? '\x1b[?25h' : ''}`;
  }

  dispose(): void { this.term.dispose(); }
}
