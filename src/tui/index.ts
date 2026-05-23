/**
 * `agentpulse live` — Ink TUI entry point.
 *
 * Wires the session watcher (Workstream A) to the pulse orchestrator
 * (Workstream B) and mounts the React/Ink app. Handles graceful shutdown
 * on Ctrl-C / 'q'.
 */

import React from 'react';
import { render } from 'ink';
import { discoverSessions, createSessionWatcher } from '../sessions/index.js';
import { createOrchestrator } from '../orchestrator.js';
import type {
  DiscoveredSession,
  LiveOptions,
  SessionEvent,
} from '../types.js';
import { App } from './App.js';

export async function runLiveTui(opts: LiveOptions = {}): Promise<void> {
  const windowMs = opts.windowMs ?? 20 * 60_000;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 30_000;
  const detectorsEnabled = opts.detectorsEnabled ?? true;
  // v0.2.1: 1h default (was 24h). 24h surfaced too many idle transcripts.
  const staleMs = opts.staleMs ?? 1 * 3_600_000;
  const discoveryRoots = opts.discoveryRoots;
  const hideIdle = opts.hideIdle ?? false;
  const maxSessions = opts.maxSessions ?? 10;

  // Discovery is a one-shot probe; the watcher takes over for live updates.
  const initial = await discoverSessions({
    roots: discoveryRoots,
    staleMs,
  });

  const orchestrator = createOrchestrator({
    windowMs,
    refreshIntervalMs,
    detectorsEnabled,
  });

  const watcher = createSessionWatcher({
    discover: { roots: discoveryRoots, staleMs },
  });

  // Wire watcher → orchestrator. The watcher emits add/change/remove; the
  // orchestrator owns the state map. We *do* listen here even though the
  // App component listens to the watcher too — the orchestrator wiring is
  // a side-effect, not a render concern.
  const known = new Set<string>();
  const wireSession = (s: DiscoveredSession): void => {
    if (known.has(s.id)) return;
    known.add(s.id);
    orchestrator.add(s);
  };

  for (const s of initial) wireSession(s);

  const onWatcherEvent = (event: SessionEvent): void => {
    if (event.type === 'add') {
      wireSession(event.session);
    } else if (event.type === 'change') {
      wireSession(event.session);
      // Force an immediate refresh on file change. Failures land on the
      // SessionState.error field.
      void orchestrator.refresh(event.session.id).catch(() => {});
    } else if (event.type === 'remove') {
      known.delete(event.sessionId);
      orchestrator.remove(event.sessionId);
    }
  };
  watcher.on(onWatcherEvent);

  await watcher.start();

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    watcher.off(onWatcherEvent);
    try {
      await watcher.stop();
    } catch {
      /* swallow — best-effort shutdown */
    }
    try {
      orchestrator.stop();
    } catch {
      /* swallow */
    }
  };

  const onExit = (): void => {
    void shutdown();
  };

  // SIGINT/SIGTERM fall through to Ink's exit handler, which fires onExit
  // via the App's useInput Ctrl-C branch. We *also* register a fallback
  // for environments where Ink doesn't receive the keypress (e.g. piped
  // stdin), so the watcher/orchestrator still stop cleanly.
  const onSignal = (): void => {
    void shutdown().then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const { waitUntilExit, unmount } = render(
    React.createElement(App, {
      orchestrator,
      watcher,
      refreshIntervalMs,
      onExit,
      hideIdle,
      maxSessions,
    })
  );

  try {
    await waitUntilExit();
  } finally {
    await shutdown();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // Ink's render returns an unmount handle; call it idempotently to be safe.
    try {
      unmount();
    } catch {
      /* already unmounted */
    }
  }
}
