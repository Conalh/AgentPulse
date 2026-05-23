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
import { compareByProject, urgencyOf, URGENCY_RANK } from '../dist/tui/sort.js';

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

// ── v0.4.5 — project-grouped sort ───────────────────────────────────────

// Minimal SessionState fixture sufficient for the comparator. The
// comparator only reads `session.projectName`, `session.runtime`,
// `recap?.verdict.bucket`, and `lastUpdated`.
function sortFixture({ id, projectName, runtime = 'claude-code', bucket = null, lastUpdated = 0 }) {
  return {
    session: {
      id,
      runtime,
      transcriptPath: `/tmp/${id}.jsonl`,
      projectName,
      lastModified: lastUpdated,
    },
    recap: bucket
      ? {
          verdict: { bucket, confidence: 0.8, signals: [], drifts: [] },
          enriched: { primaryFiles: [], pathClusters: {} },
        }
      : null,
    lastUpdated,
    pending: false,
  };
}

test('sort.urgencyOf: ranks drifting < stuck < pending < converging < exploring < idle < done', () => {
  // Drifting (most urgent) → lowest number → sorts first.
  assert.ok(URGENCY_RANK.drifting < URGENCY_RANK.stuck);
  assert.ok(URGENCY_RANK.stuck < URGENCY_RANK.pending);
  assert.ok(URGENCY_RANK.pending < URGENCY_RANK.converging);
  assert.ok(URGENCY_RANK.converging < URGENCY_RANK.exploring);
  assert.ok(URGENCY_RANK.exploring < URGENCY_RANK.idle);
  assert.ok(URGENCY_RANK.idle < URGENCY_RANK.done);
  // Missing recap (state.pending → null) maps to the synthetic "pending" rank.
  const pending = sortFixture({ id: 'x', projectName: 'p', bucket: null });
  assert.equal(urgencyOf(pending), URGENCY_RANK.pending);
});

test('compareByProject: clusters same-project sessions together (v0.4.5)', () => {
  // The reason this sort exists: a user with both Cursor and Claude Code
  // running on `ontology` wants those two rows adjacent. Pre-fix
  // (urgency-first), they'd land in different buckets and sit far apart.
  // Both ontology sessions share urgency `idle` here so runtime is what
  // tie-breaks within the project group.
  const states = [
    sortFixture({ id: 'a', projectName: 'ontology', runtime: 'cursor', bucket: 'idle' }),
    sortFixture({ id: 'b', projectName: 'AgentPulse', bucket: 'stuck' }),
    sortFixture({ id: 'c', projectName: 'ontology', runtime: 'claude-code', bucket: 'idle' }),
    sortFixture({ id: 'd', projectName: 'core', bucket: 'idle' }),
  ];
  const sorted = [...states].sort(compareByProject);
  const labels = sorted.map((s) => `${s.session.projectName}/${s.session.runtime}`);

  // Alphabetical project order: AgentPulse, core, ontology.
  // Within ontology (both idle): claude-code before cursor (runtime asc).
  assert.deepEqual(labels, [
    'AgentPulse/claude-code',
    'core/claude-code',
    'ontology/claude-code',
    'ontology/cursor',
  ]);
});

test('compareByProject: within a project, urgency wins over runtime', () => {
  // Same project (`core`), same two runtimes — but one of them is
  // drifting. Drifting should rise above an idle session even in the
  // same project group.
  const states = [
    sortFixture({ id: 'a', projectName: 'core', runtime: 'cursor', bucket: 'idle' }),
    sortFixture({ id: 'b', projectName: 'core', runtime: 'claude-code', bucket: 'drifting' }),
    sortFixture({ id: 'c', projectName: 'core', runtime: 'codex', bucket: 'done' }),
  ];
  const sorted = [...states].sort(compareByProject);
  assert.deepEqual(
    sorted.map((s) => s.session.runtime),
    ['claude-code', 'cursor', 'codex'],
    'drifting (claude-code) → idle (cursor) → done (codex)',
  );
});

test('compareByProject: lastUpdated DESC breaks ties on identical project+runtime', () => {
  const states = [
    sortFixture({ id: 'a', projectName: 'core', bucket: 'idle', lastUpdated: 1000 }),
    sortFixture({ id: 'b', projectName: 'core', bucket: 'idle', lastUpdated: 3000 }),
    sortFixture({ id: 'c', projectName: 'core', bucket: 'idle', lastUpdated: 2000 }),
  ];
  const sorted = [...states].sort(compareByProject);
  assert.deepEqual(sorted.map((s) => s.session.id), ['b', 'c', 'a']);
});

test('compareByProject: project sort is case-insensitive', () => {
  // Real labels come from path-derived slugs — case can be inconsistent.
  // `AgentPulse` and `agentpulse` should cluster, not split.
  const states = [
    sortFixture({ id: 'a', projectName: 'agentpulse', bucket: 'idle', lastUpdated: 1000 }),
    sortFixture({ id: 'b', projectName: 'AgentPulse', bucket: 'idle', lastUpdated: 2000 }),
    sortFixture({ id: 'c', projectName: 'core', bucket: 'idle', lastUpdated: 3000 }),
  ];
  const sorted = [...states].sort(compareByProject);
  // The two agentpulse variants sit adjacent; lastUpdated tiebreaks them.
  assert.equal(sorted[0].session.id, 'b'); // AgentPulse, 2000
  assert.equal(sorted[1].session.id, 'a'); // agentpulse, 1000
  assert.equal(sorted[2].session.id, 'c'); // core, 3000
});
