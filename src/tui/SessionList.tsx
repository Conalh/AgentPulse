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
 * v0.4.4: short session-id tail used to disambiguate rows whose
 * `projectName + runtime` combination is identical to another visible row.
 * 6 hex chars is 16M of space — plenty of collision resistance for the
 * ≤10-session list, but still short enough to fit in the label column
 * even on the longest project names without aggressive truncation.
 */
const DISAMBIG_ID_LEN = 6;

/**
 * Returns the key used to detect "two rows look the same." Includes runtime
 * because `core (claude-code)` and `core (cursor)` already look distinct
 * thanks to the runtime suffix — only intra-runtime collisions need an
 * extra tail.
 */
function labelCollisionKey(label: string, runtime: string): string {
  return `${label}|${runtime}`;
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

  // v0.4.4: pre-compute label collision counts so we only show the
  // session-id tail on rows whose project+runtime label appears 2+ times.
  // Unique rows render exactly as before (no extra visual noise).
  //
  // v0.4.7: aliased sessions don't participate in collision counts — when
  // a session has a user-chosen alias, that name IS the disambiguator and
  // the hex tail is suppressed. Counting them in would inflate other rows'
  // collision-count and trigger spurious hex tails on rows that don't need
  // them.
  const labelCounts = new Map<string, number>();
  for (const s of states) {
    if (s.alias) continue;
    const key = labelCollisionKey(fallbackLabel(s), s.session.runtime);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
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

        // v0.4.7: when the user has set an alias for this session, it
        // becomes the lead element of the row label — and replaces the
        // hex-tail disambiguator from v0.4.4 (the alias IS the disambig).
        const alias = s.alias;

        // v0.4.4: when 2+ visible sessions share the same project+runtime
        // AND neither has an alias, append a short hex tail so the list
        // isn't three identical-looking rows. Only renders on collision —
        // unique or aliased rows stay clean.
        const collisionCount =
          alias ? 0 : labelCounts.get(labelCollisionKey(label, s.session.runtime)) ?? 1;
        const showDisambig = !alias && collisionCount >= 2;
        const disambigSuffix = showDisambig ? ` · ${s.session.id.slice(0, DISAMBIG_ID_LEN)}` : '';

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
