import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  utimesSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, sep } from 'node:path';

import { discoverSessions, createSessionWatcher } from '../dist/sessions/index.js';
import { decodeSlug, deriveProjectName } from '../dist/sessions/discovery.js';

function mkTmp(prefix = 'agentpulse-sessions-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Wait until `predicate()` returns true or `timeoutMs` elapses.
 * Polls every 10 ms. Returns true on success, false on timeout.
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

test('discoverSessions returns empty when default roots are missing', async () => {
  // We can't actually delete the user's ~/.claude, but we can verify that
  // when we point at a definitely-nonexistent root we get [] without
  // throwing. The defaults-empty case is implicit in the same code path:
  // each root is stat()'d and skipped on ENOENT.
  const nonexistent = join(tmpdir(), `definitely-not-a-real-dir-${process.pid}-${Date.now()}`);
  const result = await discoverSessions({ roots: [nonexistent] });
  assert.deepEqual(result, []);
});

test('discoverSessions with explicit roots finds a JSONL and infers runtime/projectName', async () => {
  const root = mkTmp();
  try {
    // Build a Claude-Code-like layout: <root>/c-Dev-MyApp/<uuid>.jsonl
    // We name the *outer* root with `.claude/projects` so inferRuntimeFromPath
    // picks up `claude-code`.
    const claudeRoot = join(root, '.claude', 'projects');
    const projDir = join(claudeRoot, 'c-Dev-MyApp');
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, 'abc123.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        cwd: '/repo/MyApp',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      }) + '\n'
    );

    const result = await discoverSessions({ roots: [claudeRoot] });
    assert.equal(result.length, 1);
    const session = result[0];
    assert.equal(session.runtime, 'claude-code');
    assert.equal(session.transcriptPath, transcript);
    // c-Dev-MyApp → MyApp (last slug segment)
    assert.equal(session.projectName, 'MyApp');
    // id is a 12-char hex slice of sha1
    assert.match(session.id, /^[0-9a-f]{12}$/);
    // cwd extracted from first JSONL line
    assert.equal(session.cwd, '/repo/MyApp');
    assert.ok(typeof session.lastModified === 'number' && session.lastModified > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverSessions honors staleMs and skips old files', async () => {
  const root = mkTmp();
  try {
    const transcript = join(root, 'old.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n');
    // Backdate mtime by 1 hour.
    const past = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(transcript, past, past);

    // staleMs = 1 ms → everything older than 1 ms ago is excluded.
    const result = await discoverSessions({ roots: [root], staleMs: 1 });
    assert.deepEqual(result, []);

    // Confirm it WOULD be found with a generous staleMs.
    const result2 = await discoverSessions({
      roots: [root],
      staleMs: 2 * 60 * 60 * 1000, // 2 h
    });
    assert.equal(result2.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('watcher emits add for a JSONL created after start()', async () => {
  const root = mkTmp();
  // Wrap inside ".claude/projects" so the watcher infers the right runtime.
  const claudeRoot = join(root, '.claude', 'projects');
  mkdirSync(claudeRoot, { recursive: true });
  const watcher = createSessionWatcher({
    discover: { roots: [claudeRoot], staleMs: Infinity },
    debounceMs: 50,
    pollIntervalMs: 100,
  });
  const events = [];
  watcher.on((ev) => events.push(ev));
  try {
    await watcher.start();
    // Give the watcher a moment to actually attach.
    await new Promise((r) => setTimeout(r, 100));

    const projDir = join(claudeRoot, 'demo-app');
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, 'session.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', cwd: '/tmp/x', message: { role: 'user', content: [] } }) + '\n'
    );

    const ok = await waitFor(() => events.some((e) => e.type === 'add'), 3000);
    assert.ok(ok, `expected an 'add' event, got: ${JSON.stringify(events)}`);
    const add = events.find((e) => e.type === 'add');
    assert.equal(add.session.runtime, 'claude-code');
    assert.equal(add.session.transcriptPath, transcript);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('watcher emits change when an existing JSONL is appended', async () => {
  const root = mkTmp();
  const claudeRoot = join(root, '.claude', 'projects', 'app');
  mkdirSync(claudeRoot, { recursive: true });
  const transcript = join(claudeRoot, 'session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n');

  const watcher = createSessionWatcher({
    discover: { roots: [join(root, '.claude', 'projects')], staleMs: Infinity },
    debounceMs: 50,
    pollIntervalMs: 100,
  });
  const events = [];
  watcher.on((ev) => events.push(ev));
  try {
    await watcher.start();
    // Initial seed should NOT emit an 'add' (it's pre-known). Wait a tick.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      watcher.snapshot().some((s) => s.transcriptPath === transcript),
      'pre-existing transcript should be in the snapshot'
    );

    // Append. Tweak mtime to force a measurable change (some platforms have
    // 1-second mtime resolution).
    appendFileSync(transcript, JSON.stringify({ type: 'assistant' }) + '\n');
    const future = (Date.now() + 2000) / 1000;
    utimesSync(transcript, future, future);

    const ok = await waitFor(() => events.some((e) => e.type === 'change'), 3000);
    assert.ok(ok, `expected a 'change' event, got: ${JSON.stringify(events)}`);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('watcher emits remove when a JSONL is unlinked', async () => {
  const root = mkTmp();
  const claudeRoot = join(root, '.claude', 'projects', 'app');
  mkdirSync(claudeRoot, { recursive: true });
  const transcript = join(claudeRoot, 'session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n');

  const watcher = createSessionWatcher({
    discover: { roots: [join(root, '.claude', 'projects')], staleMs: Infinity },
    debounceMs: 50,
    pollIntervalMs: 100,
  });
  const events = [];
  watcher.on((ev) => events.push(ev));
  try {
    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    unlinkSync(transcript);

    const ok = await waitFor(() => events.some((e) => e.type === 'remove'), 3000);
    assert.ok(ok, `expected a 'remove' event, got: ${JSON.stringify(events)}`);
    const removed = events.find((e) => e.type === 'remove');
    assert.match(removed.sessionId, /^[0-9a-f]{12}$/);
    // After removal the snapshot should no longer contain it.
    assert.equal(
      watcher.snapshot().find((s) => s.transcriptPath === transcript),
      undefined
    );
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// v0.2.1 regression: Windows drive-letter prefix in Claude Code slugs.
// Pre-fix, `C--Users-conno-Dev-AgentPulse` decoded to `C` and every Windows
// session collapsed to a single-letter project name.
test('decodeSlug strips Windows drive-letter prefix (C--Users-... → last segment)', () => {
  assert.equal(decodeSlug('C--Users-conno-Dev-AgentPulse'), 'AgentPulse');
  assert.equal(decodeSlug('D--Projects-MyApp'), 'MyApp');
  assert.equal(decodeSlug('c--Users-conno-Dev-Cool'), 'Cool');
  // Non-drive slugs still work.
  assert.equal(decodeSlug('c-Dev-MyApp'), 'MyApp');
  assert.equal(decodeSlug('repo'), 'repo');
  // Single-letter fallthrough (still single letter — caller handles the cwd fallback).
  assert.equal(decodeSlug('C'), 'C');
});

test('deriveProjectName falls back to cwd basename when slug decodes to a single letter', () => {
  const root = '/.claude/projects';
  // Simulated path: ~/.claude/projects/C/<uuid>.jsonl with cwd in the transcript.
  const transcript = '/.claude/projects/C/abc-def.jsonl';
  // Without cwd → returns "C" (the broken pre-v0.2.1 behavior we now document).
  assert.equal(deriveProjectName(transcript, root), 'C');
  // With cwd → falls back to basename(cwd), giving the real project name.
  assert.equal(
    deriveProjectName(transcript, root, '/Users/conno/Dev/RealProject'),
    'RealProject'
  );
  // cwd basename that's also a single letter → stays with the original.
  assert.equal(
    deriveProjectName(transcript, root, '/X'),
    'C'
  );
});
