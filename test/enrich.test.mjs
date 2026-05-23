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

const toolUse = (offset, toolName, toolInput, runtime = 'claude-code') => ({
  timestamp: T0 + offset,
  runtime,
  kind: 'tool_use',
  toolName,
  toolInput,
});

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
  assert.equal(e.pathClusters['.'], 1);
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
