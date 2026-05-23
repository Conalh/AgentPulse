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
    };
  }

  async function runPulse(state: InternalState): Promise<void> {
    state.pending = true;
    let recap: PulseRecap | null = null;
    let error: string | undefined;
    try {
      recap = await pulse({
        transcriptDir: state.session.transcriptPath,
        windowMs,
        detectorsEnabled,
        // v0.2.5: the orchestrator is used by the TUI; we must suppress
        // parser warnings here because console.warn writes interfere with
        // Ink's screen redraw and cause whole-window flicker on every
        // 30-second refresh tick.
        silent: true,
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
    } else {
      state.recap = recap;
      state.error = undefined;
      state.lastUpdated = Date.now();
    }
    state.pending = false;
    emit({ type: 'session-updated', state: publicState(state) });
  }

  function refreshInternal(id: string): Promise<void> {
    const state = states.get(id);
    if (!state) return Promise.resolve();

    // Coalesce: if a refresh is already running for this session, the new
    // caller piggybacks on the in-flight promise. This is the cleaner of
    // the two suggested patterns — it means watcher floods translate to
    // exactly one pulse() invocation per overlapping batch.
    if (state.inFlight) return state.inFlight;

    const promise = runPulse(state).finally(() => {
      state.inFlight = undefined;
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
