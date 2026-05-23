/**
 * Shared parser helpers.
 *
 * Adapted from SessionTrail (`src/transcript.ts`, MIT, Copyright (c) 2026 Conal).
 * v0.2 will move this into `agent-gov-core` so all suite tools share one parser.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a timestamp from a runtime line into epoch ms.
 * Accepts ISO-8601 strings, numeric epoch seconds, and numeric epoch ms.
 * Returns undefined if the value isn't a recognizable timestamp.
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: anything in epoch-seconds range (~ year 2001 -> 5138) we
    // treat as seconds. Codex/OpenAI ecosystems sometimes emit seconds.
    if (value < 1e12 && value > 1e9) {
      return Math.round(value * 1000);
    }
    return Math.round(value);
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Walk events and fill any zero/undefined timestamps by interpolating from
 * sibling events. Forward-fill, then back-fill for any leading zeros. If
 * the entire file has no timestamps, leave them at 0 (caller drops when
 * a window is supplied).
 */
export function interpolateTimestamps<T extends { timestamp: number }>(events: T[]): T[] {
  let last = 0;
  for (const ev of events) {
    if (ev.timestamp > 0) {
      last = ev.timestamp;
    } else if (last > 0) {
      ev.timestamp = last;
    }
  }
  let next = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.timestamp > 0) {
      next = ev.timestamp;
    } else if (next > 0) {
      ev.timestamp = next;
    }
  }
  return events;
}

/**
 * Concatenate text content blocks (Claude Code / Cursor message shape).
 */
export function extractTextFromBlocks(
  blocks: ReadonlyArray<{ type?: string; text?: string }> | undefined
): string | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join('\n');
}

/**
 * Stringify a tool_result content payload. Claude Code can emit either a
 * string or an array of content blocks. We coerce to a flat string.
 */
export function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block)) {
        if (typeof block.text === 'string') {
          parts.push(block.text);
        } else if (typeof block.content === 'string') {
          parts.push(block.content);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('\n');
    }
  }
  return undefined;
}

/**
 * Heuristic exit-code extractor for Bash-like tool results. Claude Code
 * sometimes includes `<exit_code>N</exit_code>` markers in result text;
 * Codex's `local_shell_call_output` carries a structured field.
 */
export function extractExitCode(content: unknown, text: string | undefined): number | undefined {
  if (isRecord(content)) {
    const direct = content.exitCode ?? content.exit_code ?? content.returncode;
    if (typeof direct === 'number' && Number.isFinite(direct)) {
      return direct;
    }
    if (typeof direct === 'string' && direct.trim() !== '') {
      const n = Number.parseInt(direct, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  if (typeof text === 'string') {
    const match = text.match(/<exit_code>\s*(-?\d+)\s*<\/exit_code>/);
    if (match) {
      return Number.parseInt(match[1]!, 10);
    }
  }
  return undefined;
}
