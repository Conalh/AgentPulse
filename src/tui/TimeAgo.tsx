/**
 * v0.5.3 — self-clocking "Xs ago" cell.
 *
 * Pre-v0.5.3 the App component held a `now` state that ticked every
 * 1000 ms to drive every "updated 6s ago" / "Last refresh: 12s ago"
 * label on the dashboard. Because that state sat at the root and was
 * passed down as a prop, EVERY Ink component re-rendered every second
 * — SessionList, SessionDetail, the help overlay, the footer — even
 * when none of their underlying data had changed. Cmd.exe and slower
 * terminals visibly thrashed.
 *
 * This component owns its own `now` interval and renders just one
 * label. Putting it inside SessionList / SessionDetail rows means
 * only the cells that actually depend on wall-clock drift re-render
 * each second; everything else stays a stable diff and React.memo
 * around the larger panes can short-circuit cleanly.
 *
 * The trade-off is one `setInterval` per visible cell. With the
 * default `--max-sessions 10` that's 10–11 timers, which is well
 * inside Node's cheap range and far less work than diffing every
 * Box / Text in the tree once per second.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { formatAgo } from './duration.js';

export interface TimeAgoProps {
  /** Epoch milliseconds of the event we're labelling. 0 / invalid → fallback. */
  timestamp: number;
  /** Wrap the rendered string in a prefix like "updated " or "Last refresh: ". */
  prefix?: string;
  /** Rendered when timestamp is 0 / negative. Default: 'never'. */
  fallback?: string;
  /** Render the Text dim. Mirrors the surrounding row styling. */
  dim?: boolean;
}

/**
 * Update cadence. 1 second matches the resolution `formatAgo` rolls over
 * at for the first minute (`Xs ago`); going faster wouldn't change the
 * displayed value, slower would visibly lag.
 */
const TICK_MS = 1000;

export function TimeAgo({
  timestamp,
  prefix = '',
  fallback = 'never',
  dim = false,
}: TimeAgoProps): React.ReactElement {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    // unref so the interval doesn't keep the process alive on its own —
    // matters for tests (which render then don't unmount) and for real
    // CLI shutdown semantics. Ink's stdin handler is what keeps the
    // process alive during normal use; this timer should just ride along.
    id.unref?.();
    return () => clearInterval(id);
  }, []);
  const body = timestamp > 0 ? formatAgo(now, timestamp) : fallback;
  return <Text dimColor={dim}>{prefix + body}</Text>;
}
