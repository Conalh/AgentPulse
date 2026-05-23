#!/usr/bin/env node
/**
 * AgentPulse CLI — `agentpulse recap [options]`.
 *
 * Thin wrapper over `pulse()` from `./index.js`. Pure stdlib: `node:util`
 * for arg parsing, `node:fs/promises` for output writes, `node:path` for
 * path normalization. No external CLI libs.
 *
 * Exit codes:
 *   0  recap rendered (drifting still exits 0 in v0.1 — gating is a future
 *      Action feature, see project spec).
 *   1  unexpected runtime error.
 *   2  usage error (missing subcommand, missing flag, invalid duration).
 */

import { parseArgs } from 'node:util';
import { writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pulse } from './index.js';
import type { PulseRecap } from './types.js';

const USAGE = `Usage:
  agentpulse recap --transcript-dir <path> [options]   one-shot recap
  agentpulse live [options]                            live multi-session TUI

Recap options:
  --transcript-dir <path>   Directory of transcript JSONL files (required)
  --window <duration>       e.g. 20m, 1h, 30s. Default: 20m
  --watch                   Re-emit periodically until SIGINT
  --watch-interval <dur>    Default: 30s
  --repo <path>             Default: process.cwd()
  --no-detectors            Skip drift detection
  --format <fmt>            'text' (default) or 'json'
  --output <path>           Write to file instead of stdout

Live options:
  --window <duration>       Recap window per session. Default: 20m
  --refresh <duration>      Background refresh cadence. Default: 30s
  --no-detectors            Skip drift detection
  --roots <p1,p2,...>       Override discovery roots (comma-separated)
  --stale <duration>        Skip sessions older than this. Default: 1h
  --show-idle               Include sessions with zero activity in the window
  --max-sessions <N>        Cap the displayed list. Default: 10

  -h, --help                Show this help`;

/**
 * Parse a short duration like `20m`, `1h`, `30s`, `500ms` into milliseconds.
 * Returns `null` on bad input — callers translate that into a usage error.
 *
 * The grammar is deliberately tight (one number, one unit) rather than
 * accepting compound forms like `1h30m` — keeps the CLI surface predictable.
 */
export function parseDuration(s: string | undefined): number | null {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2]!.toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * mult[unit]!;
}

function renderText(recap: PulseRecap): string {
  const head = recap.narrative;
  const verdictLine = `Verdict: ${recap.verdict.bucket} (confidence ${recap.verdict.confidence.toFixed(2)})`;
  const signals =
    recap.verdict.signals.length > 0
      ? `\nSignals:\n  - ${recap.verdict.signals.join('\n  - ')}`
      : '';
  return `${head}\n\n${verdictLine}${signals}`;
}

async function emit(
  recap: PulseRecap,
  format: 'text' | 'json',
  output: string | undefined,
  append: boolean
): Promise<void> {
  const payload = format === 'json' ? JSON.stringify(recap) : renderText(recap);
  if (output) {
    const data = payload + '\n';
    if (append) await appendFile(output, data, 'utf8');
    else await writeFile(output, data, 'utf8');
  } else {
    process.stdout.write(payload + '\n');
  }
}

interface ParsedCli {
  transcriptDir: string;
  windowMs: number;
  watch: boolean;
  watchIntervalMs: number;
  repo: string;
  detectorsEnabled: boolean;
  format: 'text' | 'json';
  output: string | undefined;
}

interface ParseFailure {
  message: string;
  /** Non-zero process exit code; 2 for usage errors, 0 for --help. */
  code: number;
}

export function parseCli(
  argv: string[]
): { ok: true; opts: ParsedCli } | { ok: false; error: ParseFailure } {
  if (argv.length === 0) {
    return { ok: false, error: { message: USAGE, code: 2 } };
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { ok: false, error: { message: USAGE, code: 0 } };
  }
  if (argv[0] !== 'recap') {
    // 'live' is handled by main() before reaching parseCli, so anything else here is a usage error.
    return {
      ok: false,
      error: { message: `Unknown subcommand: ${argv[0]}\n\n${USAGE}`, code: 2 },
    };
  }
  const rest = argv.slice(1);

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        'transcript-dir': { type: 'string' },
        window: { type: 'string' },
        watch: { type: 'boolean', default: false },
        'watch-interval': { type: 'string' },
        repo: { type: 'string' },
        'no-detectors': { type: 'boolean', default: false },
        format: { type: 'string', default: 'text' },
        output: { type: 'string' },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { message: `${msg}\n\n${USAGE}`, code: 2 } };
  }
  const v = parsed.values;

  const transcriptDir = v['transcript-dir'];
  if (typeof transcriptDir !== 'string' || transcriptDir.length === 0) {
    return {
      ok: false,
      error: {
        message: `Missing required flag: --transcript-dir\n\n${USAGE}`,
        code: 2,
      },
    };
  }

  const windowStr = (v.window as string | undefined) ?? '20m';
  const windowMs = parseDuration(windowStr);
  if (windowMs === null) {
    return {
      ok: false,
      error: { message: `Invalid --window duration: ${windowStr}`, code: 2 },
    };
  }

  const intervalStr = (v['watch-interval'] as string | undefined) ?? '30s';
  const watchIntervalMs = parseDuration(intervalStr);
  if (watchIntervalMs === null) {
    return {
      ok: false,
      error: {
        message: `Invalid --watch-interval duration: ${intervalStr}`,
        code: 2,
      },
    };
  }

  const format = (v.format as string | undefined) ?? 'text';
  if (format !== 'text' && format !== 'json') {
    return {
      ok: false,
      error: {
        message: `Invalid --format: ${format} (expected 'text' or 'json')`,
        code: 2,
      },
    };
  }

  return {
    ok: true,
    opts: {
      transcriptDir: resolve(transcriptDir),
      windowMs,
      watch: Boolean(v.watch),
      watchIntervalMs,
      repo: resolve((v.repo as string | undefined) ?? process.cwd()),
      detectorsEnabled: !v['no-detectors'],
      format,
      output: v.output as string | undefined,
    },
  };
}

async function runOnce(opts: ParsedCli, append: boolean): Promise<void> {
  const recap = await pulse({
    transcriptDir: opts.transcriptDir,
    windowMs: opts.windowMs,
    repoRoot: opts.repo,
    detectorsEnabled: opts.detectorsEnabled,
  });
  // In text watch mode we clear the screen before each emit so the latest
  // verdict sits at the top. JSON watch mode appends NDJSON so downstream
  // tools can `tail -f` the file.
  if (opts.watch && opts.format === 'text' && !opts.output) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
  await emit(recap, opts.format, opts.output, append);
}

async function watchLoop(opts: ParsedCli): Promise<void> {
  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // First emit overwrites output file if any; subsequent emits append.
  let append = false;
  while (!stopping) {
    try {
      await runOnce(opts, append);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agentpulse: ${msg}\n`);
    }
    append = true;
    if (stopping) break;
    await sleep(opts.watchIntervalMs, () => stopping);
  }
}

/** Resolve after `ms`, or sooner if `shouldStop()` flips true. */
function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((res) => {
    const tick = 100;
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed += tick;
      if (elapsed >= ms || shouldStop()) {
        clearInterval(id);
        res();
      }
    }, tick);
  });
}

/**
 * Parse `agentpulse live` flags. Returns the resolved LiveOptions or a
 * ParseFailure. Kept separate from parseCli() so the recap and live
 * subcommands can diverge without contaminating each other.
 */
function parseLiveCli(
  argv: string[]
): { ok: true; opts: import('./types.js').LiveOptions } | { ok: false; error: ParseFailure } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        window: { type: 'string' },
        refresh: { type: 'string' },
        'no-detectors': { type: 'boolean', default: false },
        roots: { type: 'string' },
        stale: { type: 'string' },
        'show-idle': { type: 'boolean', default: false },
        'max-sessions': { type: 'string' },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { message: `${msg}\n\n${USAGE}`, code: 2 } };
  }
  const v = parsed.values;

  const windowStr = (v.window as string | undefined) ?? '20m';
  const windowMs = parseDuration(windowStr);
  if (windowMs === null) {
    return { ok: false, error: { message: `Invalid --window duration: ${windowStr}`, code: 2 } };
  }

  const refreshStr = (v.refresh as string | undefined) ?? '30s';
  const refreshIntervalMs = parseDuration(refreshStr);
  if (refreshIntervalMs === null) {
    return { ok: false, error: { message: `Invalid --refresh duration: ${refreshStr}`, code: 2 } };
  }

  const staleStr = (v.stale as string | undefined) ?? '1h';
  const staleMs = parseDuration(staleStr);
  if (staleMs === null) {
    return { ok: false, error: { message: `Invalid --stale duration: ${staleStr}`, code: 2 } };
  }

  const rootsStr = v.roots as string | undefined;
  const discoveryRoots = rootsStr
    ? rootsStr.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  const maxSessionsStr = v['max-sessions'] as string | undefined;
  let maxSessions: number | undefined;
  if (maxSessionsStr !== undefined) {
    const n = Number(maxSessionsStr);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return {
        ok: false,
        error: { message: `Invalid --max-sessions: ${maxSessionsStr} (expected non-negative integer)`, code: 2 },
      };
    }
    maxSessions = n;
  }

  return {
    ok: true,
    opts: {
      windowMs,
      refreshIntervalMs,
      detectorsEnabled: !v['no-detectors'],
      discoveryRoots,
      staleMs,
      showIdle: Boolean(v['show-idle']),
      maxSessions,
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Handle global help before subcommand dispatch.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  // 'live' subcommand — lazy-load the TUI module so its deps don't get
  // pulled in for plain `agentpulse recap` invocations.
  if (argv[0] === 'live') {
    const parsed = parseLiveCli(argv.slice(1));
    if (!parsed.ok) {
      process.stderr.write(parsed.error.message + '\n');
      process.exit(parsed.error.code);
    }
    const { runLiveTui } = await import('./tui/index.js');
    await runLiveTui(parsed.opts);
    return;
  }

  // Default: 'recap' subcommand.
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    const stream = parsed.error.code === 0 ? process.stdout : process.stderr;
    stream.write(parsed.error.message + '\n');
    process.exit(parsed.error.code);
  }

  const opts = parsed.opts;
  if (opts.watch) {
    await watchLoop(opts);
  } else {
    await runOnce(opts, false);
  }
}

main().catch((err) => {
  process.stderr.write(`agentpulse: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
