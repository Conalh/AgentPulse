// Tests for Layer 2 — semantic enrichment.
// Run via `npm test` (which first compiles TS → dist/).

import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichWindow, STOPWORD_COUNT } from '../dist/enrich.js';

// ── Helpers ──────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

const userMsg = (offset, text) => ({
  timestamp: T0 + offset,
  runtime: 'claude-code',
  kind: 'user_message',
  text,
});

const toolUse = (offset, toolName, toolInput, cwdOrRuntime, runtime = 'claude-code') => {
  // Backwards-compat: callers that used `(offset, name, input, runtime)`
  // (where the 4th arg was the runtime string) still work. New callers can
  // pass `(offset, name, input, cwd)` or `(offset, name, input, cwd, runtime)`.
  let cwd;
  let rt = runtime;
  if (typeof cwdOrRuntime === 'string') {
    // Heuristic: a runtime is one of three short tokens; anything else looks
    // like a path/cwd.
    if (cwdOrRuntime === 'claude-code' || cwdOrRuntime === 'cursor' || cwdOrRuntime === 'codex') {
      rt = cwdOrRuntime;
    } else {
      cwd = cwdOrRuntime;
    }
  }
  return {
    timestamp: T0 + offset,
    runtime: rt,
    kind: 'tool_use',
    toolName,
    toolInput,
    ...(cwd !== undefined ? { cwd } : {}),
  };
};

const WSTART = T0;
const WEND = T0 + 60 * 60 * 1000; // 1 hour window

// ── 1. Topic extraction ─────────────────────────────────────────────

test('topic extraction: drops stopwords, keeps content tokens', () => {
  const events = [
    userMsg(1_000, 'The login auth bug is back, can you fix the login again?'),
    userMsg(2_000, 'Why is the auth login failing? The bug is in auth.'),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  assert.ok(e.topics.includes('login'), 'topics should include "login"');
  assert.ok(e.topics.includes('auth'), 'topics should include "auth"');
  assert.ok(e.topics.includes('bug'), 'topics should include "bug"');
  assert.ok(!e.topics.includes('the'), 'topics must NOT include "the"');
  assert.ok(!e.topics.includes('is'), 'topics must NOT include "is"');
  assert.ok(!e.topics.includes('you'), 'topics must NOT include "you"');
  assert.equal(e.userMessageCount, 2);

  // Topic limit default = 5.
  assert.ok(e.topics.length <= 5);
});

// ── 2. Path clusters ────────────────────────────────────────────────

test('path clusters: top-2-level bucket by parent directory', () => {
  const events = [
    toolUse(100, 'Read', { file_path: 'src/auth/login.ts' }),
    toolUse(200, 'Read', { file_path: 'src/auth/middleware.ts' }),
    toolUse(300, 'Read', { file_path: 'src/auth/session.ts' }),
    toolUse(400, 'Read', { file_path: 'src/api/users.ts' }),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  assert.deepEqual(e.pathClusters, { 'src/auth': 3, 'src/api': 1 });
});

test('path clusters: handles deeper paths and windows paths', () => {
  const events = [
    toolUse(100, 'Read', { file_path: 'tests/unit/foo.test.ts' }),
    toolUse(200, 'Read', { file_path: 'tests\\unit\\bar.test.ts' }),
    toolUse(300, 'Read', { file_path: 'top.md' }),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  assert.equal(e.pathClusters['tests/unit'], 2);
  // v0.2.5: bare-filename paths bucket as `(project root)` for readability
  // in narratives. Was `.`, but `.` reads weirdly in "focused on .".
  assert.equal(e.pathClusters['(project root)'], 1);
});

// v0.2.5 regression: per-event cwd should strip from the cluster key so
// absolute paths under the session cwd bucket by project-relative dirs.
test('path clusters: strip per-event cwd so absolute paths cluster by relative subdirs', () => {
  const cwd = 'C:/Dev/fit-ontology';
  const events = [
    toolUse(100, 'Edit', { file_path: 'C:/Dev/fit-ontology/app.py' }, cwd),
    toolUse(200, 'Edit', { file_path: 'C:/Dev/fit-ontology/utils/foo.py' }, cwd),
    toolUse(300, 'Edit', { file_path: 'C:/Dev/fit-ontology/utils/bar.py' }, cwd),
    toolUse(400, 'Read', { file_path: 'C:/Dev/fit-ontology/src/api/x.py' }, cwd),
    // File outside cwd — should NOT be stripped, keeps absolute clustering.
    toolUse(500, 'Read', { file_path: 'C:/Dev/other/foo.py' }, cwd),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  // Project-relative buckets:
  assert.equal(e.pathClusters['(project root)'], 1); // app.py at root
  assert.equal(e.pathClusters['utils'], 2);
  assert.equal(e.pathClusters['src/api'], 1);
  // File outside cwd retains absolute-path top-2-segment clustering:
  // `C:/Dev/other/foo.py` → parts `['C:', 'Dev', 'other', 'foo.py']`,
  // dirParts `['C:', 'Dev', 'other']`, top-2 → `C:/Dev`.
  assert.equal(e.pathClusters['C:/Dev'], 1);
});

test('path clusters: backslash cwd on Windows still strips correctly', () => {
  const cwd = 'C:\\Dev\\fit-ontology';
  const events = [
    toolUse(100, 'Edit', { file_path: 'C:\\Dev\\fit-ontology\\utils\\foo.py' }, cwd),
    toolUse(200, 'Edit', { file_path: 'C:\\Dev\\fit-ontology\\utils\\bar.py' }, cwd),
  ];
  const e = enrichWindow(events, WSTART, WEND);
  assert.equal(e.pathClusters['utils'], 2);
});

// ── 3. Action classification ────────────────────────────────────────

test('action classification: mix of read / edit / bash verify / curl / mcp', () => {
  const events = [
    toolUse(100, 'Read', { file_path: 'a.ts' }),
    toolUse(200, 'Glob', { pattern: '**/*.ts' }),
    toolUse(300, 'Grep', { pattern: 'foo' }),
    toolUse(400, 'Edit', { file_path: 'a.ts' }),
    toolUse(500, 'Write', { file_path: 'b.ts' }),
    toolUse(600, 'Bash', { command: 'npm test -- --watch' }),
    toolUse(700, 'Bash', { command: 'pytest tests/' }),
    toolUse(800, 'Bash', { command: 'cd src && ls' }),
    toolUse(900, 'Bash', { command: 'git status' }),
    toolUse(1000, 'Bash', { command: 'curl https://example.com' }),
    toolUse(1100, 'WebFetch', { url: 'https://x.com' }),
    toolUse(1200, 'mcp__github__list_issues', {}),
    toolUse(1300, 'SomeWeirdTool', {}),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  assert.equal(e.actionCounts.exploration, 3, 'Read/Glob/Grep');
  assert.equal(e.actionCounts.editing, 2, 'Edit + Write');
  assert.equal(e.actionCounts.verification, 2, 'npm test + pytest');
  assert.equal(e.actionCounts.navigation, 2, 'cd + git status');
  assert.equal(e.actionCounts.external, 3, 'curl + WebFetch + mcp__*');
  assert.equal(e.actionCounts.other, 1, 'SomeWeirdTool');
  assert.equal(e.toolInvocationCount, 13);
});

// ── 4. Primary files ────────────────────────────────────────────────

test('action classification: current Codex shell_command counts as Bash', () => {
  const events = [
    toolUse(100, 'shell_command', { command: 'Get-Content package.json' }, 'codex'),
    toolUse(200, 'shell_command', { command: 'npm test' }, 'codex'),
    toolUse(300, 'shell_command', { command: 'git status --short' }, 'codex'),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  assert.equal(e.actionCounts.verification, 1);
  assert.equal(e.actionCounts.navigation, 1);
  assert.equal(e.actionCounts.other, 1);
  assert.ok(e.uniqueTools.includes('Bash'));
  assert.ok(e.commandVerbs.includes('npm test'));
});

test('primary files: top-N by edit count', () => {
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push(toolUse(100 + i, 'Edit', { file_path: 'src/session.ts' }));
  }
  events.push(toolUse(800, 'Edit', { file_path: 'src/middleware.ts' }));
  events.push(toolUse(900, 'Write', { file_path: 'src/middleware.ts' }));
  events.push(toolUse(1000, 'Edit', { file_path: 'src/login.ts' }));

  const e = enrichWindow(events, WSTART, WEND);

  assert.equal(e.primaryFiles[0], 'src/session.ts');
  assert.equal(e.primaryFiles[1], 'src/middleware.ts');
  assert.equal(e.primaryFiles[2], 'src/login.ts');
  assert.equal(e.primaryFiles.length, 3);
});

// ── 5. Command verbs ────────────────────────────────────────────────

test('command verbs: first two whitespace tokens of Bash command', () => {
  const events = [
    toolUse(100, 'Bash', { command: 'npm test -- --watch' }),
    toolUse(200, 'Bash', { command: 'npm test' }),
    toolUse(300, 'Bash', { command: 'git status' }),
    toolUse(400, 'Bash', { command: 'git status --short' }),
    toolUse(500, 'Bash', { command: 'ls' }),
  ];

  const e = enrichWindow(events, WSTART, WEND);

  assert.ok(e.commandVerbs.includes('npm test'));
  assert.ok(e.commandVerbs.includes('git status'));
  assert.ok(e.commandVerbs.includes('ls'));
  // Highest-count verb should come first.
  assert.equal(e.commandVerbs[0], 'git status');
});

// ── 6. Empty window ─────────────────────────────────────────────────

test('empty window: returns sensible zero/empty values without throwing', () => {
  const e = enrichWindow([], WSTART, WEND);

  assert.deepEqual(e.events, []);
  assert.equal(e.windowStart, WSTART);
  assert.equal(e.windowEnd, WEND);
  assert.equal(e.durationMs, WEND - WSTART);
  assert.deepEqual(e.topics, []);
  assert.deepEqual(e.pathClusters, {});
  assert.deepEqual(e.actionCounts, {
    exploration: 0,
    editing: 0,
    verification: 0,
    external: 0,
    navigation: 0,
    other: 0,
  });
  assert.deepEqual(e.primaryFiles, []);
  assert.deepEqual(e.commandVerbs, []);
  assert.deepEqual(e.uniqueTools, []);
  assert.equal(e.toolInvocationCount, 0);
  assert.equal(e.userMessageCount, 0);
  assert.deepEqual(e.runtimeUsage, {});
});

// ── Bonus coverage ──────────────────────────────────────────────────

test('topic extraction: drops evaluative adjectives and conversational fillers (v0.4.3)', () => {
  // Regression: real-world dogfooding produced "working on bad for 20
  // minutes" because the user said things like "bad picture" and "bad"
  // out-counted the actual topic words. None of these words should ever
  // win the topics ranking.
  const events = [
    userMsg(1_000, 'this is bad bad bad, the picture is bad'),
    userMsg(2_000, 'looks weird, kinda nice though, hmm yeah'),
    userMsg(3_000, "i think things look broken — try again maybe"),
    userMsg(4_000, 'authentication broken on login'),
  ];
  const e = enrichWindow(events, WSTART, WEND);

  for (const w of ['bad', 'good', 'looks', 'thing', 'things', 'try', 'hmm',
                   'yeah', 'maybe', 'think', 'broken', 'weird', 'nice']) {
    assert.ok(!e.topics.includes(w), `topics must NOT include filler "${w}"`);
  }
  // The actual subject word should survive.
  assert.ok(
    e.topics.includes('authentication') || e.topics.includes('login'),
    'real topic word should survive the filter',
  );
});

test('events outside the window are dropped', () => {
  const events = [
    userMsg(-1000, 'before the window'),
    userMsg(500, 'inside the window login'),
    userMsg(WEND - WSTART + 1000, 'after the window'),
  ];
  const e = enrichWindow(events, WSTART, WEND);
  assert.equal(e.userMessageCount, 1);
  assert.ok(e.topics.includes('login'));
});

test('runtime usage aggregates per runtime', () => {
  const events = [
    toolUse(100, 'Read', { file_path: 'a.ts' }, 'claude-code'),
    toolUse(200, 'Read', { file_path: 'b.ts' }, 'cursor'),
    toolUse(300, 'Read', { file_path: 'c.ts' }, 'cursor'),
  ];
  const e = enrichWindow(events, WSTART, WEND);
  assert.equal(e.runtimeUsage['claude-code'], 1);
  assert.equal(e.runtimeUsage['cursor'], 2);
});

test('topicLimit / primaryFileLimit / commandVerbLimit options honored', () => {
  const events = [
    userMsg(100, 'alpha beta gamma delta epsilon zeta eta theta'),
    toolUse(200, 'Edit', { file_path: 'a.ts' }),
    toolUse(201, 'Edit', { file_path: 'b.ts' }),
    toolUse(202, 'Edit', { file_path: 'c.ts' }),
    toolUse(203, 'Edit', { file_path: 'd.ts' }),
    toolUse(300, 'Bash', { command: 'one cmd' }),
    toolUse(301, 'Bash', { command: 'two cmd' }),
    toolUse(302, 'Bash', { command: 'three cmd' }),
  ];
  const e = enrichWindow(events, WSTART, WEND, {
    topicLimit: 2,
    primaryFileLimit: 2,
    commandVerbLimit: 2,
  });
  assert.equal(e.topics.length, 2);
  assert.equal(e.primaryFiles.length, 2);
  assert.equal(e.commandVerbs.length, 2);
});

test('stopword list is reasonably sized', () => {
  // Sanity: not empty, not insanely big. Locks the stopword surface.
  assert.ok(STOPWORD_COUNT >= 50);
  assert.ok(STOPWORD_COUNT < 500);
});
