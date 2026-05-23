/**
 * AgentPulse Layer 3 (outcome signal) + Layer 4 (trajectory classifier).
 *
 * Pure, deterministic, no I/O. Reads an EnrichedWindow and emits a
 * five-bucket verdict + the structured signals that justify it.
 *
 * Layer 3 — readOutcomeSignal: looks at verification runs, the most recent
 * user message, and the most recent assistant message to characterize "how
 * are we feeling about this window".
 *
 * Layer 4 — classifyTrajectory: priority-ordered decision tree against
 * Layer 2 + Layer 3 outputs, with a lightweight drift check up front.
 */

import type { Finding } from 'agent-gov-core';
import type {
  EnrichedWindow,
  OutcomeSignal,
  TrajectoryBucket,
  TrajectoryOptions,
  TrajectoryVerdict,
  TranscriptEvent,
  UserToneTrend,
  VerificationTrend,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────
// Layer 3 — outcome signal
// ─────────────────────────────────────────────────────────────────────

/** Verification command verbs that warrant trend-tracking. */
const VERIFICATION_HINTS = [
  'test',
  'jest',
  'mocha',
  'vitest',
  'pytest',
  'lint',
  'eslint',
  'tsc',
  'typecheck',
  'type-check',
  'build',
  'cargo test',
  'cargo check',
  'go test',
  'npm test',
  'pnpm test',
  'yarn test',
  'make test',
  'make check',
  'rspec',
  'phpunit',
];

const FAIL_PATTERNS: RegExp[] = [
  /\bFAIL\b/,
  /\bFAILED\b/,
  /\bfailing\b/i,
  /\d+\s+failed\b/i,
  /\bTests?:\s*\d+\s*failed/i,
  /\berror\b/i,
];

const PASS_PATTERNS: RegExp[] = [
  /\bpassing\b/i,
  /\bPASS\b/,
  /\bPASSED\b/,
  /\bTests?:\s*\d+\s*passed/i,
  /\d+\s+passed\b/i,
  /\bok\s+\d+/i,
];

const AFFIRMING_TOKENS = [
  'thanks',
  'thank you',
  'perfect',
  'that works',
  'great',
  'nice',
  'done',
];

const CORRECTING_TOKENS = [
  'no',
  'wrong',
  'still',
  'again',
  'not quite',
];

const QUESTION_LEAD = /^(why|how|what|when|where|can|could|would|should|is|are|do|does)\b/i;

const COMPLETION_VERBS: RegExp[] = [
  /\bdone\b/i,
  /\bfixed\b/i,
  /\bcompleted\b/i,
  /\ball set\b/i,
  /that should do it/i,
  /that's it\b/i,
  /you're set\b/i,
  /\bready to\b/i,
  /now you can\b/i,
];

/**
 * Decide whether a single Bash tool_use looks like a verification command.
 * We tolerate either a populated `toolResultExitCode`, in which case the
 * exit code wins, or a textual heuristic over the command/result.
 */
function isVerificationEvent(ev: TranscriptEvent): boolean {
  if (ev.kind !== 'tool_use' || ev.toolName !== 'Bash') return false;
  const cmd = String(
    (ev.toolInput && (ev.toolInput.command as unknown)) ?? ''
  ).toLowerCase();
  if (!cmd) return false;
  return VERIFICATION_HINTS.some((h) => cmd.includes(h));
}

/**
 * Classify the outcome of a single verification event.
 *  - exit code wins when present (0 = pass, nonzero = fail)
 *  - otherwise fall back to textual patterns in the result body
 *  - returns null when we can't tell — those events are skipped
 */
function verificationOutcome(ev: TranscriptEvent): 'pass' | 'fail' | null {
  if (typeof ev.toolResultExitCode === 'number') {
    return ev.toolResultExitCode === 0 ? 'pass' : 'fail';
  }
  const text = ev.toolResultText ?? '';
  if (!text) return null;
  const hasFail = FAIL_PATTERNS.some((re) => re.test(text));
  const hasPass = PASS_PATTERNS.some((re) => re.test(text));
  // If both fire (e.g. "1 failed, 3 passed"), the failure dominates — that's
  // how every test runner reports a red build.
  if (hasFail) return 'fail';
  if (hasPass) return 'pass';
  return null;
}

function computeVerificationTrend(events: TranscriptEvent[]): VerificationTrend {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const outcomes: ('pass' | 'fail')[] = [];
  for (const ev of sorted) {
    if (!isVerificationEvent(ev)) continue;
    const o = verificationOutcome(ev);
    if (o) outcomes.push(o);
  }
  if (outcomes.length === 0) return 'no_data';
  const first = outcomes[0]!;
  const last = outcomes[outcomes.length - 1]!;
  const anyFail = outcomes.includes('fail');
  const anyPass = outcomes.includes('pass');
  if (first === 'fail' && last === 'pass') return 'improving';
  if (first === 'pass' && last === 'fail') return 'regressing';
  if (anyPass && !anyFail) return 'flat_pass';
  if (anyFail && !anyPass) return 'flat_fail';
  // Mixed but neither monotonic — bias to the latest result.
  return last === 'pass' ? 'flat_pass' : 'flat_fail';
}

function findMostRecent(
  events: TranscriptEvent[],
  kind: TranscriptEvent['kind']
): TranscriptEvent | null {
  let best: TranscriptEvent | null = null;
  for (const ev of events) {
    if (ev.kind !== kind) continue;
    if (best === null || ev.timestamp > best.timestamp) best = ev;
  }
  return best;
}

function computeUserToneTrend(events: TranscriptEvent[]): UserToneTrend {
  const latest = findMostRecent(events, 'user_message');
  if (!latest) return 'idle';
  const text = (latest.text ?? '').trim();
  if (!text) return 'neutral';
  const lower = text.toLowerCase();

  // Affirming wins over question/correcting when explicit — "thanks, that
  // works" is unambiguous even if it ends in a comma. Word-boundary anchored
  // to keep "noted" from triggering "no".
  if (AFFIRMING_TOKENS.some((tok) => wordContains(lower, tok))) return 'affirming';

  // Correcting: bare "no" or sentence-start "but ..." or any of the other
  // negation cues.
  if (
    CORRECTING_TOKENS.some((tok) => wordContains(lower, tok)) ||
    /^but\b/i.test(text) ||
    /[.!?]\s+but\b/i.test(text)
  ) {
    return 'correcting';
  }

  if (text.endsWith('?') || QUESTION_LEAD.test(text)) return 'questioning';
  return 'neutral';
}

/** Word-boundary contains. Treats spaces as boundaries on either side. */
function wordContains(haystack: string, needle: string): boolean {
  // Escape regex metacharacters in the token — none of ours contain any, but
  // belt-and-braces in case the list grows.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(haystack);
}

function computeCompletionVerbsRecent(events: TranscriptEvent[]): boolean {
  const latest = findMostRecent(events, 'assistant_message');
  if (!latest) return false;
  const text = latest.text ?? '';
  if (!text) return false;
  return COMPLETION_VERBS.some((re) => re.test(text));
}

function computeIdleGapMs(enriched: EnrichedWindow): number {
  const latestUser = findMostRecent(enriched.events, 'user_message');
  if (!latestUser) return enriched.windowEnd - enriched.windowStart;
  return Math.max(0, enriched.windowEnd - latestUser.timestamp);
}

export function readOutcomeSignal(enriched: EnrichedWindow): OutcomeSignal {
  return {
    verificationTrend: computeVerificationTrend(enriched.events),
    userToneTrend: computeUserToneTrend(enriched.events),
    completionVerbsRecent: computeCompletionVerbsRecent(enriched.events),
    idleGapMs: computeIdleGapMs(enriched),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Layer 4 — trajectory classifier
// ─────────────────────────────────────────────────────────────────────

const PRIVILEGED_PATH_RULES: { pattern: RegExp; slug: string; label: string }[] = [
  { pattern: /(^|[\\/])\.ssh([\\/]|$)/, slug: 'ssh_path', label: '.ssh directory' },
  { pattern: /(^|[\\/])\.aws([\\/]|$)/, slug: 'aws_path', label: '.aws directory' },
  { pattern: /(^|[\\/])\.kube([\\/]|$)/, slug: 'kube_path', label: '.kube directory' },
  { pattern: /^\/etc\/shadow(\/|$)/, slug: 'etc_shadow', label: '/etc/shadow' },
  { pattern: /^\/private\/var(\/|$)/, slug: 'private_var', label: '/private/var' },
];

const SHELL_EXFIL_RE =
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i;

/**
 * Paths the spec treats as "outside the implicit repo root":
 *   - /tmp/...
 *   - /var/...
 *   - ~/... (home-relative)
 * We can't reliably know the cwd from the event alone, so we apply this rule
 * to Write tool_use events targeting these prefixes. False positives are
 * acceptable here — the v0.1 detector is meant to be a stand-in for the
 * real gov-suite scan.
 */
const OUTSIDE_REPO_RE = /^(\/tmp\/|\/var\/|~\/)/;

function buildDrift(
  slug: string,
  message: string,
  ev: TranscriptEvent,
  filePath?: string
): Finding {
  // The spec asks for kind `agent_pulse.live_drift_<slug>`. The shared
  // schema's tool enum is closed (no `agent_pulse`), so we set `tool` to the
  // closest fit (`session_trail` — live session drift) and carry the
  // requested namespace verbatim in `kind`. Constructing the literal
  // satisfies the `Finding` interface; the validator would reject the kind
  // pattern, but that's a known v0.1 compromise.
  const drift: Finding = {
    tool: 'session_trail',
    kind: `agent_pulse.live_drift_${slug}`,
    severity: 'high',
    message,
    data: {
      timestamp: ev.timestamp,
      toolName: ev.toolName ?? null,
    },
  };
  if (filePath) drift.location = { file: filePath };
  return drift;
}

function extractFilePath(ev: TranscriptEvent): string | undefined {
  const input = ev.toolInput;
  if (!input || typeof input !== 'object') return undefined;
  const candidate =
    (input as Record<string, unknown>).file_path ??
    (input as Record<string, unknown>).path ??
    (input as Record<string, unknown>).filePath ??
    (input as Record<string, unknown>).notebook_path;
  return typeof candidate === 'string' ? candidate : undefined;
}

function detectDrifts(events: TranscriptEvent[]): {
  drifts: Finding[];
  signals: string[];
} {
  const drifts: Finding[] = [];
  const signals: string[] = [];
  for (const ev of events) {
    if (ev.kind !== 'tool_use') continue;

    // Privileged path check applies to any tool_use touching a file (Read,
    // Edit, Write, Glob, …) — privilege is about the path, not the verb.
    const filePath = extractFilePath(ev);
    if (filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      for (const rule of PRIVILEGED_PATH_RULES) {
        if (rule.pattern.test(normalized)) {
          drifts.push(
            buildDrift(
              rule.slug,
              `${ev.toolName ?? 'tool'} touched privileged path (${rule.label}): ${filePath}`,
              ev,
              filePath
            )
          );
          signals.push(`privileged path: ${rule.label}`);
          break;
        }
      }
    }

    if (ev.toolName === 'Bash') {
      const cmd = String(
        (ev.toolInput && (ev.toolInput.command as unknown)) ?? ''
      );
      if (cmd && SHELL_EXFIL_RE.test(cmd)) {
        drifts.push(
          buildDrift(
            'shell_exfil',
            `Bash piped network fetch into a shell: ${truncate(cmd, 120)}`,
            ev
          )
        );
        signals.push('curl|wget piped to shell');
      }
    }

    if (ev.toolName === 'Write' && filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      if (OUTSIDE_REPO_RE.test(normalized)) {
        drifts.push(
          buildDrift(
            'outside_repo_write',
            `Write to path outside repo root: ${filePath}`,
            ev,
            filePath
          )
        );
        signals.push(`write outside repo: ${filePath}`);
      }
    }
  }
  return { drifts, signals };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function topClusterShare(
  clusters: Record<string, number>
): { share: number; top: string | null; total: number } {
  let total = 0;
  let topKey: string | null = null;
  let topCount = 0;
  for (const [k, v] of Object.entries(clusters)) {
    total += v;
    if (v > topCount) {
      topCount = v;
      topKey = k;
    }
  }
  const share = total > 0 ? topCount / total : 0;
  return { share, top: topKey, total };
}

function firstEditedFile(enriched: EnrichedWindow): string | null {
  return enriched.primaryFiles[0] ?? null;
}

export function classifyTrajectory(
  enriched: EnrichedWindow,
  outcome: OutcomeSignal,
  opts?: TrajectoryOptions
): TrajectoryVerdict {
  const editing = enriched.actionCounts.editing ?? 0;
  const exploration = enriched.actionCounts.exploration ?? 0;
  const cluster = topClusterShare(enriched.pathClusters);

  // 1. Drifting — first priority. Detectors are on by default.
  if (opts?.detectorsEnabled !== false) {
    const { drifts, signals } = detectDrifts(enriched.events);
    if (drifts.length > 0) {
      return makeVerdict('drifting', 0.9, uniq(signals).slice(0, 4), drifts);
    }
  }

  // 2. Done — completion verb + idle gap + not actively being corrected.
  if (
    outcome.completionVerbsRecent &&
    outcome.idleGapMs > 60_000 &&
    outcome.userToneTrend !== 'correcting'
  ) {
    const signals: string[] = [
      `assistant emitted completion verb in last reply`,
      `idle for ${formatMs(outcome.idleGapMs)} after that`,
    ];
    if (outcome.verificationTrend === 'flat_pass') {
      signals.push('verifications all passing');
    } else if (outcome.verificationTrend === 'improving') {
      signals.push('tests recovered to green');
    }
    return makeVerdict('done', 0.85, signals.slice(0, 4), []);
  }

  // 3. Stuck — heavy editing + verifications not improving + user pushing back.
  const stuckHardSignal =
    editing >= 3 &&
    outcome.verificationTrend === 'flat_fail' &&
    outcome.userToneTrend === 'correcting';
  const stuckSoftSignal =
    editing >= 5 &&
    (outcome.verificationTrend === 'flat_fail' ||
      outcome.verificationTrend === 'regressing');
  if (stuckHardSignal || stuckSoftSignal) {
    const target = firstEditedFile(enriched);
    const signals: string[] = [
      `${editing} edits${target ? ` (top file: ${target})` : ''}`,
      outcome.verificationTrend === 'regressing'
        ? 'tests went from passing to failing'
        : 'tests still failing',
    ];
    if (outcome.userToneTrend === 'correcting') {
      signals.push('user is correcting the agent');
    }
    return makeVerdict('stuck', stuckHardSignal ? 0.8 : 0.7, signals.slice(0, 4), []);
  }

  // 4. Converging — editing happening, tests recovering, focus narrowing.
  if (
    editing >= 1 &&
    outcome.verificationTrend === 'improving' &&
    cluster.share >= 0.6 &&
    cluster.top
  ) {
    const pct = Math.round(cluster.share * 100);
    const signals: string[] = [
      `${editing} edit${editing === 1 ? '' : 's'} in window`,
      'tests went from failing to passing',
      `top cluster ${cluster.top} covers ${pct}% of activity`,
    ];
    return makeVerdict('converging', 0.85, signals.slice(0, 4), []);
  }

  // 4b. Converging (no verification signal) — v0.2.2 patch.
  //
  // The original converging rule required `verificationTrend === 'improving'`,
  // which means heavy editing without test data (or in repos with no test
  // command at all) would fall all the way through to the 0.3-confidence
  // exploring fallback. That misclassified obviously-productive sessions —
  // 40 edits across one cluster is not "exploring", it's converging without
  // a verification proxy.
  //
  // Heuristic: a "productive editing session" is editing >= 5 with either
  // a narrowed cluster (top >= 50%) OR a clear primary file. Confidence is
  // medium (0.6) because we can't see the outcome, only the activity shape.
  if (editing >= 5 && (cluster.share >= 0.5 || enriched.primaryFiles.length >= 1)) {
    const pct = Math.round(cluster.share * 100);
    const signals: string[] = [`${editing} edits in window`];
    if (cluster.top && cluster.share >= 0.5) {
      signals.push(`top cluster ${cluster.top} covers ${pct}% of activity`);
    }
    if (enriched.primaryFiles.length > 0) {
      signals.push(`primary file: ${enriched.primaryFiles[0]}`);
    }
    signals.push('no verification data — confidence reflects that');
    return makeVerdict('converging', 0.6, signals.slice(0, 4), []);
  }

  // 5. Exploring — no edits, lots of reads/searches.
  if (editing === 0 && exploration >= 3) {
    const signals: string[] = [
      `${exploration} exploration actions`,
      'no edits yet',
    ];
    if (cluster.top) {
      const pct = Math.round(cluster.share * 100);
      signals.push(`browsing ${cluster.top} (${pct}% of tool calls)`);
    }
    if (outcome.userToneTrend === 'questioning') {
      signals.push('user asked a question');
    }
    return makeVerdict('exploring', 0.7, signals.slice(0, 4), []);
  }

  // 6. Fallback — low-confidence exploring with a transparent "we don't know"
  // signal so the renderer can hedge.
  const fallbackSignals: string[] = [
    `${exploration} exploration / ${editing} editing actions`,
    `verifications: ${outcome.verificationTrend}`,
    `user tone: ${outcome.userToneTrend}`,
    'no decisive signal — defaulting to exploring',
  ];
  return makeVerdict('exploring', 0.3, fallbackSignals.slice(0, 4), []);
}

function makeVerdict(
  bucket: TrajectoryBucket,
  confidence: number,
  signals: string[],
  drifts: Finding[]
): TrajectoryVerdict {
  return { bucket, confidence, signals, drifts };
}

function uniq(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}
