import { expect, test } from 'vitest';
import { NodeScreen } from './screen.js';
import { encode, isLeftPress, isWheel, parseInput } from './mouse.js';

const feed = async (s: NodeScreen, data: string) => { s.write(data); await s.settle(); };

test('a row with a red bold word and a wide character renders as SGR text, padded to the width', async () => {
  const s = new NodeScreen(8, 2);
  await feed(s, '\x1b[1;31mred\x1b[0m 世');
  expect(s.frame(10)).toBe('\x1b[1;10H\x1b[0;1;31mred\x1b[0m 世  \x1b[2;10H        ');
});

test('only changed rows are re-emitted; truecolor, palette and bright colors map to SGR', async () => {
  const s = new NodeScreen(6, 3);
  await feed(s, '\x1b[38;2;1;2;3mA\x1b[48;5;200mB\x1b[0m\x1b[91mC');
  s.frame(1);
  expect(s.frame(1)).toBe('');
  await feed(s, '\x1b[0m\x1b[3;1Hz');
  expect(s.frame(1)).toBe('\x1b[3;1Hz     ');
  s.invalidate();
  expect(s.frame(1).startsWith('\x1b[1;1H\x1b[0;38;2;1;2;3mA\x1b[0;38;2;1;2;3;48;5;200mB\x1b[0;91mC\x1b[0m')).toBe(true);
});

test('cursor follows the node and is shown only while the node shows it; mouse mode is tracked', async () => {
  const s = new NodeScreen(10, 4);
  await feed(s, 'ab\r\ncd');
  expect(s.cursor(5)).toBe('\x1b[2;7H\x1b[?25h');
  await feed(s, '\x1b[?25l\x1b[?1002h');
  expect(s.cursor(5)).toBe('\x1b[2;7H');
  expect(s.mouse).toBe(true);
});

test('SGR mouse reports are split from keys, classified and re-encoded with the sidebar offset', () => {
  const p = parseInput('a\x1b[<0;35;7Mb\x1b[<64;40;2M\x1b[<0;35;7m');
  expect(p).toEqual([
    { text: 'a' }, { mouse: { b: 0, x: 35, y: 7, press: true } }, { text: 'b' },
    { mouse: { b: 64, x: 40, y: 2, press: true } }, { mouse: { b: 0, x: 35, y: 7, press: false } },
  ]);
  const [, m1, , w, r] = p as any[];
  expect([isLeftPress(m1.mouse), isWheel(w.mouse), isLeftPress(r.mouse)]).toEqual([true, true, false]);
  expect(encode(m1.mouse, 31)).toBe('\x1b[<0;4;7M');
  expect(encode(r.mouse, 31)).toBe('\x1b[<0;4;7m');
});
