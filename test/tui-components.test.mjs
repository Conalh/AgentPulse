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

function fixtureState({ id, projectName, bucket, confidence = 0.8, drifts = [], lastUpdatedDeltaMs = 4000, narrative = 'Doing things.' }) {
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
