import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparkline } from '../dist/tui/sparkline.js';

const T0 = 1_700_000_000_000;
const WINDOW_MS = 20 * 60 * 1000;
const T_END = T0 + WINDOW_MS;

test('sparkline: empty timestamps → empty fallback', () => {
  assert.equal(sparkline([], T0, T_END), '');
  assert.equal(sparkline([], T0, T_END, { emptyFallback: '——' }), '——');
});

test('sparkline: all timestamps in one bucket → one full cell + rest empty', () => {
  // All events near windowStart → leftmost cell.
  const events = [T0 + 100, T0 + 200, T0 + 300, T0 + 400];
  const out = sparkline(events, T0, T_END, { width: 8 });
  assert.equal(out.length, 8);
  // The leftmost cell should be the densest. Other cells should be empty (space).
  assert.notEqual(out[0], ' ');
  for (let i = 1; i < 8; i++) {
    assert.equal(out[i], ' ', `cell ${i} should be empty, got "${out[i]}"`);
  }
});

test('sparkline: timestamps evenly distributed → roughly even bars', () => {
  // 16 events evenly across an 8-cell window → 2 per cell.
  const events = [];
  for (let i = 0; i < 16; i++) {
    events.push(T0 + (i + 0.5) * (WINDOW_MS / 16));
  }
  const out = sparkline(events, T0, T_END, { width: 8 });
  assert.equal(out.length, 8);
  // Every cell should be non-empty.
  for (let i = 0; i < 8; i++) {
    assert.notEqual(out[i], ' ', `cell ${i} should be non-empty`);
  }
});

test('sparkline: out-of-window timestamps are ignored', () => {
  // Two events before window, one inside, one after.
  const events = [T0 - 1000, T0 + 500, T_END + 1000];
  const out = sparkline(events, T0, T_END, { width: 4 });
  assert.equal(out.length, 4);
  // Only one valid event → exactly one non-empty cell.
  const nonEmpty = [...out].filter((c) => c !== ' ').length;
  assert.equal(nonEmpty, 1);
});

test('sparkline: invalid window bounds return fallback', () => {
  assert.equal(sparkline([T0], NaN, T_END), '');
  assert.equal(sparkline([T0], T0, T0), ''); // zero span
  assert.equal(sparkline([T0], T_END, T0), ''); // negative span
});

test('sparkline: deterministic — same input → same output', () => {
  const events = [T0 + 100, T0 + 1000, T0 + 5000];
  const a = sparkline(events, T0, T_END, { width: 12 });
  const b = sparkline(events, T0, T_END, { width: 12 });
  assert.equal(a, b);
});
