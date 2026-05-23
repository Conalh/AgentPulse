/**
 * AgentPulse public API.
 *
 * Programmatic entry point. The CLI lives in `cli.ts`.
 * Each layer's implementation lives in its own file; this re-exports the
 * shapes and the convenience pipeline runner.
 */

export * from './types.js';

// Layer implementations re-export from their owning files once landed.
// Parallel build agents will fill these in. The stubs below let
// downstream callers wire the pipeline before all layers are implemented.

export { parseTranscript } from './parser.js';
export { enrichWindow } from './enrich.js';
export { classifyTrajectory, readOutcomeSignal } from './trajectory.js';
export { renderRecap } from './narrative.js';

/**
 * Convenience pipeline: parse → enrich → classify → render.
 *
 * Most callers should use this. The CLI uses it under the hood. Drop down
 * to the individual layer functions only when you need to inspect or
 * substitute an intermediate stage.
 */
import { parseTranscript } from './parser.js';
import { enrichWindow } from './enrich.js';
import { classifyTrajectory, readOutcomeSignal } from './trajectory.js';
import { renderRecap } from './narrative.js';
import type { PulseRecap } from './types.js';

export interface PulseOptions {
  /** Glob or directory of transcript files. */
  transcriptDir: string;
  /** Window duration in ms. Default: 20 minutes. */
  windowMs?: number;
  /** Now-ish epoch ms used as windowEnd. Default: Date.now(). */
  endAt?: number;
  /** Repository root, for gov-suite drift detectors. Default: cwd. */
  repoRoot?: string;
  /** Enable gov-suite detectors for the drifting bucket. Default: true. */
  detectorsEnabled?: boolean;
  /** Suppress parser warnings (skipped malformed lines). The TUI sets this
   *  to true on every refresh to avoid `console.warn` interfering with
   *  Ink's screen redraw. Default: false. */
  silent?: boolean;
}

export async function pulse(opts: PulseOptions): Promise<PulseRecap> {
  const endAt = opts.endAt ?? Date.now();
  const windowMs = opts.windowMs ?? 20 * 60 * 1000;
  const startAt = endAt - windowMs;

  const events = await parseTranscript(opts.transcriptDir, {
    since: startAt,
    until: endAt,
    silent: opts.silent,
  });

  const enriched = enrichWindow(events, startAt, endAt);
  const outcome = readOutcomeSignal(enriched);
  const verdict = classifyTrajectory(enriched, outcome, {
    detectorsEnabled: opts.detectorsEnabled ?? true,
    // v0.3.1: thread repoRoot into drift detection so a Write outside the
    // session's repo is flagged regardless of whether it hits the legacy
    // hardcoded prefixes (`/tmp/`, `/var/`, `~/`).
    repoRoot: opts.repoRoot,
  });

  return renderRecap(enriched, outcome, verdict);
}
