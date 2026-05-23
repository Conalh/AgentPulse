/**
 * Claude Code / Cursor JSONL parser.
 *
 * Both runtimes use the Anthropic message envelope:
 *   { type: 'user'|'assistant', message: { role, content: [...blocks] }, ... }
 * with optional `cwd`, `sessionId`, `version`, `timestamp` at the top level.
 *
 * Adapted from SessionTrail (`src/transcript.ts`, MIT, Copyright (c) 2026 Conal).
 */

import type { Runtime, TranscriptEvent } from '../types.js';
import {
  coerceTimestamp,
  extractExitCode,
  extractTextFromBlocks,
  extractToolResultText,
  isRecord,
} from './util.js';

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AnthropicLine {
  type?: string;
  role?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  source?: string;
  timestamp?: unknown;
  message?: {
    role?: string;
    content?: ContentBlock[];
  };
}

/**
 * Detect whether an unrecognized line is more likely Claude Code or Cursor.
 * Claude Code transcripts carry `sessionId`, `cwd`, `version`, or `source:'claude-code'`.
 * Cursor's older shape often omits these but still uses the Anthropic envelope.
 */
export function detectAnthropicRuntime(line: AnthropicLine): Runtime {
  if (
    line.source === 'claude-code' ||
    typeof line.sessionId === 'string' ||
    typeof line.cwd === 'string' ||
    typeof line.version === 'string'
  ) {
    return 'claude-code';
  }
  if (line.type === 'user' || line.type === 'assistant') {
    return 'claude-code';
  }
  if (line.role && line.message) {
    return 'cursor';
  }
  return 'unknown';
}

function lineRole(line: AnthropicLine): 'user' | 'assistant' | 'system' | undefined {
  const t = line.type ?? line.role ?? line.message?.role;
  if (t === 'user' || t === 'assistant' || t === 'system') {
    return t;
  }
  return undefined;
}

/**
 * Parse a single Anthropic-envelope line into zero-or-more TranscriptEvents.
 * Returns null if this line isn't an Anthropic-shape message.
 */
export function parseAnthropicLine(
  parsed: unknown,
  forcedRuntime?: Runtime
): TranscriptEvent[] | null {
  if (!isRecord(parsed)) return null;
  const line = parsed as AnthropicLine;
  const role = lineRole(line);
  if (!role) return null;

  const runtime: Runtime = forcedRuntime ?? detectAnthropicRuntime(line);
  // If detection landed on 'unknown' but we have an Anthropic envelope,
  // default to claude-code — it's the more common case and the consumer
  // only needs a Runtime label, not provenance.
  const finalRuntime: Runtime = runtime === 'unknown' ? 'claude-code' : runtime;

  const ts = coerceTimestamp(line.timestamp) ?? 0;
  const cwd = typeof line.cwd === 'string' ? line.cwd : undefined;
  const blocks = line.message?.content ?? [];

  if (role === 'system') {
    const text = extractTextFromBlocks(blocks) ?? '';
    return [
      {
        timestamp: ts,
        runtime: finalRuntime,
        kind: 'system',
        text,
        cwd,
        raw: parsed,
      },
    ];
  }

  if (blocks.length === 0) {
    return [
      {
        timestamp: ts,
        runtime: finalRuntime,
        kind: role === 'user' ? 'user_message' : 'assistant_message',
        text: '',
        cwd,
        raw: parsed,
      },
    ];
  }

  const events: TranscriptEvent[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({
        timestamp: ts,
        runtime: finalRuntime,
        kind: 'tool_use',
        toolName: block.name,
        toolInput: block.input ?? {},
        toolUseId: typeof block.id === 'string' ? block.id : undefined,
        cwd,
        raw: block,
      });
      continue;
    }
    if (block.type === 'tool_result') {
      const text = extractToolResultText(block.content);
      const exit = extractExitCode(block.content, text);
      events.push({
        timestamp: ts,
        runtime: finalRuntime,
        kind: 'tool_result',
        toolResultText: text,
        toolResultExitCode: exit,
        toolUseId:
          typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
        cwd,
        raw: block,
      });
      continue;
    }
  }

  // Emit the message event before any tool_use blocks that occurred on the
  // same line. Within a single assistant turn this is the natural order.
  if (textParts.length > 0 || events.length === 0) {
    events.unshift({
      timestamp: ts,
      runtime: finalRuntime,
      kind: role === 'user' ? 'user_message' : 'assistant_message',
      text: textParts.join('\n'),
      cwd,
      raw: parsed,
    });
  }

  return events;
}
