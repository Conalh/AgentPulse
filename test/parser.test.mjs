import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTranscript } from '../dist/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-parser-'));
}

test('parses Claude Code JSONL with user/tool_use/tool_result roundtrip', async () => {
  const dir = tmpDir();
  cpSync(join(FIXTURES, 'claude-code.jsonl'), join(dir, 'session.jsonl'));
  try {
    const events = await parseTranscript(dir);

    // 7 lines in the fixture, 1 is invalid JSON → 6 lines parsed.
    // Line breakdown:
    //   1: user_message
    //   2: assistant_message + tool_use(Read)
    //   3: tool_result
    //   4: tool_use(Bash) — no leading text → only tool_use
    //   5: tool_result
    //   6: assistant_message
    // Total events: 7 (assistant line 2 emits both message + tool_use).
    assert.equal(events.length, 7);
    assert.ok(events.every((e) => e.runtime === 'claude-code'));

    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, [
      'user_message',
      'assistant_message',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'assistant_message',
    ]);

    // Tool use IDs link to tool result IDs
    const readToolUse = events[2];
    const readResult = events[3];
    assert.equal(readToolUse.toolName, 'Read');
    assert.equal(readToolUse.toolUseId, 'tu_read_1');
    assert.equal(readResult.toolUseId, 'tu_read_1');
    assert.match(readResult.toolResultText, /login/);

    const bashUse = events[4];
    const bashResult = events[5];
    assert.equal(bashUse.toolName, 'Bash');
    assert.equal(bashUse.toolInput.command, 'npm test');
    assert.equal(bashResult.toolResultExitCode, 0);

    // Chronologically sorted
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].timestamp >= events[i - 1].timestamp);
    }

    // cwd flows through
    assert.equal(events[0].cwd, '/repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parses Cursor JSONL and tolerates missing timestamps', async () => {
  const dir = tmpDir();
  cpSync(join(FIXTURES, 'cursor.jsonl'), join(dir, 'cursor.jsonl'));
  try {
    const events = await parseTranscript(dir);
    assert.ok(events.length >= 3);
    assert.ok(events.every((e) => e.runtime === 'cursor'));

    // No timestamps in cursor fixture — all events should have timestamp 0
    // (interpolation has nothing to borrow from).
    assert.ok(events.every((e) => e.timestamp === 0));

    const toolUses = events.filter((e) => e.kind === 'tool_use');
    assert.equal(toolUses.length, 2);
    assert.deepEqual(
      toolUses.map((e) => e.toolName),
      ['Glob', 'Edit']
    );
    assert.equal(toolUses[1].toolInput.path, 'src/utils/date.ts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parses Codex JSONL with response_item shape', async () => {
  const dir = tmpDir();
  cpSync(join(FIXTURES, 'codex.jsonl'), join(dir, 'codex.jsonl'));
  try {
    const events = await parseTranscript(dir);
    assert.ok(events.every((e) => e.runtime === 'codex'));

    // session_meta emits a system event; 4 response_items produce 4 more.
    assert.equal(events.length, 5);
    assert.deepEqual(
      events.map((e) => e.kind),
      ['system', 'tool_use', 'tool_result', 'tool_use', 'assistant_message']
    );

    // function_call_output exit_code is extracted
    const shellResult = events[2];
    assert.equal(shellResult.toolResultExitCode, 0);
    assert.match(shellResult.toolResultText, /package\.json/);

    // apply_patch arguments aren't valid JSON — should land under .patch
    const patchUse = events[3];
    assert.equal(patchUse.toolName, 'apply_patch');
    assert.ok(typeof patchUse.toolInput.patch === 'string');
    assert.match(patchUse.toolInput.patch, /Begin Patch/);

    // shell arguments ARE JSON
    const shellUse = events[1];
    assert.equal(shellUse.toolName, 'shell');
    assert.equal(shellUse.toolInput.command, 'ls /repo');

    // Codex timestamps are real, monotonic.
    for (let i = 1; i < events.length; i += 1) {
      assert.ok(events[i].timestamp >= events[i - 1].timestamp);
    }
    assert.ok(events[0].timestamp > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('honors since/until window and drops zero-timestamp events when windowed', async () => {
  const dir = tmpDir();
  cpSync(join(FIXTURES, 'codex.jsonl'), join(dir, 'codex.jsonl'));
  cpSync(join(FIXTURES, 'cursor.jsonl'), join(dir, 'cursor.jsonl')); // no timestamps
  try {
    const since = Date.parse('2026-05-23T11:00:02.000Z');
    const until = Date.parse('2026-05-23T11:00:03.500Z');
    const events = await parseTranscript(dir, { since, until });

    // Only codex events with ts in [since, until] survive; cursor (ts=0)
    // is dropped because a window was supplied.
    assert.ok(events.length > 0);
    assert.ok(events.every((e) => e.timestamp >= since && e.timestamp <= until));
    assert.ok(events.every((e) => e.runtime === 'codex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skips malformed lines without throwing', async () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'bad.jsonl'),
    'not json\n{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\nalso not json\n'
  );
  try {
    const events = await parseTranscript(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'user_message');
    assert.equal(events[0].text, 'hi');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walks subdirectories and merges results chronologically', async () => {
  const dir = tmpDir();
  const sub = join(dir, 'nested');
  mkdirSync(sub, { recursive: true });
  cpSync(join(FIXTURES, 'codex.jsonl'), join(sub, 'codex.jsonl'));
  cpSync(join(FIXTURES, 'claude-code.jsonl'), join(dir, 'cc.jsonl'));
  try {
    const events = await parseTranscript(dir);
    // Sorted by timestamp — claude events (May 23 10:00) come before codex
    // events (May 23 11:00).
    const runtimes = events.map((e) => e.runtime);
    const firstCodex = runtimes.indexOf('codex');
    const lastClaude = runtimes.lastIndexOf('claude-code');
    assert.ok(
      firstCodex > lastClaude,
      'claude-code events should precede codex events when sorted by timestamp'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
