// Tests for Workstream B — multi-session pulse orchestrator.
// Run via `npm test` (which first compiles TS → dist/).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createOrchestrator } from '../dist/orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-orch-'));
}

function makeFixtureSession(id, label = 'project') {
  const dir = tmpDir();
  const transcriptPath = join(dir, 'session.jsonl');
  cpSync(join(FIXTURES, 'claude-code.jsonl'), transcriptPath);
  return {
    session: {
      id,
      runtime: 'claude-code',
      transcriptPath,
      projectName: label,
      lastModified: Date.now(),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/** Wait until `predicate()` returns truthy, up to `timeoutMs`. */
async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(15);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

test('add() triggers initial refresh and emits added then updated', async () => {
  const { session, cleanup } = makeFixtureSession('s1');
  // Long refresh interval so the background timer cannot fire during the test.
  const orch = createOrchestrator({
    refreshIntervalMs: 60_000,
    detectorsEnabled: false,
  });
  const events = [];
  orch.on((e) => events.push(e));

  try {
    orch.add(session);

    // 'session-added' must fire synchronously with pending: true and recap: null.
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'session-added');
    assert.equal(events[0].state.session.id, 's1');
    assert.equal(events[0].state.recap, null);
    assert.equal(events[0].state.pending, true);

    // The initial refresh is in-flight — wait for the 'session-updated' event.
    await waitFor(
      () => events.some((e) => e.type === 'session-updated'),
      2000,
      'session-updated for s1'
    );

    const updated = events.find((e) => e.type === 'session-updated');
    assert.equal(updated.state.session.id, 's1');
    assert.equal(updated.state.pending, false);
    // Recap should be present and well-formed (no parse error path).
    assert.ok(updated.state.recap, 'recap should be set after refresh');
    assert.ok(updated.state.recap.verdict, 'recap.verdict should exist');
    assert.equal(updated.state.error, undefined);
    assert.ok(updated.state.lastUpdated > 0);
  } finally {
    orch.stop();
    cleanup();
  }
});

test('remove() clears the timer, emits session-removed, and no further updates fire', async () => {
  const { session, cleanup } = makeFixtureSession('s2');
  // Tight refresh interval so we'd notice a leaked timer.
  const orch = createOrchestrator({
    refreshIntervalMs: 50,
    detectorsEnabled: false,
  });
  const events = [];
  orch.on((e) => events.push(e));

  try {
    orch.add(session);
    await waitFor(
      () => events.some((e) => e.type === 'session-updated'),
      2000,
      'initial session-updated'
    );

    orch.remove('s2');
    const removed = events.find((e) => e.type === 'session-removed');
    assert.ok(removed, 'session-removed should fire');
    assert.equal(removed.sessionId, 's2');

    // states() should no longer carry s2.
    assert.equal(orch.states().length, 0);

    // Snapshot count, then wait longer than several timer intervals — no
    // further 'session-updated' for s2 should arrive.
    const countAfterRemove = events.length;
    await delay(250);
    const sUpdates = events
      .slice(countAfterRemove)
      .filter((e) => e.type === 'session-updated' && e.state.session.id === 's2');
    assert.equal(sUpdates.length, 0, 'no updates after remove');
  } finally {
    orch.stop();
    cleanup();
  }
});

test('states() returns a snapshot of currently-tracked sessions', async () => {
  const a = makeFixtureSession('a');
  const b = makeFixtureSession('b');
  const orch = createOrchestrator({
    refreshIntervalMs: 60_000,
    detectorsEnabled: false,
  });

  try {
    assert.deepEqual(orch.states(), []);
    orch.add(a.session);
    orch.add(b.session);

    const snap = orch.states();
    assert.equal(snap.length, 2);
    const ids = snap.map((s) => s.session.id).sort();
    assert.deepEqual(ids, ['a', 'b']);

    // Snapshot is detached: mutating it should not affect the orchestrator.
    snap.pop();
    assert.equal(orch.states().length, 2);
  } finally {
    orch.stop();
    a.cleanup();
    b.cleanup();
  }
});

test('multiple sessions are pulsed independently', async () => {
  const a = makeFixtureSession('multi-a');
  const b = makeFixtureSession('multi-b');
  const orch = createOrchestrator({
    refreshIntervalMs: 60_000,
    detectorsEnabled: false,
  });
  const updates = new Map();
  orch.on((e) => {
    if (e.type === 'session-updated') {
      updates.set(e.state.session.id, (updates.get(e.state.session.id) ?? 0) + 1);
    }
  });

  try {
    orch.add(a.session);
    orch.add(b.session);

    await waitFor(
      () => updates.get('multi-a') >= 1 && updates.get('multi-b') >= 1,
      2000,
      'both sessions update'
    );

    const snap = orch.states();
    const stateA = snap.find((s) => s.session.id === 'multi-a');
    const stateB = snap.find((s) => s.session.id === 'multi-b');
    assert.ok(stateA?.recap, 'A has recap');
    assert.ok(stateB?.recap, 'B has recap');
    assert.equal(stateA.error, undefined);
    assert.equal(stateB.error, undefined);
  } finally {
    orch.stop();
    a.cleanup();
    b.cleanup();
  }
});

test('concurrent refresh() calls coalesce into a single pulse run', async () => {
  // Use a transcript path whose parse latency we can observe — the fixture
  // is small but pulse() still does parse + enrich + classify + render
  // asynchronously, which is enough to interleave several refresh() calls
  // before the first one settles. We assert that across many concurrent
  // refresh() calls, the number of 'session-updated' emissions is far
  // smaller than the call count.
  const { session, cleanup } = makeFixtureSession('coalesce');
  const orch = createOrchestrator({
    refreshIntervalMs: 60_000,
    detectorsEnabled: false,
  });
  const updates = [];
  orch.on((e) => {
    if (e.type === 'session-updated') updates.push(e);
  });

  try {
    orch.add(session);
    // The add() above scheduled one refresh. While it's in flight, fire
    // 10 more refresh() calls. They should all piggyback on the in-flight
    // promise — total updates after settling should be 1, not 11.
    const calls = [];
    for (let i = 0; i < 10; i++) calls.push(orch.refresh('coalesce'));
    await Promise.all(calls);

    // Now no refresh is in flight. A fresh refresh() afterward kicks a new
    // pulse and brings the update count to 2.
    await orch.refresh('coalesce');

    assert.equal(
      updates.length,
      2,
      `expected exactly 2 updates (1 batch + 1 follow-up), got ${updates.length}`
    );
  } finally {
    orch.stop();
    cleanup();
  }
});

test('errors are captured in state.error without crashing or affecting siblings', async () => {
  const orch = createOrchestrator({
    refreshIntervalMs: 60_000,
    detectorsEnabled: false,
  });
  const events = [];
  orch.on((e) => events.push(e));

  const bad = {
    id: 'bad',
    runtime: 'claude-code',
    // Path that does not exist — parser will throw, orchestrator should catch.
    transcriptPath: join(tmpdir(), 'agentpulse-orch-nope', 'does-not-exist.jsonl'),
    projectName: 'nope',
    lastModified: Date.now(),
  };
  const good = makeFixtureSession('good');

  try {
    orch.add(bad);
    orch.add(good.session);

    await waitFor(
      () =>
        events.some(
          (e) => e.type === 'session-updated' && e.state.session.id === 'bad'
        ) &&
        events.some(
          (e) => e.type === 'session-updated' && e.state.session.id === 'good'
        ),
      2000,
      'both sessions report updates'
    );

    const snap = orch.states();
    const badState = snap.find((s) => s.session.id === 'bad');
    const goodState = snap.find((s) => s.session.id === 'good');

    assert.ok(badState, 'bad session still tracked');
    assert.ok(
      typeof badState.error === 'string' && badState.error.length > 0,
      'bad state.error is set'
    );
    assert.equal(badState.recap, null, 'bad state has no recap (never succeeded)');
    assert.equal(badState.pending, false);

    assert.ok(goodState, 'good session unaffected');
    assert.equal(goodState.error, undefined);
    assert.ok(goodState.recap, 'good session has recap');
  } finally {
    orch.stop();
    good.cleanup();
  }
});

test('stop() is idempotent and clears all timers and listeners', async () => {
  const { session, cleanup } = makeFixtureSession('idem');
  const orch = createOrchestrator({
    refreshIntervalMs: 30,
    detectorsEnabled: false,
  });
  const events = [];
  orch.on((e) => events.push(e));

  try {
    orch.add(session);
    await waitFor(
      () => events.some((e) => e.type === 'session-updated'),
      2000,
      'initial update'
    );

    orch.stop();
    const before = events.length;
    // Second stop() must not throw.
    orch.stop();

    // After stop, states() is empty and no further events arrive.
    assert.deepEqual(orch.states(), []);
    await delay(150);
    assert.equal(events.length, before, 'no further events after stop');
  } finally {
    cleanup();
  }
});
