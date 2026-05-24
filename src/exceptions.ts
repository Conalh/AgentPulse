/**
 * v0.4.1 — per-session exception baseline.
 *
 * A session can carry a `.agentpulse-exceptions.json` file at its `cwd` root.
 * The file lists drift-finding fingerprints the user has explicitly approved
 * ("yes, I know `curl | sh` is happening in this script — stop yelling about
 * it"). At pulse-time the orchestrator threads the loaded set into
 * `detectDrifts()` and matching findings are filtered before the drifting
 * bucket rule fires.
 *
 * Two consumers:
 *  - `pulse()` (via `loadExceptions`) reads the file to build the filter set.
 *  - The TUI's `a` key (via `appendExceptions`) writes new entries into the
 *    file. Pure Node stdlib — no new deps.
 *
 * File schema (intentionally minimal):
 *
 *   {
 *     "version": 1,
 *     "exceptions": [
 *       { "kind": "agent_pulse.live_drift_shell_exfil",
 *         "fingerprint": "abc123...",
 *         "approvedAt": "2026-05-23T18:00:00.000Z",
 *         "note": "approved by user via TUI" }
 *     ]
 *   }
 *
 * For v0.4.1 the filter is strict — only exact fingerprint matches drop. A
 * future iteration could match by `kind` (broader, "approve every shell_exfil
 * in this repo") but that's a deliberate later call.
 *
 * Load is silent on missing / malformed files: exceptions are an optional
 * baseline, not a required config — a typo shouldn't break the dashboard.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding } from 'agent-gov-core';
import { fingerprintFinding } from 'agent-gov-core';

const EXCEPTIONS_FILENAME = '.agentpulse-exceptions.json';

/**
 * v0.5.2: per-file write queue. Two near-concurrent `appendExceptions`
 * calls used to race on the read-modify-write cycle — both would read
 * the pre-existing file, both would write their own version, and the
 * second's write would silently wipe the first's new entries. Now
 * writes are serialized by the resolved file path. Keyed by path so
 * sessions with different cwds don't share a queue.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(path: string, op: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(op);
  writeQueues.set(path, next);
  // Cleanup uses `.then(onOk, onErr)` (vs `.finally`) so the cleanup
  // branch is terminal — `.finally` would propagate the parent's
  // rejection into a new unhandled chain. The caller's own `await next`
  // already exposes any error.
  const cleanup = (): void => {
    if (writeQueues.get(path) === next) writeQueues.delete(path);
  };
  next.then(cleanup, cleanup);
  return next;
}

interface ExceptionEntry {
  kind: string;
  fingerprint: string;
  approvedAt: string;
  note?: string;
}

interface ExceptionsFile {
  version: number;
  exceptions: ExceptionEntry[];
}

/**
 * Resolve the on-disk path for a session's exception file. Accepts either
 * a directory (the session's cwd) or a full file path — if `searchPath`
 * already ends in `.agentpulse-exceptions.json`, we use it verbatim. That
 * lets tests + power users override the location without forcing a directory.
 */
function resolveExceptionsPath(searchPath: string): string {
  if (searchPath.endsWith(EXCEPTIONS_FILENAME)) return searchPath;
  return join(searchPath, EXCEPTIONS_FILENAME);
}

/**
 * Load the fingerprints from a session's exceptions file.
 *
 * Returns an empty Set when:
 *  - `searchPath` is undefined/empty (no session cwd available)
 *  - the file is missing
 *  - the file is unparseable JSON
 *  - the file is parseable but doesn't match the expected shape
 *
 * All failure modes are silent by design — see file header.
 */
export async function loadExceptions(searchPath?: string): Promise<Set<string>> {
  if (!searchPath) return new Set();
  const path = resolveExceptionsPath(searchPath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!parsed || typeof parsed !== 'object') return new Set();
  const file = parsed as Partial<ExceptionsFile>;
  if (!Array.isArray(file.exceptions)) return new Set();
  const out = new Set<string>();
  for (const entry of file.exceptions) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as ExceptionEntry).fingerprint === 'string' &&
      (entry as ExceptionEntry).fingerprint.length > 0
    ) {
      out.add((entry as ExceptionEntry).fingerprint);
    }
  }
  return out;
}

/**
 * Append drift findings to a session's exception baseline. Existing entries
 * are preserved; duplicates (by fingerprint) are dropped. Creates the file
 * if it doesn't exist yet.
 *
 * If a drift finding lacks a `fingerprint`, we compute one on the fly via
 * `fingerprintFinding`. We don't mutate the input findings — the computed
 * fingerprint is only used for the written entry.
 *
 * Throws when:
 *  - `searchPath` is missing (caller error — they should have checked cwd)
 *  - the existing file is parseable but malformed (we refuse to overwrite
 *    user-edited content we can't merge into safely)
 *  - the write itself fails (disk full, permission, etc.) — caller surfaces
 *
 * Read errors that look like "missing file" are tolerated: we start fresh.
 */
export async function appendExceptions(
  searchPath: string,
  drifts: Finding[]
): Promise<void> {
  if (!searchPath) {
    throw new Error('appendExceptions: searchPath is required');
  }
  if (drifts.length === 0) return; // no-op, don't touch disk
  const path = resolveExceptionsPath(searchPath);

  // v0.5.2: serialize against this path so concurrent calls don't
  // overwrite each other's appended entries.
  return enqueueWrite(path, async () => {
    // Read existing entries (if any). A missing file is fine — we'll create.
    // A present-but-unparseable file IS an error here, because writing on top
    // would clobber user-edited content.
    let existing: ExceptionsFile = { version: 1, exceptions: [] };
    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      // ENOENT is fine; any other read error propagates.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    if (raw !== null) {
      const parsed = JSON.parse(raw) as unknown; // intentionally throws on bad JSON
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(
          `appendExceptions: existing ${EXCEPTIONS_FILENAME} is not a JSON object`
        );
      }
      const file = parsed as Partial<ExceptionsFile>;
      existing = {
        version: typeof file.version === 'number' ? file.version : 1,
        exceptions: Array.isArray(file.exceptions) ? (file.exceptions as ExceptionEntry[]) : [],
      };
    }

    const seen = new Set<string>(
      existing.exceptions
        .map((e) => (e && typeof e.fingerprint === 'string' ? e.fingerprint : ''))
        .filter((fp): fp is string => fp.length > 0)
    );

    const approvedAt = new Date().toISOString();
    for (const drift of drifts) {
      const fp = drift.fingerprint ?? fingerprintFinding(drift);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      existing.exceptions.push({
        kind: drift.kind,
        fingerprint: fp,
        approvedAt,
        note: 'approved by user via TUI',
      });
    }

    await writeFile(
      path,
      `${JSON.stringify(existing, null, 2)}\n`,
      'utf8'
    );
  });
}
