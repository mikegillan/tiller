import assert from 'node:assert/strict';
import test from 'node:test';
import { cropFor, planBeat } from './beats.js';

test('a crop centres its rect, but never shows past the frame edges', () => {
  // A 1000x500 frame at 1.6x is 1600x800: offsets range from -600 to 0 across, -300 to 0 down.
  assert.deepEqual(cropFor([450, 200, 100, 100], 1000, 500), { scale: 1.6, tx: -300, ty: -150 });
  assert.deepEqual(cropFor([0, 0, 10, 10], 1000, 500), { scale: 1.6, tx: 0, ty: 0 });
  assert.deepEqual(cropFor([990, 490, 10, 10], 1000, 500), { scale: 1.6, tx: -600, ty: -300 });
});

test('a long wait plays whole at a whole-number speed, then holds the last frame', () => {
  // 40s into 15s needs 2.67x, so 3x: 40 / 3 = 13.33s = 400 frames, 50 frames of hold.
  assert.deepEqual(planBeat({ seconds: 15 }, 40), [{ trimBefore: 0, frames: 400, speed: 3 }]);
});

test('a clip that nearly fits plays at 1x and is trimmed at the end', () => {
  assert.deepEqual(planBeat({ seconds: 10 }, 14), [{ trimBefore: 0, frames: 300, speed: 1 }]);
});

test('a short clip plays at 1x (the rest is a hold)', () => {
  assert.deepEqual(planBeat({ seconds: 8 }, 5), [{ trimBefore: 0, frames: 150, speed: 1 }]);
});

test('speed caps at 4x and the overflow is trimmed', () => {
  assert.deepEqual(planBeat({ seconds: 10 }, 60), [{ trimBefore: 0, frames: 300, speed: 4 }]);
});

test('explicit segments run back to back and stop at the target', () => {
  // 4s at 1x (120) + 24s at 3x (240) fills 12s; the last segment does not fit.
  const beat = { seconds: 12, segments: [{ from: 0, to: 4, speed: 1 }, { from: 4, to: 28, speed: 3 }, { from: 28, speed: 1 }] };
  assert.deepEqual(planBeat(beat, 30), [
    { trimBefore: 0, frames: 120, speed: 1 },
    { trimBefore: 120, frames: 240, speed: 3 },
  ]);
});
