/**
 * Workstream B — multi-session pulse orchestrator.
 *
 * Tracks a Map<sessionId, SessionState> of agent sessions, runs `pulse()`
 * against each on a per-session timer (and on-demand via `refresh()`), and
 * fans state changes out to listeners (the TUI in Workstream C).
 *
 * Design notes:
 *  - No EventEmitter — a Set<Listener> keeps the dependency surface small
 *    and avoids EventEmitter's max-listener warnings when the TUI subscribes
 *    multiple components.
 *  - Per-session refresh coalescing: every state carries an `inFlight`
 *    promise. If `refresh()` is called while one is running, the second
 *    caller awaits the in-flight promise and returns — pulse() is invoked
 *    exactly once per overlapping batch. This shields us from a watcher
 *    that emits 5 'change' events in 100ms.
 *  - Per-session timers fire independently — no global tick — so a slow
 *    pulse on one session never blocks refreshes on another.
 */

import { pulse } from './index.js';
import { loadAliases } from './aliases.js';
import { applyHysteresis, initialHysteresis } from './hysteresis.js';
import type { HysteresisState } from './hysteresis.js';
import { evictParseCache, readWindowFromCache } from './parseCache.js';
import type {
  DiscoveredSession,
  OrchestratorEvent,
  OrchestratorOptions,
  PulseOrchestrator,
  PulseRecap,
  SessionState,
} from './types.js';

type Listener = (event: OrchestratorEvent) => void;

interface InternalState extends SessionState {
  /** Background refresh timer handle. */
  timer?: NodeJS.Timeout;
  /** In-flight refresh promise — used to coalesce concurrent refresh() calls. */
  inFlight?: Promise<void>;
  /** Set when a refresh arrives while one is already in flight. The current
   *  refresh's `.finally` notices this and re-fires immediately so the latest
   *  file state is read. v0.3.1: pre-fix, watcher events during an in-flight
   *  pulse piggybacked on the running pulse and got a stale recap — the
   *  dashboard could lag a full refresh cycle behind reality. */
  dirty?: boolean;
  /** v0.5.4: hysteresis state. The bucket surfaced on `recap.verdict.bucket`
   *  is the *damped* output of this state machine — a new bucket must be
   *  produced by 2 consecutive pulses before it replaces the prior one.
   *  Initialized lazily on the first successful pulse. */
  hysteresis?: HysteresisState;
}

const DEFAULT_WINDOW_MS = 20 * 60 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

export function createOrchestrator(
  opts: OrchestratorOptions = {}
): PulseOrchestrator {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const detectorsEnabled = opts.detectorsEnabled ?? true;
  const refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;

  const states = new Map<string, InternalState>();
  const listeners = new Set<Listener>();
  let stopped = false;

  function emit(event: OrchestratorEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Listener exceptions must not break the orchestrator loop.
        // We intentionally swallow — listeners that want to surface errors
        // should handle them themselves.
      }
    }
  }

  function publicState(s: InternalState): SessionState {
    // Shallow-clone so external consumers can't mutate our internal map
    // and never see our `timer` / `inFlight` internals.
    return {
      session: s.session,
      recap: s.recap,
      lastUpdated: s.lastUpdated,
      error: s.error,
      pending: s.pending,
      alias: s.alias,
    };
  }

  async function runPulse(state: InternalState): Promise<void> {
    state.pending = true;
    let recap: PulseRecap | null = null;
    let error: string | undefined;
    try {
      // v0.6.0: incremental transcript read. Pre-fix, pulse() called
      // parseTranscriptDir which re-read the whole transcript file
      // every refresh. With parseCache, we read only new bytes since
      // the previous pulse and reuse cached events for older lines.
      // For a 2-hour session with a 10 MB transcript on a 30 s refresh
      // cadence, the per-pulse I/O drops to whatever the agent appended
      // in the last 30 s — typically a few KB.
      //
      // Window math is identical to what pulse() would compute (endAt
      // = Date.now(), startAt = endAt - windowMs), so the events the
      // cache filters to are exactly what pulse()'s internal filter
      // would have produced.
      const endAt = Date.now();
      const startAt = endAt - windowMs;
      const events = await readWindowFromCache(
        state.session.transcriptPath,
        startAt,
        endAt,
        { silent: true }
      );
      recap = await pulse({
        transcriptDir: state.session.transcriptPath,
        windowMs,
        endAt, // explicit so pulse uses the same endAt the cache filtered against
        detectorsEnabled,
        // v0.3.1: each session's cwd (extracted from its first transcript
        // line at discovery time) becomes the repoRoot for drift detection.
        // A Write outside the session's own working directory is real drift,
        // not just writes to `/tmp/` or `~/`.
        repoRoot: state.session.cwd,
        // v0.2.5: the orchestrator is used by the TUI; we must suppress
        // parser warnings here because console.warn writes interfere with
        // Ink's screen redraw and cause whole-window flicker on every
        // 30-second refresh tick.
        silent: true,
        // v0.6.0: pre-parsed events bypass pulse()'s parser entirely.
        events,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    // The session may have been removed (or the orchestrator stopped) while
    // pulse() was in flight. In that case, drop the result on the floor.
    if (stopped || !states.has(state.session.id)) return;

    if (error !== undefined) {
      state.error = error;
      // Leave prior recap in place — a transient read failure shouldn't
      // wipe the last good narrative.
    } else if (recap) {
      // v0.5.4: hysteresis. The classifier's bucket goes through a small
      // state machine that requires 2 consecutive pulses agreeing on a
      // new bucket before flipping. Pre-v0.5.4 a borderline session
      // (signals sitting near a rule threshold) could bounce between
      // buckets every refresh; the TUI pill and the notifier both
      // double-fired off that flicker. Now only the latest pulse's
      // bucket is exposed when it confirms what we already saw.
      //
      // We damp the bucket on `recap.verdict.bucket` and, when we override
      // it, the confidence with it. Narrative, signals, and drifts stay
      // tied to the latest pulse — so the user still sees "tests just
      // started failing" in the narrative on the very next refresh even
      // when the pill colour takes one more cycle to follow. The narrative
      // is the truth; the pill is the consensus.
      //
      // Confidence is part of the pill, not the narrative, so it must track
      // the bucket we actually show. Leaving the raw pulse's confidence in
      // place during an override would attach a number computed for
      // `rawBucket` to a pill showing `stableBucket` — e.g. a pill reading
      // "converging · 0.85" where the 0.85 was the classifier's certainty
      // about "stuck". We clamp to the min of what we last showed for the
      // stable bucket and the dissenting reading, so a contested window can
      // only lower our stated confidence, never inflate it.
      const rawBucket = recap.verdict.bucket;
      if (!state.hysteresis) {
        // First successful pulse — initialize. No dampening on entry.
        state.hysteresis = initialHysteresis(rawBucket);
      } else {
        const step = applyHysteresis(state.hysteresis, rawBucket);
        state.hysteresis = step.state;
        if (step.stableBucket !== rawBucket) {
          // Surface the damped bucket + damped confidence. Construct a NEW
          // verdict object so the original (unmodified) recap stays
          // available to any caller that might want it later. `state.recap`
          // still holds the PRIOR recap here (we overwrite it below), so its
          // confidence is what we last showed for the stable bucket.
          const priorConfidence =
            state.recap?.verdict.confidence ?? recap.verdict.confidence;
          recap = {
            ...recap,
            verdict: {
              ...recap.verdict,
              bucket: step.stableBucket,
              confidence: Math.min(priorConfidence, recap.verdict.confidence),
            },
          };
        }
      }

      state.recap = recap;
      state.error = undefined;
      state.lastUpdated = Date.now();
    }

    // v0.4.7: refresh the alias from the home + cwd files each pulse.
    // Cheap (small JSON read), and means a `n`-key rename or an external
    // edit to either file lands on the dashboard within one refresh tick.
    // Read failures are silent — alias is a niceties layer, not required.
    try {
      const aliases = await loadAliases({ cwd: state.session.cwd });
      state.alias = aliases.get(state.session.id);
    } catch {
      state.alias = undefined;
    }

    state.pending = false;
    emit({ type: 'session-updated', state: publicState(state) });
  }

  function refreshInternal(id: string): Promise<void> {
    const state = states.get(id);
    if (!state) return Promise.resolve();

    // v0.3.1: "running + dirty" coalesce. Pre-fix, a refresh arriving during
    // an in-flight pulse piggybacked on the running promise and got the recap
    // for the FILE STATE FROM BEFORE THE CHANGE. On actively-written
    // transcripts, that meant the dashboard could lag a full refresh cycle
    // (30s) behind reality. Now: if a refresh arrives mid-pulse, we mark the
    // state dirty; the in-flight pulse's `.finally` notices `dirty` and
    // immediately fires another. Watcher floods still collapse to ~2 pulses
    // max per overlapping batch (the original + the re-fire), but we never
    // lose a file change.
    if (state.inFlight) {
      state.dirty = true;
      return state.inFlight;
    }

    const promise = runPulse(state).finally(() => {
      state.inFlight = undefined;
      if (state.dirty && !stopped && states.has(state.session.id)) {
        state.dirty = false;
        // Re-fire to pick up changes that arrived during the previous pulse.
        // Fire-and-forget; if it errors, runPulse captures into state.error.
        void refreshInternal(id);
      }
    });
    state.inFlight = promise;
    return promise;
  }

  function scheduleTimer(state: InternalState): void {
    if (stopped) return;
    state.timer = setTimeout(function tick() {
      if (stopped || !states.has(state.session.id)) return;
      // Fire-and-forget — runPulse handles its own errors. We re-arm the
      // timer after the pulse settles so we don't stack overlapping ticks
      // on a slow session.
      void refreshInternal(state.session.id).finally(() => {
        if (stopped || !states.has(state.session.id)) return;
        scheduleTimer(state);
      });
    }, refreshIntervalMs);
    // Don't keep the event loop alive on the orchestrator's account — the
    // TUI is what should hold the process open.
    state.timer.unref?.();
  }

  function add(session: DiscoveredSession): void {
    if (stopped) return;
    if (states.has(session.id)) {
      // Idempotent re-add — refresh the session record (e.g. updated mtime)
      // and kick a refresh, but don't double-schedule timers.
      const existing = states.get(session.id)!;
      existing.session = session;
      void refreshInternal(session.id);
      return;
    }

    const state: InternalState = {
      session,
      recap: null,
      lastUpdated: 0,
      pending: true,
    };
    states.set(session.id, state);
    emit({ type: 'session-added', state: publicState(state) });

    // Initial pulse + start the background timer. Fire-and-forget; consumers
    // wait on 'session-updated' or call refresh() directly.
    void refreshInternal(session.id);
    scheduleTimer(state);
  }

  function remove(sessionId: string): void {
    const state = states.get(sessionId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    // v0.6.0: drop the parseCache entry too. The session is gone — any
    // future re-discovery of the same path (e.g. transcript replaced)
    // must start with a clean cache so file-rotation detection logic
    // isn't tripped up by stale offset state.
    evictParseCache(state.session.transcriptPath);
    states.delete(sessionId);
    emit({ type: 'session-removed', sessionId });
  }

  async function refresh(sessionId: string): Promise<void> {
    await refreshInternal(sessionId);
  }

  function statesSnapshot(): SessionState[] {
    return Array.from(states.values(), publicState);
  }

  function on(listener: Listener): void {
    listeners.add(listener);
  }

  function off(listener: Listener): void {
    listeners.delete(listener);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const state of states.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
    states.clear();
    listeners.clear();
  }

  return {
    add,
    remove,
    refresh,
    states: statesSnapshot,
    on,
    off,
    stop,
  };
}
