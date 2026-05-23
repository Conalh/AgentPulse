/**
 * Root Ink component for `agentpulse live`.
 *
 * Subscribes to the orchestrator + watcher and re-renders on every state
 * change. Owns selection cursor, help overlay, and the wall-clock tick used
 * for "Xs ago" labels.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type {
  OrchestratorEvent,
  PulseOrchestrator,
  SessionEvent,
  SessionState,
  SessionWatcher,
} from '../types.js';
import { SessionList } from './SessionList.js';
import { SessionDetail } from './SessionDetail.js';
import { formatDelta } from './duration.js';
import { Splash } from './Splash.js';

export interface AppProps {
  orchestrator: PulseOrchestrator;
  watcher: SessionWatcher;
  refreshIntervalMs: number;
  onExit: () => void;
  /** Hide sessions with zero tool invocations in the window. Default false
   *  (idle sessions stay visible, dimmed via low confidence). */
  hideIdle?: boolean;
  /** Cap the displayed list. 0 disables the cap. Default unbounded when
   *  omitted (the CLI passes 10 by default). */
  maxSessions?: number;
  /** Show subagent transcripts (project names matching `agent-<hex>`).
   *  Default false — subagent sessions are ephemeral tooling artifacts and
   *  noise to the human watching their own work. */
  showSubagents?: boolean;
}

/** Subagent-shaped project names — Claude Code stores transcripts of agents
 *  spawned via the SDK under names like `agent-a92e01b8034a7c780`. These
 *  are tooling artifacts, not human-facing sessions. */
const SUBAGENT_NAME_RE = /^agent-[0-9a-f]{8,}/i;

/**
 * v0.3.2: urgency ordering for the session list.
 *
 * The dashboard's at-a-glance read should put the things that need eyes at
 * the top. Drifting and stuck are warning-shaped; converging is "in flight,
 * keep an eye"; exploring is "low info"; idle and done are "parked / over".
 *
 * Sessions still pending their first pulse (recap === null) sit just below
 * the warning tier — they're new and worth seeing, but not as urgent as
 * confirmed drift.
 */
const URGENCY_RANK: Record<string, number> = {
  drifting: 0,
  stuck: 1,
  pending: 2, // synthetic — used when recap is null
  converging: 3,
  exploring: 4,
  idle: 5,
  done: 6,
};

function urgencyOf(s: SessionState): number {
  if (!s.recap) return URGENCY_RANK.pending!;
  return URGENCY_RANK[s.recap.verdict.bucket] ?? 7;
}

function compareByUrgency(a: SessionState, b: SessionState): number {
  const ua = urgencyOf(a);
  const ub = urgencyOf(b);
  if (ua !== ub) return ua - ub;
  // Tie-break: most-recently-updated within the same bucket sorts first.
  return b.lastUpdated - a.lastUpdated;
}

function isSubagentSession(s: SessionState): boolean {
  const name = s.session.projectName ?? '';
  if (SUBAGENT_NAME_RE.test(name)) return true;
  // Also catch the raw-tail fallback case where projectName was empty and the
  // file's basename UUID would trip the same pattern.
  const tail = s.session.transcriptPath.split(/[\\/]/).pop() ?? '';
  return SUBAGENT_NAME_RE.test(tail);
}

const HELP_LINES = [
  '↑/↓, k/j, or w/s   move selection',
  'r                  force refresh on selected session',
  '?                  toggle help',
  'q / Ctrl-C         quit',
];

export function App({
  orchestrator,
  watcher,
  refreshIntervalMs,
  onExit,
  hideIdle = false,
  maxSessions = 0,
  showSubagents = false,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [states, setStates] = useState<SessionState[]>(() => orchestrator.states());
  const [now, setNow] = useState<number>(() => Date.now());
  const [showHelp, setShowHelp] = useState<boolean>(false);
  // v0.2.9: debounce timestamp for the help-overlay toggle. See `?` handler.
  const lastHelpToggleRef = useRef<number>(0);
  // v0.3.0: brief startup splash. Flips to false after 900ms so the
  // dashboard renders in-place over the splash (alt-screen handles the
  // clear).
  const [showSplash, setShowSplash] = useState<boolean>(true);
  useEffect(() => {
    const id = setTimeout(() => setShowSplash(false), 900);
    return () => clearTimeout(id);
  }, []);

  // Filter + cap. Filtering by "active in window" is purely a render concern —
  // the orchestrator still tracks every session, so an idle one becoming
  // active pops in on the next refresh without needing to be re-added.
  // A session counts as idle when its recap is missing or shows zero tool
  // invocations in the window. Sessions still mid-first-pulse (recap === null)
  // are kept visible regardless of showIdle so the dashboard isn't blank on
  // startup.
  const visibleStates = useMemo(() => {
    let v = states;
    if (!showSubagents) {
      v = v.filter((s) => !isSubagentSession(s));
    }
    if (hideIdle) {
      v = v.filter((s) => {
        if (s.recap === null) return true; // first pulse pending — keep visible
        return s.recap.enriched.toolInvocationCount > 0;
      });
    }
    // v0.3.2: urgency sort. Pre-fix, the list was in discovery order
    // (which roughly maps to lastModified DESC). For a "mission control"
    // dashboard the user wants the things that need attention surfaced
    // at the top: drifting/stuck first, active work next, idle/done last.
    // Within a bucket, sort by lastUpdated DESC so the freshest entry in
    // each tier sits up top.
    v = [...v].sort(compareByUrgency);
    if (maxSessions > 0 && v.length > maxSessions) {
      v = v.slice(0, maxSessions);
    }
    return v;
  }, [states, hideIdle, maxSessions, showSubagents]);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const initial = orchestrator.states();
    return initial.length > 0 ? initial[0]!.session.id : null;
  });

  // v0.2.11: debounce orchestrator + watcher events into a single batched
  // setStates call. Pre-fix, sessions discovered or refreshed in rapid
  // succession each triggered an immediate re-render. Ink's diff calculation
  // can't always finish one frame before the next is queued, and on cmd.exe
  // the result was stacked dashboards with mismatched session counts visible
  // simultaneously. 100 ms collapses a burst of events into one render —
  // imperceptible delay to a human but cuts render-thrash entirely.
  useEffect(() => {
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      pendingTimer = null;
      setStates(orchestrator.states());
    };
    const handler = (_e: OrchestratorEvent): void => {
      if (pendingTimer) return; // already scheduled — coalesce
      pendingTimer = setTimeout(flush, 100);
    };
    orchestrator.on(handler);
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      orchestrator.off(handler);
    };
  }, [orchestrator]);

  // Watcher events are largely handled outside (the wiring lives in
  // runLiveTui), but we also listen here so the App can react to add/remove
  // for selection-fallback purposes. Same 100 ms debounce — multiple file
  // changes across sessions used to fire bursts of setStates.
  useEffect(() => {
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      pendingTimer = null;
      setStates(orchestrator.states());
    };
    const handler = (_e: SessionEvent): void => {
      if (pendingTimer) return;
      pendingTimer = setTimeout(flush, 100);
    };
    watcher.on(handler);
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      watcher.off(handler);
    };
  }, [watcher, orchestrator]);

  // Wall-clock tick — drives the "Xs ago" labels and the refresh countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the selected session disappears from the visible list, fall back to
  // the first visible one. (When the user toggles showIdle off, their previous
  // selection may now be hidden.)
  useEffect(() => {
    if (visibleStates.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const stillThere = visibleStates.some((s) => s.session.id === selectedId);
    if (!stillThere) setSelectedId(visibleStates[0]!.session.id);
  }, [visibleStates, selectedId]);

  // Keyboard input. Navigation operates over `visibleStates` so hidden idle
  // sessions don't appear in the up/down cycle.
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      onExit();
      exit();
      return;
    }
    if (input === '?') {
      // v0.2.9: debounce. Rapid `?`-spam was causing the help overlay to
      // toggle faster than Ink could complete a render, producing stacked
      // dashboards (the overlay add/remove changes the screen height; if a
      // press lands mid-render, the next render diff can leak the previous
      // frame). 200 ms is invisible to a human pressing once but throttles
      // a held key down to single transitions.
      const now = Date.now();
      if (now - lastHelpToggleRef.current >= 200) {
        lastHelpToggleRef.current = now;
        setShowHelp((v) => !v);
      }
      return;
    }
    if (visibleStates.length === 0) return;

    const idx = Math.max(
      0,
      visibleStates.findIndex((s) => s.session.id === selectedId)
    );

    // Up: arrow / vim-k / WASD-w. Shifted variants honored so users with
    // sticky shift / caps lock aren't surprised.
    if (key.upArrow || input === 'k' || input === 'w' || input === 'W') {
      const next = Math.max(0, idx - 1);
      setSelectedId(visibleStates[next]!.session.id);
      return;
    }
    if (key.downArrow || input === 'j' || input === 's' || input === 'S') {
      const next = Math.min(visibleStates.length - 1, idx + 1);
      setSelectedId(visibleStates[next]!.session.id);
      return;
    }
    if (input === 'r' && selectedId) {
      // Fire-and-forget; orchestrator emits 'session-updated' on completion.
      void orchestrator.refresh(selectedId).catch(() => {
        /* surfaced via SessionState.error */
      });
      return;
    }
  });

  const selectedState = useMemo(
    () => visibleStates.find((s) => s.session.id === selectedId) ?? null,
    [visibleStates, selectedId]
  );

  // Header shows total tracked sessions + how many are visible after filter,
  // so the user knows hidden sessions exist when the count diverges.
  const totalLabel =
    visibleStates.length === states.length
      ? `${states.length} session${states.length === 1 ? '' : 's'}`
      : `${visibleStates.length}/${states.length} sessions`;
  const headerRight = `${totalLabel}, refresh ${formatDelta(refreshIntervalMs)}`;

  // v0.3.0: splash for the first ~900ms. Returns before any of the dashboard
  // chrome so the splash is centered in the alt-screen frame.
  if (showSplash) {
    return <Splash />;
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold>AgentPulse</Text>
          <Text dimColor> · by </Text>
          <Text bold color="red">
            RAGE
          </Text>
        </Box>
        <Text dimColor>{headerRight}</Text>
      </Box>

      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <SessionList states={visibleStates} selectedId={selectedId} now={now} />
      </Box>

      <Box borderStyle="round" flexDirection="column">
        <SessionDetail
          state={selectedState}
          now={now}
          refreshIntervalMs={refreshIntervalMs}
        />
      </Box>

      {showHelp && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
          <Text bold>Keys</Text>
          {HELP_LINES.map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </Box>
      )}

      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>↑↓ / WS select · r refresh · ? help · q quit</Text>
        <Text dimColor>
          ▲<Text color="red" bold>RAGE</Text>
        </Text>
      </Box>
    </Box>
  );
}
