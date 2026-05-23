/**
 * Left pane — scrollable list of all known sessions with verdict pills.
 *
 * Stateless. The parent owns selection + state; we render what's given.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionState } from '../types.js';
import { colorFor, isLowConfidence, pillFor } from './theme.js';
import { formatAgo } from './duration.js';

export interface SessionListProps {
  states: SessionState[];
  selectedId: string | null;
  now: number;
}

function fallbackLabel(state: SessionState): string {
  const sess = state.session;
  if (sess.projectName && sess.projectName.length > 0) return sess.projectName;
  // Best-effort: last path segment minus extension.
  const parts = sess.transcriptPath.split(/[\\/]/);
  const tail = parts[parts.length - 1] ?? sess.id;
  const cleaned = tail.replace(/\.jsonl$/i, '');
  // v0.2.3 last-ditch: if we still have nothing meaningful (UUID-shaped
  // tail), use the short session id with a "session-" prefix so the user
  // sees something stable and recognizable instead of raw hex.
  if (/^[0-9a-f-]+$/i.test(cleaned) && cleaned.length > 6) {
    return `session-${sess.id.slice(0, 8)}`;
  }
  return cleaned;
}

/** Column width budget for the label+runtime column. Keep stable so timestamp
 *  ticks don't cause wrap-shift flicker. */
const LABEL_COL_WIDTH = 38;

export function SessionList({ states, selectedId, now }: SessionListProps): React.ReactElement {
  if (states.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No sessions detected yet…</Text>
        <Text dimColor>(transcripts must have been updated in the staleMs window)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {states.map((s) => {
        const isSelected = s.session.id === selectedId;
        const bucket = s.recap?.verdict.bucket;
        const confidence = s.recap?.verdict.confidence ?? 0;
        const driftCount = s.recap?.verdict.drifts.length ?? 0;
        const label = fallbackLabel(s);
        const pill = bucket ? pillFor(bucket) : '·';
        const pillColor = bucket ? colorFor(bucket) : 'gray';
        const dimBucket = bucket ? isLowConfidence(confidence) : true;
        const bucketLabel = bucket
          ? bucket === 'drifting' && driftCount > 0
            ? `${bucket} (${driftCount})`
            : bucket
          : s.pending
            ? 'pending…'
            : s.error
              ? 'error'
              : '—';
        const updatedLabel = s.lastUpdated > 0
          ? `updated ${formatAgo(now, s.lastUpdated)}`
          : 'no recap yet';

        // v0.2.3: compute the label truncation budget from the runtime
        // suffix length so the combined column never exceeds LABEL_COL_WIDTH.
        // Pre-fix, a long slug like `agent-a92e01b8034a7c780-7...` truncated
        // to 22 chars + ` (claude-code)` overflowed the 32-char box and
        // wrapped to two lines, causing layout flicker on every timer tick.
        const runtimeSuffix = ` (${s.session.runtime})`;
        const labelBudget = Math.max(8, LABEL_COL_WIDTH - runtimeSuffix.length - 1);
        const truncatedLabel = truncate(label, labelBudget);

        return (
          <Box key={s.session.id} flexDirection="row">
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            <Text color={pillColor}>{pill}</Text>
            <Text>{'  '}</Text>
            <Box width={LABEL_COL_WIDTH}>
              <Text bold={isSelected}>{truncatedLabel}</Text>
              <Text dimColor>{runtimeSuffix}</Text>
            </Box>
            <Box width={22}>
              <Text color={bucket ? colorFor(bucket) : undefined} dimColor={dimBucket}>
                {bucketLabel}
              </Text>
            </Box>
            <Text dimColor>{updatedLabel}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
