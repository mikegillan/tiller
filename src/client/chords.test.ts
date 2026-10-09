import { expect, test } from 'vitest';
import { initial, step, type Action, type ChordState } from './chords.js';

const run = (input: string, s: ChordState = initial) => {
  const actions: Action[] = [];
  for (const ch of input) { const r = step(s, ch); s = r.state; actions.push(...r.actions); }
  return { s, actions };
};
const sw = (target: any) => [{ type: 'switch', target }];

test.each([
  ['d', [{ type: 'detach' }]], ['j', sw('next')], ['k', sw('prev')], ['n', [{ type: 'act', key: 'new' }]], ['s', [{ type: 'act', key: 'sidebar' }]], ['!', sw('needs')], ['b', sw('back')],
  ['?', [{ type: 'help' }]], ['l', [{ type: 'picker' }]], ['1', sw(0)], ['9', sw(8)],
])('Ctrl-\\ %s', (key, actions) => {
  expect(run('\x1c' + key).actions).toEqual(actions);
});
test('plain bytes pass through; a lone prefix is held', () => {
  expect(run('ab').actions).toEqual([{ type: 'passthrough', data: 'a' }, { type: 'passthrough', data: 'b' }]);
  const r = run('\x1c');
  expect(r).toEqual({ s: { held: true, pick: null }, actions: [] });
  expect(run('d', r.s).actions).toEqual([{ type: 'detach' }]);
});
test('double prefix sends a literal Ctrl-\\', () => {
  expect(run('\x1c\x1c').actions).toEqual([{ type: 'passthrough', data: '\x1c' }]);
});
test('unknown chord key passes both bytes through', () => {
  expect(run('\x1cz').actions).toEqual([{ type: 'passthrough', data: '\x1cz' }]);
});
test('picker parses a multi-digit number on Enter, Esc cancels, other keys are swallowed', () => {
  const r = run('\x1cl12');
  expect(r.s.pick).toBe('12');
  expect(run('\r', r.s).actions).toEqual(sw(11));
  expect(run('x\r', run('\x1cl2').s).actions).toEqual(sw(1));
  expect(run('\x1b', r.s)).toEqual({ s: initial, actions: sw('cur') });
  expect(run('\r', run('\x1cl').s).actions).toEqual(sw('cur'));
});
