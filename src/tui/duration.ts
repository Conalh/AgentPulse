/**
 * Tiny duration humanizer for the TUI.
 *
 * Examples:
 *   formatAgo(now, now - 4000)        → "4s ago"
 *   formatAgo(now, now - 72_000)      → "1 min ago"
 *   formatAgo(now, now - 3_700_000)   → "1h ago"
 *
 * Kept dumb on purpose — round-down to the nearest unit, no plural quirks.
 */

export function formatAgo(now: number, then: number): string {
  if (!Number.isFinite(then) || then <= 0) return 'never';
  const deltaMs = Math.max(0, now - then);
  return `${formatDelta(deltaMs)} ago`;
}

/** Bare delta — no "ago" suffix. Used for next-refresh countdown labels. */
export function formatDelta(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return '0s';
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1 min' : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
