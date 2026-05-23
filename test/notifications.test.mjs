// Tests for v0.4.2 — local notifications on state transitions.
//
// We exercise the notifier purely through its public API: `onTransition`
// returns true iff a notification fired, which lets us assert on policy
// without spawning real `osascript` / `notify-send` / `powershell.exe`
// processes. The bell-mode test captures `process.stderr.write` to verify
// the BEL byte was emitted.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNotifier,
  shouldNotify,
} from '../dist/notifications.js';

// ─────────────────────────────────────────────────────────────────────
// stderr capture helpers (used by the bell-mode test). We monkey-patch
// process.stderr.write rather than using a stream wrapper because the
// notifier writes directly to `process.stderr`.
// ─────────────────────────────────────────────────────────────────────
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const writes = [];
  process.stderr.write = (chunk, ...rest) => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
    // Swallow the bell so test output doesn't ping the developer's terminal.
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return writes.join('');
}

// ─────────────────────────────────────────────────────────────────────
// Policy tests — these don't depend on any channel, just the trigger
// shape. Run against `none` so we incidentally also confirm none-mode
// returns false universally.
// ─────────────────────────────────────────────────────────────────────

test('notifier (none mode): onTransition always returns false', () => {
  const n = createNotifier({ mode: 'none' });
  assert.equal(n.onTransition(null, 'drifting', 'demo'), false);
  assert.equal(n.onTransition('converging', 'stuck', 'demo'), false);
  assert.equal(n.onTransition('drifting', 'drifting', 'demo'), false);
  assert.equal(n.onTransition('idle', 'converging', 'demo'), false);
});

test('notifier (bell mode): null -> drifting fires (returns true)', () => {
  const n = createNotifier({ mode: 'bell' });
  // Capture stderr so we don't ring the dev's terminal during the suite.
  let result;
  captureStderr(() => {
    result = n.onTransition(null, 'drifting', 'demo');
  });
  assert.equal(result, true);
});

test('notifier (bell mode): safe-bucket transitions return false', () => {
  const n = createNotifier({ mode: 'bell' });
  captureStderr(() => {
    assert.equal(n.onTransition(null, 'converging', 'demo'), false);
    assert.equal(n.onTransition('idle', 'exploring', 'demo'), false);
    assert.equal(n.onTransition('converging', 'done', 'demo'), false);
    assert.equal(n.onTransition(null, 'idle', 'demo'), false);
  });
});

test('notifier (bell mode): drifting -> drifting does not double-alert', () => {
  const n = createNotifier({ mode: 'bell' });
  captureStderr(() => {
    assert.equal(n.onTransition('drifting', 'drifting', 'demo'), false);
    assert.equal(n.onTransition('stuck', 'drifting', 'demo'), false);
    assert.equal(n.onTransition('drifting', 'stuck', 'demo'), false);
  });
});

test('notifier (bell mode): drifting -> safe-bucket clears silently', () => {
  const n = createNotifier({ mode: 'bell' });
  captureStderr(() => {
    assert.equal(n.onTransition('drifting', 'idle', 'demo'), false);
    assert.equal(n.onTransition('drifting', 'converging', 'demo'), false);
    assert.equal(n.onTransition('stuck', 'done', 'demo'), false);
  });
});

test('notifier (bell mode): writes \\x07 (BEL) to stderr on fire', () => {
  const n = createNotifier({ mode: 'bell' });
  const captured = captureStderr(() => {
    const r = n.onTransition('converging', 'drifting', 'demo');
    assert.equal(r, true);
  });
  assert.match(captured, /\x07/);
});

test('notifier (bell mode): no stderr write on non-firing transition', () => {
  const n = createNotifier({ mode: 'bell' });
  const captured = captureStderr(() => {
    n.onTransition('drifting', 'idle', 'demo');
    n.onTransition(null, 'converging', 'demo');
  });
  assert.equal(captured.includes('\x07'), false);
});

// ─────────────────────────────────────────────────────────────────────
// shouldNotify() — direct policy unit. Belts-and-braces with the API
// tests above; if the policy regresses these fail first with clearer
// diagnostics than the higher-level fire/no-fire assertions.
// ─────────────────────────────────────────────────────────────────────

test('shouldNotify: null -> alert buckets', () => {
  assert.equal(shouldNotify(null, 'drifting'), true);
  assert.equal(shouldNotify(null, 'stuck'), true);
});

test('shouldNotify: safe -> alert buckets', () => {
  assert.equal(shouldNotify('converging', 'drifting'), true);
  assert.equal(shouldNotify('exploring', 'stuck'), true);
  assert.equal(shouldNotify('idle', 'drifting'), true);
  assert.equal(shouldNotify('done', 'stuck'), true);
});

test('shouldNotify: alert -> alert (no double-alert)', () => {
  assert.equal(shouldNotify('drifting', 'stuck'), false);
  assert.equal(shouldNotify('stuck', 'drifting'), false);
  assert.equal(shouldNotify('drifting', 'drifting'), false);
});

test('shouldNotify: alert -> safe (clearing is silent)', () => {
  assert.equal(shouldNotify('drifting', 'idle'), false);
  assert.equal(shouldNotify('drifting', 'converging'), false);
  assert.equal(shouldNotify('stuck', 'done'), false);
});

test('shouldNotify: safe -> safe', () => {
  assert.equal(shouldNotify(null, 'converging'), false);
  assert.equal(shouldNotify('idle', 'exploring'), false);
  assert.equal(shouldNotify('converging', 'done'), false);
});

// ─────────────────────────────────────────────────────────────────────
// `both` mode — confirms bell fires even when OS channel is also engaged.
// We don't assert on OS-channel side effects because spawning real
// `osascript` / `notify-send` / `powershell.exe` is what we explicitly
// want to avoid in CI. The child_process spawns are detached + ignored,
// so an ENOENT on the wrong-platform binary is swallowed harmlessly.
// ─────────────────────────────────────────────────────────────────────

test('notifier (both mode): firing transition rings the bell', () => {
  const n = createNotifier({ mode: 'both' });
  const captured = captureStderr(() => {
    const r = n.onTransition(null, 'stuck', 'demo');
    assert.equal(r, true);
  });
  assert.match(captured, /\x07/);
});

test('notifier (os mode): returns true on fire even without bell', () => {
  const n = createNotifier({ mode: 'os' });
  // No stderr write expected in pure os mode — the child_process spawn is
  // detached so its lifetime doesn't block the test.
  const captured = captureStderr(() => {
    const r = n.onTransition(null, 'drifting', 'demo');
    assert.equal(r, true);
  });
  assert.equal(captured.includes('\x07'), false);
});

// ─────────────────────────────────────────────────────────────────────
// notifyOnce — used by --once mode. Should fire unconditionally for any
// non-`none` mode (the caller decides whether to call it).
// ─────────────────────────────────────────────────────────────────────

test('notifyOnce: none mode returns false', () => {
  const n = createNotifier({ mode: 'none' });
  assert.equal(n.notifyOnce('demo'), false);
});

test('notifyOnce: bell mode fires unconditionally', () => {
  const n = createNotifier({ mode: 'bell' });
  let r;
  const captured = captureStderr(() => {
    r = n.notifyOnce('demo');
  });
  assert.equal(r, true);
  assert.match(captured, /\x07/);
});

// ─────────────────────────────────────────────────────────────────────
// stop() — must be idempotent and side-effect-free for the noop API.
// ─────────────────────────────────────────────────────────────────────

test('stop(): is callable and idempotent on all modes', () => {
  for (const mode of ['none', 'bell', 'os', 'both']) {
    const n = createNotifier({ mode });
    n.stop();
    n.stop();
  }
});
