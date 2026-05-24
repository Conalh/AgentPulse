// @ts-check
/**
 * Tests for Layer 2.5 — analyzeSequences (src/sequences.ts).
 *
 * One test per pattern firing correctly + empty + mixed/no-match +
 * stuck-loop file-discrimination (different files don't trigger).
 *
 * Timestamps use FRESH + offset (mirroring trajectory.test.mjs) so events
 * look chronologically real. analyzeSequences itself doesn't care about
 * windowEnd / freshness — only about the ordering — but consistency with
 * the other test suites makes the fixtures easier to read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSequences } from '../dist/sequences.js';
import { classifyTrajectory, readOutcomeSignal } from '../dist/trajectory.js';

const T0 = 1_700_000_000_000;
const WINDOW_DURATION_MS = 20 * 60 * 1000;
const WINDOW_END = T0 + WINDOW_DURATION_MS;
const FRESH = WINDOW_END - 2 * 60 * 1000;

function bashEvent(t, command, { exitCode, resultText } = {}) {
  return {
    timestamp: t,
    runtime: 'claude-code',
    kind: 'tool_use',
    toolName: 'Bash',
    toolInput: { command },
    toolResultExitCode: exitCode,
    toolResultText: resultText,
  };
}

function toolUse(t, toolName, input) {
  return {
    timestamp: t,
    runtime: 'claude-code',
    kind: 'tool_use',
    toolName,
    toolInput: input,
  };
}

function userMsg(t, text) {
  return { timestamp: t, runtime: 'claude-code', kind: 'user_message', text };
}

function makeWindow(overrides = {}) {
  const events = overrides.events ?? [];
  const windowStart = overrides.windowStart ?? T0;
  const windowEnd = overrides.windowEnd ?? WINDOW_END;
  return {
    events,
    windowStart,
    windowEnd,
    durationMs: windowEnd - windowStart,
    topics: overrides.topics ?? [],
    pathClusters: overrides.pathClusters ?? {},
    actionCounts: {
      exploration: 0,
      editing: 0,
      verification: 0,
      external: 0,
      navigation: 0,
      other: 0,
      ...(overrides.actionCounts ?? {}),
    },
    primaryFiles: overrides.primaryFiles ?? [],
    commandVerbs: overrides.commandVerbs ?? [],
    uniqueTools: overrides.uniqueTools ?? [],
    toolInvocationCount: overrides.toolInvocationCount ?? 0,
    userMessageCount: overrides.userMessageCount ?? 0,
    runtimeUsage: overrides.runtimeUsage ?? { 'claude-code': 1 },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pattern detection — one test per pattern
// ─────────────────────────────────────────────────────────────────────

test('analyzeSequences: empty event list → none / 0 confidence', () => {
  const sig = analyzeSequences([]);
  assert.equal(sig.pattern, 'none');
  assert.equal(sig.confidence, 0);
  assert.deepEqual(sig.details, []);
});

test('analyzeSequences: mixed activity that matches nothing → none', () => {
  // One edit, one verify (only 1 cycle — below the 2-cycle tdd threshold),
  // a couple of reads (below the 3-consecutive exploratory threshold).
  const events = [
    toolUse(FRESH + 1000, 'Read', { file_path: 'src/a.ts' }),
    toolUse(FRESH + 2000, 'Edit', { file_path: 'src/a.ts' }),
    bashEvent(FRESH + 3000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 4000, 'Read', { file_path: 'src/b.ts' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'none');
});

test('analyzeSequences: tdd_loop fires on ≥2 edit→verify cycles', () => {
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'tdd_loop');
  assert.equal(sig.cycleCount, 2);
  assert.ok(sig.confidence >= 0.65 && sig.confidence <= 0.85);
});

test('analyzeSequences: tdd_loop with ≥3 cycles → confidence 0.85', () => {
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 2000, 'pytest', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 4000, 'pytest', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 5000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 6000, 'pytest', { exitCode: 0, resultText: 'PASS' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'tdd_loop');
  assert.equal(sig.cycleCount, 3);
  assert.ok(sig.confidence >= 0.8);
});

test('analyzeSequences: refuse_to_verify fires on ≥4 edits with 0 verifications', () => {
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/a.ts' }),
    toolUse(FRESH + 2000, 'Edit', { file_path: 'src/b.ts' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/c.ts' }),
    toolUse(FRESH + 4000, 'Edit', { file_path: 'src/d.ts' }),
    toolUse(FRESH + 5000, 'Edit', { file_path: 'src/e.ts' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'refuse_to_verify');
  assert.ok(sig.confidence >= 0.6);
});

test('analyzeSequences: stuck_loop tolerates interleaved reads between edit and verify (v0.5.3)', () => {
  // Real agents do exploration BETWEEN iterations: edit a file, read 3
  // others to figure out what's wrong, then run tests. Pre-fix the
  // 3-position look-ahead window would miss the verify event because
  // 3 Read events filled the slots first. v0.5.3 skips exploration
  // events when looking for the next verification, so the cycle is
  // detected correctly.
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/auth.ts' }),
    toolUse(FRESH + 1500, 'Read', { file_path: 'src/auth.test.ts' }),
    toolUse(FRESH + 2000, 'Read', { file_path: 'src/auth.types.ts' }),
    toolUse(FRESH + 2500, 'Read', { file_path: 'src/session.ts' }),
    bashEvent(FRESH + 3000, 'npm test', { exitCode: 1, resultText: 'FAIL auth.test.ts' }),
    toolUse(FRESH + 4000, 'Edit', { file_path: 'src/auth.ts' }),
    toolUse(FRESH + 4500, 'Grep', { pattern: 'login' }),
    toolUse(FRESH + 5000, 'Glob', { pattern: '**/*.test.ts' }),
    bashEvent(FRESH + 5500, 'npm test', { exitCode: 1, resultText: 'FAIL auth.test.ts' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'stuck_loop');
  assert.equal(sig.primaryFile, 'src/auth.ts');
  assert.equal(sig.cycleCount, 2);
});

test('analyzeSequences: stuck_loop fires on same-file edit→fail cycles', () => {
  // Same file edited twice, each time followed by a failing test.
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/auth.ts' }),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 1, resultText: 'FAIL auth.test.ts' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/auth.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 1, resultText: 'FAIL auth.test.ts' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'stuck_loop');
  assert.equal(sig.primaryFile, 'src/auth.ts');
  assert.equal(sig.cycleCount, 2);
  assert.ok(sig.confidence >= 0.8);
});

test('analyzeSequences: stuck_loop does NOT fire when each cycle hits a different file', () => {
  // Even though there are 2 edit→fail cycles, the files differ — that's
  // not "stuck on the same file", it's just unrelated failures. Should
  // fall through to refuse_to_verify? No — verifications WERE run.
  // Should fall through to tdd_loop? Yes, technically 2 cycles. So this
  // tests that the file-discrimination logic in stuck_loop works.
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/a.ts' }),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 1, resultText: 'FAIL' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/b.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 1, resultText: 'FAIL' }),
  ];
  const sig = analyzeSequences(events);
  assert.notEqual(sig.pattern, 'stuck_loop');
  // Falls through to tdd_loop because there ARE 2 edit→verify cycles.
  assert.equal(sig.pattern, 'tdd_loop');
});

test('analyzeSequences: exploratory_edit fires on read+ → edit shape', () => {
  // 4 consecutive reads, then 2 edits in the back half.
  const events = [
    toolUse(FRESH + 1000, 'Read', { file_path: 'src/a.ts' }),
    toolUse(FRESH + 2000, 'Read', { file_path: 'src/b.ts' }),
    toolUse(FRESH + 3000, 'Grep', { pattern: 'foo' }),
    toolUse(FRESH + 4000, 'Read', { file_path: 'src/c.ts' }),
    toolUse(FRESH + 5000, 'Edit', { file_path: 'src/a.ts' }),
    toolUse(FRESH + 6000, 'Edit', { file_path: 'src/a.ts' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'exploratory_edit');
  assert.ok(sig.confidence >= 0.5);
});

test('analyzeSequences: determinism — same input → same output', () => {
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
  ];
  const a = analyzeSequences(events);
  const b = analyzeSequences(events);
  assert.deepEqual(a, b);
});

test('analyzeSequences: non-tool events (user_message) are ignored', () => {
  // User messages interleaved should not break detection.
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/foo.ts' }),
    userMsg(FRESH + 1500, 'how is it going?'),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/foo.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
  ];
  const sig = analyzeSequences(events);
  assert.equal(sig.pattern, 'tdd_loop');
  assert.equal(sig.cycleCount, 2);
});

// ─────────────────────────────────────────────────────────────────────
// Wiring — classifyTrajectory uses the sequence signal
// ─────────────────────────────────────────────────────────────────────

test('classifyTrajectory: stuck_loop overrides done/stuck with confidence 0.85', () => {
  // Build an enriched window that, without sequence, would be 'idle' or
  // fallback — but the sequence carries the verdict.
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/auth.ts' }),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 1, resultText: 'FAIL' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/auth.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 1, resultText: 'FAIL' }),
  ];
  const enriched = makeWindow({
    events,
    actionCounts: { editing: 2, verification: 2 },
    primaryFiles: ['src/auth.ts'],
    pathClusters: { src: 4 },
  });
  const outcome = readOutcomeSignal(enriched);
  const sequence = analyzeSequences(events);
  const verdict = classifyTrajectory(enriched, outcome, { sequence });
  assert.equal(verdict.bucket, 'stuck');
  assert.equal(verdict.confidence, 0.85);
  assert.equal(verdict.sequence?.pattern, 'stuck_loop');
  assert.ok(verdict.signals.some((s) => s.includes('src/auth.ts')));
});

test('classifyTrajectory: refuse_to_verify + editing≥5 flips to stuck', () => {
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/a.ts' }),
    toolUse(FRESH + 2000, 'Edit', { file_path: 'src/b.ts' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/c.ts' }),
    toolUse(FRESH + 4000, 'Edit', { file_path: 'src/d.ts' }),
    toolUse(FRESH + 5000, 'Edit', { file_path: 'src/e.ts' }),
  ];
  const enriched = makeWindow({
    events,
    actionCounts: { editing: 5 },
    primaryFiles: ['src/a.ts'],
    pathClusters: { src: 5 },
  });
  const outcome = readOutcomeSignal(enriched);
  const sequence = analyzeSequences(events);
  const verdict = classifyTrajectory(enriched, outcome, { sequence });
  assert.equal(verdict.bucket, 'stuck');
  assert.equal(verdict.sequence?.pattern, 'refuse_to_verify');
  assert.ok(verdict.signals.some((s) => /no verification/i.test(s)));

  // v0.4.3: only ONE signal should mention "no verification". Pre-fix the
  // trajectory layer pushed its own message AND spread sequence.details,
  // producing two near-identical bullets in the TUI:
  //   "5 edits with no verification — agent isn't running anything"
  //   "5 edits with no verification events in the window"
  const noVerificationSignals = verdict.signals.filter((s) =>
    /no verification/i.test(s)
  );
  assert.equal(
    noVerificationSignals.length,
    1,
    'exactly one signal should mention "no verification" (no duplicates)'
  );
});

test('classifyTrajectory: tdd_loop (≥3 cycles) bumps converging to 0.9', () => {
  const events = [
    toolUse(FRESH + 1000, 'Edit', { file_path: 'src/auth/session.ts' }),
    bashEvent(FRESH + 2000, 'npm test', { exitCode: 1, resultText: 'FAIL' }),
    toolUse(FRESH + 3000, 'Edit', { file_path: 'src/auth/session.ts' }),
    bashEvent(FRESH + 4000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 5000, 'Edit', { file_path: 'src/auth/session.ts' }),
    bashEvent(FRESH + 6000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
    toolUse(FRESH + 7000, 'Edit', { file_path: 'src/auth/session.ts' }),
    bashEvent(FRESH + 8000, 'npm test', { exitCode: 0, resultText: 'PASS' }),
  ];
  const enriched = makeWindow({
    events,
    actionCounts: { editing: 4, verification: 4 },
    primaryFiles: ['src/auth/session.ts'],
    pathClusters: { 'src/auth': 4 },
  });
  const outcome = readOutcomeSignal(enriched);
  const sequence = analyzeSequences(events);
  const verdict = classifyTrajectory(enriched, outcome, { sequence });
  assert.equal(verdict.bucket, 'converging');
  assert.equal(verdict.confidence, 0.9);
  assert.equal(verdict.sequence?.pattern, 'tdd_loop');
});
