/**
 * Layer 1 — Transcript parser.
 *
 * Reads `.jsonl` transcripts from Claude Code, Cursor, and Codex out of a
 * directory and emits a flat, chronologically sorted `TranscriptEvent[]`.
 *
 * v0.1 vendoring note: the per-runtime parsers below are adapted from
 * SessionTrail (`src/transcript.ts`, MIT, Copyright (c) 2026 Conal). The
 * v0.2 cleanup factors this into `agent-gov-core` so every suite tool —
 * SessionTrail, AgentPulse, future consumers — shares one parser surface
 * instead of carrying separate copies that drift out of sync.
 *
 * Hard rules (from project spec):
 *  - No network calls.
 *  - No LLM calls.
 *  - Node stdlib + agent-gov-core only.
 *  - TypeScript strict, ESM, Node 20+.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ParseOptions, TranscriptEvent } from './types.js';
import {
  detectAnthropicRuntime,
  parseAnthropicLine,
} from './parsers/claude-code.js';
import {
  isCodexLine,
  isCodexSessionMeta,
  parseCodexLine,
} from './parsers/codex.js';
import { interpolateTimestamps, isRecord } from './parsers/util.js';

/**
 * Parse all `.jsonl` transcripts under `transcriptDir` into normalized
 * events. Directories are walked recursively; non-jsonl files are ignored.
 * A single `.jsonl` file path is also accepted.
 *
 * Malformed lines are counted and reported via `console.warn` but do not
 * throw — partial transcripts are a fact of life with active sessions, and
 * we'd rather render a recap from 95% of a file than refuse the whole thing.
 *
 * Honors `opts.since` / `opts.until` as inclusive epoch-ms bounds. The
 * returned array is chronologically sorted by `timestamp`.
 */
export async function parseTranscript(
  transcriptDir: string,
  opts: ParseOptions = {}
): Promise<TranscriptEvent[]> {
  const files = await listJsonlFiles(transcriptDir);

  const allEvents: TranscriptEvent[] = [];
  let totalSkipped = 0;
  let totalLines = 0;

  for (const file of files) {
    const { events, skipped, lines } = await parseFile(file);
    allEvents.push(...events);
    totalSkipped += skipped;
    totalLines += lines;
  }

  if (totalSkipped > 0 && !opts.silent) {
    // Single aggregate warning — we don't want to spam per-line. Counting
    // is the difference between an audit user noticing partial data and
    // silently trusting a half-parsed file.
    //
    // v0.2.5: the TUI passes opts.silent === true because `console.warn`
    // writes disrupt Ink's screen control and cause whole-window flicker on
    // every refresh tick. The `recap` CLI leaves silent unset so its
    // one-shot output still surfaces the skip count.
    // eslint-disable-next-line no-console
    console.warn(
      `[agentpulse:parser] skipped ${totalSkipped} malformed line(s) out of ${totalLines} across ${files.length} file(s)`
    );
  }

  // Filter before sort — sorting is O(n log n) so trimming first when a
  // window is supplied keeps the constant factor low on long histories.
  const filtered = filterByWindow(allEvents, opts);

  filtered.sort((a, b) => a.timestamp - b.timestamp);
  return filtered;
}

interface FileParseResult {
  events: TranscriptEvent[];
  lines: number;
  skipped: number;
}

async function parseFile(path: string): Promise<FileParseResult> {
  const raw = await readFile(path, 'utf8');
  const events: TranscriptEvent[] = [];
  let lines = 0;
  let skipped = 0;

  // v0.3.1: Pre-fix, this set `codexSessionDetected = true` on first
  // `session_meta` and then forced EVERY subsequent line through the codex
  // parser. parseCodexLine's `default` branch always returns a system event
  // (never null), which meant a mixed-runtime file (rare but real — e.g.
  // Cursor transcripts copied into ~/.claude/projects/) would have every
  // Anthropic line mistagged as codex. Now: only route to the codex parser
  // when the LINE ITSELF looks like a codex shape, not based on a sticky
  // session-wide flag.

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    // Codex path: only when this specific line is a codex shape.
    if (isCodexSessionMeta(parsed) || isCodexLine(parsed)) {
      const out = parseCodexLine(parsed);
      if (out) {
        events.push(...out);
        continue;
      }
    }

    const anthropic = parseAnthropicLine(parsed);
    if (anthropic) {
      events.push(...anthropic);
      continue;
    }

    // Last-ditch: if it has any Anthropic-ish hints, force-parse as one.
    if (isRecord(parsed) && (parsed.message || parsed.role || parsed.type)) {
      const runtime = detectAnthropicRuntime(
        parsed as Parameters<typeof detectAnthropicRuntime>[0]
      );
      const forced = parseAnthropicLine(parsed, runtime);
      if (forced) {
        events.push(...forced);
        continue;
      }
    }
    // Unknown shape — count it as skipped so the user sees the gap.
    skipped += 1;
  }

  // Per-file interpolation keeps sessions independent: a missing timestamp
  // in file B shouldn't borrow from file A.
  interpolateTimestamps(events);

  return { events, lines, skipped };
}

function filterByWindow(events: TranscriptEvent[], opts: ParseOptions): TranscriptEvent[] {
  const since = opts.since;
  const until = opts.until;
  if (since === undefined && until === undefined) {
    return events;
  }
  return events.filter((e) => {
    // Drop events with timestamp 0 only when a window is specified —
    // they have no place in a time-bounded view.
    if (e.timestamp === 0) return false;
    if (since !== undefined && e.timestamp < since) return false;
    if (until !== undefined && e.timestamp > until) return false;
    return true;
  });
}

/**
 * Recursively collect `*.jsonl` files. Sorted lexicographically for
 * deterministic ordering across platforms (readdir order is FS-dependent).
 */
async function listJsonlFiles(directory: string): Promise<string[]> {
  let s;
  try {
    s = await stat(directory);
  } catch (err) {
    throw new Error(
      `agentpulse parser: cannot read transcript path "${directory}": ${(err as Error).message}`
    );
  }
  if (s.isFile()) {
    return directory.endsWith('.jsonl') ? [directory] : [];
  }

  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push(full);
      }
    }
  }

  await walk(directory);
  return result;
}
