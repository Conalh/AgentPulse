/**
 * Smoke tests for the TUI pure-helper modules.
 *
 * These don't require the Ink test renderer, so they run reliably in CI
 * regardless of TTY support. The component tests live in tui-components.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { colorFor, pillFor, isLowConfidence } from '../dist/tui/theme.js';
import { formatAgo, formatDelta } from '../dist/tui/duration.js';

test('theme.colorFor returns the expected color per bucket', () => {
  assert.equal(colorFor('converging'), 'green');
  assert.equal(colorFor('exploring'), 'gray');
  assert.equal(colorFor('stuck'), 'yellow');
  assert.equal(colorFor('done'), 'blue');
  assert.equal(colorFor('drifting'), 'red');
});

test('theme.pillFor returns the expected glyph per bucket', () => {
  assert.equal(pillFor('converging'), '●');
  assert.equal(pillFor('exploring'), '◐');
  assert.equal(pillFor('stuck'), '▲');
  assert.equal(pillFor('done'), '■');
  assert.equal(pillFor('drifting'), '⚠');
});

test('theme.isLowConfidence flips at 0.5', () => {
  assert.equal(isLowConfidence(0.0), true);
  assert.equal(isLowConfidence(0.49), true);
  assert.equal(isLowConfidence(0.5), false);
  assert.equal(isLowConfidence(0.9), false);
});

test('duration.formatAgo formats "Ns ago" for sub-minute deltas', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAgo(now, now - 4000), '4s ago');
  assert.equal(formatAgo(now, now - 1000), '1s ago');
  assert.equal(formatAgo(now, now), '0s ago');
});

test('duration.formatAgo formats "N min ago" for minute-scale deltas', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAgo(now, now - 72_000), '1 min ago');
  assert.equal(formatAgo(now, now - 5 * 60_000), '5 min ago');
});

test('duration.formatAgo formats hours and days', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAgo(now, now - 3_700_000), '1h ago');
  assert.equal(formatAgo(now, now - 2 * 86_400_000), '2d ago');
});

test('duration.formatAgo handles zero / invalid timestamps', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatAgo(now, 0), 'never');
  assert.equal(formatAgo(now, -1), 'never');
});

test('duration.formatDelta produces bare deltas (no "ago")', () => {
  assert.equal(formatDelta(4_000), '4s');
  assert.equal(formatDelta(0), '0s');
  assert.equal(formatDelta(60_000), '1 min');
  assert.equal(formatDelta(3_600_000), '1h');
});
