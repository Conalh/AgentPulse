/**
 * v0.6.0 — incremental transcript parsing.
 *
 * Pre-v0.6, every refresh re-walked the full transcript file end-to-end:
 * a 2-hour Claude Code session with a 10 MB JSONL ate ~10 MB of disk I/O
 * and N thousand JSON.parse calls every 30 seconds, of which the vast
 * majority of events were immediately dropped by the windowing filter.
 *
 * This module reads only what's new. Per-path state tracks the byte
 * offset of the last complete line we've parsed. On the next pulse we
 * `stat` the file:
 *
 *   - size unchanged + mtime unchanged → return cached events, no read
 *   - size grew                        → tail-read [lastOffset, size),
 *                                        parse only the new lines,
 *                                        append to cached events
 *   - size shrank or mtime regressed   → file was rotated or truncated,
 *                                        evict the entry and start fresh
 *   - file missing                     → evict the entry, return []
 *
 * Window filtering happens AFTER incremental read — the cache holds a
 * superset of what any single pulse needs (older events that may still
 * be inside the window). We prune events older than the window with a
 * generous safety margin so memory doesn't grow unbounded for a
 * many-hour session.
 *
 * On a partial final line (the agent is mid-write), we stop at the last
 * complete `\n`; the deferred bytes get picked up on the next read.
 *
 * The cache is process-wide so multiple orchestrators (or live + watcher
 * both consulting the same file) share state. Failure modes (read error,
 * parse error on a line) follow the same silent-by-default pattern as
 * the v1.1.0 substrate parser.
 */

import { open, stat } from 'node:fs/promises';
import {
  coerceTimestamp,
  detectAnthropicRuntime,
  interpolateTimestamps,
  isCodexLine,
  isCodexSessionMeta,
  isRecord,
  parseAnthropicLine,
  parseCodexLine,
  isAntigravityLine,
  parseAntigravityLine,
  extractExitCode,
} from 'agent-gov-core';
import type { TranscriptEvent } from './types.js';

interface CacheEntry {
  /** Byte offset JUST PAST the last complete line we've parsed. The next
   *  read starts here. */
  endByteOffset: number;
  /** mtime at the last successful read. Used to detect rotation/truncation. */
  lastMtimeMs: number;
  /** Size at the last successful read. Same purpose as lastMtimeMs. */
  lastSize: number;
  /** All events parsed so far, kept in chronological order. Pruned by
   *  `readWindowFromCache` to a generous superset of the active window. */
  events: TranscriptEvent[];
  activeToolCalls?: Map<string, string>;
}

const cache = new Map<string, CacheEntry>();

/**
 * How much extra history to retain in the cache beyond the active
 * window's start. Generous margin so a window expanding (e.g. user
 * tweaking `--window 1h` from 20m) doesn't immediately require a full
 * re-read. 1 hour covers realistic window-resize moves without bloating
 * memory for typical sessions.
 */
const PRUNE_MARGIN_MS = 60 * 60 * 1000;

/**
 * Read events for the [since, until] window from `path`, using the
 * per-path incremental cache. Returns a freshly-filtered, chronologically
 * sorted `TranscriptEvent[]`.
 *
 * Drop-in replacement for the (file-path subset of) the v1.1.0
 * `parseTranscriptDir` semantics, with the same handling of:
 *  - missing file → empty array
 *  - malformed lines → counted + skipped
 *  - missing timestamps → interpolated from neighbors
 *  - window boundaries → filter to [since, until] inclusive
 */
export async function readWindowFromCache(
  path: string,
  since: number,
  until: number,
  opts: { silent?: boolean } = {}
): Promise<TranscriptEvent[]> {
  const silent = opts.silent ?? false;

  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (err) {
    // Drop any cached state and rethrow with a contextual message,
    // matching the v1.1.0 substrate parser's behaviour on a missing
    // transcript path. The orchestrator's try/catch promotes this
    // into `SessionState.error`. A live session whose file gets
    // rotated/deleted between pulses will be caught here; the watcher
    // emits a 'remove' event independently which evicts the session.
    cache.delete(path);
    throw new Error(
      `transcript-parser: cannot read transcript path "${path}": ${(err as Error).message}`
    );
  }

  let entry = cache.get(path);

  // Rotation / truncation detection. A real append-only transcript
  // only grows; a smaller size or older mtime means the file was
  // rotated, truncated, or replaced — reset and start fresh.
  if (entry && (fileStat.size < entry.lastSize || fileStat.mtimeMs < entry.lastMtimeMs)) {
    entry = undefined;
    cache.delete(path);
  }

  // Fast path: no change since the last read. Just filter and return.
  if (
    entry &&
    entry.endByteOffset === fileStat.size &&
    entry.lastMtimeMs === fileStat.mtimeMs
  ) {
    return filterAndPrune(entry, since, until);
  }

  const fromOffset = entry ? entry.endByteOffset : 0;
  const lengthToRead = fileStat.size - fromOffset;

  // Defensive: if the cache offset somehow exceeds the file size (caught
  // above for explicit shrinkage; this handles equality with mtime mismatch),
  // just refresh the metadata and return current state.
  if (lengthToRead <= 0) {
    if (entry) {
      entry.lastMtimeMs = fileStat.mtimeMs;
      entry.lastSize = fileStat.size;
      return filterAndPrune(entry, since, until);
    }
    return [];
  }

  // Read the new bytes only.
  const handle = await open(path, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(lengthToRead);
    await handle.read(buf, 0, lengthToRead, fromOffset);
  } finally {
    await handle.close();
  }

  // Find the last complete newline IN THE BUFFER (byte space). Anything
  // after it is an incomplete line (the agent is mid-write); defer to the
  // next read. We search the raw buffer for the `\n` byte (0x0A) rather
  // than decoding to a string first and using a string index, because a
  // UTF-16 code-unit index is NOT a byte offset: any multibyte char
  // (emoji, accents, CJK) makes the two diverge, and we add `consumedBytes`
  // to a byte offset (`endByteOffset`). Getting that wrong rewinds the next
  // read into the middle of already-parsed lines and re-appends them as
  // duplicate events. 0x0A can only ever be a standalone newline in valid
  // UTF-8 (no continuation/lead byte is < 0x80), so the byte search is
  // exact, and decoding `[0, consumedBytes)` is guaranteed to end on a
  // char boundary.
  const lastNewlineIdx = buf.lastIndexOf(0x0a);
  const consumedBytes = lastNewlineIdx >= 0 ? lastNewlineIdx + 1 : 0;
  const completeBlock =
    consumedBytes > 0 ? buf.toString('utf8', 0, consumedBytes) : '';

  if (!entry) {
    entry = {
      endByteOffset: 0,
      lastMtimeMs: 0,
      lastSize: 0,
      events: [],
      activeToolCalls: new Map<string, string>(),
    };
  } else if (!entry.activeToolCalls) {
    entry.activeToolCalls = new Map<string, string>();
  }

  const newEvents = parseLines(completeBlock, silent, path, entry.activeToolCalls);

  entry.events.push(...newEvents);
  entry.endByteOffset = fromOffset + consumedBytes;
  entry.lastMtimeMs = fileStat.mtimeMs;
  entry.lastSize = fileStat.size;

  // Interpolate timestamps across the FULL event set. New events may
  // have zero timestamps that should borrow from the events before
  // them in the cached prefix.
  interpolateTimestamps(entry.events);

  cache.set(path, entry);
  return filterAndPrune(entry, since, until);
}

/**
 * Filter cached events to the active window, prune events that have
 * permanently fallen out of any plausible future window.
 *
 * Pruning is done in-place on the entry to keep memory bounded for
 * many-hour sessions.
 */
function filterAndPrune(
  entry: CacheEntry,
  since: number,
  until: number
): TranscriptEvent[] {
  const pruneThreshold = since - PRUNE_MARGIN_MS;
  if (entry.events.length > 0 && entry.events[0]!.timestamp < pruneThreshold) {
    entry.events = entry.events.filter((e) => e.timestamp >= pruneThreshold);

    // Prune orphan activeToolCalls to keep memory bounded
    if (entry.activeToolCalls && entry.activeToolCalls.size > 0) {
      const liveIds = new Set<string>();
      for (const e of entry.events) {
        if (e.toolUseId) {
          liveIds.add(e.toolUseId);
        }
      }
      for (const [key, toolUseId] of entry.activeToolCalls.entries()) {
        if (!liveIds.has(toolUseId)) {
          entry.activeToolCalls.delete(key);
        }
      }
    }
  }

  const filtered: TranscriptEvent[] = [];
  for (const e of entry.events) {
    if (e.timestamp === 0) continue; // timestamp-0 events have no window membership
    if (e.timestamp < since) continue;
    if (e.timestamp > until) continue;
    filtered.push(e);
  }

  // Cache events are appended in arrival order; sort defensively in case
  // a tail-read produced an out-of-order chunk (clock skew between
  // sessions writing to the same logical stream — rare but cheap to handle).
  filtered.sort((a, b) => a.timestamp - b.timestamp);
  return filtered;
}

/**
 * Parse a block of newline-terminated JSONL lines into TranscriptEvents.
 * Mirrors the per-line dispatch in agent-gov-core's
 * `parseTranscriptDir/parseFile`: codex shapes first (so cross-runtime
 * files don't mislabel), then anthropic, then a force-anthropic
 * fallback when the line has shape hints.
 *
 * Skipped lines (invalid JSON, unrecognized shape) are counted; an
 * aggregate warning is emitted to `console.warn` unless `silent`.
 */
function parseLines(
  rawText: string,
  silent: boolean,
  filePath: string,
  activeToolCalls?: Map<string, string>
): TranscriptEvent[] {
  if (rawText.length === 0) return [];

  const events: TranscriptEvent[] = [];
  let lines = 0;
  let skipped = 0;

  for (const line of rawText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    // Codex first — its `default` payload-type branch always returns an
    // event, so we must route on shape, not on a sticky session flag.
    const codexCustom = parseCodexCustomToolLine(parsed);
    if (codexCustom) {
      events.push(...codexCustom);
      continue;
    }

    if (isCodexSessionMeta(parsed) || isCodexLine(parsed)) {
      const out = parseCodexLine(parsed);
      if (out) {
        events.push(...out);
        continue;
      }
    }

    // Antigravity support
    if (isAntigravityLine(parsed)) {
      const out = parseAntigravityLine(parsed, activeToolCalls);
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

    // Last-ditch: anything anthropic-shaped goes through the force path.
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

    skipped += 1;
  }

  if (skipped > 0 && !silent) {
    // eslint-disable-next-line no-console
    console.warn(
      `[agentpulse:parseCache] skipped ${skipped} of ${lines} line(s) on incremental read`
    );
  }

  return events;
}

function parseCodexCustomToolLine(parsed: unknown): TranscriptEvent[] | null {
  if (!isRecord(parsed) || parsed.type !== 'response_item') return null;
  const payload = parsed.payload;
  if (!isRecord(payload)) return null;

  const timestamp = coerceTimestamp(parsed.timestamp) ?? 0;
  const payloadType = payload.type;

  if (payloadType === 'custom_tool_call') {
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    const input = payload.input;
    let toolInput: Record<string, unknown> = {};

    if (isRecord(input)) {
      toolInput = input;
    } else if (typeof input === 'string') {
      try {
        const decoded: unknown = JSON.parse(input);
        toolInput = isRecord(decoded) ? decoded : { input };
      } catch {
        toolInput = name === 'apply_patch' ? { patch: input } : { input };
      }
    }

    return [{
      timestamp,
      runtime: 'codex',
      kind: 'tool_use',
      toolName: name,
      toolInput,
      toolUseId: callId,
      raw: parsed,
    }];
  }

  if (payloadType === 'custom_tool_call_output') {
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
    const output = payload.output;
    const text =
      typeof output === 'string'
        ? output
        : output === undefined
          ? undefined
          : JSON.stringify(output);
    const regexExit = text ? /Exit code:\s*(-?\d+)/i.exec(text) : null;
    const toolResultExitCode =
      extractExitCode(output, text) ?? (regexExit ? Number(regexExit[1]) : undefined);

    return [{
      timestamp,
      runtime: 'codex',
      kind: 'tool_result',
      toolUseId: callId,
      toolResultText: text,
      toolResultExitCode,
      raw: parsed,
    }];
  }

  return null;
}

/**
 * Drop the cached state for `path`. Called by the watcher when a file
 * is removed, and exposed for tests + tools that need to force a full
 * re-read on the next call.
 */
export function evictParseCache(path: string): void {
  cache.delete(path);
}

/**
 * Drop ALL cached state. Tests use this between cases to avoid leak.
 */
export function clearParseCache(): void {
  cache.clear();
}
