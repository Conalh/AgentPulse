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
}

const HELP_LINES = [
  '↑/↓ or k/j   move selection',
  'r            force refresh on selected session',
  '?            toggle help',
  'q / Ctrl-C   quit',
];

export function App({ orchestrator, watcher, refreshIntervalMs, onExit }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [states, setStates] = useState<SessionState[]>(() => orchestrator.states());
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const initial = orchestrator.states();
    return initial.length > 0 ? initial[0]!.session.id : null;
  });
  const [now, setNow] = useState<number>(() => Date.now());
  const [showHelp, setShowHelp] = useState<boolean>(false);

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

  // If the selected session disappears, fall back to the first.
  useEffect(() => {
    if (states.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const stillThere = states.some((s) => s.session.id === selectedId);
    if (!stillThere) setSelectedId(states[0]!.session.id);
  }, [states, selectedId]);

  // Keyboard input.
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
    if (states.length === 0) return;

    const idx = Math.max(
      0,
      states.findIndex((s) => s.session.id === selectedId)
    );

    if (key.upArrow || input === 'k') {
      const next = Math.max(0, idx - 1);
      setSelectedId(states[next]!.session.id);
      return;
    }
    if (key.downArrow || input === 'j') {
      const next = Math.min(states.length - 1, idx + 1);
      setSelectedId(states[next]!.session.id);
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
    () => states.find((s) => s.session.id === selectedId) ?? null,
    [states, selectedId]
  );

  const headerRight = `${states.length} session${states.length === 1 ? '' : 's'}, refresh ${formatDelta(refreshIntervalMs)}`;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold>AgentPulse</Text>
        <Text dimColor>{headerRight}</Text>
      </Box>

      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <SessionList states={states} selectedId={selectedId} now={now} />
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
