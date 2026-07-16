/**
 * v0.3.2: Tiny Unicode block-character sparkline for visualizing activity
 * density over the session window.
 *
 * Lifted-in-spirit from agenttrace's metrics view (one of the inspector's
 * suggested "borrow the good idea" moves). Compact, deterministic, no deps.
 *
 * Pure function — given the same timestamps + bounds + width, returns the
 * same string. The TUI renders it in `SessionDetail`; the same helper
 * could feed a JSON output later.
 */

/** Unicode block-eighths, ordered from empty to full. */
const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export interface SparklineOptions {
  /** Display width in characters. Each cell represents
   *  `(windowEnd - windowStart) / width` ms of the window. Default 16. */
  width?: number;
  /** When all buckets are empty, return this. Default: empty string. */
  emptyFallback?: string;
}

/**
 * Build a density sparkline from a timestamp array.
 *
 * @param timestamps    Event epoch-ms timestamps. Order doesn't matter.
 * @param windowStart   Epoch-ms of the window's left edge.
 * @param windowEnd     Epoch-ms of the window's right edge.
 * @param opts          Width + fallback options.
 * @returns             A string of length `opts.width` made of `BLOCKS` chars.
 *                      Left = window start, right = window end. Cell height
 *                      = relative density (max bucket → █).
 */
export function sparkline(
  timestamps: number[],
  windowStart: number,
  windowEnd: number,
  opts: SparklineOptions = {}
): string {
  const width = Math.max(1, Math.floor(opts.width ?? 16));
  const fallback = opts.emptyFallback ?? '';

  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return fallback;
  }
  const span = windowEnd - windowStart;
  if (span <= 0) return fallback;

  const buckets = new Array<number>(width).fill(0);
  for (const t of timestamps) {
    if (!Number.isFinite(t) || t < windowStart || t > windowEnd) continue;
    // Map t into [0, width). Right edge clamps to width-1.
    let idx = Math.floor(((t - windowStart) / span) * width);
    if (idx < 0) idx = 0;
    if (idx >= width) idx = width - 1;
    buckets[idx]! += 1;
  }

  let max = 0;
  for (const b of buckets) if (b > max) max = b;
  if (max === 0) return fallback;

  return buckets
    .map((count) => {
      if (count === 0) return BLOCKS[0]!;
      // Normalize to [1, 8] — never use the empty char for a non-zero bucket.
      const level = Math.max(1, Math.min(8, Math.round((count / max) * 8)));
      return BLOCKS[level]!;
    })
    .join('');
}
