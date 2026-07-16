/**
 * Layer 2.5 — Ordered action-sequence pattern detector.
 *
 * Pure, deterministic, no I/O. Reads a chronologically-ordered list of
 * TranscriptEvents and emits a `SequenceSignal` describing the *shape* of
 * the activity, not just the counts. Layer 2 (`enrichWindow`) counts how
 * many edits / verifications / explorations happened; Layer 2.5 cares
 * about the order they happened in.
 *
 * Four patterns, in priority order:
 *
 *   1. `stuck_loop`        — repeated (edit same file → failing verify).
 *                            High-confidence signal that the agent is
 *                            wedged on one file.
 *   2. `refuse_to_verify`  — editing >= 4 with zero verification events.
 *                            High-risk: writing code without running
 *                            anything.
 *   3. `tdd_loop`          — repeated (editing → verification) cycles
 *                            within a 3-event window. Healthy iteration.
 *   4. `exploratory_edit`  — >=3 consecutive exploration events followed
 *                            by >=1 editing event in the back half of
 *                            the timeline. The agent oriented itself
 *                            before changing anything.
 *
 * Priority: `stuck_loop` > `refuse_to_verify` > `tdd_loop` >
 * `exploratory_edit`. Only the highest-priority match is returned, since
 * a "stuck" reading is more decision-relevant than a co-occurring "tdd"
 * one.
 *
 * Threshold tuning notes:
 *   - tdd_loop: ≥2 cycles to fire (confidence 0.65); ≥3 cycles bumps to
 *     0.85. Pre-tuning: 1 cycle is too noisy (any one edit + nearby test
 *     run would qualify).
 *   - stuck_loop: ≥2 cycles on the SAME file with failing verify each
 *     time. Confidence 0.85 (this is the strongest pattern — explicit
 *     loop on a single file is unambiguous).
 *   - refuse_to_verify: ≥4 edits AND 0 verifications. Confidence 0.7
 *     (count alone is fuzzy — some legitimate sessions edit prose/docs
 *     and have no test command). The classifier layers in further
 *     gating (only flips to stuck when edits ≥ 5).
 *   - exploratory_edit: ≥3 consecutive explorations, ≥1 edit in back
 *     half. Confidence 0.6 (descriptive, not high-stakes — used as a
 *     supporting signal for converging).
 */

import type {
  ActionClass,
  SequencePattern,
  SequenceSignal,
  TranscriptEvent,
} from './types.js';
import {
  canonicalToolName,
  extractFilePath as extractFilePathFromInput,
} from './normalize.js';
import { classifyResultText, isVerificationCommand } from './verification.js';

// ─────────────────────────────────────────────────────────────────────
// Action classification — local copy of the Layer 2 logic, scoped to
// just the classes Layer 2.5 cares about. Keeping this self-contained
// avoids a circular import with src/enrich.ts and avoids re-exporting
// classifyToolUse as a public API.
// ─────────────────────────────────────────────────────────────────────

function classifyEvent(ev: TranscriptEvent): ActionClass | null {
  if (ev.kind !== 'tool_use') return null;
  // v0.6.2: canonicalize so Codex shell + apply_patch register as
  // verification / editing in the sequence detectors. Pre-fix, every
  // Codex transcript fell into the `default` branch and returned null
  // — meaning TDD loops in Codex sessions never fired stuck_loop /
  // tdd_loop, even when the underlying shape was there.
  const name = canonicalToolName(ev.toolName);
  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'exploration';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'editing';
    case 'Bash': {
      const cmd = String(ev.toolInput?.['command'] ?? '');
      return isVerificationCommand(cmd) ? 'verification' : 'other';
    }
    default:
      return null;
  }
}

function extractFilePath(ev: TranscriptEvent): string | undefined {
  // v0.6.2: delegate to the shared normalizer for cross-runtime
  // file-path extraction (Cursor `path`, Anthropic `file_path`, etc.).
  return extractFilePathFromInput(ev.toolInput);
}

/**
 * A verification event "passed" when:
 *   - toolResultExitCode === 0, OR
 *   - no exit code present but result text matches a pass pattern and not a
 *     fail pattern.
 * "Failed" is the converse. `null` = indeterminate (no exit code and the
 * result text matched neither table). `detectStuckLoop` counts only clear
 * failures (`passed === false`) toward a stuck cycle, so an indeterminate
 * outcome never inflates the stuck signal — the conservative direction
 * given how broad result text can be.
 */
function verificationPassed(ev: TranscriptEvent): boolean | null {
  if (typeof ev.toolResultExitCode === 'number') {
    return ev.toolResultExitCode === 0;
  }
  const outcome = classifyResultText(ev.toolResultText);
  if (outcome === null) return null;
  return outcome === 'pass';
}

// ─────────────────────────────────────────────────────────────────────
// Pattern detectors
// ─────────────────────────────────────────────────────────────────────

interface ClassifiedEvent {
  ev: TranscriptEvent;
  cls: ActionClass;
  filePath?: string | undefined;
  /**
   * For verification events only: did the run pass? Resolved at
   * classification time using the linked tool_result (see
   * `resolveVerificationOutcome`). `undefined` for non-verification
   * events; `null` when indeterminate even after linking.
   */
  verifyPassed?: boolean | null;
}

/**
 * Resolve a verification event's pass/fail, falling back to the linked
 * tool_result when the tool_use itself carries no outcome.
 *
 * On real parsed transcripts the parser emits tool_use and tool_result
 * as SEPARATE events and the exit code lives on the tool_result. Reading
 * the outcome off the Bash tool_use alone (as the detectors used to)
 * yielded `null` for every real session — so stuck_loop never fired on
 * anything but the synthetic test shape, silently degrading to tdd_loop.
 * This is the same tool_use-vs-tool_result gap that bit Layer 3's
 * `computeVerificationTrend` in v0.6.1; we mirror its linking here.
 */
function resolveVerificationOutcome(
  ev: TranscriptEvent,
  resultByToolUseId: Map<string, TranscriptEvent>
): boolean | null {
  let outcome = verificationPassed(ev);
  if (outcome === null && ev.toolUseId) {
    const linked = resultByToolUseId.get(ev.toolUseId);
    if (linked) outcome = verificationPassed(linked);
  }
  return outcome;
}

/**
 * Find (editing → verification) cycle count.
 * A "cycle" is an editing event followed by a verification event within
 * the next 3 classified events.
 */
/**
 * v0.5.3: find the next verification event after `startIdx`, skipping
 * over interleaving exploration events (Read / Glob / Grep / LS) without
 * counting them against the look-ahead budget. The budget applies only
 * to non-exploration events.
 *
 * Pre-fix the look-ahead capped at 3 array positions, so an agent that
 * edited a file then read 3 files for context before running tests would
 * MISS the cycle — the verify event was past the window. Real agents do
 * exploration between iterations; skipping it is the right semantics.
 *
 * Returns `-1` when no verification is reachable within the budget.
 */
function findNextVerificationIdx(
  seq: readonly ClassifiedEvent[],
  startIdx: number,
  maxNonExplorationLookahead: number
): number {
  let nonExplorationLookedAt = 0;
  for (let j = startIdx; j < seq.length; j++) {
    const cls = seq[j]!.cls;
    if (cls === 'verification') return j;
    if (cls === 'exploration') continue; // skip; doesn't count toward budget
    nonExplorationLookedAt += 1;
    if (nonExplorationLookedAt >= maxNonExplorationLookahead) return -1;
  }
  return -1;
}

function countEditVerifyCycles(seq: ClassifiedEvent[]): number {
  let cycles = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i]!.cls !== 'editing') continue;
    // v0.5.3: skip-exploration look-ahead — see findNextVerificationIdx
    // header for why this matters.
    const j = findNextVerificationIdx(seq, i + 1, 3);
    if (j >= 0) {
      cycles += 1;
      i = j; // advance past this verify so we don't double-count
    }
  }
  return cycles;
}

/**
 * stuck_loop: ≥2 cycles where the SAME file is edited and the
 * accompanying verification fails. We look for sequences like:
 *   Edit(foo.ts) → Bash(npm test, fail) → Edit(foo.ts) → Bash(npm test, fail)
 * Returns the most-stuck file (highest cycle count) when ≥ 2.
 */
function detectStuckLoop(
  seq: ClassifiedEvent[]
): { file: string; cycles: number } | null {
  const perFile = new Map<string, number>();
  for (let i = 0; i < seq.length; i++) {
    const editEv = seq[i]!;
    if (editEv.cls !== 'editing' || !editEv.filePath) continue;
    // v0.5.3: skip-exploration look-ahead. An agent that edits, reads a
    // few files to figure out what's broken, then runs tests is still
    // executing a stuck loop on the original file — pre-fix we'd miss
    // those cycles entirely.
    const j = findNextVerificationIdx(seq, i + 1, 3);
    if (j < 0) continue;
    const verifyEv = seq[j]!;
    const passed = verifyEv.verifyPassed ?? null;
    // Conservative: only count clear failures. Indeterminate doesn't count
    // as "stuck" (would be a false positive for runners with no parseable
    // output).
    if (passed === false) {
      const file = editEv.filePath;
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    // v0.8.1: consume the verification — advance past it so the NEXT edit
    // pairs with the NEXT verify, exactly like countEditVerifyCycles does.
    // Pre-fix, every edit before a single failing test run matched that
    // same run: Edit(a) → Edit(a) → Bash(npm test, fail) counted as TWO
    // failing cycles and fired stuck_loop (≥2) off ONE test invocation —
    // the first iteration of a perfectly normal TDD session classified as
    // stuck at 0.85 confidence, and `--once --strict` gated on it.
    // A cycle is one edit-run → one verify-run; multiple edits sharing a
    // verify are one cycle, not many.
    i = j;
  }
  // Pick the file with the most failing cycles, but only if ≥ 2.
  let bestFile: string | null = null;
  let bestCycles = 0;
  for (const [file, cycles] of perFile) {
    if (cycles > bestCycles) {
      bestFile = file;
      bestCycles = cycles;
    }
  }
  if (bestFile && bestCycles >= 2) {
    return { file: bestFile, cycles: bestCycles };
  }
  return null;
}

/**
 * Prose file extensions. Edits to these don't count toward the
 * refuse_to_verify threshold — a docs-only session legitimately has no
 * test command to run, so "edited a lot, verified nothing" is the
 * expected shape, not a risk signal. Code edits are what we care about.
 */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.org',
]);

/**
 * Is this edit targeting a prose file? Unknown/missing paths count as
 * code (conservative — we'd rather fire refuse_to_verify on an
 * unclassifiable edit than silently suppress a real "writing code
 * without testing" signal).
 */
function isProseEdit(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return PROSE_EXTENSIONS.has(lower.slice(dot));
}

/**
 * refuse_to_verify: ≥4 *code* editing events with ZERO verification
 * events interleaved anywhere in the window. Prose edits (docs, notes)
 * are excluded from the count — see `isProseEdit` for the rationale.
 */
function detectRefuseToVerify(
  seq: ClassifiedEvent[]
): { edits: number } | null {
  let codeEdits = 0;
  let verifies = 0;
  for (const c of seq) {
    if (c.cls === 'editing') {
      if (!isProseEdit(c.filePath)) codeEdits += 1;
    } else if (c.cls === 'verification') verifies += 1;
  }
  if (codeEdits >= 4 && verifies === 0) return { edits: codeEdits };
  return null;
}

/**
 * exploratory_edit: ≥3 consecutive exploration events then ≥1 editing
 * event in the back half of the (classified) sequence. "Back half" =
 * index >= floor(seq.length / 2).
 */
function detectExploratoryEdit(
  seq: ClassifiedEvent[]
): { explorations: number } | null {
  if (seq.length < 4) return null;
  // Find any run of ≥3 consecutive explorations.
  let bestRun = 0;
  let runStart = -1;
  let curRun = 0;
  let curStart = -1;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i]!.cls === 'exploration') {
      if (curRun === 0) curStart = i;
      curRun += 1;
      if (curRun > bestRun) {
        bestRun = curRun;
        runStart = curStart;
      }
    } else {
      curRun = 0;
      curStart = -1;
    }
  }
  if (bestRun < 3) return null;
  // Need ≥1 editing in the back half AND after the exploration run ends.
  const backHalfStart = Math.floor(seq.length / 2);
  const runEnd = runStart + bestRun - 1;
  const editingAfter = seq.some(
    (c, i) => c.cls === 'editing' && i > runEnd && i >= backHalfStart
  );
  if (!editingAfter) return null;
  return { explorations: bestRun };
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────

/**
 * Analyze the temporal shape of a window's events and emit a
 * SequenceSignal. Pure: same input → same output. Stable timestamp tie-
 * breaking (preserves input order for equal timestamps via a stable sort
 * key).
 */
export function analyzeSequences(events: TranscriptEvent[]): SequenceSignal {
  if (!events || events.length === 0) {
    return emptySignal();
  }

  // Sort chronologically. Use index as secondary key for stable order.
  const indexed = events.map((ev, i) => ({ ev, i }));
  indexed.sort((a, b) => {
    if (a.ev.timestamp !== b.ev.timestamp) {
      return a.ev.timestamp - b.ev.timestamp;
    }
    return a.i - b.i;
  });
  const sorted = indexed.map((x) => x.ev);

  // Link tool_result exit codes to their tool_use by id, so verification
  // outcomes resolve on real transcripts (where the exit code lives on the
  // separate tool_result). See `resolveVerificationOutcome`.
  const resultByToolUseId = new Map<string, TranscriptEvent>();
  for (const ev of sorted) {
    if (ev.kind === 'tool_result' && ev.toolUseId) {
      resultByToolUseId.set(ev.toolUseId, ev);
    }
  }

  // Classify each event; drop those that don't belong to our domain.
  const seq: ClassifiedEvent[] = [];
  for (const ev of sorted) {
    const cls = classifyEvent(ev);
    if (cls === null) continue;
    // Only retain classes Layer 2.5 cares about (drop 'other'/'external'/etc.
    // to keep the "next-3-events" window meaningful).
    if (cls !== 'editing' && cls !== 'verification' && cls !== 'exploration') {
      continue;
    }
    const entry: ClassifiedEvent = { ev, cls, filePath: extractFilePath(ev) };
    if (cls === 'verification') {
      entry.verifyPassed = resolveVerificationOutcome(ev, resultByToolUseId);
    }
    seq.push(entry);
  }

  if (seq.length === 0) {
    return emptySignal();
  }

  // 1. stuck_loop — highest priority. Repeated failures on the same file
  //    is the strongest negative signal.
  const stuck = detectStuckLoop(seq);
  if (stuck) {
    return {
      pattern: 'stuck_loop' as SequencePattern,
      confidence: 0.85,
      cycleCount: stuck.cycles,
      primaryFile: stuck.file,
      details: [
        `${stuck.cycles} failing edit→verify cycles on ${stuck.file}`,
      ],
    };
  }

  // 2. refuse_to_verify — editing without running anything.
  const refuse = detectRefuseToVerify(seq);
  if (refuse) {
    return {
      pattern: 'refuse_to_verify' as SequencePattern,
      confidence: 0.7,
      details: [
        `${refuse.edits} edits with no verification events in the window`,
      ],
    };
  }

  // 3. tdd_loop — healthy iteration shape.
  const cycles = countEditVerifyCycles(seq);
  if (cycles >= 2) {
    // 2 cycles → 0.65, 3+ cycles → 0.85. Smooth ramp would be:
    //   confidence = min(0.85, 0.5 + cycles * 0.1)
    const confidence = Math.min(0.85, 0.5 + cycles * 0.1);
    return {
      pattern: 'tdd_loop' as SequencePattern,
      confidence,
      cycleCount: cycles,
      details: [`${cycles} edit→verify cycles in tight succession`],
    };
  }

  // 4. exploratory_edit — read first, edit later.
  const expl = detectExploratoryEdit(seq);
  if (expl) {
    return {
      pattern: 'exploratory_edit' as SequencePattern,
      confidence: 0.6,
      details: [
        `${expl.explorations} consecutive explorations before editing began`,
      ],
    };
  }

  return emptySignal();
}

function emptySignal(): SequenceSignal {
  return { pattern: 'none', confidence: 0, details: [] };
}
