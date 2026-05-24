/**
 * v0.4.7 — agent aliases.
 *
 * A user with multiple agents running on the same project (Cursor + two
 * Claude Code windows + a Codex session, say) often wants to call them
 * `CC1` / `CC2` / `CG1` / `CD1` themselves so the dashboard reads as
 * theirs, not as four anonymous sessions with hex tails.
 *
 * An alias is just a freeform user-chosen string keyed by session id.
 * When set, it renders in front of the project name and replaces the
 * v0.4.4 hex-tail disambiguator (the alias IS the disambiguator).
 *
 * Two-tier storage — both files are pure JSON, both optional:
 *
 *   1. Per-cwd `<cwd>/.agentpulse-aliases.json` — commit alongside your
 *      `.agentpulse-exceptions.json` to share team conventions.
 *   2. User-home `~/.agentpulse/aliases.json` — your personal default,
 *      survives across all projects + machines.
 *
 * Lookup order: cwd file wins over home file. Writes via the `n` key
 * (in the TUI) land in the home file by default; promoting to a
 * team-shared cwd file is a manual copy/paste — intentional, so the
 * "shared" file is never written to without the user knowing.
 *
 * Both files share the schema:
 *
 *   {
 *     "version": 1,
 *     "aliases": {
 *       "<sessionId>": "<alias string>"
 *     }
 *   }
 *
 * Load is silent on missing / malformed files — aliases are a niceties
 * layer, not required config.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ALIAS_FILENAME = '.agentpulse-aliases.json';
const HOME_ALIAS_DIR = '.agentpulse';
const HOME_ALIAS_FILENAME = 'aliases.json';

interface AliasFile {
  version: number;
  aliases: Record<string, string>;
}

/**
 * Per-cwd alias file path. If `searchPath` already points to the file
 * itself (ends in `.agentpulse-aliases.json`), it's used verbatim. Mirrors
 * `resolveExceptionsPath` in `exceptions.ts`.
 */
function resolveCwdAliasPath(searchPath: string): string {
  if (searchPath.endsWith(ALIAS_FILENAME)) return searchPath;
  return join(searchPath, ALIAS_FILENAME);
}

/**
 * Home alias file path: `~/.agentpulse/aliases.json`. The directory is
 * created on first write; reads silently no-op when missing.
 *
 * `home` is overridable for tests.
 */
export function homeAliasPath(home?: string): string {
  const base = home ?? homedir();
  return join(base, HOME_ALIAS_DIR, HOME_ALIAS_FILENAME);
}

async function readAliasFile(path: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const file = parsed as Partial<AliasFile>;
  if (!file.aliases || typeof file.aliases !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(file.aliases as Record<string, unknown>)) {
    if (typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

export interface LoadAliasesOptions {
  /** Session cwd — used to find a per-project `.agentpulse-aliases.json`. */
  cwd?: string;
  /** Override for `homedir()` — tests pass a tmpdir here. */
  home?: string;
}

/**
 * Load aliases for a single session. cwd file wins over home file when
 * both define the same session id; merged map is returned. Either file
 * (or both) may be missing — that's fine.
 *
 * Despite the per-session call shape, the home file is read on every call.
 * It's small (kilobytes at most) and reads are infrequent (once per pulse,
 * not per render), so we don't bother caching here. The orchestrator can
 * memoize if profiling ever shows it matters.
 */
export async function loadAliases(
  opts: LoadAliasesOptions = {}
): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  // Home first so cwd entries can override.
  const home = await readAliasFile(homeAliasPath(opts.home));
  for (const [k, v] of Object.entries(home)) merged.set(k, v);
  if (opts.cwd) {
    const cwdFile = await readAliasFile(resolveCwdAliasPath(opts.cwd));
    for (const [k, v] of Object.entries(cwdFile)) merged.set(k, v);
  }
  return merged;
}

export interface SetAliasOptions {
  /** Override for `homedir()` — tests pass a tmpdir here. */
  home?: string;
}

/**
 * v0.5.2: per-file write queue. Two near-concurrent `setAlias` calls used
 * to race on the read-modify-write cycle — both would read the
 * pre-existing file, both would write their own version, and the second
 * call's write would silently wipe the first. Now writes are serialized
 * by the resolved file path: the second call awaits the first's
 * `writeFile` before starting its own `readFile`.
 *
 * Keyed by path so different home directories (real vs. test tmpdirs)
 * don't share a queue.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(path: string, op: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  // Chain regardless of whether `previous` rejected — a failed write
  // shouldn't block the next caller. We swallow its error here; the
  // failing caller already received it via their own promise.
  const next = previous.catch(() => {}).then(op);
  writeQueues.set(path, next);
  // Clean up the queue once this op settles so a long-idle path doesn't
  // leak the latest promise. Use `.then(onOk, onErr)` (vs. `.finally`)
  // because `.finally` propagates the parent's rejection into a new
  // unhandled chain — the caller's own `await next` already exposes
  // any error, so the cleanup must be a terminal branch that swallows.
  const cleanup = (): void => {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  };
  next.then(cleanup, cleanup);
  return next;
}

/**
 * Set (or update) an alias in the home file. The cwd file is never
 * written by this function — promoting to a shared file is a manual,
 * deliberate step. The home directory (`~/.agentpulse/`) is created on
 * first write.
 *
 * Passing an empty / whitespace-only alias removes the entry, so
 * `n`-then-Enter on an empty buffer is the natural "clear alias" path.
 *
 * v0.5.2: serialized via `enqueueWrite` against the resolved file path,
 * so two `setAlias` calls fired back-to-back can't lose each other's
 * changes through a read-modify-write race.
 */
export async function setAlias(
  sessionId: string,
  alias: string,
  opts: SetAliasOptions = {}
): Promise<void> {
  if (!sessionId) throw new Error('setAlias: sessionId is required');
  const path = homeAliasPath(opts.home);
  return enqueueWrite(path, async () => {
    await mkdir(dirname(path), { recursive: true });

    const existing: AliasFile = { version: 1, aliases: {} };
    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Malformed existing file → refuse to clobber. The user can fix the
        // file by hand; we'd rather error than silently destroy data.
        throw new Error(
          `setAlias: existing ${HOME_ALIAS_FILENAME} is not valid JSON; refusing to overwrite`
        );
      }
      if (parsed && typeof parsed === 'object') {
        const file = parsed as Partial<AliasFile>;
        if (file.aliases && typeof file.aliases === 'object') {
          for (const [k, v] of Object.entries(file.aliases as Record<string, unknown>)) {
            if (typeof k === 'string' && typeof v === 'string') existing.aliases[k] = v;
          }
        }
        if (typeof file.version === 'number') existing.version = file.version;
      }
    }

    const cleaned = alias.trim();
    if (cleaned.length === 0) {
      delete existing.aliases[sessionId];
    } else {
      existing.aliases[sessionId] = cleaned;
    }

    await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  });
}
