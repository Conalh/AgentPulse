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
  | 'drifting'     // gov-suite detectors firing in the live window
  | 'idle';        // window has historical activity but nothing fresh — agent
                   // is parked (waiting on the human, on review, on external
                   // input). v0.2.6 addition: distinguishes "still actively
                   // working" from "did 15 edits 18 minutes ago and stopped".

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
  /** Suppress the "skipped N malformed lines" warning. The TUI sets this to
   *  true on every refresh because `console.warn` writes interfere with
   *  Ink's screen redraw and cause whole-window flicker. v0.2.5 addition. */
  silent?: boolean;
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

// ─────────────────────────────────────────────────────────────────────
// v0.2 — Live multi-session contracts
//
// These types are the synthesis surface for the `agentpulse live` TUI.
// Three workstreams build against them in parallel:
//
//   Workstream A → src/sessions/   (discoverSessions + createSessionWatcher)
//   Workstream B → src/orchestrator.ts (PulseOrchestrator class)
//   Workstream C → src/tui/        (Ink TUI consuming the orchestrator)
//
// Keep this contract stable. Drift here breaks parallel work.
// ─────────────────────────────────────────────────────────────────────

/**
 * A transcript file we found on disk that looks like an active or recent
 * agent session.
 */
export interface DiscoveredSession {
  /** Stable id derived from the transcript file path (e.g. SHA-1 short hash). */
  id: string;
  runtime: Runtime;
  /** Absolute path to the `.jsonl` file. */
  transcriptPath: string;
  /** Best-effort human label inferred from path parts.
   *  e.g. `~/.claude/projects/c-Dev-MyApp/...` → `MyApp`. */
  projectName?: string;
  /** Epoch ms of the file's last modification time. */
  lastModified: number;
  /** Working directory if the runtime supplied one in the transcript. */
  cwd?: string;
}

/**
 * Session-discovery options. All fields optional; sensible defaults.
 */
export interface DiscoverOptions {
  /** Override the discovery roots. Default: platform-aware home-relative
   *  paths for Claude Code, Cursor, and Codex. Pass an explicit list to
   *  pin to specific directories. */
  roots?: string[];
  /** Skip sessions whose lastModified is older than this many ms ago.
   *  Default: 24 hours. Use Infinity to disable. */
  staleMs?: number;
}

/**
 * Watcher event payload. Emitted on session add / change / remove.
 */
export type SessionEvent =
  | { type: 'add'; session: DiscoveredSession }
  | { type: 'change'; session: DiscoveredSession }
  | { type: 'remove'; sessionId: string };

/**
 * SessionWatcher interface — duck-typed so the implementation can use either
 * a real EventEmitter or a lightweight equivalent without forcing the
 * dependency on TUI consumers that only need .on/.off.
 */
export interface SessionWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Listen for session add/change/remove events. */
  on(listener: (event: SessionEvent) => void): void;
  off(listener: (event: SessionEvent) => void): void;
  /** Get the currently-known sessions without waiting for the next tick. */
  snapshot(): DiscoveredSession[];
}

export interface WatcherOptions {
  /** Initial discovery options. */
  discover?: DiscoverOptions;
  /** Debounce window (ms) for coalescing rapid file changes. Default: 300. */
  debounceMs?: number;
  /** Polling interval (ms) when the platform doesn't support fs.watch on the
   *  target path. Default: 1000. */
  pollIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator (Workstream B)
// ─────────────────────────────────────────────────────────────────────

/**
 * The orchestrator-tracked state for a single session.
 */
export interface SessionState {
  session: DiscoveredSession;
  /** Latest computed recap. `null` until the first pulse() completes. */
  recap: PulseRecap | null;
  /** Epoch ms of the last successful refresh. */
  lastUpdated: number;
  /** When the last pulse() threw, this carries the message. Cleared on
   *  the next successful refresh. */
  error?: string;
  /** True while a refresh is in flight for this session. */
  pending: boolean;
}

export interface OrchestratorOptions {
  /** AgentPulse window passed through to pulse(). Default: 20 min. */
  windowMs?: number;
  /** Drift detectors enabled? Default: true. */
  detectorsEnabled?: boolean;
  /** Background refresh cadence per session, in ms. Default: 30_000.
   *  File-change events from the watcher cause immediate refreshes
   *  independent of this cadence. */
  refreshIntervalMs?: number;
}

/**
 * Orchestrator update event — emitted whenever a SessionState changes
 * (added, recap refreshed, error, removed).
 */
export type OrchestratorEvent =
  | { type: 'session-added'; state: SessionState }
  | { type: 'session-updated'; state: SessionState }
  | { type: 'session-removed'; sessionId: string };

/**
 * Multi-session pulse orchestrator. Owns the in-memory state map and the
 * per-session refresh loop. The TUI subscribes to its events for redraws.
 */
export interface PulseOrchestrator {
  add(session: DiscoveredSession): void;
  remove(sessionId: string): void;
  /** Force an immediate refresh on a session (used by the watcher when
   *  the file changes). */
  refresh(sessionId: string): Promise<void>;
  /** Snapshot of all current session states. */
  states(): SessionState[];
  /** Subscribe to state changes. */
  on(listener: (event: OrchestratorEvent) => void): void;
  off(listener: (event: OrchestratorEvent) => void): void;
  /** Stop background refresh timers. Idempotent. */
  stop(): void;
}

// ─────────────────────────────────────────────────────────────────────
// TUI (Workstream C)
// ─────────────────────────────────────────────────────────────────────

export interface LiveOptions {
  /** Window for each session's recap. Default: 20 min. */
  windowMs?: number;
  /** Background refresh cadence. Default: 30s. */
  refreshIntervalMs?: number;
  /** Drift detectors. Default: true. */
  detectorsEnabled?: boolean;
  /** Override discovery roots. */
  discoveryRoots?: string[];
  /** Skip sessions older than this. Default: 1h (was 24h pre-v0.2.1 — that
   *  picked up too many idle transcripts to be useful as a "what's happening
   *  now" dashboard). Use `Infinity` to disable. */
  staleMs?: number;
  /** Hide sessions with zero tool invocations in the current window.
   *  Default: false — idle sessions are shown (greyed out via low confidence)
   *  so you can see your cursor/codex sessions even when they aren't actively
   *  running tools. Set true to filter them out.
   *
   *  v0.2.2 inverted the default: previously this was `showIdle` defaulting
   *  to false (hide idle). Hiding by default was too aggressive — it filtered
   *  out users' Cursor/Codex sessions whenever they hadn't moved in the last
   *  20 minutes, even when they were clearly active in the day.
   */
  hideIdle?: boolean;
  /** Maximum number of sessions to render in the list. Default: 10.
   *  Sessions are sorted by lastModified DESC, so the cap keeps the freshest
   *  N visible. Use a large number or 0 to disable. */
  maxSessions?: number;
  /** Show subagent transcripts (project names matching `agent-<hex>`).
   *  Default: false — subagent sessions are filtered out because they're
   *  ephemeral tooling artifacts, not the developer's own work.
   *  v0.2.3 addition. */
  showSubagents?: boolean;
}
