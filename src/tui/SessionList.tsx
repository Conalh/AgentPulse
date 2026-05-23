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
  return tail.replace(/\.jsonl$/i, '');
}

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

        return (
          <Box key={s.session.id} flexDirection="row">
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            <Text color={pillColor}>{pill}</Text>
            <Text>{'  '}</Text>
            <Box width={32}>
              <Text bold={isSelected}>
                {truncate(label, 22)}
              </Text>
              <Text dimColor> ({s.session.runtime})</Text>
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
