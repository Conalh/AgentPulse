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

// v0.5.0: Layer 1 (transcript parser) lives in agent-gov-core@1.1.0.
// We re-export it as `parseTranscript` here so v0.4.x callers don't churn —
// the canonical name in agent-gov-core is `parseTranscriptDir`.
export { parseTranscriptDir as parseTranscript } from 'agent-gov-core';
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
import { parseTranscriptDir } from 'agent-gov-core';
import { enrichWindow } from './enrich.js';
import { classifyTrajectory, readOutcomeSignal } from './trajectory.js';
import { analyzeSequences } from './sequences.js';
import { renderRecap } from './narrative.js';
import { loadExceptions } from './exceptions.js';
import { readWindowFromCache } from './parseCache.js';
import type { PulseRecap, TranscriptEvent } from './types.js';

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
  /** v0.6.0: pre-parsed events. When supplied, pulse() skips its own
   *  parser invocation entirely and uses these events directly. The
   *  orchestrator uses this to thread incrementally-parsed events into
   *  the pipeline — same recap output, dramatically less I/O on long
   *  sessions. CLI callers (`recap`, `live --once`) leave this unset
   *  and get the normal whole-file parse. The events MUST already be
   *  filtered to the [windowEnd - windowMs, windowEnd] window — pulse()
   *  trusts the caller. */
  events?: TranscriptEvent[];
}

/**
 * v0.5.6: dev-only per-layer profiling. Set `AGENTPULSE_PROFILE=1` in
 * the environment to log a one-line breakdown of each pulse to stderr:
 *
 *   [agentpulse:profile] parse: 142ms · enrich: 3ms · classify: 1ms · narrative: 0ms
 *
 * Off by default — zero overhead in normal use (one env-var read at
 * function entry). Goes to stderr because stdout is in the TUI's
 * alt-screen buffer during `agentpulse live` and any write there
 * causes whole-window flicker on cmd.exe.
 *
 * Useful when investigating slow pulses (especially while implementing
 * the incremental-parse work in v0.6.0+) — the numbers tell you which
 * layer dominates a given session's cost.
 */
function profileEnabled(): boolean {
  // Read at each call so tests can toggle without re-importing the module.
  // One env-var read per pulse is negligible.
  return process.env.AGENTPULSE_PROFILE === '1';
}

export async function pulse(opts: PulseOptions): Promise<PulseRecap> {
  const endAt = opts.endAt ?? Date.now();
  const windowMs = opts.windowMs ?? 20 * 60 * 1000;
  const startAt = endAt - windowMs;

  // Profile marker — only allocate when enabled so the hot path is
  // untouched in production.
  const profile = profileEnabled()
    ? { parse: 0, enrich: 0, sequence: 0, exceptions: 0, classify: 0, narrative: 0 }
    : null;
  const mark = (key: keyof NonNullable<typeof profile>, start: number): void => {
    if (profile) profile[key] = performance.now() - start;
  };

  let t = profile ? performance.now() : 0;
  // v0.6.0: if the caller supplied pre-parsed events (the orchestrator's
  // incremental-parse path), use them directly and skip the substrate
  // parser. The caller is responsible for window-filtering — we trust
  // the contract documented on PulseOptions.events.
  const events = opts.events ?? (
    opts.transcriptDir.toLowerCase().endsWith('.jsonl')
      ? await readWindowFromCache(opts.transcriptDir, startAt, endAt, {
          silent: opts.silent,
        })
      : await parseTranscriptDir(opts.transcriptDir, {
          since: startAt,
          until: endAt,
          silent: opts.silent,
        })
  );
  if (profile) mark('parse', t);

  if (profile) t = performance.now();
  const enriched = enrichWindow(events, startAt, endAt);
  if (profile) mark('enrich', t);

  const outcome = readOutcomeSignal(enriched);
  // v0.3.2: Layer 2.5 — ordered action-sequence detection. Runs on the
  // enriched window's events (already timestamp-filtered) and feeds the
  // classifier as an additional input. Pure function, no I/O.
  if (profile) t = performance.now();
  const sequence = analyzeSequences(enriched.events);
  if (profile) mark('sequence', t);

  // v0.4.1: load the per-session exception baseline before classification.
  // `exceptionsPath` wins when supplied; otherwise the session's `repoRoot`
  // is the conventional location. Missing / malformed files yield an empty
  // set — exceptions are an optional baseline, not required config.
  if (profile) t = performance.now();
  const exceptionsSearchPath = opts.exceptionsPath ?? opts.repoRoot;
  const exceptions = await loadExceptions(exceptionsSearchPath);
  if (profile) mark('exceptions', t);

  if (profile) t = performance.now();
  const verdict = classifyTrajectory(enriched, outcome, {
    detectorsEnabled: opts.detectorsEnabled ?? true,
    // v0.3.1: thread repoRoot into drift detection so a Write outside the
    // session's repo is flagged regardless of whether it hits the legacy
    // hardcoded prefixes (`/tmp/`, `/var/`, `~/`).
    repoRoot: opts.repoRoot,
    sequence,
    exceptions,
  });
  if (profile) mark('classify', t);

  if (profile) t = performance.now();
  const recap = renderRecap(enriched, outcome, verdict);
  if (profile) mark('narrative', t);

  if (profile) {
    const line = (
      `[agentpulse:profile] parse: ${profile.parse.toFixed(1)}ms` +
      ` · enrich: ${profile.enrich.toFixed(1)}ms` +
      ` · sequence: ${profile.sequence.toFixed(1)}ms` +
      ` · exceptions: ${profile.exceptions.toFixed(1)}ms` +
      ` · classify: ${profile.classify.toFixed(1)}ms` +
      ` · narrative: ${profile.narrative.toFixed(1)}ms`
    );
    // eslint-disable-next-line no-console
    process.stderr.write(line + '\n');
  }

  return recap;
}
