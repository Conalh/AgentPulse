/**
 * Default timing constants shared across the CLI, the one-shot runner,
 * the TUI, the orchestrator, and session discovery.
 *
 * These were previously re-spelled as literals in several places (with
 * two different spellings of the same value — `20 * 60 * 1000` vs
 * `20 * 60_000`), so changing a default meant hunting down every copy.
 * Define them once here and import everywhere.
 */

/** Analysis window: how far back each pulse looks. Default 20 minutes. */
export const DEFAULT_WINDOW_MS = 20 * 60 * 1000;

/** Live refresh cadence per session. Default 30 seconds. */
export const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

/**
 * Staleness cutoff for session discovery — transcripts untouched for
 * longer than this are not surfaced as live sessions. Default 1 hour.
 *
 * v0.2.1: tightened from 24h, which picked up every transcript touched
 * in the last day and drowned the dashboard in idle sessions. 1h matches
 * the "what's actually happening right now" intent; override via
 * `--stale` on the CLI.
 */
export const DEFAULT_STALE_MS = 60 * 60 * 1000;
