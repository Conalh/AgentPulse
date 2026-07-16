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
import { createNotifier } from '../notifications.js';
import {
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_STALE_MS,
  DEFAULT_WINDOW_MS,
} from '../defaults.js';
import type {
  DiscoveredSession,
  LiveOptions,
  OrchestratorEvent,
  SessionEvent,
  TrajectoryBucket,
} from '../types.js';
import { App } from './App.js';

export async function runLiveTui(opts: LiveOptions = {}): Promise<void> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const detectorsEnabled = opts.detectorsEnabled ?? true;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const discoveryRoots = opts.discoveryRoots;
  const hideIdle = opts.hideIdle ?? false;
  const maxSessions = opts.maxSessions ?? 10;
  const showSubagents = opts.showSubagents ?? false;
  // #F6: optional discovery bounds, applied to both the initial probe and
  // the live watcher so a broad --roots doesn't trigger an unbounded walk.
  const maxDepth = opts.maxDepth;
  const excludeDirs = opts.excludeDirs;

  // Discovery is a one-shot probe; the watcher takes over for live updates.
  const initial = await discoverSessions({
    roots: discoveryRoots,
    staleMs,
    maxDepth,
    excludeDirs,
  });

  const orchestrator = createOrchestrator({
    windowMs,
    refreshIntervalMs,
    detectorsEnabled,
  });

  // v0.4.2: local notifications on state transitions into drifting/stuck.
  // Default `'none'` — opt-in via --notify. The notifier is a separate
  // listener on the orchestrator so it never interferes with the TUI's own
  // render-driven listener. We track previous buckets per session so we can
  // pass `from` to the trigger policy.
  const notifier = createNotifier({ mode: opts.notify ?? 'none' });
  const previousBuckets = new Map<string, TrajectoryBucket | null>();
  const notifyListener = (event: OrchestratorEvent): void => {
    if (event.type === 'session-updated') {
      const sid = event.state.session.id;
      const next = event.state.recap?.verdict.bucket;
      if (next) {
        const prev = previousBuckets.get(sid) ?? null;
        // v0.5.2: prefer the user-set alias for the notification label so
        // an OS toast / bell-with-stderr-context reads as "CC1: drifting"
        // when the user has named their session, not "AgentPulse:
        // drifting". Falls back to the project name and finally to a
        // session-id stub so the label is never the bare literal
        // 'session'.
        const label =
          event.state.alias ??
          event.state.session.projectName ??
          `session-${sid.slice(0, 8)}`;
        notifier.onTransition(prev, next, label);
        previousBuckets.set(sid, next);
      }
    } else if (event.type === 'session-removed') {
      previousBuckets.delete(event.sessionId);
    }
  };
  orchestrator.on(notifyListener);

  const watcher = createSessionWatcher({
    discover: { roots: discoveryRoots, staleMs, maxDepth, excludeDirs },
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
      orchestrator.off(notifyListener);
    } catch {
      /* swallow */
    }
    try {
      notifier.stop();
    } catch {
      /* swallow */
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

  // v0.2.8: enter the terminal's *alternate screen buffer* before mounting
  // Ink. This is the same mode `htop`, `vim`, `less`, `k9s`, `lazygit`, and
  // `btop` use — the entire dashboard lives in a separate screen that
  // restores the previous terminal contents on exit. Without this, Ink's
  // in-place redraws relied on cursor-up + clear-line sequences, which on
  // some terminals (notably Windows cmd.exe) don't fully clear the previous
  // frame — every refresh appended a fresh dashboard below the previous
  // one, producing a cascading "ladder" of stacked renders.
  const ENTER_ALT_SCREEN = '\x1b[?1049h';
  const EXIT_ALT_SCREEN = '\x1b[?1049l';
  const HIDE_CURSOR = '\x1b[?25l';
  const SHOW_CURSOR = '\x1b[?25h';
  let inAltScreen = false;
  const enterAltScreen = (): void => {
    if (inAltScreen) return;
    process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    inAltScreen = true;
  };
  const exitAltScreen = (): void => {
    if (!inAltScreen) return;
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
    inAltScreen = false;
  };

  // Belt-and-braces: restore the terminal even on hard exits (uncaught
  // exception, process.exit), so the user never gets stuck in alt screen
  // with no way to recover except restarting their terminal.
  process.once('exit', () => {
    exitAltScreen();
  });

  // SIGINT/SIGTERM fall through to Ink's exit handler, which fires onExit
  // via the App's useInput Ctrl-C branch. We *also* register a fallback
  // for environments where Ink doesn't receive the keypress (e.g. piped
  // stdin), so the watcher/orchestrator still stop cleanly.
  const onSignal = (): void => {
    void shutdown().then(() => {
      exitAltScreen();
      process.exit(0);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  enterAltScreen();

  const { waitUntilExit, unmount } = render(
    React.createElement(App, {
      orchestrator,
      watcher,
      refreshIntervalMs,
      onExit,
      hideIdle,
      maxSessions,
      showSubagents,
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
    // Restore the user's pre-TUI terminal contents. The `process.once('exit')`
    // hook above catches hard exits; this one handles the normal q/Ctrl-C
    // path so the cursor reappears and prior terminal contents return BEFORE
    // the process actually exits (cleaner UX in some shells).
    exitAltScreen();
  }
}
