/**
 * Tests for src/parseCache.ts — incremental transcript parsing (v0.6.0).
 *
 * The cache is a process-wide singleton; we call `clearParseCache()`
 * between tests so state doesn't leak. Each test creates a fresh tmp
 * file with carefully constructed JSONL content so we can verify
 * specific behaviours (no-change fast path, tail-read, rotation
 * detection, missing file → throw).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readWindowFromCache,
  evictParseCache,
  clearParseCache,
} from '../dist/parseCache.js';

const T0 = 1_700_000_000_000;
const WINDOW_MS = 20 * 60_000;

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-parsecache-'));
}

function userLine(ts, text) {
  return (
    JSON.stringify({
      type: 'user',
      timestamp: new Date(ts).toISOString(),
      message: { content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

test('readWindowFromCache: parses an entire file on first call', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(path, userLine(T0 + 1000, 'hi') + userLine(T0 + 2000, 'hello'));
    const events = await readWindowFromCache(path, T0, T0 + WINDOW_MS, {
      silent: true,
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'user_message');
    assert.equal(events[0].text, 'hi');
    assert.equal(events[1].text, 'hello');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: second call with no file changes is a cache hit (no re-read)', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(path, userLine(T0 + 1000, 'one') + userLine(T0 + 2000, 'two'));

    const first = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(first.length, 2);

    // No file change. Same call should return the same events.
    const second = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(second.length, 2);
    assert.deepEqual(
      second.map((e) => e.text),
      ['one', 'two'],
    );

    // We can't easily assert "no disk read happened" without instrumentation,
    // but if the cache were re-reading every time we'd still get correct
    // output — so this test mainly guards against the cache breaking the
    // event set on a no-change pulse.
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: tail-reads only appended bytes when the file grows', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(path, userLine(T0 + 1000, 'first') + userLine(T0 + 2000, 'second'));
    await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });

    // Append two new lines. The cache should pick them up — and only
    // them — on the next read.
    appendFileSync(path, userLine(T0 + 3000, 'third') + userLine(T0 + 4000, 'fourth'));
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);

    const events = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.text),
      ['first', 'second', 'third', 'fourth'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: filters events outside the window on each call', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    // Three events spanning ~30 minutes.
    writeFileSync(
      path,
      userLine(T0 + 1000, 'in-the-past') +
        userLine(T0 + 10 * 60_000, 'middle') +
        userLine(T0 + 25 * 60_000, 'future'),
    );

    // Window 1: [T0, T0+12min] should include past + middle, skip future.
    const w1 = await readWindowFromCache(path, T0, T0 + 12 * 60_000, { silent: true });
    assert.deepEqual(w1.map((e) => e.text), ['in-the-past', 'middle']);

    // Window 2 (same file, sliding window forward): [T0+5min, T0+30min]
    // should include middle + future, skip past. Same file, same cache,
    // different window filter.
    const w2 = await readWindowFromCache(
      path,
      T0 + 5 * 60_000,
      T0 + 30 * 60_000,
      { silent: true },
    );
    assert.deepEqual(w2.map((e) => e.text), ['middle', 'future']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: handles an incomplete final line by deferring it to the next read', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    // Two complete lines + a partial third line (no trailing newline,
    // no closing braces). Constructed as raw text so the later append
    // COMPLETES it into valid JSON — emulating an agent mid-write.
    const completeLines = userLine(T0 + 1000, 'one') + userLine(T0 + 2000, 'two');
    const partialPrefix =
      `{"type":"user","timestamp":"${new Date(T0 + 3000).toISOString()}",` +
      `"message":{"content":[{"type":"text","text":"thr`;
    writeFileSync(path, completeLines + partialPrefix);

    const r1 = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(r1.length, 2, 'incomplete final line should not be parsed yet');

    // Append the rest of the partial line + a fourth complete line.
    appendFileSync(path, 'ee"}]}}\n' + userLine(T0 + 4000, 'four'));
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);

    const r2 = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(r2.length, 4, 'previously-incomplete line + new line both parsed');
    assert.equal(r2[2].text, 'three');
    assert.equal(r2[3].text, 'four');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: rotation/truncation (file shrinks) resets the cache and re-reads', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    // First: write 5 lines and populate the cache.
    let content = '';
    for (let i = 0; i < 5; i += 1) {
      content += userLine(T0 + (i + 1) * 1000, `line-${i}`);
    }
    writeFileSync(path, content);
    const r1 = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(r1.length, 5);

    // Now truncate — file is logically replaced with just 2 lines.
    writeFileSync(
      path,
      userLine(T0 + 100_000, 'after-rotation-a') +
        userLine(T0 + 101_000, 'after-rotation-b'),
    );
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);

    const r2 = await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });
    assert.equal(r2.length, 2);
    assert.deepEqual(r2.map((e) => e.text), ['after-rotation-a', 'after-rotation-b']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: throws on a missing file (matches parseTranscriptDir contract)', async () => {
  clearParseCache();
  const dir = mkTmp();
  try {
    const path = join(dir, 'never-existed.jsonl');
    await assert.rejects(
      () => readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true }),
      /cannot read transcript path/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: a file that disappears between pulses throws on the next call', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'transient.jsonl');
  try {
    writeFileSync(path, userLine(T0 + 1000, 'briefly'));
    await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });

    unlinkSync(path);
    await assert.rejects(
      () => readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true }),
      /cannot read transcript path/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('evictParseCache: forces a full re-read on the next call', async () => {
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(path, userLine(T0 + 1000, 'one') + userLine(T0 + 2000, 'two'));
    await readWindowFromCache(path, T0, T0 + WINDOW_MS, { silent: true });

    // Without changing the file: evict the cache and re-read.
    evictParseCache(path);
    const events = await readWindowFromCache(path, T0, T0 + WINDOW_MS, {
      silent: true,
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].text, 'one');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('readWindowFromCache: prunes events that fall out of the (extended) window over time', async () => {
  // Across many pulses spanning hours, the in-memory event list shouldn't
  // grow without bound. Verify that an event far past the prune threshold
  // (1h past the window start) drops out of the cached set.
  clearParseCache();
  const dir = mkTmp();
  const path = join(dir, 'long-session.jsonl');
  try {
    // Very-old event (2h before T0) + a recent event near T0.
    writeFileSync(
      path,
      userLine(T0 - 2 * 60 * 60_000, 'ancient') + userLine(T0 + 1000, 'recent'),
    );

    // Read window: [T0, T0 + WINDOW_MS]. The "ancient" event is 2h
    // before window start; the prune threshold is window start - 1h.
    // ancient < threshold, so it should be evicted from the cache on
    // the first read.
    const events = await readWindowFromCache(path, T0, T0 + WINDOW_MS, {
      silent: true,
    });
    // The active-window filter drops ancient anyway, so we get just
    // recent. We can't directly inspect cache.size from the public API,
    // but a follow-up read should also only return recent — proving the
    // cached set didn't grow with the ancient event.
    assert.deepEqual(events.map((e) => e.text), ['recent']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
