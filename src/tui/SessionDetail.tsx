/**
 * Right pane — detail of the currently-selected session.
 *
 * Shows header, transcript path, narrative, verdict pill, signals, and the
 * refresh-clock footer. Stateless — the parent passes a SessionState.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionState } from '../types.js';
import { colorFor, isLowConfidence, pillFor } from './theme.js';
import { formatAgo, formatDelta } from './duration.js';

export interface SessionDetailProps {
  state: SessionState | null;
  now: number;
  refreshIntervalMs: number;
}

export function SessionDetail({
  state,
  now,
  refreshIntervalMs,
}: SessionDetailProps): React.ReactElement {
  if (!state) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No session selected.</Text>
      </Box>
    );
  }

  const sess = state.session;
  const recap = state.recap;
  const projectLabel = sess.projectName ?? sess.id;
  const verdict = recap?.verdict;
  const bucket = verdict?.bucket;
  const confidence = verdict?.confidence ?? 0;
  const dimBucket = !!bucket && isLowConfidence(confidence);
  const narrative = recap?.narrative ?? (state.pending ? 'Computing first recap…' : 'Waiting for first refresh.');

  // Footer timing.
  const lastRefreshLabel = state.lastUpdated > 0
    ? formatAgo(now, state.lastUpdated)
    : 'never';
  const nextRefreshMs = state.lastUpdated > 0
    ? Math.max(0, state.lastUpdated + refreshIntervalMs - now)
    : refreshIntervalMs;
  const nextRefreshLabel = `~${formatDelta(nextRefreshMs)}`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{projectLabel}</Text>
        <Text dimColor> ({sess.runtime})</Text>
      </Box>
      <Text dimColor>{sess.transcriptPath}</Text>
      <Box marginTop={1} flexDirection="column">
        {narrative.split('\n').map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text>Verdict: </Text>
        {bucket ? (
          <>
            <Text color={colorFor(bucket)}>{pillFor(bucket)} </Text>
            <Text color={colorFor(bucket)} dimColor={dimBucket}>
              {bucket}
            </Text>
            <Text dimColor> (confidence {confidence.toFixed(2)})</Text>
          </>
        ) : (
          <Text dimColor>pending</Text>
        )}
      </Box>

      {verdict && verdict.signals.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Signals:</Text>
          {verdict.signals.map((sig, i) => (
            <Text key={i}> · {sig}</Text>
          ))}
        </Box>
      )}

      {verdict && verdict.drifts.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">Drift findings:</Text>
          {verdict.drifts.map((d, i) => (
            <Text key={i} color="red">
              {' '}⚠ {d.kind}: {d.message}
            </Text>
          ))}
        </Box>
      )}

      {state.error && (
        <Box marginTop={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Last refresh: {lastRefreshLabel} · next refresh: {nextRefreshLabel}
          {state.pending ? ' · refreshing…' : ''}
        </Text>
      </Box>
    </Box>
  );
}
