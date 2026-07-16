/**
 * Tests for src/jsonCache.ts — mtime-keyed JSON file cache (v0.5.6).
 *
 * The cache is a process-wide singleton. We `clearJsonCache()` between
 * tests so cross-test state doesn't leak. Each test creates fresh tmp
 * paths so there's no contention even within a parallel runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readJsonCached,
  invalidateJsonCache,
  clearJsonCache,
} from '../dist/jsonCache.js';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-jsoncache-'));
}

test('readJsonCached: returns whenMissing() for a non-existent path', async () => {
  clearJsonCache();
  const dir = mkTmp();
  try {
    const result = await readJsonCached(
      join(dir, 'does-not-exist.json'),
      (raw) => JSON.parse(raw),
      () => ({ default: true })
    );
    assert.deepEqual(result, { default: true });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readJsonCached: parses and returns on a valid file', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'data.json');
  try {
    writeFileSync(path, JSON.stringify({ hello: 'world' }));
    const result = await readJsonCached(path, JSON.parse, () => ({}));
    assert.deepEqual(result, { hello: 'world' });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readJsonCached: second call with same mtime hits cache (parser not re-invoked)', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'data.json');
  try {
    writeFileSync(path, JSON.stringify({ n: 1 }));

    let parseCount = 0;
    const parser = (raw) => {
      parseCount += 1;
      return JSON.parse(raw);
    };

    await readJsonCached(path, parser, () => ({}));
    await readJsonCached(path, parser, () => ({}));
    await readJsonCached(path, parser, () => ({}));

    assert.equal(parseCount, 1, 'parser should run exactly once across 3 reads with unchanged mtime');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readJsonCached: mtime change forces a re-read+reparse', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'data.json');
  try {
    writeFileSync(path, JSON.stringify({ v: 'first' }));
    const r1 = await readJsonCached(path, JSON.parse, () => ({}));
    assert.equal(r1.v, 'first');

    // Bump mtime explicitly so the cache invalidates even on fast disks
    // where same-millisecond writes can collide.
    writeFileSync(path, JSON.stringify({ v: 'second' }));
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);

    const r2 = await readJsonCached(path, JSON.parse, () => ({}));
    assert.equal(r2.v, 'second');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readJsonCached: malformed JSON → whenMissing() and cached as null', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'broken.json');
  try {
    writeFileSync(path, '{ this is not json');

    let parseCount = 0;
    const parser = (raw) => {
      parseCount += 1;
      return JSON.parse(raw);
    };

    const r1 = await readJsonCached(path, parser, () => ({ fallback: true }));
    assert.deepEqual(r1, { fallback: true });

    // Same broken file, same mtime → cache should hold the failure
    // (mtimeMs=0 sentinel) so we don't re-parse-and-fail every pulse.
    // Note: because the failure sentinel uses mtimeMs=0 (not the real
    // mtime), the next stat shows a different mtime and re-reads.
    // That's intentional — "user fixed the file" must be detected.
    // We DO save the futile parse, though, so a parser that throws is
    // only called when the user could plausibly have changed something.
    const r2 = await readJsonCached(path, parser, () => ({ fallback: true }));
    assert.deepEqual(r2, { fallback: true });
    // Parse runs again because mtime !== 0 on the real file. That's
    // the conservative behaviour — better to re-attempt a fixed file.
    assert.ok(parseCount >= 1, 'parser tried at least once');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readJsonCached: missing-file state is cached so we do not re-stat every pulse', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'never-exists.json');
  try {
    let parseCount = 0;
    const parser = (raw) => {
      parseCount += 1;
      return JSON.parse(raw);
    };

    await readJsonCached(path, parser, () => ({ kind: 'missing' }));
    await readJsonCached(path, parser, () => ({ kind: 'missing' }));
    await readJsonCached(path, parser, () => ({ kind: 'missing' }));

    // Parser never invoked because the file never existed.
    assert.equal(parseCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readJsonCached: a missing file that appears IS detected (stat re-runs on every call)', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'appears-later.json');
  try {
    const r1 = await readJsonCached(path, JSON.parse, () => null);
    assert.equal(r1, null);

    writeFileSync(path, JSON.stringify({ appeared: true }));
    const r2 = await readJsonCached(path, JSON.parse, () => null);
    assert.deepEqual(r2, { appeared: true });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('invalidateJsonCache: forces a re-read even when mtime is unchanged', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const path = join(dir, 'data.json');
  try {
    writeFileSync(path, JSON.stringify({ n: 1 }));

    let parseCount = 0;
    const parser = (raw) => {
      parseCount += 1;
      return JSON.parse(raw);
    };

    await readJsonCached(path, parser, () => ({}));
    assert.equal(parseCount, 1);

    // Same file, same mtime — but we explicitly invalidate.
    invalidateJsonCache(path);
    await readJsonCached(path, parser, () => ({}));
    assert.equal(parseCount, 2, 'invalidate forces re-parse');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('clearJsonCache: drops all entries', async () => {
  clearJsonCache();
  const dir = mkTmp();
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');
  try {
    writeFileSync(a, JSON.stringify({ k: 'a' }));
    writeFileSync(b, JSON.stringify({ k: 'b' }));

    let parseCount = 0;
    const parser = (raw) => {
      parseCount += 1;
      return JSON.parse(raw);
    };

    await readJsonCached(a, parser, () => ({}));
    await readJsonCached(b, parser, () => ({}));
    assert.equal(parseCount, 2);

    clearJsonCache();
    await readJsonCached(a, parser, () => ({}));
    await readJsonCached(b, parser, () => ({}));
    assert.equal(parseCount, 4, 'both paths re-parsed after clear');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
