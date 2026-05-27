/**
 * Left pane — scrollable list of all known sessions with verdict pills.
 *
 * Stateless. The parent owns selection + state; we render what's given.
 *
 * v0.5.3: dropped the `now` prop and use the self-clocking `<TimeAgo>`
 * cell for the "updated Xs ago" column. The pane re-renders only when
 * its session set or selection changes, not on every wall-clock tick.
 * Combined with the `React.memo` wrap exported below, this lets the
 * App's 1 s clock drive a tight subtree (just the TimeAgo cells)
 * instead of the entire dashboard.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionState } from '../types.js';
import { computeDisambigSuffixes } from '../labels.js';
import { colorFor, isLowConfidence, pillFor } from './theme.js';
import { TimeAgo } from './TimeAgo.js';

export interface SessionListProps {
  states: SessionState[];
  selectedId: string | null;
}

/**
 * v0.2.10: directories that commonly sit above a project root in a developer's
 * workspace. When the slug decoder gives up and falls back to a session ID, we
 * scan the recap's primary file paths for one of these — the segment *after*
 * the umbrella is the real project name.
 *
 * Example: primary file `C:\Dev\AgentPulse\src\tui\App.tsx` → find `Dev` at
 * index 1 → project name is parts[2] = `AgentPulse`.
 */
const UMBRELLA_DIRS: ReadonlySet<string> = new Set([
  'dev',
  'code',
  'projects',
  'project',
  'workspace',
  'work',
  'repos',
  'repo',
  'github',
  'gitlab',
  'src',     // sometimes the actual workspace root, e.g. `/src/myproject/`
  'sites',
  'apps',
]);

function inferProjectFromPaths(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    if (!path) continue;
    const norm = path.replace(/\\/g, '/').replace(/^\//, '').replace(/^[a-z]:\//i, '');
    const parts = norm.split('/').filter((p) => p.length > 0 && p !== '.');
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!.toLowerCase();
      if (UMBRELLA_DIRS.has(segment)) {
        const candidate = parts[i + 1];
        if (candidate && candidate.length > 0 && !/^[0-9a-f-]+$/i.test(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve the display label for a session — the same string the list
 * renders as the project name. Exported so the App-level sort comparator
 * can cluster rows by the same project key the user sees in the row.
 */
export function fallbackLabel(state: SessionState): string {
  const sess = state.session;
  if (sess.projectName && sess.projectName.length > 0) return sess.projectName;

  // v0.2.10: when the slug decoder gave up (sess.projectName missing or empty),
  // try to recover the real project name from the recap's primary file paths.
  // For sessions stored at `~/.claude/projects/C--/<uuid>.jsonl` (Claude Code
  // run from the drive root), the slug is just `C--` and our decoder bails —
  // but the agent's primary file is something like `C:\Dev\AgentPulse\...`,
  // which clearly says "AgentPulse" once you skip the umbrella `Dev` dir.
  const primaryFiles = state.recap?.enriched.primaryFiles ?? [];
  const topClusters = Object.keys(state.recap?.enriched.pathClusters ?? {});
  const inferred = inferProjectFromPaths([...primaryFiles, ...topClusters]);
  if (inferred) return inferred;

  // Last-ditch: last path segment of the transcript file, minus extension.
  const parts = sess.transcriptPath.split(/[\\/]/);
  const tail = parts[parts.length - 1] ?? sess.id;
  const cleaned = tail.replace(/\.jsonl$/i, '');
  if (/^[0-9a-f-]+$/i.test(cleaned) && cleaned.length > 6) {
    return `session-${sess.id.slice(0, 8)}`;
  }
  return cleaned;
}

/** Column width budget for the label+runtime column. Keep stable so timestamp
 *  ticks don't cause wrap-shift flicker. */
const LABEL_COL_WIDTH = 38;

/**
 * v0.7.1: the disambiguator/collision logic moved to src/labels.ts so
 * the headless `--once` snapshot can share it. DISAMBIG_ID_LEN is
 * re-exported via that module. The previous in-file `labelCollisionKey`
 * helper became internal to src/labels.ts.
 */

function SessionListInner({ states, selectedId }: SessionListProps): React.ReactElement {
  if (states.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No sessions detected yet…</Text>
        <Text dimColor>(transcripts must have been updated in the staleMs window)</Text>
      </Box>
    );
  }

  // v0.7.1: collision detection delegated to the shared helper in
  // src/labels.ts so the headless `--once` snapshot disambiguates by
  // the same rule. Behaviour is unchanged from v0.4.4/v0.4.7 — unique
  // rows stay clean, colliding rows get a hex tail, aliased rows
  // don't participate (the alias IS the disambiguator).
  const labelInputs = states.map((s) => ({
    id: s.session.id,
    projectName: fallbackLabel(s),
    runtime: s.session.runtime,
    alias: s.alias,
  }));
  const disambigSuffixes = computeDisambigSuffixes(labelInputs);

  return (
    <Box flexDirection="column">
      {states.map((s, idx) => {
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
        // v0.5.3: the "updated Xs ago" cell is rendered by `<TimeAgo>`
        // below, which owns its own 1 s interval so the rest of the
        // pane doesn't re-render every wall-clock tick.

        // v0.4.7: when the user has set an alias for this session, it
        // becomes the lead element of the row label — and replaces the
        // hex-tail disambiguator from v0.4.4 (the alias IS the disambig).
        const alias = s.alias;

        // v0.7.1: pull the precomputed suffix from the shared helper.
        // Empty for unique rows, ` · <hex>` for colliding non-aliased
        // rows. `showDisambig` is derived from suffix-non-emptiness so
        // the existing render branches below stay structurally identical.
        const disambigSuffix = disambigSuffixes[idx]!;
        const showDisambig = disambigSuffix.length > 0;

        // v0.2.3: compute the label truncation budget from the runtime
        // suffix length so the combined column never exceeds LABEL_COL_WIDTH.
        // Pre-fix, a long slug like `agent-a92e01b8034a7c780-7...` truncated
        // to 22 chars + ` (claude-code)` overflowed the 32-char box and
        // wrapped to two lines, causing layout flicker on every timer tick.
        //
        // v0.4.4: also account for the disambiguator suffix when present.
        // v0.4.7: also account for the alias prefix when present.
        const runtimeSuffix = ` (${s.session.runtime})`;
        const aliasPrefix = alias ? `${alias} · ` : '';
        const reservedSuffix = runtimeSuffix.length + disambigSuffix.length + aliasPrefix.length;
        const labelBudget = Math.max(8, LABEL_COL_WIDTH - reservedSuffix - 1);
        const truncatedLabel = truncate(label, labelBudget);

        return (
          <Box key={s.session.id} flexDirection="row">
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? '▸ ' : '  '}
            </Text>
            <Text color={pillColor}>{pill}</Text>
            <Text>{'  '}</Text>
            <Box width={LABEL_COL_WIDTH}>
              {alias && (
                <Text bold={isSelected} color="cyan">
                  {alias}
                  <Text dimColor> · </Text>
                </Text>
              )}
              <Text bold={isSelected}>{truncatedLabel}</Text>
              {showDisambig && <Text dimColor>{disambigSuffix}</Text>}
              <Text dimColor>{runtimeSuffix}</Text>
            </Box>
            <Box width={22}>
              <Text color={bucket ? colorFor(bucket) : undefined} dimColor={dimBucket}>
                {bucketLabel}
              </Text>
            </Box>
            {s.lastUpdated > 0 ? (
              <TimeAgo timestamp={s.lastUpdated} prefix="updated " dim />
            ) : (
              <Text dimColor>no recap yet</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * v0.5.3: wrap the pane in React.memo so it skips re-renders when the
 * session set + selection are unchanged. With `now` removed from the
 * prop surface (see SessionListInner), the parent's 1 s clock tick no
 * longer forces a diff of every row.
 */
export const SessionList = React.memo(SessionListInner);

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
