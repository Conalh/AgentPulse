/**
 * AgentPulse interface contracts.
 *
 * These types are the synthesis surface between the five layers. Each layer
 * consumes the previous layer's output and produces the next layer's input.
 * Keep this file stable across parallel development — drift here breaks
 * everyone else.
 *
 * Layer 1 → TranscriptEvent[]              (parser, in src/parser.ts)
 * Layer 2 → EnrichedWindow                  (enrichment, in src/enrich.ts)
 * Layer 3 → OutcomeSignal                   (outcome read, in src/trajectory.ts)
 * Layer 4 → TrajectoryVerdict               (verdict classifier, in src/trajectory.ts)
 * Layer 5 → PulseRecap                      (narrative + CLI, in src/narrative.ts + src/cli.ts)
 */

import type { Finding } from 'agent-gov-core';

// ─────────────────────────────────────────────────────────────────────
// Layer 1 — Parser output
// ─────────────────────────────────────────────────────────────────────

export type Runtime = 'claude-code' | 'cursor' | 'codex' | 'unknown';

export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'system';

/**
 * A single normalized event from any supported transcript format.
 * Cross-runtime fields are normalized; runtime-specific fields go in `raw`.
 */
export interface TranscriptEvent {
  /** Epoch milliseconds. If the transcript line had no timestamp, parser SHOULD
   *  interpolate from surrounding events; if it can't, set to 0 and the
   *  windowing layer will drop. */
  timestamp: number;
  runtime: Runtime;
  kind: EventKind;
  /** Plain-text content for user_message / assistant_message. */
  text?: string;
  /** Tool name for tool_use (e.g. 'Read', 'Bash', 'WebFetch'). */
  toolName?: string;
  /** Tool input arguments for tool_use. Shape varies by tool. */
  toolInput?: Record<string, unknown>;
  /** Tool result content for tool_result. */
  toolResultText?: string;
  /** Tool result exit code if shell-like (Bash). Undefined when N/A. */
  toolResultExitCode?: number;
  /** Per-message working directory if the runtime supplied it. */
  cwd?: string;
  /** Opaque tool-use ID linking tool_use → tool_result pairs. */
  toolUseId?: string;
  /** Original parsed object for debugging / runtime-specific consumers. */
  raw?: unknown;
}

// ─────────────────────────────────────────────────────────────────────
// Layer 2 — Enrichment output
// ─────────────────────────────────────────────────────────────────────

export type ActionClass =
  | 'exploration'      // Read, Glob, Grep, LS
  | 'editing'          // Write, Edit, NotebookEdit
  | 'verification'     // Bash running tests/lint/build
  | 'external'         // WebFetch, WebSearch, curl, fetch, MCP calls
  | 'navigation'       // cd, ls, pwd, git status/log/diff
  | 'other';           // anything that doesn't classify cleanly

export interface EnrichedWindow {
  /** Events kept in the window (after timestamp filtering). */
  events: TranscriptEvent[];
  /** Window boundaries in epoch ms. */
  windowStart: number;
  windowEnd: number;
  /** Duration of the window in ms (windowEnd - windowStart). */
  durationMs: number;
  /** Top-N keywords extracted from user prose in this window. */
  topics: string[];
  /** Directory-token clusters with invocation counts. e.g. {'src/auth': 4, 'tests': 2} */
  pathClusters: Record<string, number>;
  /** Action class counts. */
  actionCounts: Record<ActionClass, number>;
  /** Top-N files by edit count (Write/Edit invocations targeting them). */
  primaryFiles: string[];
  /** Top-N shell command "verbs" (e.g. ['npm test', 'git status']). */
  commandVerbs: string[];
  /** Unique tool names invoked in the window. */
  uniqueTools: string[];
  /** Count of total tool invocations. */
  toolInvocationCount: number;
  /** Count of user messages in the window. */
  userMessageCount: number;
  /** Runtime breakdown (multi-runtime transcripts get split). */
  runtimeUsage: Partial<Record<Runtime, number>>;
}

// ─────────────────────────────────────────────────────────────────────
// Layer 3 — Outcome signal
// ─────────────────────────────────────────────────────────────────────

export type UserToneTrend =
  | 'affirming'      // tokens like 'thanks', 'perfect', 'that works'
  | 'correcting'     // 'no', 'wrong', 'still', 'again', 'not quite'
  | 'questioning'    // user asked a question in their most recent message
  | 'idle'           // no user message in the window
  | 'neutral';       // user message present, no strong signal

export type VerificationTrend =
  | 'improving'   // tests/lints went from fail → pass during window
  | 'regressing'  // tests/lints went from pass → fail
  | 'flat_pass'   // multiple passes, no failures
  | 'flat_fail'   // multiple fails, no recovery
  | 'no_data';    // no verification commands ran

export interface OutcomeSignal {
  verificationTrend: VerificationTrend;
  userToneTrend: UserToneTrend;
  /** Whether the agent's most recent assistant message contained completion
   *  verbs ('done', 'fixed', 'completed', 'all set'). */
  completionVerbsRecent: boolean;
  /** Time since the last user message at windowEnd, in ms. Used for done/idle. */
  idleGapMs: number;
}

// ─────────────────────────────────────────────────────────────────────
// Layer 4 — Trajectory verdict
// ─────────────────────────────────────────────────────────────────────

export type TrajectoryBucket =
  | 'converging'   // narrowing focus, editing, verifications improving
  | 'exploring'    // wide reads, no edits yet, user hasn't given direction
  | 'stuck'        // many edits, verifications not improving, user re-asking
  | 'done'         // completion signal + idle gap
  | 'drifting';    // gov-suite detectors firing in the live window

export interface TrajectoryVerdict {
  bucket: TrajectoryBucket;
  /** Confidence in [0,1]. Below 0.5 → the renderer should hedge ('looks like'). */
  confidence: number;
  /** Human-readable signals that produced this verdict (for transparency). */
  signals: string[];
  /** When bucket === 'drifting', the gov-suite findings that fired during
   *  the window. Empty otherwise. */
  drifts: Finding[];
}

// ─────────────────────────────────────────────────────────────────────
// Layer 5 — CLI / output
// ─────────────────────────────────────────────────────────────────────

export interface PulseRecap {
  windowStart: number;
  windowEnd: number;
  /** Human duration string e.g. '18 minutes', '4 minutes 12 seconds'. */
  durationHuman: string;
  verdict: TrajectoryVerdict;
  /** The rendered plain-English narrative. */
  narrative: string;
  /** Full enrichment payload, for --format json consumers. */
  enriched: EnrichedWindow;
  /** Outcome signal, for --format json consumers. */
  outcome: OutcomeSignal;
}

// ─────────────────────────────────────────────────────────────────────
// Cross-cutting
// ─────────────────────────────────────────────────────────────────────

export interface ParseOptions {
  /** Filter to events at or after this epoch ms. */
  since?: number;
  /** Filter to events at or before this epoch ms. */
  until?: number;
}

export interface EnrichOptions {
  /** Number of keywords to retain. Default 5. */
  topicLimit?: number;
  /** Number of primaryFiles to retain. Default 3. */
  primaryFileLimit?: number;
  /** Number of commandVerbs to retain. Default 5. */
  commandVerbLimit?: number;
}

export interface TrajectoryOptions {
  /** Pass-through to detectors. When supplied, detectors run on the windowed
   *  events to populate `drifts[]` and (potentially) flip bucket → 'drifting'. */
  detectorsEnabled?: boolean;
}
