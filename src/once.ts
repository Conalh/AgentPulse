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
import { pulse } from './index.js';
import { createNotifier } from './notifications.js';
import type {
  LiveOptions,
  PulseRecap,
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
  runtime: string;
  transcriptPath: string;
  bucket: TrajectoryBucket | 'pending' | 'error';
  confidence: number;
  narrative: string;
  signals: string[];
  driftCount: number;
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
  const windowMs = opts.windowMs ?? 20 * 60_000;
  const detectorsEnabled = opts.detectorsEnabled ?? true;
  const staleMs = opts.staleMs ?? 1 * 3_600_000;
  const discoveryRoots = opts.discoveryRoots;
  const format = opts.format ?? 'text';
  const strict = opts.strict ?? false;

  const sessions = await discoverSessions({
    roots: discoveryRoots,
    staleMs,
  });

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
        runtime: session.runtime,
        transcriptPath: session.transcriptPath,
        bucket: 'error',
        confidence: 0,
        narrative: err instanceof Error ? err.message : String(err),
        signals: [],
        driftCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const snapshots: SessionSnapshot[] = await runConcurrent(
    sessions.map((s) => () => runOneSession(s)),
    ONCE_CONCURRENCY
  );

  const report = buildReport(snapshots);

  if (format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderTextReport(report) + '\n');
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
    const firstLabel = offenders[0]?.projectName ?? `session-${offenders[0]?.id.slice(0, 8) ?? '?'}`;
    const body =
      count === 1
        ? `${firstLabel}: ${offenders[0]!.bucket}`
        : `${count} sessions need attention (e.g. ${firstLabel})`;
    notifier.notifyOnce(body);
    notifier.stop();
  }

  // CI gating. Strict mode flips exit code when any session lands in a
  // "needs attention" bucket. The bucket list deliberately excludes
  // `pending` and `error` — those are infrastructure states, not findings.
  if (strict && report.hasGatingFinding) {
    return 1;
  }
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
    runtime,
    transcriptPath,
    bucket: recap.verdict.bucket,
    confidence: recap.verdict.confidence,
    narrative: recap.narrative,
    signals: [...recap.verdict.signals],
    driftCount: recap.verdict.drifts.length,
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

function renderTextReport(report: OnceReport): string {
  const lines: string[] = [];
  lines.push(`AgentPulse — ${report.sessionCount} session${report.sessionCount === 1 ? '' : 's'} at ${new Date(report.generatedAt).toISOString()}`);

  const bucketParts: string[] = [];
  for (const [b, n] of Object.entries(report.bucketCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
    bucketParts.push(`${b}: ${n}`);
  }
  if (bucketParts.length > 0) {
    lines.push(`  ${bucketParts.join(' · ')}`);
  }
  lines.push('');

  for (const s of report.sessions) {
    const label = s.projectName || `session-${s.id.slice(0, 8)}`;
    const driftSuffix = s.driftCount > 0 ? ` (${s.driftCount} drift)` : '';
    lines.push(`  ${label} [${s.runtime}]  →  ${s.bucket}${driftSuffix}  (confidence ${s.confidence.toFixed(2)})`);
    if (s.error) {
      lines.push(`    error: ${s.error}`);
    } else {
      lines.push(`    ${stripBoldMarkdown(s.narrative).split('\n')[0]}`);
    }
  }

  if (report.hasGatingFinding) {
    lines.push('');
    lines.push(`⚠ ${report.sessions.filter((s) => GATING_BUCKETS.has(s.bucket)).length} session(s) need attention.`);
  }

  return lines.join('\n');
}

function stripBoldMarkdown(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}
