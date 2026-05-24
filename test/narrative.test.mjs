// Tests for Layer 5 — narrative renderer.
// Run via `npm test` (which first compiles TS → dist/).

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRecap, humanDuration } from '../dist/narrative.js';

const T0 = 1_700_000_000_000;

function enrichedFixture(overrides = {}) {
  return {
    events: [],
    windowStart: T0,
    windowEnd: T0 + 18 * 60_000,
    durationMs: 18 * 60_000,
    topics: ['auth refactor'],
    pathClusters: { 'src/auth': 6, tests: 2 },
    actionCounts: {
      exploration: 3,
      editing: 5,
      verification: 4,
      external: 0,
      navigation: 1,
      other: 0,
    },
    primaryFiles: ['src/auth/session.ts', 'src/auth/login.ts'],
    commandVerbs: ['npm test'],
    uniqueTools: ['Read', 'Edit', 'Bash'],
    toolInvocationCount: 14,
    userMessageCount: 2,
    runtimeUsage: { 'claude-code': 14 },
    ...overrides,
  };
}

function outcomeFixture(overrides = {}) {
  return {
    verificationTrend: 'improving',
    userToneTrend: 'affirming',
    completionVerbsRecent: false,
    idleGapMs: 30_000,
    ...overrides,
  };
}

function verdictFixture(overrides = {}) {
  return {
    bucket: 'converging',
    confidence: 0.82,
    signals: ['edit-heavy', 'tests improving'],
    drifts: [],
    ...overrides,
  };
}

test('idle narrative with long file path renders single-line (v0.5.3 path truncation)', () => {
  // Pre-v0.5.3, a long primary-file path like
  // `C:\Dev\fit-ontology\web\app\clients\page.tsx` rendered untruncated
  // in the narrative, pushed past a typical terminal column width, and
  // wrapped onto a second line — the NARRATIVE_MIN_HEIGHT pad from
  // v0.3.5 was the only thing keeping the layout from jerking. v0.5.3
  // adds shortenPath so the narrative compresses to `…/clients/page.tsx`.
  const enriched = enrichedFixture({
    actionCounts: { exploration: 0, editing: 12, verification: 0, external: 0, navigation: 0, other: 0 },
    primaryFiles: ['C:/Users/conno/Dev/fit-ontology/web/app/clients/dashboard/page.tsx'],
    pathClusters: { 'C:/Users/conno/Dev/fit-ontology/web/app/clients/dashboard': 12 },
    events: [
      { timestamp: T0, runtime: 'claude-code', kind: 'tool_use' },
    ],
  });
  const outcome = outcomeFixture({
    verificationTrend: 'no_data',
    userToneTrend: 'idle',
    idleGapMs: 12 * 60_000,
  });
  const verdict = verdictFixture({ bucket: 'idle', confidence: 0.7 });
  const recap = renderRecap(enriched, outcome, verdict);

  // The full original path must NOT appear — it was 65+ chars and would
  // wrap a typical terminal column.
  assert.doesNotMatch(
    recap.narrative,
    /C:\/Users\/conno\/Dev\/fit-ontology\/web\/app\/clients\/dashboard\/page\.tsx/,
  );
  // The shortened form (with `…/`) AND the basename must.
  assert.match(recap.narrative, /…\//, 'should include the ellipsis marker');
  assert.match(recap.narrative, /page\.tsx/, 'should preserve the basename');
});

test('humanDuration: seconds for sub-minute', () => {
  assert.equal(humanDuration(15_000), '15 seconds');
  assert.equal(humanDuration(1_000), '1 second');
});

test('humanDuration: minutes for sub-hour', () => {
  assert.equal(humanDuration(18 * 60_000), '18 minutes');
  assert.equal(humanDuration(60_000), '1 minute');
});

test('humanDuration: hours + minutes when both nonzero', () => {
  assert.equal(humanDuration(72 * 60_000), '1 hour 12 minutes');
  assert.equal(humanDuration(2 * 3_600_000), '2 hours');
});

test('humanDuration: handles bad input', () => {
  assert.equal(humanDuration(0), '0 seconds');
  assert.equal(humanDuration(-5), '0 seconds');
  assert.equal(humanDuration(NaN), '0 seconds');
});

test('converging: narrative names topic, duration, primary file, and tests passing', () => {
  const recap = renderRecap(enrichedFixture(), outcomeFixture(), verdictFixture());
  assert.match(recap.narrative, /auth refactor/);
  assert.match(recap.narrative, /18 minutes/);
  assert.match(recap.narrative, /session\.ts/);
  assert.match(recap.narrative, /passing/i);
  assert.equal(recap.verdict.bucket, 'converging');
  assert.equal(recap.durationHuman, '18 minutes');
});

test('exploring: narrative says "exploring" and "no edits yet"', () => {
  const enriched = enrichedFixture({
    topics: [],
    actionCounts: {
      exploration: 12,
      editing: 0,
      verification: 0,
      external: 0,
      navigation: 2,
      other: 0,
    },
    primaryFiles: [],
    pathClusters: { 'src/payments': 8 },
    durationMs: 4 * 60_000,
  });
  const verdict = verdictFixture({ bucket: 'exploring', confidence: 0.7 });
  const recap = renderRecap(enriched, outcomeFixture({ verificationTrend: 'no_data' }), verdict);
  assert.match(recap.narrative, /exploring/i);
  assert.match(recap.narrative, /no edits yet/i);
  assert.match(recap.narrative, /src\/payments/);
});

test("stuck: narrative includes 'try again' tone and 'checking in'", () => {
  const enriched = enrichedFixture({
    actionCounts: {
      exploration: 1,
      editing: 9,
      verification: 5,
      external: 0,
      navigation: 0,
      other: 0,
    },
  });
  const outcome = outcomeFixture({
    verificationTrend: 'flat_fail',
    userToneTrend: 'correcting',
  });
  const verdict = verdictFixture({ bucket: 'stuck', confidence: 0.72 });
  const recap = renderRecap(enriched, outcome, verdict);
  assert.match(recap.narrative, /try again/i);
  assert.match(recap.narrative, /checking in/i);
  assert.match(recap.narrative, /tests aren't passing/);
});

test('stuck + refuse_to_verify: narrative does NOT repeat the "no verify" phrase (v0.4.3)', () => {
  // Pre-fix the narrative read:
  //   "...but without running tests to verify. The conversation has a
  //    'try again' tone. Worth checking in. It's been editing without
  //    running anything to verify — worth checking."
  // Two near-identical "verify" + "worth checking" tails back-to-back.
  // The stuck bucket narrative already covers the refuse_to_verify signal;
  // the sequence phrase should be suppressed.
  const enriched = enrichedFixture({
    actionCounts: {
      exploration: 1,
      editing: 10,
      verification: 0,
      external: 0,
      navigation: 0,
      other: 0,
    },
    primaryFiles: ['README.md'],
  });
  const outcome = outcomeFixture({
    verificationTrend: 'no_data',
    userToneTrend: 'correcting',
  });
  const verdict = verdictFixture({
    bucket: 'stuck',
    confidence: 0.75,
    sequence: {
      pattern: 'refuse_to_verify',
      confidence: 0.7,
      details: ['10 edits with no verification events in the window'],
    },
  });
  const recap = renderRecap(enriched, outcome, verdict);

  // Stuck-bucket content is still present.
  assert.match(recap.narrative, /without running tests to verify/);
  assert.match(recap.narrative, /checking in/i);

  // The sequence phrase must NOT have been appended.
  assert.doesNotMatch(
    recap.narrative,
    /without running anything to verify/,
    'narrative should not include the refuse_to_verify sequence phrase on top of the stuck body',
  );
  // "worth checking" (or "worth checking in") should appear at most once.
  const matches = recap.narrative.match(/worth checking/gi) ?? [];
  assert.equal(matches.length, 1, 'narrative should say "worth checking" only once');
});

test('done: narrative says "finished" and "signed off"', () => {
  const outcome = outcomeFixture({
    verificationTrend: 'flat_pass',
    userToneTrend: 'idle',
    completionVerbsRecent: true,
    idleGapMs: 5 * 60_000,
  });
  const verdict = verdictFixture({ bucket: 'done', confidence: 0.88 });
  const recap = renderRecap(enrichedFixture(), outcome, verdict);
  assert.match(recap.narrative, /finished/i);
  assert.match(recap.narrative, /signed off/i);
  assert.match(recap.narrative, /5 minutes/);
});

test('drifting: narrative starts with warning glyph and includes drift descriptions', () => {
  const verdict = verdictFixture({
    bucket: 'drifting',
    confidence: 0.6,
    drifts: [
      {
        tool: 'task_bound',
        kind: 'task_bound.out_of_scope_file',
        severity: 'medium',
        message: 'Touched ~/.bashrc',
      },
      {
        tool: 'scope_trail',
        kind: 'scope_trail.permission_allow_widened',
        severity: 'high',
        message: 'Widened Bash allowlist',
      },
    ],
  });
  const recap = renderRecap(enrichedFixture(), outcomeFixture(), verdict);
  assert.ok(recap.narrative.startsWith('⚠'));
  assert.match(recap.narrative, /Touched ~\/\.bashrc/);
  assert.match(recap.narrative, /Widened Bash allowlist/);
});

test('low confidence: narrative is prefixed with "Looks like"', () => {
  const verdict = verdictFixture({ bucket: 'converging', confidence: 0.3 });
  const recap = renderRecap(enrichedFixture(), outcomeFixture(), verdict);
  assert.ok(recap.narrative.startsWith('Looks like '));
  assert.match(recap.narrative, /your agent/);
});

test('low confidence does NOT prefix drifting', () => {
  const verdict = verdictFixture({
    bucket: 'drifting',
    confidence: 0.2,
    drifts: [
      {
        tool: 'task_bound',
        kind: 'task_bound.out_of_scope_file',
        severity: 'medium',
        message: 'Edited ~/.gitconfig',
      },
    ],
  });
  const recap = renderRecap(enrichedFixture(), outcomeFixture(), verdict);
  assert.ok(recap.narrative.startsWith('⚠'));
  assert.ok(!recap.narrative.startsWith('Looks like'));
});

test('PulseRecap shape: copies window bounds, verdict, enriched, outcome through', () => {
  const enriched = enrichedFixture();
  const outcome = outcomeFixture();
  const verdict = verdictFixture();
  const recap = renderRecap(enriched, outcome, verdict);
  assert.equal(recap.windowStart, enriched.windowStart);
  assert.equal(recap.windowEnd, enriched.windowEnd);
  assert.equal(recap.verdict, verdict);
  assert.equal(recap.enriched, enriched);
  assert.equal(recap.outcome, outcome);
  assert.equal(typeof recap.narrative, 'string');
  assert.equal(typeof recap.durationHuman, 'string');
});