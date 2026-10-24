/**
 * AC 12: wheel zoom about the cursor with clamping, drag, reset.
 *
 * @author Patrick Finazzo
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_K, MIN_K, applyDrag, applyWheel, reset, transformOf } from '../renderer/zoom.js';

test('reset is identity', () => {
  assert.deepEqual(reset(), { k: 1, tx: 0, ty: 0 });
  assert.equal(transformOf(reset()), 'translate(0 0) scale(1)');
});

test('wheel up zooms in about the cursor; the cursor point stays fixed', () => {
  const s = applyWheel(reset(), { x: 100, y: 50, deltaY: -500 });
  assert.ok(s.k > 1);
  // point under cursor maps to itself: x = tx + k * x0 where x0 = (100 - 0) / 1
  assert.ok(Math.abs(s.tx + s.k * 100 - 100) < 1e-6);
  assert.ok(Math.abs(s.ty + s.k * 50 - 50) < 1e-6);
});

test('clamps between MIN_K and MAX_K', () => {
  let s = reset();
  for (let i = 0; i < 50; i += 1) s = applyWheel(s, { x: 0, y: 0, deltaY: -1000 });
  assert.equal(s.k, MAX_K);
  for (let i = 0; i < 100; i += 1) s = applyWheel(s, { x: 0, y: 0, deltaY: 1000 });
  assert.equal(s.k, MIN_K);
});

test('drag translates without changing scale', () => {
  const s = applyDrag({ k: 2, tx: 10, ty: 20 }, { dx: 5, dy: -3 });
  assert.deepEqual(s, { k: 2, tx: 15, ty: 17 });
});
