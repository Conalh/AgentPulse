import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runConcurrent, gateExitCode } from '../dist/once.js';

const CLI = resolve('dist/cli.js');
const FIXTURES = resolve('test/fixtures');

// ── v0.5.5 — runConcurrent helper ────────────────────────────────────

test('runConcurrent: preserves task order in results array', async () => {
  // Tasks resolve in REVERSE order (longest delay first), but the
  // returned array must still be indexed by input order — the once-
  // mode text report depends on this for stable session ordering.
  const tasks = [0, 1, 2, 3, 4].map((i) => async () => {
    await delay((5 - i) * 5); // task 0 sleeps 25ms, task 4 sleeps 5ms
    return i;
  });
  const results = await runConcurrent(tasks, 3);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

test('runConcurrent: caps in-flight tasks at the concurrency value', async () => {
  // Track concurrent in-flight count via an external counter. If the
  // cap is honoured, peak in-flight never exceeds `concurrency`.
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, i) => async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(10);
    inFlight -= 1;
    return i;
  });
  await runConcurrent(tasks, 4);
  assert.ok(peak <= 4, `expected peak ≤ 4, got ${peak}`);
  assert.ok(peak >= 2, `expected some parallelism, peak was ${peak}`);
});

test('runConcurrent: empty task list returns empty results array', async () => {
  const results = await runConcurrent([], 6);
  assert.deepEqual(results, []);
});

test('runConcurrent: concurrency 1 is sequential (degenerate but legal)', async () => {
  const order = [];
  const tasks = [10, 5, 1].map((ms, i) => async () => {
    await delay(ms);
    order.push(i);
    return i;
  });
  await runConcurrent(tasks, 1);
  // With concurrency=1, tasks run strictly in input order despite
  // varying delays.
  assert.deepEqual(order, [0, 1, 2]);
});

function runCli(args) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

test('live --once: text format prints a per-session summary and exits 0', () => {
  const r = runCli(['live', '--once', '--roots', FIXTURES, '--stale', '999d']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /AgentPulse — \d+ session/);
  // The fixtures all classify as idle (no recent events). At least one row
  // should appear with the bucket name.
  assert.match(r.stdout, /idle/);
});

test('live --once --format json: emits a parseable JSON document', () => {
  const r = runCli([
    'live',
    '--once',
    '--format',
    'json',
    '--roots',
    FIXTURES,
    '--stale',
    '999d',
  ]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.equal(typeof doc.generatedAt, 'number');
  assert.equal(typeof doc.sessionCount, 'number');
  assert.equal(typeof doc.bucketCounts, 'object');
  assert.equal(typeof doc.hasGatingFinding, 'boolean');
  assert.ok(Array.isArray(doc.sessions));
  assert.equal(doc.sessions.length, doc.sessionCount);
});

test('live --once --strict: exits 0 when no session is drifting or stuck', () => {
  const r = runCli([
    'live',
    '--once',
    '--strict',
    '--roots',
    FIXTURES,
    '--stale',
    '999d',
  ]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
});

test('live --once --strict --no-detectors: exits 0 even if detectors would flag', () => {
  // --no-detectors short-circuits the drifting bucket. Combined with --strict,
  // this is the path users take when they want CI gating on stuck sessions
  // only (not drifts).
  const r = runCli([
    'live',
    '--once',
    '--strict',
    '--no-detectors',
    '--roots',
    FIXTURES,
    '--stale',
    '999d',
  ]);
  assert.equal(r.status, 0);
});

test('live --once: missing transcript dirs do not crash, exit 0', () => {
  const r = runCli([
    'live',
    '--once',
    '--roots',
    resolve('definitely-not-a-real-dir'),
  ]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /0 sessions/);
});

test('live --format=invalid: usage error, exit 2', () => {
  const r = runCli(['live', '--once', '--format', 'yaml', '--roots', FIXTURES]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --format/);
});

// v0.7.1: subagent transcripts must be excluded from `--once` output
// unless --show-subagents is passed. Pre-fix the headless path emitted
// every SDK-spawned subagent as its own row, so a parent session with
// N subagents reported `1 + N` rows for the same conceptual session.
test('live --once: subagent transcripts are filtered by default (v0.7.1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentpulse-once-subagents-'));
  try {
    // Mimic the Claude Code on-disk layout:
    //   <root>/C--Dev-MyApp/<uuid>.jsonl                              ← parent
    //   <root>/C--Dev-MyApp/<uuid>/subagents/agent-<hex>.jsonl        ← subagent (filtered)
    const projDir = join(root, 'C--Dev-MyApp');
    const parentUuid = '35c8a5a9-914c-4e72-8ee9-722cf0acb244';
    const subagentsDir = join(projDir, parentUuid, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const session = JSON.stringify({
      type: 'session_start',
      cwd: 'C:\\Dev\\MyApp',
      timestamp: new Date().toISOString(),
    }) + '\n';
    writeFileSync(join(projDir, parentUuid + '.jsonl'), session);
    writeFileSync(join(subagentsDir, 'agent-ae7833d215098313c.jsonl'), session);
    writeFileSync(join(subagentsDir, 'agent-abd82563f78ab0fe6.jsonl'), session);

    // Default: subagents filtered → exactly 1 session (the parent).
    const r = runCli([
      'live', '--once', '--format', 'json',
      '--roots', root, '--stale', '999d',
    ]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.sessionCount, 1, 'subagents must not appear in default --once output');
    assert.doesNotMatch(
      JSON.stringify(doc.sessions),
      /agent-[0-9a-f]{8,}/i,
      'no agent-<hex> transcripts in the snapshot',
    );

    // With --show-subagents: all 3 appear.
    const rShow = runCli([
      'live', '--once', '--format', 'json', '--show-subagents',
      '--roots', root, '--stale', '999d',
    ]);
    assert.equal(rShow.status, 0);
    const docShow = JSON.parse(rShow.stdout);
    assert.equal(docShow.sessionCount, 3, '--show-subagents must include them');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// v0.7.1: the snapshot's `label` field disambiguates co-named sessions.
// Two parent sessions sharing the same projectName + runtime now get a
// ` · <hex>` suffix in `label`, mirroring the TUI's v0.4.4 behaviour.
// `projectName` itself is preserved for programmatic consumers.
test('live --once --format json: label disambiguates co-named sessions (v0.7.1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentpulse-once-disambig-'));
  try {
    // Two Claude Code projects whose cwd basenames collide. Without
    // disambiguation the JSON would show two rows labelled identically.
    const projA = join(root, 'C--Dev-twin-a-MyApp');
    const projB = join(root, 'C--Dev-twin-b-MyApp');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    // Note: cwd basenames are identical → both projectNames resolve to
    // "MyApp". Forward-slash cwds so node:path.basename works on both
    // POSIX runners (Ubuntu CI) and Windows — production code uses the
    // platform's basename, so the fixture must use a separator the
    // current platform recognises.
    writeFileSync(
      join(projA, 'aaa.jsonl'),
      JSON.stringify({ type: 'session_start', cwd: '/Dev/twin-a/MyApp', timestamp: new Date().toISOString() }) + '\n'
    );
    writeFileSync(
      join(projB, 'bbb.jsonl'),
      JSON.stringify({ type: 'session_start', cwd: '/Dev/twin-b/MyApp', timestamp: new Date().toISOString() }) + '\n'
    );

    const r = runCli([
      'live', '--once', '--format', 'json',
      '--roots', root, '--stale', '999d',
    ]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.sessionCount, 2);
    // Both have projectName "MyApp" — the raw field is preserved.
    assert.ok(doc.sessions.every((s) => s.projectName === 'MyApp'),
      'projectName is preserved; disambiguation lives in `label`');
    // Labels must differ — at least one (in practice both) has a ` · <hex>` suffix.
    const labels = doc.sessions.map((s) => s.label);
    assert.notEqual(labels[0], labels[1], 'labels must differ when projectName collides');
    assert.ok(labels.every((l) => /^MyApp( · [0-9a-f]{6})?$/i.test(l)),
      `labels match the MyApp[ · hex] shape, got: ${JSON.stringify(labels)}`);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ── #F1 / #F8 — once-mode now honours --hide-idle / --max-sessions and
//    supports --redact. Build a temp root of idle sessions (a lone
//    session_start → empty window → idle, toolInvocationCount 0). ──────

function writeIdleRoot(n) {
  const root = mkdtempSync(join(tmpdir(), 'agentpulse-once-filters-'));
  for (let i = 0; i < n; i++) {
    const projDir = join(root, `C--Dev-Proj${i}`);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, `s${i}.jsonl`),
      JSON.stringify({
        type: 'session_start',
        cwd: `/Dev/Proj${i}`,
        timestamp: new Date().toISOString(),
      }) + '\n'
    );
  }
  return root;
}

test('live --once --hide-idle: idle sessions are filtered (#F1)', () => {
  const root = writeIdleRoot(3);
  try {
    const base = runCli(['live', '--once', '--format', 'json', '--roots', root, '--stale', '999d']);
    assert.equal(base.status, 0, base.stderr);
    assert.equal(JSON.parse(base.stdout).sessionCount, 3, 'all three shown without --hide-idle');

    const hidden = runCli(['live', '--once', '--format', 'json', '--hide-idle', '--roots', root, '--stale', '999d']);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.equal(JSON.parse(hidden.stdout).sessionCount, 0, 'all idle sessions filtered with --hide-idle');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('live --once --max-sessions caps the text listing but not JSON / gating (#F1)', () => {
  const root = writeIdleRoot(3);
  try {
    const j = runCli(['live', '--once', '--format', 'json', '--max-sessions', '1', '--roots', root, '--stale', '999d']);
    assert.equal(j.status, 0, j.stderr);
    const doc = JSON.parse(j.stdout);
    assert.equal(doc.sessionCount, 3, 'JSON keeps every analyzed session (display cap is text-only)');
    assert.equal(doc.sessions.length, 3);

    const t = runCli(['live', '--once', '--format', 'text', '--max-sessions', '1', '--roots', root, '--stale', '999d']);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /showing freshest 1 of 3 sessions/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('live --once --redact paths reduces the transcript path to a basename (#F8)', () => {
  const root = writeIdleRoot(1);
  try {
    const plain = JSON.parse(
      runCli(['live', '--once', '--format', 'json', '--roots', root, '--stale', '999d']).stdout
    );
    assert.match(plain.sessions[0].transcriptPath, /[\\/]/, 'unredacted path is absolute');

    const red = JSON.parse(
      runCli(['live', '--once', '--format', 'json', '--redact', 'paths', '--roots', root, '--stale', '999d']).stdout
    );
    const tp = red.sessions[0].transcriptPath;
    assert.equal(/[\\/]/.test(tp), false, `redacted path should be a basename, got ${tp}`);
    assert.match(tp, /\.jsonl$/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('live --once --redact all drops narratives and signals (#F8)', () => {
  const root = writeIdleRoot(1);
  try {
    const red = JSON.parse(
      runCli(['live', '--once', '--format', 'json', '--redact', 'all', '--roots', root, '--stale', '999d']).stdout
    );
    assert.equal(red.sessions[0].narrative, '', 'narrative dropped under --redact all');
    assert.deepEqual(red.sessions[0].signals, [], 'signals dropped under --redact all');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('live --redact=invalid: usage error, exit 2 (#F8)', () => {
  const r = runCli(['live', '--once', '--redact', 'sometimes', '--roots', FIXTURES]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --redact/);
});

// ── #F2 — strict CI gate is fail-open on infrastructure errors unless
//    --fail-on-error. gateExitCode is the pure governance-gate contract. ─

test('gateExitCode: strict + a gating bucket → 1 (#F2)', () => {
  assert.equal(
    gateExitCode({ hasGatingFinding: true, bucketCounts: { drifting: 1 } }, { strict: true, failOnError: false }),
    1
  );
});

test('gateExitCode: strict + only errors, no --fail-on-error → 0 (fail-open default) (#F2)', () => {
  assert.equal(
    gateExitCode({ hasGatingFinding: false, bucketCounts: { error: 2 } }, { strict: true, failOnError: false }),
    0
  );
});

test('gateExitCode: strict + --fail-on-error + errors → 1 (fail-closed) (#F2)', () => {
  assert.equal(
    gateExitCode({ hasGatingFinding: false, bucketCounts: { error: 2 } }, { strict: true, failOnError: true }),
    1
  );
});

test('gateExitCode: --fail-on-error without --strict stays advisory → 0 (#F2)', () => {
  assert.equal(
    gateExitCode({ hasGatingFinding: false, bucketCounts: { error: 2 } }, { strict: false, failOnError: true }),
    0
  );
});

test('gateExitCode: a clean run → 0 (#F2)', () => {
  assert.equal(
    gateExitCode({ hasGatingFinding: false, bucketCounts: { idle: 3 } }, { strict: true, failOnError: true }),
    0
  );
});
