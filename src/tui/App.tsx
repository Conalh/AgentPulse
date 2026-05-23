/**
 * Root Ink component for `agentpulse live`.
 *
 * Subscribes to the orchestrator + watcher and re-renders on every state
 * change. Owns selection cursor, help overlay, and the wall-clock tick used
 * for "Xs ago" labels.
 */

import React, { useEffect, useMemo, useState } from 'react';
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
}

const HELP_LINES = [
  '↑/↓ or k/j   move selection',
  'r            force refresh on selected session',
  '?            toggle help',
  'q / Ctrl-C   quit',
];

export function App({
  orchestrator,
  watcher,
  refreshIntervalMs,
  onExit,
  hideIdle = false,
  maxSessions = 0,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [states, setStates] = useState<SessionState[]>(() => orchestrator.states());
  const [now, setNow] = useState<number>(() => Date.now());
  const [showHelp, setShowHelp] = useState<boolean>(false);

  // Filter + cap. Filtering by "active in window" is purely a render concern —
  // the orchestrator still tracks every session, so an idle one becoming
  // active pops in on the next refresh without needing to be re-added.
  // A session counts as idle when its recap is missing or shows zero tool
  // invocations in the window. Sessions still mid-first-pulse (recap === null)
  // are kept visible regardless of showIdle so the dashboard isn't blank on
  // startup.
  const visibleStates = useMemo(() => {
    let v = states;
    if (hideIdle) {
      v = v.filter((s) => {
        if (s.recap === null) return true; // first pulse pending — keep visible
        return s.recap.enriched.toolInvocationCount > 0;
      });
    }
    if (maxSessions > 0 && v.length > maxSessions) {
      v = v.slice(0, maxSessions);
    }
    return v;
  }, [states, hideIdle, maxSessions]);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const initial = orchestrator.states();
    return initial.length > 0 ? initial[0]!.session.id : null;
  });

  // Subscribe to orchestrator updates.
  useEffect(() => {
    const handler = (_e: OrchestratorEvent): void => {
      setStates(orchestrator.states());
    };
    orchestrator.on(handler);
    return () => {
      orchestrator.off(handler);
    };
  }, [orchestrator]);

  // Watcher events are largely handled outside (the wiring lives in
  // runLiveTui), but we also listen here so the App can react to add/remove
  // for selection-fallback purposes.
  useEffect(() => {
    const handler = (_e: SessionEvent): void => {
      // The orchestrator listener already drives the redraw via the
      // session-added / session-removed event, but if the watcher fires
      // before the orchestrator settles we still want the snapshot to
      // include the new session.
      setStates(orchestrator.states());
    };
    watcher.on(handler);
    return () => {
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
      setShowHelp((v) => !v);
      return;
    }
    if (visibleStates.length === 0) return;

    const idx = Math.max(
      0,
      visibleStates.findIndex((s) => s.session.id === selectedId)
    );

    if (key.upArrow || input === 'k') {
      const next = Math.max(0, idx - 1);
      setSelectedId(visibleStates[next]!.session.id);
      return;
    }
    if (key.downArrow || input === 'j') {
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

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold>AgentPulse</Text>
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

      <Box paddingX={1}>
        <Text dimColor>↑↓ select · r refresh · ? help · q quit</Text>
      </Box>
    </Box>
  );
}
