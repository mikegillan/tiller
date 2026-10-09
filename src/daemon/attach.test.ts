import { expect, test } from 'vitest';
import { detachChord } from './attach.js';

test('Ctrl-\\ then d detaches, keeping earlier bytes', () => {
  expect(detachChord(false, 'ab\x1cd')).toEqual({ detach: true, passthrough: 'ab', held: false });
});
test('Ctrl-\\ then another byte passes both through', () => {
  expect(detachChord(false, '\x1cx')).toEqual({ detach: false, passthrough: '\x1cx', held: false });
});
test('a lone Ctrl-\\ is held until the next chunk', () => {
  const a = detachChord(false, 'a\x1c');
  expect(a).toEqual({ detach: false, passthrough: 'a', held: true });
  expect(detachChord(a.held, 'd').detach).toBe(true);
  expect(detachChord(a.held, 'q')).toEqual({ detach: false, passthrough: '\x1cq', held: false });
});
