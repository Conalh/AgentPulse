/**
 * Property tests on the pure-core layers (v0.6.1).
 *
 * Unlike example-driven tests (one input → one assertion), these
 * generate randomized inputs and assert *invariants* that must hold
 * regardless of which specific input was generated. Property tests
 * catch the bugs that hide in the gaps between examples — the kind
 * of subtle regressions that crop up when someone edits a rule tree
 * at 2 am.
 *
 * Conventions:
 *  - Hand-rolled `Math.random()` generation (no fast-check dep). The
 *    invariants we're checking are simple enough that fuzz loops over
 *    a few hundred iterations are sufficient. Lower noise, zero deps.
 *  - Each property has a deterministic seed line at the top of the
 *    test for reproducibility — set `AGENTPULSE_PROPERTY_SEED=<n>` in
 *    the env to replay a specific run (we just feed it into Math.random
 *    indirectly via a small PRNG below).
 *  - Iteration count is 200 per property — sweet spot for "catches
 *    real bugs" + "runs in under a second."
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTrajectory, readOutcomeSignal } from '../dist/trajectory.js';
import { sparkline } from '../dist/tui/sparkline.js';
import { parseDuration } from '../dist/cli.js';
import { applyHysteresis, initialHysteresis } from '../dist/hysteresis.js';
import { analyzeSequences } from '../dist/sequences.js';

const ITERATIONS = 200;

// ── Tiny seeded PRNG so we can reproduce a flaking run ──────────────
// xorshift32. Plenty for property-test noise.
function makeRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0xdeadbeef;
  return function rng() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

const SEED = Number.parseInt(process.env.AGENTPULSE_PROPERTY_SEED ?? '', 10);
const rng = makeRng(Number.isFinite(SEED) && SEED > 0 ? SEED : Date.now() & 0xffffffff);

function randInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randChoice(arr) {
  return arr[randInt(0, arr.length - 1)];
}

// ── Fixture builders ────────────────────────────────────────────────

function randomEnriched() {
  const windowStart = 1_700_000_000_000;
  const durationMs = randInt(60_000, 60 * 60_000);
  const windowEnd = windowStart + durationMs;
  return {
    events: [],
    windowStart,
    windowEnd,
    durationMs,
    topics: [],
    pathClusters: {},
    actionCounts: {
      exploration: randInt(0, 20),
      editing: randInt(0, 20),
      verification: randInt(0, 20),
      external: randInt(0, 5),
      navigation: randInt(0, 5),
      other: randInt(0, 5),
    },
    primaryFiles: [],
    commandVerbs: [],
    uniqueTools: [],
    toolInvocationCount: randInt(0, 50),
    userMessageCount: randInt(0, 10),
    runtimeUsage: { 'claude-code': 1 },
  };
}

function randomOutcome() {
  return {
    verificationTrend: randChoice([
      'improving',
      'regressing',
      'flat_pass',
      'flat_fail',
      'no_data',
    ]),
    userToneTrend: randChoice([
      'affirming',
      'correcting',
      'questioning',
      'idle',
      'neutral',
    ]),
    completionVerbsRecent: rng() < 0.3,
    idleGapMs: randInt(0, 30 * 60_000),
  };
}

// ── classifyTrajectory invariants ───────────────────────────────────

test('property: classifyTrajectory confidence is always in [0, 1]', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const enriched = randomEnriched();
    const outcome = randomOutcome();
    const verdict = classifyTrajectory(enriched, outcome);
    assert.ok(
      verdict.confidence >= 0 && verdict.confidence <= 1,
      `iteration ${i}: confidence ${verdict.confidence} out of [0, 1]`,
    );
  }
});

test('property: classifyTrajectory bucket is always one of the six known values', () => {
  const KNOWN = new Set([
    'converging',
    'exploring',
    'stuck',
    'done',
    'drifting',
    'idle',
  ]);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const enriched = randomEnriched();
    const outcome = randomOutcome();
    const verdict = classifyTrajectory(enriched, outcome);
    assert.ok(
      KNOWN.has(verdict.bucket),
      `iteration ${i}: unknown bucket ${verdict.bucket}`,
    );
  }
});

test('property: classifyTrajectory is deterministic (same inputs → same verdict)', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const enriched = randomEnriched();
    const outcome = randomOutcome();
    const v1 = classifyTrajectory(enriched, outcome);
    const v2 = classifyTrajectory(enriched, outcome);
    assert.equal(v1.bucket, v2.bucket, `iteration ${i}: bucket differs`);
    assert.equal(v1.confidence, v2.confidence, `iteration ${i}: confidence differs`);
    assert.deepEqual(v1.signals, v2.signals, `iteration ${i}: signals differ`);
  }
});

test('property: classifyTrajectory drifts array is empty unless bucket === drifting', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const enriched = randomEnriched();
    const outcome = randomOutcome();
    const verdict = classifyTrajectory(enriched, outcome);
    if (verdict.bucket !== 'drifting') {
      assert.equal(
        verdict.drifts.length,
        0,
        `iteration ${i}: non-drifting verdict (${verdict.bucket}) has ${verdict.drifts.length} drifts`,
      );
    }
  }
});

// ── sparkline invariants ────────────────────────────────────────────

test('property: sparkline output length equals the requested width', () => {
  const WINDOW_START = 1_700_000_000_000;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const width = randInt(1, 64);
    const duration = randInt(60_000, 60 * 60_000);
    const n = randInt(0, 100);
    const timestamps = [];
    for (let j = 0; j < n; j += 1) {
      timestamps.push(WINDOW_START + randInt(0, duration));
    }
    const out = sparkline(timestamps, WINDOW_START, WINDOW_START + duration, {
      width,
      emptyFallback: ' '.repeat(width),
    });
    assert.equal(
      out.length,
      width,
      `iteration ${i}: width ${width}, got length ${out.length}: "${out}"`,
    );
  }
});

test('property: sparkline empty fallback used when no timestamps fall in window', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const width = randInt(1, 64);
    const fallback = '·'.repeat(width);
    const out = sparkline([], 1_700_000_000_000, 1_700_000_001_000, {
      width,
      emptyFallback: fallback,
    });
    assert.equal(out, fallback, `iteration ${i}: empty input did not produce fallback`);
  }
});

// ── parseDuration invariants ────────────────────────────────────────

test('property: parseDuration linearity — N*1m === parseDuration(`Nm`)', () => {
  const oneMinute = parseDuration('1m');
  assert.equal(oneMinute, 60_000);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const n = randInt(1, 1000);
    const parsed = parseDuration(`${n}m`);
    assert.equal(parsed, n * oneMinute, `iteration ${i}: parseDuration(${n}m)`);
  }
});

test('property: parseDuration rejects malformed inputs without throwing', () => {
  // Note: `1.5h` IS valid per the grammar (`\d+(\.\d+)?` covers fractional).
  // Test only inputs that should genuinely reject.
  const bad = ['', 'abc', '5x', '-1s', 'm', '20', '   '];
  for (const s of bad) {
    const parsed = parseDuration(s);
    assert.equal(parsed, null, `expected null for ${JSON.stringify(s)}`);
  }
});

// ── applyHysteresis invariants ──────────────────────────────────────

test('property: applyHysteresis input state is never mutated', () => {
  const BUCKETS = ['converging', 'exploring', 'stuck', 'done', 'drifting', 'idle'];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = initialHysteresis(randChoice(BUCKETS));
    const frozen = JSON.stringify(start);
    applyHysteresis(start, randChoice(BUCKETS));
    assert.equal(
      JSON.stringify(start),
      frozen,
      `iteration ${i}: input state mutated`,
    );
  }
});

test('property: applyHysteresis stableBucket only changes after 2 consecutive agreements', () => {
  // For any starting state and any sequence of pulses, the stable bucket
  // at step N+1 either equals stable at step N, OR equals pendingBucket
  // at step N (and only if that pending had count ≥ 1 already, i.e. the
  // second confirmation completes the flip).
  const BUCKETS = ['converging', 'exploring', 'stuck', 'done', 'drifting', 'idle'];
  for (let i = 0; i < ITERATIONS; i += 1) {
    let state = initialHysteresis(randChoice(BUCKETS));
    const steps = randInt(2, 10);
    for (let s = 0; s < steps; s += 1) {
      const prev = state;
      const raw = randChoice(BUCKETS);
      const step = applyHysteresis(prev, raw);
      const flipped = step.stableBucket !== prev.stableBucket;
      if (flipped) {
        // To have flipped, the previous pending must have been `raw`
        // and had count >= 1 (so this pulse is the second confirmation).
        assert.ok(
          prev.pendingBucket === raw && prev.pendingCount >= 1,
          `iteration ${i}, step ${s}: flipped to ${step.stableBucket} ` +
            `but prev pending was ${prev.pendingBucket} with count ${prev.pendingCount}`,
        );
      }
      state = step.state;
    }
  }
});

// ── analyzeSequences invariants ─────────────────────────────────────

test('property: analyzeSequences pattern is one of the five known values', () => {
  const KNOWN = new Set([
    'tdd_loop',
    'exploratory_edit',
    'refuse_to_verify',
    'stuck_loop',
    'none',
  ]);
  for (let i = 0; i < ITERATIONS; i += 1) {
    // Random handful of tool_use events. The classifier should never
    // produce a pattern outside the known set, regardless of input.
    const n = randInt(0, 20);
    const events = [];
    const t0 = 1_700_000_000_000;
    for (let j = 0; j < n; j += 1) {
      events.push({
        timestamp: t0 + j * 1000,
        runtime: 'claude-code',
        kind: 'tool_use',
        toolName: randChoice(['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Write']),
        toolInput: randChoice(['Bash']) === 'Bash' ? { command: 'npm test' } : {},
      });
    }
    const sig = analyzeSequences(events);
    assert.ok(
      KNOWN.has(sig.pattern),
      `iteration ${i}: unknown pattern ${sig.pattern}`,
    );
    assert.ok(
      sig.confidence >= 0 && sig.confidence <= 1,
      `iteration ${i}: confidence ${sig.confidence} out of [0, 1]`,
    );
  }
});

// ── readOutcomeSignal invariants ────────────────────────────────────

test('property: readOutcomeSignal idleGapMs is always non-negative', () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const enriched = randomEnriched();
    const outcome = readOutcomeSignal(enriched);
    assert.ok(
      outcome.idleGapMs >= 0,
      `iteration ${i}: idleGapMs ${outcome.idleGapMs} is negative`,
    );
  }
});
