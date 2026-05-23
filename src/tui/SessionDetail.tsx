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
import { sparkline } from './sparkline.js';

/**
 * v0.3.3: pinned sparkline width. Kept as a constant so the cell-Box and
 * the sparkline helper agree on a single source of truth — drift between
 * them is what caused the activity row to "jerk" on every refresh.
 */
const SPARKLINE_WIDTH = 24;

/**
 * v0.3.1: Render a single narrative line, parsing `**bold**` Markdown spans
 * into Ink `<Text bold>` nodes. Pre-fix, the narrative templates use `**`
 * for emphasis (which is the right source format for plain-text consumers),
 * but the TUI rendered those literal asterisks — so a user saw
 * `Your agent has been working on **your code**` instead of bolded `your code`.
 * No external markdown lib; inline parser handles the one syntax we use.
 */
function MdLine({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const openIdx = text.indexOf('**', i);
    if (openIdx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (openIdx > i) parts.push(text.slice(i, openIdx));
    const closeIdx = text.indexOf('**', openIdx + 2);
    if (closeIdx < 0) {
      // Unclosed `**` — treat remainder as plain text rather than throw.
      parts.push(text.slice(openIdx));
      break;
    }
    parts.push(
      <Text key={key++} bold>
        {text.slice(openIdx + 2, closeIdx)}
      </Text>
    );
    i = closeIdx + 2;
  }
  return <Text>{parts}</Text>;
}

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
          <MdLine key={i} text={line} />
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

      {/* v0.3.3: ALWAYS render the activity row once a recap exists, even
          when no events fell into any bucket — pre-fix, the row appeared
          and disappeared based on `events.length > 0` and the sparkline
          string itself could be empty when all events were out-of-window,
          both of which caused the surrounding text to shimmer (the "jerk
          around" you screenshotted). The sparkline now always returns a
          string of exactly SPARKLINE_WIDTH characters (spaces when empty)
          and lives inside a Box of pinned width, so the trailing event-
          count text holds its column. */}
      {recap && (
        <Box marginTop={1}>
          <Text dimColor>Activity: </Text>
          <Box width={SPARKLINE_WIDTH}>
            <Text color={bucket ? colorFor(bucket) : 'cyan'}>
              {sparkline(
                recap.enriched.events.map((e) => e.timestamp),
                recap.enriched.windowStart,
                recap.enriched.windowEnd,
                {
                  width: SPARKLINE_WIDTH,
                  emptyFallback: ' '.repeat(SPARKLINE_WIDTH),
                }
              )}
            </Text>
          </Box>
          <Text dimColor>
            {' '}({recap.enriched.events.length} event{recap.enriched.events.length === 1 ? '' : 's'} over{' '}
            {formatDelta(recap.enriched.windowEnd - recap.enriched.windowStart)})
          </Text>
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
