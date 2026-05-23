import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve('dist/cli.js');
const FIXTURES = resolve('test/fixtures');

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
