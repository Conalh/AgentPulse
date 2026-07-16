# Live Session Staleness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep AgentPulse's live session set continuously bounded by `staleMs` and display actual transcript activity time in the session list.

**Architecture:** The session watcher owns live-set membership. It will reject stale probe results and maintain one deadline timer that evicts known sessions as they age out on every platform; the TUI will render the already-available `session.lastModified` separately from recap refresh state.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Node test runner, React 19, Ink 7.

## Global Constraints

- `staleMs: Infinity` disables all staleness filtering and expiration.
- Expired transcripts are never deleted or modified.
- No CLI flags, public types, dependencies, parser behavior, classifier behavior, or default timing values change.
- A fresh write to an expired transcript makes it eligible for discovery again.

---

### Task 1: Enforce staleness throughout the watcher lifecycle

**Files:**
- Modify: `test/sessions.test.mjs`
- Modify: `src/sessions/watcher.ts`

**Interfaces:**
- Consumes: `DiscoverOptions.staleMs`, `DiscoveredSession.lastModified`, and existing watcher `add`/`remove` events.
- Produces: unchanged `SessionWatcher` public interface with continuously fresh `snapshot()` membership.

- [ ] **Step 1: Add failing polling and expiration regression tests**

Add tests that use a missing root to force the cross-platform polling fallback, backdate a transcript before its first poll, and assert that no `add` occurs. Add a second test that seeds a fresh transcript with a short `staleMs`, waits for `remove` without a filesystem event, updates the file, and asserts that polling adds it again.

```js
test('watcher polling ignores transcripts older than staleMs', async () => {
  const root = mkTmp();
  const claudeRoot = join(root, 'later', '.claude', 'projects');
  const watcher = createSessionWatcher({
    discover: { roots: [claudeRoot], staleMs: 100 },
    debounceMs: 20,
    pollIntervalMs: 50,
  });
  const events = [];
  watcher.on((event) => events.push(event));
  try {
    await watcher.start();
    mkdirSync(claudeRoot, { recursive: true });
    const transcript = join(claudeRoot, 'old.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(transcript, old, old);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(events.some((event) => event.type === 'add'), false);
    assert.deepEqual(watcher.snapshot(), []);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('watcher removes sessions at staleMs and re-adds them after new activity', async () => {
  const root = mkTmp();
  const claudeRoot = join(root, 'later', '.claude', 'projects');
  const watcher = createSessionWatcher({
    discover: { roots: [claudeRoot], staleMs: 200 },
    debounceMs: 20,
    pollIntervalMs: 50,
  });
  const events = [];
  watcher.on((event) => events.push(event));
  try {
    await watcher.start();
    mkdirSync(claudeRoot, { recursive: true });
    const transcript = join(claudeRoot, 'active.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n');

    assert.equal(await waitFor(() => events.some((event) => event.type === 'add')), true);
    assert.equal(await waitFor(() => events.some((event) => event.type === 'remove')), true);
    assert.deepEqual(watcher.snapshot(), []);

    const now = Date.now() / 1000;
    utimesSync(transcript, now, now);
    assert.equal(
      await waitFor(() => events.filter((event) => event.type === 'add').length === 2),
      true,
    );
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
```

- [ ] **Step 2: Run the watcher tests and verify the new tests fail**

Run: `npm run build && node --test test/sessions.test.mjs`

Expected: the old polling transcript emits `add`, and the fresh session does not emit `remove` merely because time passes.

- [ ] **Step 3: Implement a shared freshness gate and deadline timer**

In `src/sessions/watcher.ts`, import `DEFAULT_STALE_MS`, resolve the effective cutoff once, and add internal helpers with no public API changes:

```ts
import { DEFAULT_STALE_MS } from '../defaults.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

const staleMs = discoverOpts.staleMs ?? DEFAULT_STALE_MS;
let staleTimer: NodeJS.Timeout | undefined;

function isStale(lastModified: number, now = Date.now()): boolean {
  return staleMs !== Infinity && lastModified < now - staleMs;
}

function forget(absPath: string, session: DiscoveredSession): void {
  known.delete(absPath);
  sizes.delete(absPath);
  emit({ type: 'remove', sessionId: session.id });
}

function scheduleStaleExpiry(): void {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = undefined;
  if (stopping || staleMs === Infinity || known.size === 0) return;

  let earliestExpiry = Infinity;
  for (const session of known.values()) {
    earliestExpiry = Math.min(earliestExpiry, session.lastModified + staleMs);
  }
  const delay = Math.max(
    1,
    Math.min(MAX_TIMEOUT_MS, earliestExpiry - Date.now() + 1),
  );
  staleTimer = setTimeout(() => {
    staleTimer = undefined;
    const now = Date.now();
    for (const [absPath, session] of Array.from(known.entries())) {
      if (isStale(session.lastModified, now)) forget(absPath, session);
    }
    scheduleStaleExpiry();
  }, delay);
  staleTimer.unref?.();
}
```

Use `isStale(st.mtimeMs)` immediately after a successful stat in `probe()`. Ignore stale unknown files and forget stale known files. Call `scheduleStaleExpiry()` after membership or modification changes and after the initial seed. Clear `staleTimer` in `stopImpl()`.

- [ ] **Step 4: Run the watcher tests and verify they pass**

Run: `npm run build && node --test test/sessions.test.mjs`

Expected: all session discovery and watcher tests pass, including polling rejection, timed expiration, and reactivation.

- [ ] **Step 5: Commit the watcher behavior**

```powershell
git add -- src/sessions/watcher.ts test/sessions.test.mjs
git commit -m "fix: keep live sessions within stale cutoff"
```

### Task 2: Display transcript activity instead of recap refresh time

**Files:**
- Modify: `test/tui-components.test.mjs`
- Modify: `src/tui/SessionList.tsx`

**Interfaces:**
- Consumes: existing `SessionState.session.lastModified` and `SessionState.lastUpdated` fields.
- Produces: session-list copy `activity <age> ago`; the detail pane retains `Last refresh` from `lastUpdated`.

- [ ] **Step 1: Add a failing timestamp regression test**

```js
test('SessionList shows transcript activity time instead of recap refresh time', () => {
  const state = fixtureState({ id: 'a', projectName: 'MyApp', bucket: 'idle' });
  state.session.lastModified = Date.now() - 10 * 60_000;
  state.lastUpdated = Date.now() - 1_000;

  const { lastFrame } = render(
    createElement(SessionList, { states: [state], selectedId: 'a' })
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /activity 10 min ago/);
  assert.doesNotMatch(frame, /updated 1s ago/);
});
```

- [ ] **Step 2: Run the component tests and verify the new test fails**

Run: `npm run build && node --test test/tui-components.test.mjs`

Expected: FAIL because the current list renders `updated 1s ago` from `lastUpdated`.

- [ ] **Step 3: Render actual transcript activity**

Change the session-list timestamp cell and its comments to use:

```tsx
{s.session.lastModified > 0 ? (
  <TimeAgo timestamp={s.session.lastModified} prefix="activity " dim />
) : (
  <Text dimColor>activity unknown</Text>
)}
```

Do not change `SessionDetail`; its refresh clock is intentionally distinct.

- [ ] **Step 4: Run the component tests and verify they pass**

Run: `npm run build && node --test test/tui-components.test.mjs`

Expected: all TUI component tests pass and the new row shows transcript activity age.

- [ ] **Step 5: Commit the timestamp correction**

```powershell
git add -- src/tui/SessionList.tsx test/tui-components.test.mjs
git commit -m "fix: show transcript activity in session list"
```

### Task 3: Verify the complete fix

**Files:**
- Review: `src/sessions/watcher.ts`
- Review: `src/tui/SessionList.tsx`
- Review: `test/sessions.test.mjs`
- Review: `test/tui-components.test.mjs`

**Interfaces:**
- Consumes: the completed watcher and TUI changes.
- Produces: verified branch state ready for user handoff.

- [ ] **Step 1: Run formatting and whitespace validation**

Run: `git diff --check HEAD~2..HEAD`

Expected: no output and exit code 0.

- [ ] **Step 2: Run the full build and test suite**

Run: `npm test`

Expected: exit code 0 with zero failed tests.

- [ ] **Step 3: Review the final diff**

Run: `git diff HEAD~2..HEAD -- src/sessions/watcher.ts src/tui/SessionList.tsx test/sessions.test.mjs test/tui-components.test.mjs`

Check correctness at cutoff boundaries, timer cleanup, `Infinity`, reactivation, duplicate events, readability, security, and polling performance. Address any required finding with a failing test before changing production code.

- [ ] **Step 4: Verify repository state**

Run: `git status --short --branch && git log -3 --oneline`

Expected: clean `codey/fix-live-session-staleness` branch containing the design, watcher, and timestamp commits.
