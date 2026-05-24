/**
 * Tests for src/aliases.ts — agent-alias storage (v0.4.7).
 *
 * Aliases live in two optional files:
 *   - <cwd>/.agentpulse-aliases.json (per-project, cwd wins)
 *   - <home>/.agentpulse/aliases.json (personal default)
 *
 * Each test creates fresh tmpdirs and points the alias module at them so
 * the user's real `~/.agentpulse/` is never touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAliases, setAlias, homeAliasPath } from '../dist/aliases.js';

function mkTmpHome() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-aliases-home-'));
}
function mkTmpCwd() {
  return mkdtempSync(join(tmpdir(), 'agentpulse-aliases-cwd-'));
}

test('loadAliases: empty Map when neither home nor cwd file exists', async () => {
  const home = mkTmpHome();
  const cwd = mkTmpCwd();
  try {
    const aliases = await loadAliases({ home, cwd });
    assert.equal(aliases.size, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadAliases: reads home-only aliases', async () => {
  const home = mkTmpHome();
  const cwd = mkTmpCwd();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(
      homeAliasPath(home),
      JSON.stringify({ version: 1, aliases: { sess1: 'CC1', sess2: 'CG1' } })
    );
    const aliases = await loadAliases({ home, cwd });
    assert.equal(aliases.get('sess1'), 'CC1');
    assert.equal(aliases.get('sess2'), 'CG1');
    assert.equal(aliases.size, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadAliases: reads cwd-only aliases', async () => {
  const home = mkTmpHome();
  const cwd = mkTmpCwd();
  try {
    writeFileSync(
      join(cwd, '.agentpulse-aliases.json'),
      JSON.stringify({ version: 1, aliases: { sess1: 'frontend' } })
    );
    const aliases = await loadAliases({ home, cwd });
    assert.equal(aliases.get('sess1'), 'frontend');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadAliases: cwd file overrides home file on the same session id', async () => {
  const home = mkTmpHome();
  const cwd = mkTmpCwd();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(
      homeAliasPath(home),
      JSON.stringify({ version: 1, aliases: { sess1: 'home-name', sess2: 'home-only' } })
    );
    writeFileSync(
      join(cwd, '.agentpulse-aliases.json'),
      JSON.stringify({ version: 1, aliases: { sess1: 'cwd-name', sess3: 'cwd-only' } })
    );
    const aliases = await loadAliases({ home, cwd });
    assert.equal(aliases.get('sess1'), 'cwd-name', 'cwd overrides home');
    assert.equal(aliases.get('sess2'), 'home-only', 'home-only key still present');
    assert.equal(aliases.get('sess3'), 'cwd-only', 'cwd-only key present');
    assert.equal(aliases.size, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadAliases: malformed JSON in either file → silent skip (load never throws)', async () => {
  const home = mkTmpHome();
  const cwd = mkTmpCwd();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(homeAliasPath(home), 'not valid {{{ json');
    writeFileSync(join(cwd, '.agentpulse-aliases.json'), '[also invalid');
    const aliases = await loadAliases({ home, cwd });
    assert.equal(aliases.size, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadAliases: ignores non-string aliases and empty-string keys', async () => {
  const home = mkTmpHome();
  const cwd = mkTmpCwd();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(
      homeAliasPath(home),
      JSON.stringify({
        version: 1,
        aliases: { sess1: 'valid', sess2: 42, '': 'no-key', sess3: '' },
      })
    );
    const aliases = await loadAliases({ home });
    assert.equal(aliases.get('sess1'), 'valid');
    assert.equal(aliases.has('sess2'), false, 'numeric value is rejected');
    assert.equal(aliases.has(''), false, 'empty key is rejected');
    assert.equal(aliases.has('sess3'), false, 'empty value is rejected');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: creates ~/.agentpulse/ dir and writes a new alias', async () => {
  const home = mkTmpHome();
  try {
    assert.equal(existsSync(join(home, '.agentpulse')), false);
    await setAlias('sess-new', 'CC1', { home });
    assert.equal(existsSync(join(home, '.agentpulse')), true);
    assert.equal(existsSync(homeAliasPath(home)), true);
    const file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.equal(file.version, 1);
    assert.equal(file.aliases['sess-new'], 'CC1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: updates an existing entry without clobbering others', async () => {
  const home = mkTmpHome();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(
      homeAliasPath(home),
      JSON.stringify({ version: 1, aliases: { a: 'AA', b: 'BB', c: 'CC' } })
    );
    await setAlias('b', 'BB-renamed', { home });
    const file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.deepEqual(file.aliases, { a: 'AA', b: 'BB-renamed', c: 'CC' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: empty / whitespace value deletes the entry', async () => {
  const home = mkTmpHome();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(
      homeAliasPath(home),
      JSON.stringify({ version: 1, aliases: { a: 'AA', b: 'BB' } })
    );

    // Empty string clears `a`.
    await setAlias('a', '', { home });
    let file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.equal(file.aliases.a, undefined);
    assert.equal(file.aliases.b, 'BB');

    // Whitespace-only also clears.
    await setAlias('b', '   ', { home });
    file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.equal(file.aliases.b, undefined);
    assert.deepEqual(file.aliases, {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: refuses to overwrite a malformed existing file', async () => {
  const home = mkTmpHome();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(homeAliasPath(home), 'definitely not json {');
    await assert.rejects(
      () => setAlias('sess', 'CC1', { home }),
      /not valid JSON/i,
      'setAlias should error rather than clobbering user-edited content'
    );
    // File contents are unchanged.
    assert.equal(readFileSync(homeAliasPath(home), 'utf8'), 'definitely not json {');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: trims whitespace around the alias before storing', async () => {
  const home = mkTmpHome();
  try {
    await setAlias('sess', '  CC1  ', { home });
    const file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.equal(file.aliases.sess, 'CC1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: empty sessionId throws (caller error)', async () => {
  const home = mkTmpHome();
  try {
    await assert.rejects(
      () => setAlias('', 'name', { home }),
      /sessionId is required/i
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: concurrent writes do not lose each other (v0.5.2)', async () => {
  // Pre-v0.5.2, two near-concurrent setAlias calls each read the
  // pre-existing file before the other's writeFile resolved — both saw
  // {} as the starting state, both wrote their own single-key file, and
  // the second silently wiped the first.
  //
  // With the per-path write queue, the second call awaits the first's
  // writeFile before starting its own readFile, so both entries survive.
  const home = mkTmpHome();
  try {
    // Fire 5 concurrent setAlias calls — exactly the failure mode the
    // pre-fix code couldn't handle.
    await Promise.all([
      setAlias('sess-a', 'AAA', { home }),
      setAlias('sess-b', 'BBB', { home }),
      setAlias('sess-c', 'CCC', { home }),
      setAlias('sess-d', 'DDD', { home }),
      setAlias('sess-e', 'EEE', { home }),
    ]);

    const file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.equal(file.aliases['sess-a'], 'AAA', 'first concurrent write survived');
    assert.equal(file.aliases['sess-b'], 'BBB');
    assert.equal(file.aliases['sess-c'], 'CCC');
    assert.equal(file.aliases['sess-d'], 'DDD');
    assert.equal(file.aliases['sess-e'], 'EEE');
    assert.equal(Object.keys(file.aliases).length, 5, 'all 5 entries present');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('setAlias: a failing write does not block the next caller (v0.5.2)', async () => {
  // The queue chains via `.catch(() => {}).then(op)` so a rejected
  // earlier op shouldn't poison subsequent calls. Verify by pointing
  // the first call at a malformed existing file (which will reject)
  // and confirming a follow-up call still succeeds.
  const home = mkTmpHome();
  try {
    mkdirSync(join(home, '.agentpulse'));
    writeFileSync(homeAliasPath(home), 'not valid {');

    // Fire failing call + good call back-to-back. The good call
    // overwrites the malformed file so it succeeds.
    const failing = setAlias('sess-x', 'XXX', { home });
    // Don't await `failing` — the chained call has to enqueue while
    // the first is in flight to exercise the queue's failure path.
    await assert.rejects(failing, /not valid JSON/i);

    // After a failing write resolves, the queue's cleanup runs and the
    // next call's mkdir+writeFile re-creates a valid file fresh.
    rmSync(homeAliasPath(home), { force: true });
    await setAlias('sess-y', 'YYY', { home });
    const file = JSON.parse(readFileSync(homeAliasPath(home), 'utf8'));
    assert.equal(file.aliases['sess-y'], 'YYY');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
