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
import { fingerprintFinding } from 'agent-gov-core';
import type {
  EnrichedWindow,
  OutcomeSignal,
  SequenceSignal,
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

/**
 * v0.3.2: anchor `curl|wget` at command start (or right after a `&&` / `;` /
 * `||` / `|` subcommand separator) so the regex matches AS THE COMMAND, not
 * as embedded content inside quoted args.
 *
 * Pre-fix, a `gh release create --notes "...curl ... | sh..."` (the literal
 * command shipped while writing release notes about the drift detector
 * itself) tripped the rule — the regex scanned anywhere in the command
 * string. The actual executed binary was `gh`, not curl. False positive.
 *
 * The shape: `(curl|wget)` must sit at line start or right after a shell
 * separator, with no quote chars or pipe between curl and the pipe-to-shell.
 * False positives drop substantially. The remaining miss-case is content at
 * start-of-line inside a heredoc, which would need real shell tokenization
 * to catch and isn't worth the complexity here.
 */
const SHELL_EXFIL_RE =
  /(?:^|[;&|]\s*)(?:sudo\s+)?(curl|wget)\b[^\n|'"]*\|\s*(?:sudo\s+)?(sh|bash|zsh)\b/i;

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

/**
 * v0.3.1: when a repoRoot is provided, anything outside it counts as
 * outside-repo (the whole point of repo-rooted gating). Normalizes Windows
 * backslashes and drive-letter case so a write to `C:/Dev/Other/foo.py`
 * from a session rooted at `c:\dev\fit-ontology` correctly flags as drift.
 */
function isOutsideRepoRoot(filePath: string, repoRoot: string): boolean {
  const norm = (s: string): string =>
    s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = norm(filePath);
  const r = norm(repoRoot);
  if (r.length === 0) return false;
  // Treat the root itself as "inside" — a Write to the project dir is fine.
  if (f === r) return false;
  return !f.startsWith(r + '/');
}

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
  // v0.4.1: stamp a deterministic fingerprint so the exception baseline
  // can match this finding by id across refreshes. agent-gov-core hashes
  // (kind, file, line, column, salientKey) — same finding on the same site
  // produces the same fingerprint, which is exactly what we want for
  // dedupe-against-baseline semantics.
  drift.fingerprint = fingerprintFinding(drift);
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

function detectDrifts(
  events: TranscriptEvent[],
  repoRoot?: string,
  exceptions?: Set<string>
): {
  drifts: Finding[];
  signals: string[];
} {
  const drifts: Finding[] = [];
  const signals: string[] = [];

  // v0.4.1: helper that pairs a drift with its signal and applies the
  // exception baseline. When a drift's fingerprint is in the user-approved
  // set, BOTH the finding and its matching signal are dropped — otherwise
  // the signal would still surface in `verdict.signals` and leak the
  // suppressed concern back into the narrative.
  function pushIfNotExcepted(drift: Finding, signal: string): void {
    if (drift.fingerprint && exceptions?.has(drift.fingerprint)) return;
    drifts.push(drift);
    signals.push(signal);
  }

  for (const ev of events) {
    if (ev.kind !== 'tool_use') continue;

    // Privileged path check applies to any tool_use touching a file (Read,
    // Edit, Write, Glob, …) — privilege is about the path, not the verb.
    const filePath = extractFilePath(ev);
    if (filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      for (const rule of PRIVILEGED_PATH_RULES) {
        if (rule.pattern.test(normalized)) {
          pushIfNotExcepted(
            buildDrift(
              rule.slug,
              `${ev.toolName ?? 'tool'} touched privileged path (${rule.label}): ${filePath}`,
              ev,
              filePath
            ),
            `privileged path: ${rule.label}`
          );
          break;
        }
      }
    }

    if (ev.toolName === 'Bash') {
      const cmd = String(
        (ev.toolInput && (ev.toolInput.command as unknown)) ?? ''
      );
      if (cmd && SHELL_EXFIL_RE.test(cmd)) {
        pushIfNotExcepted(
          buildDrift(
            'shell_exfil',
            `Bash piped network fetch into a shell: ${truncate(cmd, 120)}`,
            ev
          ),
          'curl|wget piped to shell'
        );
      }
    }

    if (ev.toolName === 'Write' && filePath) {
      // v0.3.1: prefer repoRoot-relative comparison when available; fall back
      // to the legacy hardcoded-prefix check for backwards compat with
      // callers that don't pass a repo root yet.
      const normalized = filePath.replace(/\\/g, '/');
      const outsideRepo = repoRoot
        ? isOutsideRepoRoot(filePath, repoRoot)
        : OUTSIDE_REPO_RE.test(normalized);
      if (outsideRepo) {
        pushIfNotExcepted(
          buildDrift(
            'outside_repo_write',
            `Write to path outside repo root: ${filePath}`,
            ev,
            filePath
          ),
          `write outside repo: ${filePath}`
        );
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

/**
 * v0.3.2: count how many times a given file was edited in the window. Used
 * by the tightened Rule 4b (converging without verification) — we want to
 * see real focus on the primary file, not just "primary file exists".
 */
function countEditsTo(events: TranscriptEvent[], filePath: string): number {
  if (!filePath) return 0;
  const target = filePath.replace(/\\/g, '/');
  let count = 0;
  for (const ev of events) {
    if (ev.kind !== 'tool_use') continue;
    if (ev.toolName !== 'Edit' && ev.toolName !== 'Write' && ev.toolName !== 'NotebookEdit') continue;
    const fp = extractFilePath(ev);
    if (!fp) continue;
    if (fp.replace(/\\/g, '/') === target) count += 1;
  }
  return count;
}

/**
 * v0.2.6: how stale the most recent event can be before we flip the verdict
 * to `idle`. 5 minutes is short enough that an actively-running agent always
 * registers as active (refresh happens every 30s by default, so the window
 * gets new events well before this threshold), and long enough that brief
 * thinking pauses don't flicker the verdict between converging and idle.
 */
const IDLE_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000;

/** Find the most recent event timestamp in the window. Returns 0 when the
 *  window has no events. */
function mostRecentEventMs(enriched: EnrichedWindow): number {
  let max = 0;
  for (const ev of enriched.events) {
    if (typeof ev.timestamp === 'number' && ev.timestamp > max) {
      max = ev.timestamp;
    }
  }
  return max;
}

export function classifyTrajectory(
  enriched: EnrichedWindow,
  outcome: OutcomeSignal,
  opts?: TrajectoryOptions
): TrajectoryVerdict {
  const editing = enriched.actionCounts.editing ?? 0;
  const exploration = enriched.actionCounts.exploration ?? 0;
  const cluster = topClusterShare(enriched.pathClusters);
  // v0.3.2: Layer 2.5 sequence signal. When supplied, it influences a few
  // specific rules below — stuck_loop overrides Rule 3 stuck, tdd_loop
  // bumps converging confidence, refuse_to_verify flips bucket on heavy
  // editing, exploratory_edit adds a supporting signal. The signal also
  // rides on the verdict so the narrative renderer can append a phrase.
  const sequence = opts?.sequence;

  // 1. Drifting — first priority. Detectors are on by default. Drift findings
  //    are worth surfacing even if the agent has technically gone quiet.
  // v0.4.1: optional exceptions set filters out user-approved fingerprints
  // BEFORE the bucket-rule check, so an exempted finding doesn't flip the
  // verdict to `drifting` on its own.
  if (opts?.detectorsEnabled !== false) {
    const { drifts, signals } = detectDrifts(
      enriched.events,
      opts?.repoRoot,
      opts?.exceptions
    );
    if (drifts.length > 0) {
      return makeVerdict('drifting', 0.9, uniq(signals).slice(0, 4), drifts, sequence);
    }
  }

  // 2. Idle — the most recent event is more than 5 minutes old AND no
  //    completion verb was emitted.
  //
  //    v0.2.7 widened: previously this required `toolInvocationCount > 0`,
  //    so a totally-silent window fell through to the "no decisive signal"
  //    exploring fallback. That was backwards — an empty window is the
  //    CLEAREST case of idle, not the most ambiguous. Now fires for both:
  //      - empty windows (no events at all → freshness is Infinity)
  //      - stale windows (had activity earlier, none in last 5 min)
  //
  //    Confidence is higher for empty windows (we KNOW nothing's happening)
  //    than for the had-activity-then-stopped case (could be a brief pause).
  //
  //    If a completion verb WAS emitted, fall through to rule 3 (`done`)
  //    which is the more specific "the agent signed off" state.
  const lastEventMs = mostRecentEventMs(enriched);
  const freshnessMs = lastEventMs > 0 ? enriched.windowEnd - lastEventMs : Infinity;
  if (freshnessMs > IDLE_FRESHNESS_THRESHOLD_MS && !outcome.completionVerbsRecent) {
    const signals: string[] = [];
    const isEmpty = enriched.toolInvocationCount === 0 && enriched.userMessageCount === 0;
    if (isEmpty) {
      signals.push('no events in the window at all');
    } else {
      signals.push(`last activity ${formatMs(freshnessMs)} ago`);
      if (enriched.toolInvocationCount > 0) {
        signals.push(
          `${enriched.toolInvocationCount} tool invocation${enriched.toolInvocationCount === 1 ? '' : 's'} earlier in the window`
        );
      }
      if (editing > 0) {
        signals.push(`${editing} edit${editing === 1 ? '' : 's'} before going quiet`);
      }
      if (cluster.top && cluster.share >= 0.5) {
        signals.push(`focus was on ${cluster.top}`);
      }
    }
    // Higher confidence on truly-empty windows — we have unambiguous data.
    return makeVerdict('idle', isEmpty ? 0.85 : 0.75, signals.slice(0, 4), [], sequence);
  }

  // 2.5. stuck_loop sequence (Layer 2.5) — fires BEFORE Rule 3 Done because
  // a tight loop on the same file with failing tests is the strongest stuck
  // signal we have, regardless of whether the agent emitted a completion
  // verb. Confidence 0.85; signals prepended so the loop is the headline.
  if (sequence?.pattern === 'stuck_loop' && (sequence.cycleCount ?? 0) >= 2) {
    const signals: string[] = [
      `stuck on ${sequence.primaryFile ?? 'the same file'} (${sequence.cycleCount} failing cycles)`,
      ...sequence.details,
    ];
    if (editing > 0) signals.push(`${editing} total edits in window`);
    return makeVerdict('stuck', 0.85, signals.slice(0, 4), [], sequence);
  }

  // 3. Done — completion verb + idle gap + not actively being corrected.
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
    return makeVerdict('done', 0.85, signals.slice(0, 4), [], sequence);
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
  // v0.3.2: refuse_to_verify + editing ≥ 5 also flips to stuck even
  // without a flat_fail signal. The whole point: we have no verification
  // data because the agent never ran any.
  const refuseToVerifyStuck =
    sequence?.pattern === 'refuse_to_verify' && editing >= 5;
  if (stuckHardSignal || stuckSoftSignal || refuseToVerifyStuck) {
    const target = firstEditedFile(enriched);
    const signals: string[] = [];
    if (refuseToVerifyStuck) {
      signals.push(
        `${editing} edits with no verification — agent isn't running anything`
      );
      signals.push(...sequence!.details);
    } else {
      signals.push(`${editing} edits${target ? ` (top file: ${target})` : ''}`);
      signals.push(
        outcome.verificationTrend === 'regressing'
          ? 'tests went from passing to failing'
          : 'tests still failing'
      );
      if (outcome.userToneTrend === 'correcting') {
        signals.push('user is correcting the agent');
      }
    }
    const confidence = stuckHardSignal ? 0.8 : refuseToVerifyStuck ? 0.75 : 0.7;
    return makeVerdict('stuck', confidence, signals.slice(0, 4), [], sequence);
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
    // v0.3.2: tdd_loop (≥3 cycles) on top of a converging shape bumps
    // confidence to 0.9 — the explicit iteration loop is a stronger
    // signal than just "edits + improving tests".
    let confidence = 0.85;
    if (sequence?.pattern === 'tdd_loop' && (sequence.cycleCount ?? 0) >= 3) {
      confidence = 0.9;
      signals.unshift(
        `tight TDD loop (${sequence.cycleCount} edit→verify cycles)`
      );
    }
    // v0.3.2: exploratory_edit adds a supporting signal when both fire.
    if (sequence?.pattern === 'exploratory_edit') {
      signals.push(
        `explored ${sequence.details[0] ?? 'the area'} before editing`
      );
    }
    return makeVerdict('converging', confidence, signals.slice(0, 4), [], sequence);
  }

  // 4b. Converging (no verification signal) — v0.2.2 → v0.3.2.
  //
  // Original v0.2.2 rule fired on `editing >= 5 + (cluster >= 50% OR
  // primaryFile)`. Gemini's review called this out as too aggressive: an
  // agent thrashing one file (5+ edits, primaryFile set) would fire even
  // without focused intent. v0.3.2 tightens to: editing >= 5 AND cluster
  // share >= 70% AND primary file edited at least 3 times. That's
  // "productive editing on a focused area," not "lots of unfocused edits
  // somewhere."
  //
  // Confidence stays at 0.6 because verification signal is still absent —
  // we're inferring intent from shape, not outcome.
  const primaryFileEditCount = enriched.primaryFiles[0]
    ? countEditsTo(enriched.events, enriched.primaryFiles[0])
    : 0;
  if (
    editing >= 5 &&
    cluster.share >= 0.7 &&
    cluster.top &&
    primaryFileEditCount >= 3
  ) {
    const pct = Math.round(cluster.share * 100);
    const signals: string[] = [
      `${editing} edits in window`,
      `top cluster ${cluster.top} covers ${pct}% of activity`,
      `primary file ${enriched.primaryFiles[0]} edited ${primaryFileEditCount} times`,
      'no verification data — confidence reflects that',
    ];
    return makeVerdict('converging', 0.6, signals.slice(0, 4), [], sequence);
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
    return makeVerdict('exploring', 0.7, signals.slice(0, 4), [], sequence);
  }

  // 6. Fallback — low-confidence exploring with a transparent "we don't know"
  // signal so the renderer can hedge.
  const fallbackSignals: string[] = [
    `${exploration} exploration / ${editing} editing actions`,
    `verifications: ${outcome.verificationTrend}`,
    `user tone: ${outcome.userToneTrend}`,
    'no decisive signal — defaulting to exploring',
  ];
  return makeVerdict('exploring', 0.3, fallbackSignals.slice(0, 4), [], sequence);
}

function makeVerdict(
  bucket: TrajectoryBucket,
  confidence: number,
  signals: string[],
  drifts: Finding[],
  sequence?: SequenceSignal
): TrajectoryVerdict {
  const v: TrajectoryVerdict = { bucket, confidence, signals, drifts };
  // Only attach when there's a meaningful pattern. `none` is omitted so
  // downstream consumers don't have to special-case it.
  if (sequence && sequence.pattern !== 'none') {
    v.sequence = sequence;
  }
  return v;
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
