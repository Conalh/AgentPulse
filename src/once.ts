/**
 * v0.4.0: One-shot headless mode for `agentpulse live --once`.
 *
 * Same discovery + orchestrator + pulse pipeline as the TUI, but no Ink and
 * no refresh loop. Runs every detected session through `pulse()` exactly
 * once, prints a snapshot, exits with the configured strictness code.
 *
 * The CI-gateable form. Drop this in a pre-merge GitHub Action with
 * `--strict` and the build fails when any agent session is currently
 * drifting or stuck.
 */

import { discoverSessions } from './sessions/index.js';
import { isSubagentTranscript } from './sessions/subagents.js';
import { computeDisambigSuffixes } from './labels.js';
import { pulse } from './index.js';
import { DEFAULT_STALE_MS, DEFAULT_WINDOW_MS } from './defaults.js';
import { createNotifier } from './notifications.js';
import type {
  LiveOptions,
  PulseRecap,
  RedactMode,
  TrajectoryBucket,
} from './types.js';

/**
 * v0.5.5: how many session pulses can run in parallel. Disk I/O on
 * transcript files is the bottleneck; ~6 keeps a typical 4-8 core CI
 * runner saturated without thrashing the filesystem queue. Configurable
 * via `AP_ONCE_CONCURRENCY` env var for users who want to tune.
 */
const ONCE_CONCURRENCY: number = (() => {
  const fromEnv = Number.parseInt(process.env.AP_ONCE_CONCURRENCY ?? '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 6;
})();

/**
 * Concurrency-capped task runner. Spawns up to `concurrency` workers
 * that pull tasks off the list in order; each worker awaits one task
 * fully before fetching the next. Output is indexed so the returned
 * array preserves the original task order — important here because
 * the text report iterates sessions in their discovery order.
 *
 * Hand-rolled to avoid a runtime dependency on `p-limit` for a tiny
 * helper used in exactly one place.
 */
export async function runConcurrent<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

interface SessionSnapshot {
  id: string;
  projectName: string | undefined;
  /** v0.7.1: display label — `projectName` with a disambiguator appended
   *  when another visible session shares the same `projectName|runtime`
   *  key. Mirrors the TUI's v0.4.4 hex-tail behaviour so JSON consumers
   *  and humans reading the text report can both tell co-named sessions
   *  apart. When no collision exists, `label === projectName`. */
  label: string;
  runtime: string;
  transcriptPath: string;
  bucket: TrajectoryBucket | 'pending' | 'error';
  confidence: number;
  narrative: string;
  signals: string[];
  driftCount: number;
  /** Tool invocations the pulse saw in the window. Mirrors the value the TUI
   *  filters on for `hideIdle` (recap.enriched.toolInvocationCount). 0 for
   *  error rows. */
  toolInvocationCount: number;
  /** Set when pulse() threw. */
  error?: string;
}

interface OnceReport {
  generatedAt: number;
  sessionCount: number;
  bucketCounts: Record<string, number>;
  hasGatingFinding: boolean;
  sessions: SessionSnapshot[];
}

/**
 * Run the headless one-shot. Returns an exit code (0 for success, 1 when
 * `--strict` and any session is drifting/stuck, 2 for usage-shaped errors
 * the caller handles upstream).
 */
export async function runOnceMode(opts: LiveOptions): Promise<number> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const detectorsEnabled = opts.detectorsEnabled ?? true;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const discoveryRoots = opts.discoveryRoots;
  const format = opts.format ?? 'text';
  const strict = opts.strict ?? false;
  // Headless filters the TUI applied but `--once` previously ignored: idle
  // sessions are dropped from the report (idle never gates, so this is
  // governance-safe), and the per-session listing is capped for readability.
  const hideIdle = opts.hideIdle ?? false;
  const maxSessions = opts.maxSessions; // undefined / 0 => no display cap
  // Fail closed on infrastructure errors when strict (opt-in; see runtime
  // gating below). Redaction scrubs transcript-derived content from output.
  const failOnError = opts.failOnError ?? false;
  const redact: RedactMode = opts.redact ?? 'none';

  const discovered = await discoverSessions({
    roots: discoveryRoots,
    staleMs,
    maxDepth: opts.maxDepth,
    excludeDirs: opts.excludeDirs,
  });

  // v0.7.1: honour the same `showSubagents` default the TUI applies
  // (App.tsx). Pre-fix the headless `--once` path emitted every
  // SDK-spawned subagent transcript as its own row, so a parent session
  // with N subagents reported `1 + N` rows for the same conceptual
  // session. The TUI used to be the only surface filtering them.
  const showSubagents = opts.showSubagents ?? false;
  const sessions = showSubagents
    ? discovered
    : discovered.filter(
        (s) => !isSubagentTranscript(s.projectName, s.transcriptPath)
      );

  // v0.5.5: parallel session pulses with a concurrency cap. Pre-fix
  // every session was awaited sequentially, so CI runs against artifact
  // directories with dozens of historical transcripts paid linear cost.
  // Sessions are independent — pulse() does not share state across them
  // — so parallelization is safe; the cap keeps disk I/O from
  // thrashing on shared CI runners.
  //
  // Why hand-rolled vs. `p-limit`: zero deps. The runner is 12 lines and
  // single-purpose. Output order is preserved via per-index assignment
  // so the text report iterates sessions in their discovery order, same
  // as the pre-fix sequential loop.
  async function runOneSession(
    session: (typeof sessions)[number]
  ): Promise<SessionSnapshot> {
    try {
      const recap = await pulse({
        transcriptDir: session.transcriptPath,
        windowMs,
        detectorsEnabled,
        repoRoot: session.cwd,
        silent: true,
      });
      return snapshotFromRecap(
        session.id,
        session.projectName,
        session.runtime,
        session.transcriptPath,
        recap
      );
    } catch (err) {
      return {
        id: session.id,
        projectName: session.projectName,
        // label is filled in by the disambiguation pass below — error
        // rows still participate so a crashed session doesn't lose its
        // disambiguator when two errored sessions share a project name.
        label: session.projectName ?? `session-${session.id.slice(0, 8)}`,
        runtime: session.runtime,
        transcriptPath: session.transcriptPath,
        bucket: 'error',
        confidence: 0,
        narrative: err instanceof Error ? err.message : String(err),
        signals: [],
        driftCount: 0,
        toolInvocationCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const snapshots: SessionSnapshot[] = await runConcurrent(
    sessions.map((s) => () => runOneSession(s)),
    ONCE_CONCURRENCY
  );

  // v0.7.1: compute display labels with the same collision logic the
  // TUI uses (src/labels.ts). Two visible sessions sharing
  // `projectName|runtime` get a ` · <hex>` suffix so downstream JSON
  // consumers and the text report can tell them apart — pre-fix two
  // co-named rows were indistinguishable in the snapshot.
  const baseLabels = snapshots.map((s) => ({
    id: s.id,
    projectName: s.projectName ?? `session-${s.id.slice(0, 8)}`,
    runtime: s.runtime,
  }));
  const suffixes = computeDisambigSuffixes(baseLabels);
  for (let i = 0; i < snapshots.length; i++) {
    snapshots[i]!.label = baseLabels[i]!.projectName + suffixes[i]!;
  }

  // hideIdle: drop zero-activity sessions from the report entirely. Error
  // rows are KEPT (an unreadable transcript is a finding you want to see, and
  // it matters for --fail-on-error below); idle / zero-tool sessions never
  // land in a gating bucket, so removing them can't change the gate.
  const reported = hideIdle
    ? snapshots.filter((s) => s.bucket === 'error' || s.toolInvocationCount > 0)
    : snapshots;

  // bucketCounts / hasGatingFinding / sessionCount are computed over the FULL
  // reported set so governance sees every session; maxSessions caps only the
  // human text listing (renderTextReport), never the analysis — drifting
  // session #21 still gates even if it isn't printed.
  const rawReport = buildReport(reported);
  const report = redact === 'none' ? rawReport : redactReport(rawReport, redact);

  if (format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderTextReport(report, maxSessions, redact) + '\n');
  }

  // v0.4.2: one-shot notification when --notify is set and any session is
  // in drifting/stuck. `--once` is a snapshot, not a live monitor — we fire
  // exactly one notification per invocation regardless of how many sessions
  // are gating. Anything more would be noisy in a cron context.
  const notifyMode = opts.notify ?? 'none';
  if (notifyMode !== 'none' && report.hasGatingFinding) {
    const notifier = createNotifier({ mode: notifyMode });
    const offenders = report.sessions.filter((s) => GATING_BUCKETS.has(s.bucket));
    const count = offenders.length;
    // v0.7.1: use the disambiguated label so a notification body for two
    // co-named offenders ("AgentPulse: stuck" / "AgentPulse: stuck")
    // tells you which session.
    const firstLabel = offenders[0]?.label ?? `session-${offenders[0]?.id.slice(0, 8) ?? '?'}`;
    const body =
      count === 1
        ? `${firstLabel}: ${offenders[0]!.bucket}`
        : `${count} sessions need attention (e.g. ${firstLabel})`;
    notifier.notifyOnce(body);
    notifier.stop();
  }

  // CI gating — see gateExitCode for the rules. The stderr note for the
  // fail-on-error path stays here (gateExitCode is pure).
  const errorCount = report.bucketCounts['error'] ?? 0;
  if (strict && failOnError && errorCount > 0) {
    process.stderr.write(
      `agentpulse: ${errorCount} session(s) failed to analyze; failing the gate (--fail-on-error)\n`
    );
  }
  return gateExitCode(report, { strict, failOnError });
}

/**
 * Compute the `--once` process exit code from a report and the gating
 * options. Pure + exported so the governance contract is unit-testable.
 *
 *   - strict + a gating bucket (`drifting`/`stuck`)        → 1
 *   - strict + failOnError + at least one `error` bucket   → 1  (fail closed)
 *   - otherwise                                            → 0
 *
 * `pending` and `error` are infrastructure states, not findings, so they
 * never gate on their own — EXCEPT when `failOnError` opts an `error` into
 * the gate (#F2). Pre-fix, a run of only unreadable/corrupt transcripts
 * exited 0 under `--strict`: the governance gate passed though its own
 * analysis never ran (fail-open). `--fail-on-error` makes that fail closed;
 * bare `--strict` keeps the prior advisory-on-error behaviour.
 */
export function gateExitCode(
  report: { hasGatingFinding: boolean; bucketCounts: Record<string, number> },
  opts: { strict: boolean; failOnError: boolean }
): number {
  if (opts.strict && report.hasGatingFinding) return 1;
  const errorCount = report.bucketCounts['error'] ?? 0;
  if (opts.strict && opts.failOnError && errorCount > 0) return 1;
  return 0;
}

function snapshotFromRecap(
  id: string,
  projectName: string | undefined,
  runtime: string,
  transcriptPath: string,
  recap: PulseRecap
): SessionSnapshot {
  return {
    id,
    projectName,
    // label is replaced by the disambiguation pass after all snapshots
    // are built; this is the placeholder used if disambiguation is
    // skipped (e.g. in tests calling snapshotFromRecap directly).
    label: projectName ?? `session-${id.slice(0, 8)}`,
    runtime,
    transcriptPath,
    bucket: recap.verdict.bucket,
    confidence: recap.verdict.confidence,
    narrative: recap.narrative,
    signals: [...recap.verdict.signals],
    driftCount: recap.verdict.drifts.length,
    toolInvocationCount: recap.enriched.toolInvocationCount,
  };
}

const GATING_BUCKETS: ReadonlySet<string> = new Set(['drifting', 'stuck']);

function buildReport(snapshots: SessionSnapshot[]): OnceReport {
  const bucketCounts: Record<string, number> = {};
  let hasGatingFinding = false;
  for (const s of snapshots) {
    bucketCounts[s.bucket] = (bucketCounts[s.bucket] ?? 0) + 1;
    if (GATING_BUCKETS.has(s.bucket)) hasGatingFinding = true;
  }
  return {
    generatedAt: Date.now(),
    sessionCount: snapshots.length,
    bucketCounts,
    hasGatingFinding,
    sessions: snapshots,
  };
}

function renderTextReport(
  report: OnceReport,
  maxSessions?: number,
  redact: RedactMode = 'none'
): string {
  const lines: string[] = [];
  lines.push(`AgentPulse — ${report.sessionCount} session${report.sessionCount === 1 ? '' : 's'} at ${new Date(report.generatedAt).toISOString()}`);

  const bucketParts: string[] = [];
  for (const [b, n] of Object.entries(report.bucketCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
    bucketParts.push(`${b}: ${n}`);
  }
  if (bucketParts.length > 0) {
    lines.push(`  ${bucketParts.join(' · ')}`);
  }
  if (redact !== 'none') {
    lines.push(`  (output redacted: ${redact})`);
  }
  lines.push('');

  // maxSessions caps the per-session listing for readability. Snapshots are
  // in discovery order (lastModified DESC), so slicing keeps the freshest N.
  // Display-only: bucketCounts / hasGatingFinding above already reflect every
  // analyzed session, and the truncation is announced (never silent).
  const cap = maxSessions && maxSessions > 0 ? maxSessions : report.sessions.length;
  const shown = report.sessions.slice(0, cap);
  if (shown.length < report.sessions.length) {
    lines.push(`  showing freshest ${shown.length} of ${report.sessions.length} sessions (--max-sessions ${maxSessions})`);
    lines.push('');
  }

  for (const s of shown) {
    // v0.7.1: prefer the disambiguated label over raw projectName so
    // the text report can be skimmed when two sessions share a name.
    const label = s.label || s.projectName || `session-${s.id.slice(0, 8)}`;
    const driftSuffix = s.driftCount > 0 ? ` (${s.driftCount} drift)` : '';
    lines.push(`  ${label} [${s.runtime}]  →  ${s.bucket}${driftSuffix}  (confidence ${s.confidence.toFixed(2)})`);
    if (s.error) {
      lines.push(`    error: ${s.error}`);
    } else if (s.narrative) {
      // narrative is '' under --redact all; skip the detail line then.
      lines.push(`    ${stripBoldMarkdown(s.narrative).split('\n')[0]}`);
    }
  }

  if (report.hasGatingFinding) {
    // Count from bucketCounts, not the (possibly capped) shown list, so the
    // tally stays accurate when a gating session sits below the display cap.
    const gating =
      (report.bucketCounts['drifting'] ?? 0) + (report.bucketCounts['stuck'] ?? 0);
    lines.push('');
    lines.push(`⚠ ${gating} session(s) need attention.`);
  }

  return lines.join('\n');
}

function stripBoldMarkdown(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}

// ── Redaction (#F8) ──────────────────────────────────────────────────
//
// `--once` output (text report + JSON) can reach the GitHub step summary
// and a sticky PR comment. Narratives, signals, and the transcript path
// embed transcript-derived absolute paths, path clusters, and file names.
// `--redact paths` reduces those to basenames; `--redact all` additionally
// drops narratives and signals. Labels / buckets / confidence / drift
// counts are always preserved — a project basename and a verdict aren't
// path leaks, and dropping them would defeat the report's purpose.

/** Last path segment of `p` (handles both separators). */
function basenameOf(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

/** Reduce a token to its basename when it looks like a filesystem path
 *  (has a separator, a leading `…/` ellipsis marker, or a drive letter).
 *  Plain words — topics like `auth` — pass through unchanged. */
function redactPathToken(token: string): string {
  const looksLikePath =
    /[\\/]/.test(token) || token.startsWith('…/') || /^[a-z]:/i.test(token);
  return looksLikePath ? basenameOf(token) : token;
}

/** Redact backticked path tokens inside a rendered narrative, leaving the
 *  surrounding prose and non-path topics intact. */
function redactNarrative(narrative: string): string {
  return narrative.replace(
    /`([^`]+)`/g,
    (_m, inner: string) => '`' + redactPathToken(inner) + '`'
  );
}

/** Redact absolute-path runs anywhere in free text (error messages carry
 *  the full transcript path, unbackticked). A "path run" is two or more
 *  separator-delimited segments, optionally drive-prefixed. */
function redactAbsPaths(s: string): string {
  return s.replace(/(?:[a-z]:)?(?:[\\/][^\s"'`\\/]+){2,}/gi, (m) => {
    const base = basenameOf(m);
    return base ? '…/' + base : m;
  });
}

function redactReport(report: OnceReport, mode: RedactMode): OnceReport {
  const sessions = report.sessions.map((s) => {
    const out: SessionSnapshot = { ...s, transcriptPath: basenameOf(s.transcriptPath) };
    if (out.error) out.error = redactAbsPaths(out.error);
    if (mode === 'all') {
      out.narrative = '';
      out.signals = [];
    } else {
      out.narrative = redactNarrative(s.narrative);
      // Token-level pass so single-separator cluster paths (`src/auth`) and
      // absolute file tokens both collapse to a basename, without mangling
      // prose words that contain no separator.
      out.signals = s.signals.map((sig) =>
        sig.split(' ').map(redactPathToken).join(' ')
      );
    }
    return out;
  });
  return { ...report, sessions };
}
