/**
 * v0.5.6 — process-wide mtime-keyed JSON file cache.
 *
 * Both `aliases.ts` and `exceptions.ts` are read on every pulse (once
 * per session for aliases, once per pulse for exceptions). With 10
 * sessions on a 30 s refresh interval, that's 20+ small JSON file
 * reads per cycle — most of which return identical content because
 * the files only change when the user presses `a`/`n` or edits them
 * by hand.
 *
 * This module caches the parsed result keyed by absolute path. On
 * every read it `stat`s the file and compares mtime against the
 * cached value; mtime match → return cached data, mtime mismatch
 * (or ENOENT vs. present) → re-read + reparse. Stats are O(microseconds)
 * even on Windows; the read+JSON.parse skip compounds over a session.
 *
 * Cache is module-level so multiple sessions sharing the same
 * `~/.agentpulse/aliases.json` benefit from a single read. Failure
 * modes (parse error, read error) are cached as `null` so we don't
 * thrash on a permanently-broken file.
 *
 * `invalidate(path)` is called from the writers (`setAlias`,
 * `appendExceptions`) after a successful write so the next read picks
 * up the new content without waiting for mtime resolution to kick in
 * (mtime on Windows can lag the actual write on some filesystems).
 */

import { stat, readFile } from 'node:fs/promises';

interface CacheEntry<T> {
  /** Epoch ms of the file's mtime at last successful read. 0 means
   *  "the file did not exist at last check." */
  mtimeMs: number;
  /** Parsed result. `null` is a sentinel for "file missing or unreadable
   *  or unparseable" — callers translate that to their own default. */
  data: T | null;
}

// Single shared cache. JSON parse output is typed as `unknown` here; each
// caller's `parser` narrows it. The Map's value type widens via the
// generic on the read function — we don't try to enforce a per-key type
// at the Map level because that'd require a key-to-type registry.
const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Read + parse a JSON file with mtime-based caching. Returns `whenMissing()`
 * for any of: missing file, unreadable file, unparseable JSON. Returns
 * the parser output otherwise.
 *
 * Notes:
 *  - The parser MUST be deterministic; we cache its output verbatim.
 *  - The parser MAY return any value; we cache by `unknown` internally
 *    and let the generic `T` flow through the public signature.
 *  - We deliberately do NOT throw on parse/read errors — these files
 *    are user-edited niceties layers (aliases, exceptions), and the
 *    rest of the dashboard must continue rendering even when one is
 *    malformed.
 */
export async function readJsonCached<T>(
  path: string,
  parse: (raw: string) => T,
  whenMissing: () => T
): Promise<T> {
  let mtimeMs: number;
  try {
    const s = await stat(path);
    mtimeMs = s.mtimeMs;
  } catch {
    // ENOENT or any other stat failure → treat as missing. Cache the
    // missing state so a directory full of nonexistent sibling files
    // doesn't re-stat on every pulse.
    const existing = cache.get(path);
    if (existing && existing.mtimeMs === 0) {
      return whenMissing();
    }
    cache.set(path, { mtimeMs: 0, data: null });
    return whenMissing();
  }

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.data !== null) {
    return cached.data as T;
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    cache.set(path, { mtimeMs: 0, data: null });
    return whenMissing();
  }

  let parsed: T;
  try {
    parsed = parse(raw);
  } catch {
    // Parser threw — cache the failure as missing-shaped so we don't
    // re-parse the same broken file every pulse. mtime stored as 0
    // means "next mtime change forces a re-read", which is correct
    // semantics for "the user fixed the file."
    cache.set(path, { mtimeMs: 0, data: null });
    return whenMissing();
  }

  cache.set(path, { mtimeMs, data: parsed });
  return parsed;
}

/**
 * Invalidate the cached entry for a given path. Call this after a
 * successful write so the next read re-fetches even if mtime hasn't
 * propagated yet (Windows + some network filesystems can lag).
 */
export function invalidateJsonCache(path: string): void {
  cache.delete(path);
}

/**
 * Clear the entire cache. Exposed for tests that want a clean slate
 * between cases without setting up a fresh module-level singleton.
 */
export function clearJsonCache(): void {
  cache.clear();
}
