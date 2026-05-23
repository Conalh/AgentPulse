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

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

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
 * `c-Dev-MyApp` for the project dir (originally `C:\Dev\MyApp` or
 * `/c/Dev/MyApp`). We take the last "meaningful" segment after splitting on
 * the slug separator.
 */
export function deriveProjectName(transcriptPath: string, rootPath: string): string | undefined {
  // The project dir is the path component that sits directly under the root.
  // If the transcript lives multiple levels deep we still take the first
  // segment under the root — that's typically the project slug for both
  // Claude Code and Cursor.
  const normTranscript = resolve(transcriptPath);
  const normRoot = resolve(rootPath);
  if (!normTranscript.startsWith(normRoot + sep) && normTranscript !== normRoot) {
    // Fall back to the parent dir's basename.
    return decodeSlug(basename(transcriptPath, '.jsonl')) || undefined;
  }
  const rel = normTranscript.slice(normRoot.length + 1);
  const firstSeg = rel.split(/[\\/]/)[0];
  if (!firstSeg) return undefined;
  // If firstSeg IS the file itself (transcript at root), use its basename.
  if (firstSeg.toLowerCase().endsWith('.jsonl')) {
    return decodeSlug(basename(firstSeg, '.jsonl')) || undefined;
  }
  return decodeSlug(firstSeg) || undefined;
}

/**
 * Convert a Claude Code-style slug back into something human-readable.
 *   `c-Dev-MyApp` → `MyApp`
 *   `-Users-conal-projects-cool-app` → `cool-app`
 *   `repo` → `repo`
 */
export function decodeSlug(slug: string): string {
  if (!slug) return slug;
  // Drop a leading dash if present (Unix slugs often start with one).
  let s = slug.startsWith('-') ? slug.slice(1) : slug;
  // Split on '-' and find the last segment that looks "name-ish" — i.e. not
  // a single letter (drive prefix) and not a system directory name.
  const parts = s.split('-').filter(Boolean);
  if (parts.length === 0) return slug;
  // Heuristic: take the last 1-2 segments. If the very last segment is short
  // and the prior is longer, join them. Otherwise just return the last.
  const last = parts[parts.length - 1];
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

      const projectName = deriveProjectName(absPath, root.path);
      const cwd = await extractCwdFromFirstLine(absPath);

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
