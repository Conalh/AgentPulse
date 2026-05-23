/**
 * Session discovery — walk known runtime transcript roots and surface
 * recent .jsonl files as DiscoveredSession objects.
 *
 * Pure node stdlib. See `src/types.ts` for the contract.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

import type {
  DiscoverOptions,
  DiscoveredSession,
  Runtime,
} from '../types.js';

// v0.2.1: tightened from 24h. 24h was picking up every transcript touched in
// the last day, drowning the dashboard in idle sessions. 1h matches the
// "what's actually happening right now" intent. Override via --stale on the CLI.
const DEFAULT_STALE_MS = 60 * 60 * 1000;

interface Root {
  /** Absolute path on disk. */
  path: string;
  /** Runtime label inferred from this root. */
  runtime: Runtime;
}

/**
 * Default platform-aware roots. Home-relative; missing dirs are tolerated by
 * the walker (it just returns []).
 */
export function defaultRoots(): Root[] {
  const home = homedir();
  return [
    { path: join(home, '.claude', 'projects'), runtime: 'claude-code' },
    { path: join(home, '.cursor', 'projects'), runtime: 'cursor' },
    { path: join(home, '.cursor', 'agent-transcripts'), runtime: 'cursor' },
    { path: join(home, '.codex', 'sessions'), runtime: 'codex' },
    { path: join(home, '.codex', 'projects'), runtime: 'codex' },
  ];
}

/**
 * Infer a Runtime from an arbitrary path by looking for runtime-ish path
 * segments. Falls back to 'unknown' if nothing matches — useful when the
 * caller passes opts.roots that don't follow the default layout.
 */
export function inferRuntimeFromPath(p: string): Runtime {
  const lower = p.toLowerCase().split(/[\\/]/);
  if (lower.includes('.claude') || lower.some((s) => s === 'claude' || s === 'claude-code')) {
    return 'claude-code';
  }
  if (lower.includes('.cursor') || lower.includes('cursor')) {
    return 'cursor';
  }
  if (lower.includes('.codex') || lower.includes('codex')) {
    return 'codex';
  }
  return 'unknown';
}

/**
 * Derive a friendly project name from a path. Claude Code uses slugs like
 * `C--Users-conno-Dev-MyApp` for the project dir (originally `C:\Users\conno\Dev\MyApp`
 * or `/Users/conno/Dev/MyApp`). We take the last meaningful segment after
 * splitting on the slug separator.
 *
 * v0.2.1: if the decoded slug looks like a Windows drive prefix only
 * (just "C", "D", etc.), we fall back to `basename(cwd)` when a cwd was
 * extracted from the transcript. This is the difference between 30 sessions
 * all labeled "C" and 30 sessions labeled with their actual project names.
 */
export function deriveProjectName(
  transcriptPath: string,
  rootPath: string,
  cwd?: string
): string | undefined {
  const normTranscript = resolve(transcriptPath);
  const normRoot = resolve(rootPath);

  let slug: string | undefined;
  if (!normTranscript.startsWith(normRoot + sep) && normTranscript !== normRoot) {
    slug = basename(transcriptPath, '.jsonl');
  } else {
    const rel = normTranscript.slice(normRoot.length + 1);
    const firstSeg = rel.split(/[\\/]/)[0];
    if (firstSeg) {
      slug = firstSeg.toLowerCase().endsWith('.jsonl')
        ? basename(firstSeg, '.jsonl')
        : firstSeg;
    }
  }

  const decoded = slug ? decodeSlug(slug) : undefined;

  // Fallback: if the decoded slug is junk (empty, single letter that looks
  // like a drive prefix, "C--"-shaped leftover, or — added in v0.4.6 — a
  // date-shape segment from Codex's `~/.codex/sessions/<year>/<month>/<day>/`
  // layout), prefer the cwd basename.
  //
  // Codex stores transcripts at `~/.codex/sessions/2026/05/23/rollout-xxx.jsonl`,
  // which would otherwise surface as a project named "2026" in the dashboard
  // (the year segment is the slug). None of these date-shape strings are ever
  // real project names; treat them as junky and force the cwd fallback.
  const looksJunky =
    !decoded ||
    /^[a-z]$/i.test(decoded) ||
    /^[a-z]--+$/i.test(decoded) ||
    /^-+$/.test(decoded) ||
    /^\d{1,4}$/.test(decoded) ||              // year / month / day segment
    /^\d{4}-\d{2}-\d{2}$/.test(decoded);      // ISO date

  if (looksJunky && cwd) {
    const fromCwd = basename(cwd);
    if (fromCwd && !/^[a-z]$/i.test(fromCwd)) return fromCwd;
  }

  // Last resort when even cwd doesn't help: return the slug minus the drive
  // prefix if it leaves something meaningful. v0.2.6: previously this fell
  // back to the *original* slug when stripping emptied it out, which is how
  // raw `C--` rows still surfaced in the dashboard. Now: when even the
  // stripped slug is empty, return undefined so the UI falls through to
  // its own `session-<id-prefix>` fallback rather than showing junk.
  //
  // v0.4.6: date-shape slugs (`2026`, `05`, `2026-05-23`) get the same
  // undefined treatment — never want to render those as a "project name".
  if (looksJunky && slug) {
    const isDateShape =
      /^\d{1,4}$/.test(slug) || /^\d{4}-\d{2}-\d{2}$/.test(slug);
    if (isDateShape) return undefined;
    const stripped = slug.replace(/^[a-z]--+/i, '');
    return stripped.length > 0 ? stripped : undefined;
  }

  return decoded || undefined;
}

/**
 * Convert a Claude Code-style slug back into something human-readable.
 *   `C--Users-conno-Dev-MyApp` → `MyApp`
 *   `c-Dev-MyApp` → `MyApp`
 *   `-Users-conal-projects-cool-app` → `cool-app`
 *   `repo` → `repo`
 *
 * v0.2.1: handles the `C--` Windows drive-letter prefix produced by Claude
 * Code on Windows (the `C:\` root gets slug-encoded as `C--`).
 */
export function decodeSlug(slug: string): string {
  if (!slug) return slug;
  // Drop a leading dash if present (Unix slugs often start with one).
  let s = slug.startsWith('-') ? slug.slice(1) : slug;
  // Drop a `<letter>--` Windows-drive prefix if present.
  s = s.replace(/^[a-z]--/i, '');
  // Split on '-' and find the last meaningful segment.
  const parts = s.split('-').filter(Boolean);
  // v0.2.2: when the strip + split leaves nothing (slug was just "C--"
  // with no remainder), return an empty string so callers know to fall
  // back to cwd. Returning the original slug (the old behavior) shows
  // raw "C--" in the dashboard.
  if (parts.length === 0) return '';
  const last = parts[parts.length - 1]!;
  return last;
}

/**
 * Read the first valid line of a JSONL file and try to extract a cwd field.
 * Returns undefined on any failure — discovery should never throw because of
 * a malformed transcript.
 */
export async function extractCwdFromFirstLine(filePath: string): Promise<string | undefined> {
  // Open the file and read up to ~64 KB. We only need the first line; reading
  // a small chunk is cheap and avoids streaming the whole transcript.
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead <= 0) return undefined;
    const chunk = buf.slice(0, bytesRead).toString('utf8');
    const newline = chunk.indexOf('\n');
    const firstLine = (newline >= 0 ? chunk.slice(0, newline) : chunk).trim();
    if (!firstLine) return undefined;
    try {
      const parsed = JSON.parse(firstLine) as unknown;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.cwd === 'string') return obj.cwd;
        // Codex session_meta wraps cwd inside .payload
        const payload = obj.payload;
        if (payload && typeof payload === 'object') {
          const inner = (payload as Record<string, unknown>).cwd;
          if (typeof inner === 'string') return inner;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Generate a stable short id from an absolute path.
 */
export function sessionIdFromPath(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 12);
}

/**
 * Recursively walk a directory and yield every .jsonl file. Tolerates
 * missing dirs (returns []) and EACCES on subdirs (skips them).
 */
async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const nested = await walkJsonl(full);
      out.push(...nested);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Discover sessions across the supplied (or default) roots.
 *
 * The returned array is sorted by lastModified DESC.
 */
export async function discoverSessions(
  opts: DiscoverOptions = {}
): Promise<DiscoveredSession[]> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const cutoff = staleMs === Infinity ? -Infinity : Date.now() - staleMs;

  // Resolve roots. When `opts.roots` is supplied we use them verbatim and
  // infer runtime from the path. When not supplied, we use the platform
  // defaults with their pinned runtime labels.
  const roots: Root[] = opts.roots
    ? opts.roots.map((r) => {
        const abs = isAbsolute(r) ? r : resolve(r);
        return { path: abs, runtime: inferRuntimeFromPath(abs) };
      })
    : defaultRoots();

  const seen = new Map<string, DiscoveredSession>();

  for (const root of roots) {
    let exists = true;
    try {
      const st = await fs.stat(root.path);
      if (!st.isDirectory()) exists = false;
    } catch {
      exists = false;
    }
    if (!exists) continue;

    const files = await walkJsonl(root.path);
    for (const file of files) {
      let st;
      try {
        st = await fs.stat(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = st.mtimeMs;
      if (mtime < cutoff) continue;

      const absPath = resolve(file);
      if (seen.has(absPath)) continue;

      // Extract cwd first so deriveProjectName can use it as a fallback when
      // the path slug decodes to a junk single-letter (Windows drive only).
      const cwd = await extractCwdFromFirstLine(absPath);
      const projectName = deriveProjectName(absPath, root.path, cwd);

      seen.set(absPath, {
        id: sessionIdFromPath(absPath),
        runtime: root.runtime,
        transcriptPath: absPath,
        projectName,
        lastModified: mtime,
        cwd,
      });
    }
  }

  const out = Array.from(seen.values());
  out.sort((a, b) => b.lastModified - a.lastModified);
  return out;
}
