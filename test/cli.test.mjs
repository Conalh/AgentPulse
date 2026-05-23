// Tests for Layer 5b — CLI arg parsing.
// We spawn the compiled `dist/cli.js` and assert on exit codes / stderr.
// Watch mode is not integration-tested here (per the task spec).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'dist', 'cli.js');

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    ...opts,
  });
}

test('CLI: no args -> exit 2 with usage on stderr', () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});

test('CLI: unknown subcommand -> exit 2', () => {
  const r = runCli(['summarize']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown subcommand/);
});

test('CLI: recap without --transcript-dir -> exit 2', () => {
  const r = runCli(['recap']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /transcript-dir/);
});

test('CLI: invalid --window duration -> exit 2', () => {
  const r = runCli(['recap', '--transcript-dir', '/tmp/x', '--window', 'forever']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --window duration: forever/);
});

test('CLI: invalid --watch-interval duration -> exit 2', () => {
  const r = runCli([
    'recap',
    '--transcript-dir',
    '/tmp/x',
    '--watch-interval',
    'soon',
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --watch-interval duration: soon/);
});

test('CLI: invalid --format -> exit 2', () => {
  const r = runCli([
    'recap',
    '--transcript-dir',
    '/tmp/x',
    '--format',
    'yaml',
  ]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --format: yaml/);
});

test('CLI: --help -> exit 0 with usage on stdout', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test('CLI: unknown flag -> exit 2 with parse error', () => {
  const r = runCli(['recap', '--transcript-dir', '/tmp/x', '--frobnicate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:|Unknown option/);
});

// Smoke-test that arg parsing succeeds for a valid command. Until layers
// 1-4 are implemented, calling pulse() throws "not yet implemented" — so
// we assert exit code is NOT 2 (arg parsing succeeded) and stderr has the
// runtime error prefix.
test('CLI: valid args reach pulse() (exit code !== 2, runtime error surfaced)', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'agentpulse-cli-'));
  try {
    const r = runCli([
      'recap',
      '--transcript-dir',
      tmp,
      '--format',
      'json',
      '--no-detectors',
    ]);
    assert.notEqual(r.status, 2);
    assert.match(r.stderr, /agentpulse:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});