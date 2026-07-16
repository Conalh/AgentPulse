/**
 * Component-level tests for the Ink TUI.
 *
 * We render SessionList and SessionDetail with fixed fixture data through
 * ink-testing-library and assert on the rendered text. The library strips
 * ANSI by default — we only need to confirm the labels, pills, and
 * narrative show up.
 *
 * The full App component is *not* tested here — it owns selection state,
 * keyboard input, and timers, which the test renderer doesn't drive
 * cleanly. The orchestrator + watcher are exercised through the workstream
 * B/A test suites instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import { SessionList } from '../dist/tui/SessionList.js';
import { SessionDetail } from '../dist/tui/SessionDetail.js';

const NOW = 1_700_000_000_000;

function fixtureState({ id, projectName, bucket, confidence = 0.8, drifts = [], lastUpdatedDeltaMs = 4000, narrative = 'Doing things.', alias }) {
  const session = {
    id,
    runtime: 'claude-code',
    transcriptPath: `/tmp/${id}.jsonl`,
    projectName,
    lastModified: NOW - lastUpdatedDeltaMs,
  };
  const recap = bucket
    ? {
        windowStart: NOW - 60_000,
        windowEnd: NOW,
        durationHuman: '1 min',
        verdict: {
          bucket,
          confidence,
          signals: ['top cluster src/auth covers 75% of activity', 'tests went from failing to passing'],
          drifts,
        },
        narrative,
        enriched: {
          events: [],
          windowStart: NOW - 60_000,
          windowEnd: NOW,
          durationMs: 60_000,
          topics: [],
          pathClusters: {},
          actionCounts: { exploration: 0, editing: 0, verification: 0, external: 0, navigation: 0, other: 0 },
          primaryFiles: [],
          commandVerbs: [],
          uniqueTools: [],
          toolInvocationCount: 0,
          userMessageCount: 0,
          runtimeUsage: {},
        },
        outcome: {
          verificationTrend: 'no_data',
          userToneTrend: 'idle',
          completionVerbsRecent: false,
          idleGapMs: 0,
        },
      }
    : null;
  return {
    session,
    recap,
    lastUpdated: NOW - lastUpdatedDeltaMs,
    pending: false,
    ...(alias !== undefined ? { alias } : {}),
  };
}

test('SessionList renders all session names, runtimes, and bucket labels', () => {
  const states = [
    fixtureState({ id: 'a', projectName: 'MyApp', bucket: 'converging' }),
    fixtureState({ id: 'b', projectName: 'PocketCalc', bucket: 'exploring', confidence: 0.3 }),
    fixtureState({ id: 'c', projectName: 'RogueOne', bucket: 'drifting', drifts: [{ tool: 'scope_trail', kind: 'scope_trail.x', severity: 'high', message: 'x' }, { tool: 'scope_trail', kind: 'scope_trail.y', severity: 'high', message: 'y' }, { tool: 'scope_trail', kind: 'scope_trail.z', severity: 'high', message: 'z' }] }),
  ];

  const { lastFrame } = render(
    createElement(SessionList, { states, selectedId: 'a', now: NOW })
  );

  const frame = lastFrame() ?? '';
  assert.match(frame, /MyApp/);
  assert.match(frame, /PocketCalc/);
  assert.match(frame, /RogueOne/);
  assert.match(frame, /converging/);
  assert.match(frame, /exploring/);
  assert.match(frame, /drifting \(3\)/);
  // Verdict pills should be present.
  assert.match(frame, /●/); // converging
  assert.match(frame, /◐/); // exploring
  assert.match(frame, /⚠/); // drifting
});

test('SessionList disambiguates rows that share project+runtime (v0.4.4)', () => {
  // Regression: real screenshot showed three rows of `core (claude-code)`
  // because the same project had three distinct sessions. Without
  // disambiguation, all three rows render identically and look like a
  // dup-rendering bug. With v0.4.4 we append a 6-char session-id tail
  // only to the colliding rows.
  const states = [
    // Three sessions of the same project + runtime → ALL should get a tail.
    fixtureState({ id: 'aaaaaa111111', projectName: 'core', bucket: 'idle' }),
    fixtureState({ id: 'bbbbbb222222', projectName: 'core', bucket: 'idle' }),
    fixtureState({ id: 'cccccc333333', projectName: 'core', bucket: 'idle' }),
    // One unique session → must NOT get a tail.
    fixtureState({ id: 'dddddd444444', projectName: 'standalone', bucket: 'exploring' }),
  ];

  const { lastFrame } = render(
    createElement(SessionList, { states, selectedId: 'aaaaaa111111', now: NOW })
  );

  const frame = lastFrame() ?? '';
  // Each of the three colliding rows should carry its own id tail.
  assert.match(frame, /aaaaaa/, 'colliding row 1 should show its id tail');
  assert.match(frame, /bbbbbb/, 'colliding row 2 should show its id tail');
  assert.match(frame, /cccccc/, 'colliding row 3 should show its id tail');
  // The unique row's id must NOT appear.
  assert.doesNotMatch(
    frame,
    /dddddd/,
    'unique row should not show a disambiguator tail',
  );
  // The disambiguator separator " · " should appear three times (once per
  // colliding row), not on the standalone row.
  const sepMatches = frame.match(/ · /g) ?? [];
  assert.equal(sepMatches.length, 3, 'disambiguator separator appears once per colliding row');
});

test('SessionList renders alias in front of the project name (v0.4.7)', () => {
  // A single aliased session should show `CC1 · core (claude-code)` with
  // the alias prominent and the project name following.
  const states = [
    fixtureState({ id: 'a', projectName: 'core', bucket: 'idle', alias: 'CC1' }),
  ];
  const { lastFrame } = render(
    createElement(SessionList, { states, selectedId: 'a', now: NOW })
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /CC1/, 'alias renders');
  assert.match(frame, /core/, 'project name still renders alongside the alias');
  assert.match(frame, /CC1.*core/, 'alias comes BEFORE the project name');
});

test('SessionList: aliased rows suppress the hex disambiguator (v0.4.7)', () => {
  // Three sessions in the same project — two have aliases, one doesn't.
  // The aliased ones don't need a hex tail (the alias IS the disambig).
  // The unaliased one should also have no tail because, with the two
  // aliased rows excluded from the collision count, only ONE row of
  // `core (claude-code)` remains visible — no collision.
  const states = [
    fixtureState({ id: 'aaaaaa111111', projectName: 'core', bucket: 'idle', alias: 'CC1' }),
    fixtureState({ id: 'bbbbbb222222', projectName: 'core', bucket: 'idle', alias: 'CC2' }),
    fixtureState({ id: 'cccccc333333', projectName: 'core', bucket: 'idle' }),
  ];
  const { lastFrame } = render(
    createElement(SessionList, { states, selectedId: 'aaaaaa111111', now: NOW })
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /CC1/);
  assert.match(frame, /CC2/);
  // No hex tail should appear for any of the three sessions — none of the
  // ids' first 6 chars should leak into the frame.
  assert.doesNotMatch(frame, /aaaaaa/);
  assert.doesNotMatch(frame, /bbbbbb/);
  assert.doesNotMatch(frame, /cccccc/);
});

test('SessionList: aliased rows do not inflate the collision count for unaliased rows (v0.4.7)', () => {
  // Mix: two unaliased + one aliased of the same project. The aliased
  // one must NOT count toward the collision detection — so the two
  // unaliased ones (count = 2) get hex tails, and the aliased one stays
  // clean.
  const states = [
    fixtureState({ id: 'aaaaaa111111', projectName: 'core', bucket: 'idle', alias: 'CC1' }),
    fixtureState({ id: 'bbbbbb222222', projectName: 'core', bucket: 'idle' }),
    fixtureState({ id: 'cccccc333333', projectName: 'core', bucket: 'idle' }),
  ];
  const { lastFrame } = render(
    createElement(SessionList, { states, selectedId: 'aaaaaa111111', now: NOW })
  );
  const frame = lastFrame() ?? '';
  // CC1 has its alias and no hex tail.
  assert.match(frame, /CC1/);
  assert.doesNotMatch(frame, /aaaaaa/);
  // The two unaliased ones get hex tails because they collide with each other.
  assert.match(frame, /bbbbbb/);
  assert.match(frame, /cccccc/);
});

test('SessionList renders empty state when there are no sessions', () => {
  const { lastFrame } = render(
    createElement(SessionList, { states: [], selectedId: null, now: NOW })
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /No sessions detected/);
});

test('SessionDetail renders narrative, verdict pill, and signals for a session', () => {
  const state = fixtureState({
    id: 'a',
    projectName: 'MyApp',
    bucket: 'converging',
    confidence: 0.85,
    narrative: 'Your agent has been working on the login bug.',
  });
  const { lastFrame } = render(
    createElement(SessionDetail, { state, now: NOW, refreshIntervalMs: 30_000 })
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /MyApp/);
  assert.match(frame, /claude-code/);
  assert.match(frame, /Your agent has been working/);
  assert.match(frame, /converging/);
  assert.match(frame, /confidence 0\.85/);
  assert.match(frame, /Signals:/);
  assert.match(frame, /tests went from failing to passing/);
  assert.match(frame, /Last refresh:/);
});

test('SessionDetail renders a placeholder when no state is selected', () => {
  const { lastFrame } = render(
    createElement(SessionDetail, { state: null, now: NOW, refreshIntervalMs: 30_000 })
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /No session selected/);
});
