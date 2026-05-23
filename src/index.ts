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
export { analyzeSequences } from './sequences.js';

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
import { analyzeSequences } from './sequences.js';
import { renderRecap } from './narrative.js';
import { loadExceptions } from './exceptions.js';
import type { PulseRecap } from './types.js';

export { loadExceptions, appendExceptions } from './exceptions.js';

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
  /** v0.4.1: Path used to locate the per-session exception baseline file
   *  (`.agentpulse-exceptions.json`). Accepts a directory or the full file
   *  path. When omitted, falls back to `repoRoot`. When neither is set,
   *  no exceptions are loaded — drift detection runs normally. */
  exceptionsPath?: string;
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
  // v0.3.2: Layer 2.5 — ordered action-sequence detection. Runs on the
  // enriched window's events (already timestamp-filtered) and feeds the
  // classifier as an additional input. Pure function, no I/O.
  const sequence = analyzeSequences(enriched.events);
  // v0.4.1: load the per-session exception baseline before classification.
  // `exceptionsPath` wins when supplied; otherwise the session's `repoRoot`
  // is the conventional location. Missing / malformed files yield an empty
  // set — exceptions are an optional baseline, not required config.
  const exceptionsSearchPath = opts.exceptionsPath ?? opts.repoRoot;
  const exceptions = await loadExceptions(exceptionsSearchPath);
  const verdict = classifyTrajectory(enriched, outcome, {
    detectorsEnabled: opts.detectorsEnabled ?? true,
    // v0.3.1: thread repoRoot into drift detection so a Write outside the
    // session's repo is flagged regardless of whether it hits the legacy
    // hardcoded prefixes (`/tmp/`, `/var/`, `~/`).
    repoRoot: opts.repoRoot,
    sequence,
    exceptions,
  });

  return renderRecap(enriched, outcome, verdict);
}
