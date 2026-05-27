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
import { isSubagentTranscript, SUBAGENT_NAME_RE } from '../dist/sessions/subagents.js';

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
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

test('deriveProjectName treats Codex date-shape slugs as junky and prefers cwd (v0.4.6)', () => {
  // Regression: real screenshot showed `2026 (codex)` because Codex stores
  // transcripts at `~/.codex/sessions/<year>/<month>/<day>/<rollout>.jsonl`
  // and the year segment was leaking through as a project name. None of
  // those date shapes are ever real project names.
  const root = '/.codex/sessions';
  const transcript = '/.codex/sessions/2026/05/23/rollout-abc123.jsonl';

  // With cwd (Codex's session_meta.payload.cwd) → use the real project.
  assert.equal(
    deriveProjectName(transcript, root, '/Users/conno/Dev/RealProject'),
    'RealProject',
    'date-shape slug + cwd → cwd basename',
  );

  // Without cwd → undefined, so the UI's file-path inference (or last-ditch
  // session-<id-prefix> fallback) takes over instead of rendering "2026".
  assert.equal(
    deriveProjectName(transcript, root),
    undefined,
    'date-shape slug + no cwd → undefined (never "2026")',
  );

  // ISO-date-shape slug → same treatment.
  const isoTranscript = '/.codex/sessions/2026-05-23/rollout-xyz.jsonl';
  assert.equal(
    deriveProjectName(isoTranscript, root),
    undefined,
    'ISO-date-shape slug + no cwd → undefined',
  );
  assert.equal(
    deriveProjectName(isoTranscript, root, '/Users/conno/Dev/Demo'),
    'Demo',
    'ISO-date-shape slug + cwd → cwd basename',
  );

  // Sanity check: a real Codex-stored project (rare but possible — older
  // Codex layouts use a flat slug at top level) still works as before.
  assert.equal(
    deriveProjectName('/.codex/sessions/real-project/r1.jsonl', root),
    'project',
    'non-date Codex slug still decodes normally',
  );
});

// v0.7.1: shared subagent predicate. Replaces an in-file copy that used to
// live in src/tui/App.tsx; both the TUI and the headless `--once` snapshot
// path now share this so subagent filtering is consistent.
test('isSubagentTranscript: matches agent-<hex> project names and basenames (v0.7.1)', () => {
  // Project name shaped like SDK-spawned subagent.
  assert.equal(
    isSubagentTranscript('agent-a92e01b8034a7c780', '/whatever.jsonl'),
    true,
  );
  // Project name absent, basename matches.
  assert.equal(
    isSubagentTranscript(undefined, '/some/dir/agent-abd0da0516da5bade.jsonl'),
    true,
  );
  // Structural case — Claude Code's <parent>/subagents/<agent-hex>.jsonl
  // layout, where the parent's project name leaks through to the child.
  assert.equal(
    isSubagentTranscript(
      'lab', // inherited from parent — subagent inherits parent project name
      'C:\\Users\\conno\\.claude\\projects\\C--FullStee-lab\\35c8a5a9-914c\\subagents\\agent-ae7833d215098313c.jsonl'
    ),
    true,
    'structural subagents/ path segment marks it as subagent regardless of projectName',
  );
  // Plain human session — neither shape matches.
  assert.equal(
    isSubagentTranscript('AgentPulse', '/.claude/projects/C--Dev-AgentPulse/abc.jsonl'),
    false,
  );
  // Sanity: regex is exported for callers that need it raw.
  assert.match('agent-abcdef1234', SUBAGENT_NAME_RE);
});

// v0.7.1: cwd-first project naming. Pre-fix, slug decoding kept only the
// last hyphen-separated segment, so any multi-word project name collapsed:
//   C--FullStee-nutrition-experiment-lab → 'lab'   (should be the full tail)
//   C--FullStee-repo-brief               → 'brief' (should be 'repo-brief')
// The transcript's first line carries the real cwd; when present, we now
// prefer basename(cwd) over the lossy slug decode.
test('deriveProjectName prefers cwd basename for hyphenated project names (v0.7.1)', () => {
  const root = '/.claude/projects';
  // Forward-slash cwds so node:path.basename works on both POSIX (Ubuntu
  // CI) and Windows runners — production code calls the platform's
  // basename, so the fixture must use a separator the current platform
  // recognises. Real Claude Code on Windows DOES write backslash cwds,
  // and basename strips them correctly on Windows; on Linux the cwd
  // would always be POSIX-style. The test fixture uses '/' so it's
  // valid on both.

  // Case A — multi-hyphen project name. Slug-only decode → 'lab', but
  // the real project is 'nutrition-experiment-lab'.
  assert.equal(
    deriveProjectName(
      '/.claude/projects/C--FullStee-nutrition-experiment-lab/abc-def.jsonl',
      root,
      '/FullStee/nutrition-experiment-lab'
    ),
    'nutrition-experiment-lab',
    'multi-hyphen project name decodes via cwd, not the lossy slug rule',
  );

  // Case B — two-hyphen project name. Slug-only decode → 'brief', but
  // the real project is 'repo-brief'.
  assert.equal(
    deriveProjectName(
      '/.claude/projects/C--FullStee-repo-brief/16fa.jsonl',
      root,
      '/FullStee/repo-brief'
    ),
    'repo-brief',
    'two-hyphen project name decodes via cwd',
  );

  // Case C — when slug AND cwd basename agree (single-word project),
  // cwd-first still gives the right answer.
  assert.equal(
    deriveProjectName(
      '/.claude/projects/C--Users-conno-Dev-AgentPulse/xyz.jsonl',
      root,
      '/Users/conno/Dev/AgentPulse'
    ),
    'AgentPulse',
  );

  // Case D — cwd basename is a subagent-shaped string. Defensive: we
  // never use a subagent-looking basename as a project name (would
  // mislabel the whole project as a tooling artifact).
  assert.equal(
    deriveProjectName(
      '/.claude/projects/C--Users-conno-Dev-MyApp/file.jsonl',
      root,
      '/tmp/agent-abc12345def'
    ),
    'MyApp',
    'subagent-shaped cwd basename is rejected, slug path runs',
  );
});

// v0.7.1: cwd extraction must scan past metadata-only opening lines.
// Real Claude Code transcripts open with `permission-mode` and
// `file-history-snapshot` before any line that carries `cwd`. Pre-fix
// extractCwdFromFirstLine only inspected lines[0], so cwd was never
// recovered on these sessions and the project-name fallback chain
// landed on the lossy slug ("lab" instead of "nutrition-experiment-lab").
test('discoverSessions: recovers cwd from later lines past permission-mode + file-history-snapshot (v0.7.1)', async () => {
  const root = mkTmp('agentpulse-cwd-scan-');
  try {
    const projDir = join(root, 'C--FullStee-nutrition-experiment-lab');
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, '35c8a5a9-914c.jsonl');
    // Real Claude Code prelude shape: permission-mode is line 1,
    // file-history-snapshot is line 2, the first cwd-bearing line is the
    // user message at line 3. Pre-fix the cwd was never seen.
    // Forward-slash cwd so node:path.basename works on both POSIX
    // (Ubuntu CI) and Windows runners. Real Claude Code on Windows
    // writes backslashes; on Linux it writes forward slashes — the
    // fixture stays on '/' to be valid on both.
    const lines = [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: '35c8a5a9-914c' }),
      JSON.stringify({ type: 'file-history-snapshot', sessionId: '35c8a5a9-914c' }),
      JSON.stringify({ type: 'user', cwd: '/FullStee/nutrition-experiment-lab', message: { role: 'user', content: 'hi' } }),
    ].join('\n') + '\n';
    writeFileSync(transcript, lines);

    const sessions = await discoverSessions({ roots: [root], staleMs: Infinity });
    assert.equal(sessions.length, 1);
    assert.equal(
      sessions[0].cwd,
      '/FullStee/nutrition-experiment-lab',
      'cwd is extracted despite being on line 3, not line 1',
    );
    assert.equal(
      sessions[0].projectName,
      'nutrition-experiment-lab',
      'project name uses cwd basename instead of slug-decoded "lab"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
