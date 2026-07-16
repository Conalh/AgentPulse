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
import { fileURLToPath } from 'node:url';
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
  --max-depth <N>           Max discovery recursion depth below each root
                            (unbounded by default)
  --exclude <d1,d2,...>     Directory names to skip during discovery
  --hide-idle               Hide sessions with zero activity in the window
                            (also applies to --once)
  --max-sessions <N>        Cap the displayed list. Default: 10
                            (with --once: caps the printed list only;
                            gating still considers every session)
  --show-subagents          Include subagent transcripts (agent-<hex>)
  --once                    One-shot snapshot, no TUI. Exits when done.
  --format <fmt>            With --once: 'text' (default) or 'json'
  --strict                  Exit 1 if any session is drifting or stuck
                            (CI gating; only honored with --once)
  --fail-on-error           With --once --strict: also exit 1 when a session
                            fails to analyze (unreadable / corrupt transcript)
  --redact <mode>           Redact transcript-derived paths from --once output:
                            none (default), paths, all
  --notify <mode>           Local notification on transitions into drifting/
                            stuck. Modes: none (default), bell, os, both.
                            'bell' writes \\x07 to stderr; 'os' fires a
                            native notification (osascript / notify-send /
                            PowerShell on macOS / Linux / Windows).

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

/**
 * v0.3.1: Convert `**bold**` markdown spans to ANSI bold escapes so the
 * recap CLI's text output renders emphasis in any modern terminal instead
 * of showing literal asterisks. The narrative source stays markdown so JSON
 * consumers (and downstream tools) get the un-styled string verbatim.
 */
function mdToAnsi(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m');
}

function renderText(recap: PulseRecap): string {
  const head = mdToAnsi(recap.narrative);
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
        'hide-idle': { type: 'boolean', default: false },
        'max-sessions': { type: 'string' },
        'show-subagents': { type: 'boolean', default: false },
        // v0.4.0: headless CI mode.
        once: { type: 'boolean', default: false },
        format: { type: 'string' },
        strict: { type: 'boolean', default: false },
        // #F2: fail closed on infrastructure errors under --strict (opt-in).
        'fail-on-error': { type: 'boolean', default: false },
        // #F8: redact transcript-derived content from --once output.
        redact: { type: 'string' },
        // #F6: bound discovery cost on broad roots.
        'max-depth': { type: 'string' },
        exclude: { type: 'string' },
        // v0.4.2: local notification mode for transitions into drifting/stuck.
        notify: { type: 'string' },
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

  const formatStr = (v.format as string | undefined) ?? 'text';
  if (formatStr !== 'text' && formatStr !== 'json') {
    return {
      ok: false,
      error: { message: `Invalid --format: ${formatStr} (expected 'text' or 'json')`, code: 2 },
    };
  }

  // #F8: redaction mode for --once output.
  const redactStr = (v.redact as string | undefined) ?? 'none';
  if (redactStr !== 'none' && redactStr !== 'paths' && redactStr !== 'all') {
    return {
      ok: false,
      error: {
        message: `Invalid --redact: ${redactStr} (expected 'none', 'paths', or 'all')`,
        code: 2,
      },
    };
  }

  // #F6: discovery depth + exclude knobs.
  const maxDepthStr = v['max-depth'] as string | undefined;
  let maxDepth: number | undefined;
  if (maxDepthStr !== undefined) {
    const n = Number(maxDepthStr);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return {
        ok: false,
        error: {
          message: `Invalid --max-depth: ${maxDepthStr} (expected non-negative integer)`,
          code: 2,
        },
      };
    }
    maxDepth = n;
  }
  const excludeStr = v.exclude as string | undefined;
  const excludeDirs = excludeStr
    ? excludeStr.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;

  // v0.4.2: validate --notify mode. Default `'none'` — notifications are
  // opt-in because they're nag-prone; defaulting to bell would surprise users.
  const notifyStr = (v.notify as string | undefined) ?? 'none';
  if (
    notifyStr !== 'none' &&
    notifyStr !== 'bell' &&
    notifyStr !== 'os' &&
    notifyStr !== 'both'
  ) {
    return {
      ok: false,
      error: {
        message: `Invalid --notify: ${notifyStr} (expected 'none', 'bell', 'os', or 'both')`,
        code: 2,
      },
    };
  }

  return {
    ok: true,
    opts: {
      windowMs,
      refreshIntervalMs,
      detectorsEnabled: !v['no-detectors'],
      discoveryRoots,
      staleMs,
      hideIdle: Boolean(v['hide-idle']),
      maxSessions,
      showSubagents: Boolean(v['show-subagents']),
      once: Boolean(v.once),
      format: formatStr as 'text' | 'json',
      strict: Boolean(v.strict),
      failOnError: Boolean(v['fail-on-error']),
      redact: redactStr as import('./types.js').RedactMode,
      maxDepth,
      excludeDirs,
      notify: notifyStr as import('./notifications.js').NotifyMode,
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
    // v0.4.0: --once routes to the headless snapshot runner instead of
    // mounting Ink. No TUI deps loaded, exits when done, honors --strict
    // for CI gating. The TUI path stays untouched.
    if (parsed.opts.once) {
      const { runOnceMode } = await import('./once.js');
      const code = await runOnceMode(parsed.opts);
      process.exit(code);
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

// v0.6.1: only run main() when this module is the program entry point.
// Pre-fix, `import { parseDuration } from './cli.js'` ran main() at
// module-load which printed usage and exited — broke property tests
// (and any other tool that wanted to consume cli helpers as a library).
// The standard ESM idiom: compare process.argv[1] against import.meta.url.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main().catch((err) => {
    process.stderr.write(`agentpulse: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
