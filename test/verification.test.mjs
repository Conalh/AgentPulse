// Tests for src/verification.ts — the shared verification vocabulary and the
// result-text pass/fail classifier.
//
// Focus of the #F5 pass: the text-only failure heuristic used to include a
// bare /\berror\b/i, which flipped ANY result mentioning the word "error" to
// `fail`. That table is consulted only when no exit code is present (callers
// prefer the exit code), so the incidental match could bias stuck/converging/
// sequence verdicts. The heuristic is now narrowed to runner-shaped errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResultText,
  isVerificationCommand,
} from '../dist/verification.js';

// ── classifyResultText — #F5 narrowing ───────────────────────────────

test('classifyResultText: an incidental "error" word is no longer a failure', () => {
  // No exit code, no runner-shaped error token, no pass token → indeterminate.
  // Pre-#F5 this returned "fail" because of the bare /\berror\b/i.
  assert.equal(classifyResultText('the test for error handling ran'), null);
  assert.equal(classifyResultText('added an error boundary component'), null);
});

test('classifyResultText: runner-shaped error contexts still classify as fail', () => {
  assert.equal(classifyResultText('npm ERR! code ELIFECYCLE'), 'fail');
  assert.equal(classifyResultText('src/x.ts:3:1 - error TS2304: cannot find name'), 'fail');
  assert.equal(classifyResultText('Error: connection refused'), 'fail');
  assert.equal(classifyResultText('3 errors found'), 'fail');
  assert.equal(classifyResultText('build failed'), 'fail');
  assert.equal(classifyResultText('command failed with exit code 1'), 'fail');
});

test('classifyResultText: explicit FAIL / "N failed" still classify as fail', () => {
  assert.equal(classifyResultText('FAIL src/foo.test.ts'), 'fail');
  assert.equal(classifyResultText('Tests: 2 failed, 5 passed'), 'fail'); // failure dominates
  assert.equal(classifyResultText('1 failed'), 'fail');
});

test('classifyResultText: pass tokens classify as pass; unknown text is null', () => {
  assert.equal(classifyResultText('Tests: 5 passed'), 'pass');
  assert.equal(classifyResultText('ok 12'), 'pass');
  assert.equal(classifyResultText(''), null);
  assert.equal(classifyResultText(null), null);
  assert.equal(classifyResultText('just some neutral output'), null);
});

// ── isVerificationCommand — vocabulary is intentionally broad ──────────

test('isVerificationCommand: broad package-runner verbs match by design', () => {
  assert.equal(isVerificationCommand('npm run build'), true);
  assert.equal(isVerificationCommand('npm test'), true);
  assert.equal(isVerificationCommand('make check'), true);
  assert.equal(isVerificationCommand('cargo test'), true);
});

test('isVerificationCommand: word-boundary anchored — no embedded false matches', () => {
  assert.equal(isVerificationCommand('echo latest'), false); // not "test"
  assert.equal(isVerificationCommand('git status'), false);
  assert.equal(isVerificationCommand(''), false);
});
