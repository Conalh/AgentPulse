/**
 * Tests for src/hysteresis.ts — verdict-bucket dampening (v0.5.4).
 *
 * The state machine is small and pure, so the tests exhaust the cases
 * directly. The behaviour under test is "a new bucket must be produced
 * by 2 consecutive pulses before it replaces the stable bucket."
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HYSTERESIS_CONFIRMATIONS,
  applyHysteresis,
  initialHysteresis,
} from '../dist/hysteresis.js';

test('HYSTERESIS_CONFIRMATIONS is 2 (one less = no dampening; more = sluggish)', () => {
  assert.equal(HYSTERESIS_CONFIRMATIONS, 2);
});

test('initialHysteresis: first observation IS the truth — no dampening on entry', () => {
  const s = initialHysteresis('converging');
  assert.equal(s.stableBucket, 'converging');
  assert.equal(s.pendingBucket, null);
  assert.equal(s.pendingCount, 0);
});

test('applyHysteresis: same bucket → no change, pending cleared', () => {
  const before = {
    stableBucket: 'converging',
    pendingBucket: 'stuck',
    pendingCount: 1,
  };
  const step = applyHysteresis(before, 'converging');
  assert.equal(step.flipped, false);
  assert.equal(step.stableBucket, 'converging');
  assert.equal(step.state.stableBucket, 'converging');
  assert.equal(step.state.pendingBucket, null);
  assert.equal(step.state.pendingCount, 0);
});

test('applyHysteresis: single disagreement starts pending, no flip yet', () => {
  const before = initialHysteresis('converging');
  const step = applyHysteresis(before, 'stuck');
  assert.equal(step.flipped, false);
  assert.equal(step.stableBucket, 'converging', 'still showing converging on first disagreement');
  assert.equal(step.state.stableBucket, 'converging');
  assert.equal(step.state.pendingBucket, 'stuck');
  assert.equal(step.state.pendingCount, 1);
});

test('applyHysteresis: two consecutive agreements on a new bucket → flip', () => {
  let s = initialHysteresis('converging');
  s = applyHysteresis(s, 'stuck').state;
  const step = applyHysteresis(s, 'stuck');
  assert.equal(step.flipped, true);
  assert.equal(step.stableBucket, 'stuck');
  assert.equal(step.state.stableBucket, 'stuck');
  assert.equal(step.state.pendingBucket, null);
  assert.equal(step.state.pendingCount, 0);
});

test('applyHysteresis: A → B → A bounce does NOT flip (no two consecutive Bs)', () => {
  // converging → stuck → converging → ?
  // First stuck starts pending. Second pulse (back to converging) clears
  // pending. We're still showing converging. This is the noise-suppression
  // case — a one-off disagreement gets ignored.
  let s = initialHysteresis('converging');
  s = applyHysteresis(s, 'stuck').state;
  const step = applyHysteresis(s, 'converging');
  assert.equal(step.flipped, false);
  assert.equal(step.stableBucket, 'converging');
  assert.equal(step.state.pendingBucket, null);
  assert.equal(step.state.pendingCount, 0);
});

test('applyHysteresis: A → B → C resets candidate to C with count 1', () => {
  // If the second pulse disagrees with the first disagreement (i.e., we
  // see THREE buckets in a row), we start a fresh candidate. C is a NEW
  // disagreement, not a confirmation of B.
  let s = initialHysteresis('converging');
  s = applyHysteresis(s, 'stuck').state;
  const step = applyHysteresis(s, 'exploring');
  assert.equal(step.flipped, false);
  assert.equal(step.stableBucket, 'converging');
  assert.equal(step.state.pendingBucket, 'exploring');
  assert.equal(step.state.pendingCount, 1);
});

test('applyHysteresis: drifting takes one extra refresh to surface (the trade-off)', () => {
  // Documented trade-off: hysteresis applies to ALL transitions, including
  // entry into drifting. A session that goes converging → drifting needs
  // two drifting pulses in a row before the pill flips. Worst case: ~one
  // refresh interval (default 30s) of additional delay.
  let s = initialHysteresis('converging');
  let step = applyHysteresis(s, 'drifting');
  assert.equal(step.flipped, false, 'first drifting does not flip yet');
  assert.equal(step.stableBucket, 'converging');
  step = applyHysteresis(step.state, 'drifting');
  assert.equal(step.flipped, true);
  assert.equal(step.stableBucket, 'drifting');
});

test('applyHysteresis: a freshly-instantiated session in drifting alerts immediately', () => {
  // The trade-off above is only about TRANSITIONS. A first pulse that
  // classifies as drifting (e.g. session just discovered with active
  // drift) surfaces drifting immediately — no dampening on entry.
  const s = initialHysteresis('drifting');
  assert.equal(s.stableBucket, 'drifting');
});

test('applyHysteresis: post-flip, the pending state is cleared so the next pulse re-evaluates fresh', () => {
  // After a flip, the state should look exactly like a freshly-stable
  // session — no leftover pendingBucket / pendingCount that could
  // accidentally trigger another flip on the next pulse.
  let s = initialHysteresis('converging');
  s = applyHysteresis(s, 'stuck').state;
  s = applyHysteresis(s, 'stuck').state;
  assert.equal(s.stableBucket, 'stuck');
  assert.equal(s.pendingBucket, null);
  assert.equal(s.pendingCount, 0);

  // Another stuck pulse — already-stable, stays stable.
  const step = applyHysteresis(s, 'stuck');
  assert.equal(step.flipped, false);
  assert.equal(step.stableBucket, 'stuck');
});

test('applyHysteresis: returns a new state object (input not mutated)', () => {
  // The orchestrator stores the returned state. Purity of the helper
  // means the caller can safely keep references to old states (e.g.
  // for telemetry) without them being silently mutated.
  const before = initialHysteresis('converging');
  const frozen = JSON.stringify(before);
  applyHysteresis(before, 'stuck');
  assert.equal(JSON.stringify(before), frozen, 'input state must not have been mutated');
});
