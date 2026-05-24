/**
 * Right pane — detail of the currently-selected session.
 *
 * Shows header, transcript path, narrative, verdict pill, signals, and the
 * refresh-clock footer. Stateless — the parent passes a SessionState.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { SessionState } from '../types.js';
import { colorFor, isLowConfidence, pillFor } from './theme.js';
import { formatAgo, formatDelta } from './duration.js';
import { sparkline } from './sparkline.js';

/**
 * v0.5.3: self-clocking footer that owns its own 1 s interval. Replaces
 * the previous "every wall-clock tick re-renders the whole detail pane"
 * shape — now only this small subtree updates each second.
 */
function RefreshFooter({
  lastUpdated,
  refreshIntervalMs,
  pending,
}: {
  lastUpdated: number;
  refreshIntervalMs: number;
  pending: boolean;
}): React.ReactElement {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    id.unref?.(); // see TimeAgo.tsx for why we unref
    return () => clearInterval(id);
  }, []);
  const lastRefresh = lastUpdated > 0 ? formatAgo(now, lastUpdated) : 'never';
  const nextRefreshMs =
    lastUpdated > 0
      ? Math.max(0, lastUpdated + refreshIntervalMs - now)
      : refreshIntervalMs;
  return (
    <Box marginTop={1}>
      <Text dimColor>
        Last refresh: {lastRefresh} · next refresh: ~{formatDelta(nextRefreshMs)}
        {pending ? ' · refreshing…' : ''}
      </Text>
    </Box>
  );
}

/**
 * v0.3.3: pinned sparkline width. Kept as a constant so the cell-Box and
 * the sparkline helper agree on a single source of truth — drift between
 * them is what caused the activity row to "jerk" on every refresh.
 */
const SPARKLINE_WIDTH = 24;

/**
 * v0.3.4: pinned detail-pane minimum height. The pre-fix detail pane sized
 * itself to its content — short for idle sessions (~6 lines: path,
 * narrative, verdict, 1 signal, activity, footer), tall for drifting
 * sessions (~16+ lines: longer narrative, multiple signals, drift findings,
 * activity, footer). When the user arrow-navigated up/down between
 * sessions, the entire bordered box resized vertically each time, which
 * shifted the global footer + RAGE branding up and down — visible "jerk".
 *
 * Reserving 16 lines covers the typical converging case cleanly and lets
 * unusually content-heavy verdicts (drifting with many findings) expand
 * without artificially capping them. Short content gets bottom padding.
 */
const DETAIL_MIN_HEIGHT = 16;

/**
 * v0.3.5: pinned narrative-section minimum height. The outer detail box
 * was stable at 16 lines after v0.3.4, but the narrative INSIDE it still
 * varied: a 1-line "Your agent has been quiet for 12 minutes" vs. a 3-line
 * "Your agent has been quiet for 5 minutes. Earlier in the window it made
 * 12 changes to C:\Dev\fit-ontology\web\app\clients\page.tsx before going
 * idle. Likely parked, waiting on you or external input." Different
 * wrapping = different heights = the Signals/Activity/footer shift down
 * the page even though the outer box is the same size.
 *
 * 4 lines covers the typical narrative (1-3 lines) with one line of
 * padding. Content-heavy verdicts can still grow past 4 if they need to.
 */
const NARRATIVE_MIN_HEIGHT = 4;

/**
 * v0.3.5: pinned signals-section minimum height. Same logic — signals
 * vary from 1 (idle / done) to 4 (converging / drifting). 5 covers the
 * "Signals:" header plus up to 4 signal lines.
 */
const SIGNALS_MIN_HEIGHT = 5;

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
  refreshIntervalMs: number;
  /** v0.4.1: transient confirmation banner shown above the footer after the
   *  user presses `a` to whitelist drift findings. The parent owns the
   *  lifecycle (set on press, cleared by a timer); we just render. */
  flashMessage?: string | null;
}

function SessionDetailInner({
  state,
  refreshIntervalMs,
  flashMessage = null,
}: SessionDetailProps): React.ReactElement {
  if (!state) {
    return (
      <Box flexDirection="column" paddingX={1} minHeight={DETAIL_MIN_HEIGHT}>
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

  // v0.5.3: footer timing now lives in <RefreshFooter />, a self-clocking
  // subcomponent. The outer SessionDetail no longer needs `now` and can
  // memoize at its parent boundary.

  return (
    <Box flexDirection="column" paddingX={1} minHeight={DETAIL_MIN_HEIGHT}>
      <Box>
        <Text bold>{projectLabel}</Text>
        <Text dimColor> ({sess.runtime})</Text>
      </Box>
      <Text dimColor>{sess.transcriptPath}</Text>
      <Box marginTop={1} flexDirection="column" minHeight={NARRATIVE_MIN_HEIGHT}>
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

      {/* v0.3.5: always render the Signals box (when there's a verdict) so
          the section doesn't appear/disappear; minHeight reserves enough
          lines for the worst case (4 signals + header). Short signal sets
          get bottom padding inside the box. */}
      {verdict && (
        <Box flexDirection="column" marginTop={1} minHeight={SIGNALS_MIN_HEIGHT}>
          {verdict.signals.length > 0 && <Text>Signals:</Text>}
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

      {flashMessage && (
        <Box marginTop={1}>
          <Text color="green">{flashMessage}</Text>
        </Box>
      )}

      <RefreshFooter
        lastUpdated={state.lastUpdated}
        refreshIntervalMs={refreshIntervalMs}
        pending={state.pending}
      />
    </Box>
  );
}

/**
 * v0.5.3: memoized export so the App's 1 s clock tick doesn't re-render
 * the detail pane unless the underlying session state or props change.
 * The RefreshFooter inside still updates each second on its own timer.
 */
export const SessionDetail = React.memo(SessionDetailInner);
