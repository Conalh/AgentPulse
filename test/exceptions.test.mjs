// @ts-check
/**
 * Tests for v0.4.1 exception baseline — `loadExceptions` + `appendExceptions`.
 *
 * Uses real tmpdirs (no mocking) since the whole point of the module is the
 * file-system contract. Each test pins down one behaviour from the spec:
 *
 *  1. Missing file → empty Set (silent fallback).
 *  2. Valid file → fingerprints in the Set.
 *  3. Unparseable file → empty Set (silent fallback).
 *  4. Append into a missing file → file is created with the entries.
 *  5. Append duplicates → deduped by fingerprint.
 *
 * Plus two extra: roundtrip after append, and "append with no drifts is a
 * no-op". They're cheap and tighten the contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadExceptions, appendExceptions } from '../dist/exceptions.js';

const EXCEPTIONS_FILE = '.agentpulse-exceptions.json';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-exceptions-'));
}

/** Build a Finding-like literal with the fields the appender + classifier
 *  care about. Fingerprint is supplied explicitly so the test doesn't depend
 *  on the upstream hashing algorithm staying byte-for-byte stable. */
function makeFinding(fingerprint, kind = 'agent_pulse.live_drift_shell_exfil') {
  return {
    tool: 'session_trail',
    kind,
    severity: 'high',
    message: `synthetic finding ${fingerprint}`,
    fingerprint,
  };
}

test('loadExceptions returns empty Set when file is missing', async () => {
  const dir = mkTmp();
  try {
    const result = await loadExceptions(dir);
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('loadExceptions returns fingerprints from a valid file', async () => {
  const dir = mkTmp();
  try {
    const payload = {
      version: 1,
      exceptions: [
        {
          kind: 'agent_pulse.live_drift_shell_exfil',
          fingerprint: 'abc123',
          approvedAt: '2026-05-23T18:00:00.000Z',
          note: 'approved by user via TUI',
        },
        {
          kind: 'agent_pulse.live_drift_outside_repo_write',
          fingerprint: 'def456',
          approvedAt: '2026-05-23T18:00:00.000Z',
        },
      ],
    };
    writeFileSync(join(dir, EXCEPTIONS_FILE), JSON.stringify(payload, null, 2));
    const result = await loadExceptions(dir);
    assert.equal(result.size, 2);
    assert.ok(result.has('abc123'));
    assert.ok(result.has('def456'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('loadExceptions returns empty Set when file is unparseable (silent failure)', async () => {
  const dir = mkTmp();
  try {
    // Garbage that isn't valid JSON. The loader should swallow the parse
    // error rather than blow up the whole pulse() call — exceptions are
    // optional baseline, not required config.
    writeFileSync(join(dir, EXCEPTIONS_FILE), '{ this is not valid json :::');
    const result = await loadExceptions(dir);
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('appendExceptions creates the file if missing', async () => {
  const dir = mkTmp();
  try {
    const file = join(dir, EXCEPTIONS_FILE);
    assert.equal(existsSync(file), false);
    await appendExceptions(dir, [
      makeFinding('fp-one'),
      makeFinding('fp-two', 'agent_pulse.live_drift_outside_repo_write'),
    ]);
    assert.equal(existsSync(file), true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.exceptions.length, 2);
    const fps = parsed.exceptions.map((e) => e.fingerprint).sort();
    assert.deepEqual(fps, ['fp-one', 'fp-two']);
    // Spot-check the metadata so future schema changes are caught.
    for (const entry of parsed.exceptions) {
      assert.ok(typeof entry.kind === 'string' && entry.kind.length > 0);
      assert.ok(typeof entry.approvedAt === 'string' && entry.approvedAt.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('appendExceptions dedupes by fingerprint across two writes', async () => {
  const dir = mkTmp();
  try {
    // First write — two distinct entries.
    await appendExceptions(dir, [makeFinding('shared-fp'), makeFinding('first-only')]);
    // Second write — `shared-fp` should not duplicate.
    await appendExceptions(dir, [makeFinding('shared-fp'), makeFinding('second-only')]);
    const parsed = JSON.parse(
      readFileSync(join(dir, EXCEPTIONS_FILE), 'utf8')
    );
    const fps = parsed.exceptions.map((e) => e.fingerprint).sort();
    assert.deepEqual(fps, ['first-only', 'second-only', 'shared-fp']);
    // Reality-check via loadExceptions — the public API the orchestrator
    // uses had better see the same three fingerprints.
    const loaded = await loadExceptions(dir);
    assert.equal(loaded.size, 3);
    assert.ok(loaded.has('shared-fp'));
    assert.ok(loaded.has('first-only'));
    assert.ok(loaded.has('second-only'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('appendExceptions is a no-op when drifts is empty', async () => {
  const dir = mkTmp();
  try {
    // No drifts to write → the file should NOT be created (avoids leaving
    // empty baselines littered around when the user presses `a` on a
    // session that already has zero drifts).
    await appendExceptions(dir, []);
    assert.equal(existsSync(join(dir, EXCEPTIONS_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('loadExceptions accepts a direct file path as well as a directory', async () => {
  // Belt-and-braces: power users may want to point at a non-default file
  // (shared baselines across a team, for instance). The resolver collapses
  // both forms to the same target.
  const dir = mkTmp();
  try {
    const file = join(dir, EXCEPTIONS_FILE);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        exceptions: [
          { kind: 'k', fingerprint: 'direct-path-fp', approvedAt: 'now' },
        ],
      })
    );
    const viaDir = await loadExceptions(dir);
    const viaFile = await loadExceptions(file);
    assert.equal(viaDir.size, 1);
    assert.equal(viaFile.size, 1);
    assert.ok(viaDir.has('direct-path-fp'));
    assert.ok(viaFile.has('direct-path-fp'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('appendExceptions: concurrent appends do not lose each other (v0.5.2)', async () => {
  // Pre-v0.5.2, two near-concurrent appendExceptions calls each read the
  // pre-existing file before the other's writeFile resolved — both saw
  // the same starting state, both wrote their own append, and the second
  // silently wiped the first's new entry. With the per-path write queue
  // both entries survive.
  const dir = mkTmp();
  try {
    const drifts = Array.from({ length: 5 }, (_, i) => ({
      tool: 'session_trail',
      kind: 'session_trail.test_kind',
      severity: 'high',
      message: `drift ${i}`,
      fingerprint: `fp-concurrent-${i}`,
    }));

    // Fire 5 concurrent single-drift appends — exactly the failure mode
    // the pre-fix code couldn't handle.
    await Promise.all(drifts.map((d) => appendExceptions(dir, [d])));

    const set = await loadExceptions(dir);
    for (let i = 0; i < 5; i += 1) {
      assert.ok(set.has(`fp-concurrent-${i}`), `fp-concurrent-${i} should have survived`);
    }
    assert.equal(set.size, 5, 'all 5 fingerprints present');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
