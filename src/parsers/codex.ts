/**
 * Codex JSONL parser.
 *
 * Codex transcripts open with a `session_meta` line, then a stream of
 * `response_item` lines whose `payload.type` discriminates the event.
 * Top-level `timestamp` is ISO-8601.
 *
 * Adapted from SessionTrail (`src/transcript.ts`, MIT, Copyright (c) 2026 Conal).
 */

import type { TranscriptEvent } from '../types.js';
import { coerceTimestamp, isRecord } from './util.js';

interface CodexPayload {
  type?: string;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  role?: string;
  content?: unknown;
  output?: unknown;
  text?: string;
  originator?: unknown;
  source?: unknown;
}

interface CodexLine {
  type?: string;
  timestamp?: unknown;
  payload?: CodexPayload;
}

export function isCodexSessionMeta(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (parsed.type !== 'session_meta') return false;
  const payload = (parsed as CodexLine).payload;
  return payload?.originator === 'codex-tui' || payload?.source === 'cli';
}

export function isCodexLine(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  return parsed.type === 'response_item' || parsed.type === 'session_meta';
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // Codex `apply_patch` arguments are intentionally not JSON — pass through.
  }
  return { patch: value };
}

function stringifyContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const block of value) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (isRecord(block) && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) return parts.join('\n');
    return undefined;
  }
  // function_call_output is shaped { text, exit_code } directly. Pull
  // .text or .content out so the tool_result event has body text.
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
  }
  return undefined;
}

/**
 * Parse a single Codex line into zero-or-more TranscriptEvents.
 * Returns null when the line isn't recognized as a Codex event.
 */
export function parseCodexLine(parsed: unknown): TranscriptEvent[] | null {
  if (!isRecord(parsed)) return null;
  const line = parsed as CodexLine;
  if (line.type !== 'response_item' && line.type !== 'session_meta') {
    return null;
  }
  const ts = coerceTimestamp(line.timestamp) ?? 0;

  if (line.type === 'session_meta') {
    return [
      {
        timestamp: ts,
        runtime: 'codex',
        kind: 'system',
        text: '',
        raw: parsed,
      },
    ];
  }

  const payload = line.payload;
  if (!payload || typeof payload.type !== 'string') {
    return null;
  }

  switch (payload.type) {
    case 'function_call': {
      if (!payload.name) return null;
      return [
        {
          timestamp: ts,
          runtime: 'codex',
          kind: 'tool_use',
          toolName: payload.name,
          toolInput: parseArguments(payload.arguments),
          toolUseId:
            typeof payload.call_id === 'string' ? payload.call_id : undefined,
          raw: parsed,
        },
      ];
    }
    case 'function_call_output':
    case 'local_shell_call_output': {
      const text = stringifyContent(payload.output ?? payload.content);
      let exitCode: number | undefined;
      if (isRecord(payload.output)) {
        const ec = (payload.output as Record<string, unknown>).exit_code;
        if (typeof ec === 'number') exitCode = ec;
      }
      return [
        {
          timestamp: ts,
          runtime: 'codex',
          kind: 'tool_result',
          toolResultText: text,
          toolResultExitCode: exitCode,
          toolUseId:
            typeof payload.call_id === 'string' ? payload.call_id : undefined,
          raw: parsed,
        },
      ];
    }
    case 'message': {
      const role = payload.role;
      const text = stringifyContent(payload.content) ?? payload.text ?? '';
      const kind =
        role === 'user'
          ? 'user_message'
          : role === 'assistant'
            ? 'assistant_message'
            : 'system';
      return [
        {
          timestamp: ts,
          runtime: 'codex',
          kind,
          text,
          raw: parsed,
        },
      ];
    }
    default:
      // Unknown response_item subtype — surface as a system event so the
      // event count stays honest. Downstream layers can ignore.
      return [
        {
          timestamp: ts,
          runtime: 'codex',
          kind: 'system',
          text: '',
          raw: parsed,
        },
      ];
  }
}
