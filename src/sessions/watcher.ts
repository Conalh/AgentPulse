/**
 * Filesystem watcher for transcript directories.
 *
 * Strategy:
 *   1. On start(), seed the in-memory map by calling `discoverSessions`.
 *   2. For each root that exists, attempt `fs.watch(root, {recursive:true})`.
 *      If that throws ENOTSUP / EPERM / ENOENT, fall back to polling that
 *      root via setInterval + readdir scans.
 *   3. Coalesce rapid events per file with a per-file debounce timer.
 *   4. Each scheduled probe stats the file:
 *        - missing  → emit 'remove' if we'd previously seen it
 *        - new      → build a DiscoveredSession + emit 'add'
 *        - changed  → emit 'change' (mtime or size moved)
 *
 * Pure node stdlib. See `src/types.ts` for the contract.
 */

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  DiscoveredSession,
  Runtime,
  SessionEvent,
  SessionWatcher,
  WatcherOptions,
} from '../types.js';
import {
  buildWalkLimits,
  defaultRoots,
  deriveProjectName,
  discoverSessions,
  extractCwdFromFirstLine,
  inferRuntimeFromPath,
  sessionIdFromPath,
  type WalkLimits,
} from './discovery.js';

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_POLL_INTERVAL_MS = 1000;

interface ResolvedRoot {
  path: string;
  runtime: Runtime;
}

type Listener = (event: SessionEvent) => void;

function isJsonlPath(p: string): boolean {
  return p.toLowerCase().endsWith('.jsonl');
}

async function safeStat(filePath: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

async function listJsonl(dir: string, limits: WalkLimits): Promise<string[]> {
  const out: string[] = [];
  // Track depth alongside each pending dir so the same maxDepth / exclude
  // bounds the polling scan that discovery.walkJsonl applies — a broad
  // root shouldn't trigger an unbounded recursive re-scan every poll tick.
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  while (stack.length > 0) {
    const { dir: cur, depth } = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(cur, ent.name);
      if (ent.isDirectory()) {
        if (depth >= limits.maxDepth) continue;
        if (limits.exclude.has(ent.name.toLowerCase())) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile() && isJsonlPath(ent.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

export function createSessionWatcher(opts: WatcherOptions = {}): SessionWatcher {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const discoverOpts = opts.discover ?? {};
  // Same depth/exclude bounds the one-shot discovery applies, so polling
  // mode doesn't re-walk an unbounded tree every interval.
  const walkLimits = buildWalkLimits(discoverOpts);

  // Resolve roots once. We don't re-resolve later — the contract says the
  // watcher watches "the roots", not "wherever the user moves them to".
  const roots: ResolvedRoot[] = discoverOpts.roots
    ? discoverOpts.roots.map((r) => {
        const abs = isAbsolute(r) ? r : resolve(r);
        return { path: abs, runtime: inferRuntimeFromPath(abs) };
      })
    : defaultRoots();

  const known = new Map<string, DiscoveredSession>(); // keyed by absPath
  const sizes = new Map<string, { mtimeMs: number; size: number }>();
  const listeners = new Set<Listener>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const fsWatchers: FSWatcher[] = [];
  const pollTimers: NodeJS.Timeout[] = [];
  const pollRoots = new Set<string>(); // roots in polling mode

  let running = false;
  let stopping = false;

  function emit(event: SessionEvent): void {
    // Snapshot listeners to allow off() during dispatch.
    const snap = Array.from(listeners);
    for (const l of snap) {
      try {
        l(event);
      } catch {
        // Listener errors are not the watcher's problem.
      }
    }
  }

  // v0.3.1: Windows filesystems are case-insensitive. `resolve()` preserves
  // the case the user supplied (e.g. `--roots c:\dev\transcripts`), but file
  // events arrive in whatever case the FS reports (`C:\Dev\transcripts\...`).
  // Pre-fix, exact-case comparison meant rootForPath returned undefined for
  // every event on win32, the project name fell through to session-<id>, and
  // the user saw a UUID-shaped dashboard. We normalize to lowercase on win32
  // for the comparison only — returned values still use the original casing.
  const isWin32 = process.platform === 'win32';
  const norm = (s: string): string => (isWin32 ? s.toLowerCase() : s);

  function rootForPath(absPath: string): ResolvedRoot | undefined {
    let best: ResolvedRoot | undefined;
    let bestLen = -1;
    const a = norm(absPath);
    for (const r of roots) {
      const rp = norm(r.path);
      if (
        (a === rp || a.startsWith(rp + '\\') || a.startsWith(rp + '/')) &&
        r.path.length > bestLen
      ) {
        best = r;
        bestLen = r.path.length;
      }
    }
    return best;
  }

  /**
   * Probe a path: classify as add/change/remove, emit, mutate known map.
   * Called from debounced timers.
   */
  async function probe(absPath: string): Promise<void> {
    if (stopping) return;
    if (!isJsonlPath(absPath)) return;

    const st = await safeStat(absPath);
    const had = known.get(absPath);

    if (!st) {
      if (had) {
        known.delete(absPath);
        sizes.delete(absPath);
        emit({ type: 'remove', sessionId: had.id });
      }
      return;
    }

    if (!had) {
      const root = rootForPath(absPath);
      const runtime: Runtime = root ? root.runtime : inferRuntimeFromPath(absPath);
      // v0.6.2: extract cwd FIRST so deriveProjectName can use it as the
      // junky-slug fallback (matches the discovery.ts order at line ~295).
      // Pre-fix, codex date-shape slugs like `2026/05/23` on a fresh
      // file went through deriveProjectName WITHOUT cwd, hitting the
      // v0.4.6 date-shape branch and returning undefined → row label
      // fell back to the session-id stub until the next watcher cycle.
      // Now: same cwd-aware lookup as discovery, immediately on add.
      const cwd = await extractCwdFromFirstLine(absPath);
      const projectName = root
        ? deriveProjectName(absPath, root.path, cwd)
        : undefined;
      const session: DiscoveredSession = {
        id: sessionIdFromPath(absPath),
        runtime,
        transcriptPath: absPath,
        projectName,
        lastModified: st.mtimeMs,
        cwd,
      };
      known.set(absPath, session);
      sizes.set(absPath, st);
      emit({ type: 'add', session });
      return;
    }

    // Already known — detect change via mtime or size delta.
    const prev = sizes.get(absPath);
    const changed =
      !prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size;
    if (changed) {
      const updated: DiscoveredSession = {
        ...had,
        lastModified: st.mtimeMs,
      };
      known.set(absPath, updated);
      sizes.set(absPath, st);
      emit({ type: 'change', session: updated });
    }
  }

  function schedule(absPath: string): void {
    if (stopping) return;
    if (!isJsonlPath(absPath)) return;
    const existing = debounceTimers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(absPath);
      void probe(absPath);
    }, debounceMs);
    // Allow the process to exit even if a debounce timer is pending.
    if (typeof timer.unref === 'function') timer.unref();
    debounceTimers.set(absPath, timer);
  }

  async function pollScan(root: ResolvedRoot): Promise<void> {
    if (stopping) return;
    const files = await listJsonl(root.path, walkLimits);
    const seen = new Set<string>();
    for (const f of files) {
      const abs = resolve(f);
      seen.add(abs);
      // For polling, probe directly (debounce still applies via schedule()
      // so concurrent fs events don't pile up).
      schedule(abs);
    }
    // Detect removals — any known file under this root that's no longer there.
    // Same case-insensitive normalization as rootForPath (v0.3.1).
    const rootNorm = norm(root.path);
    for (const abs of Array.from(known.keys())) {
      const a = norm(abs);
      if (
        (a === rootNorm || a.startsWith(rootNorm + '\\') || a.startsWith(rootNorm + '/')) &&
        !seen.has(abs)
      ) {
        schedule(abs);
      }
    }
  }

  function startPollingRoot(root: ResolvedRoot): void {
    pollRoots.add(root.path);
    const timer = setInterval(() => {
      void pollScan(root);
    }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    pollTimers.push(timer);
  }

  function tryRecursiveWatch(root: ResolvedRoot): boolean {
    try {
      const w = fsWatch(root.path, { recursive: true }, (_eventType, filename) => {
        if (!filename) {
          // No filename in the event — fall back to a scan of the root.
          void pollScan(root);
          return;
        }
        const rel = typeof filename === 'string' ? filename : String(filename);
        const abs = resolve(join(root.path, rel));
        if (!isJsonlPath(abs)) return;
        schedule(abs);
      });
      w.on('error', () => {
        // If the OS watcher errors out, swap to polling for this root.
        try {
          w.close();
        } catch {
          // ignore
        }
        if (!pollRoots.has(root.path)) startPollingRoot(root);
      });
      fsWatchers.push(w);
      return true;
    } catch {
      return false;
    }
  }

  async function startImpl(): Promise<void> {
    if (running) return;
    running = true;
    stopping = false;

    // Seed the known map using discoverSessions on the same roots so
    // snapshot() is meaningful before any events arrive.
    const seedRoots = discoverOpts.roots ?? roots.map((r) => r.path);
    let seeded: DiscoveredSession[] = [];
    try {
      seeded = await discoverSessions({
        ...discoverOpts,
        roots: seedRoots,
      });
    } catch {
      seeded = [];
    }
    for (const s of seeded) {
      known.set(s.transcriptPath, s);
      const st = await safeStat(s.transcriptPath);
      if (st) sizes.set(s.transcriptPath, st);
    }

    for (const root of roots) {
      let exists = false;
      try {
        const st = await fs.stat(root.path);
        exists = st.isDirectory();
      } catch {
        exists = false;
      }
      if (!exists) {
        // Watch its eventual existence cheaply by polling. listJsonl on a
        // non-existent dir just returns [] so this is safe.
        startPollingRoot(root);
        continue;
      }
      const ok = tryRecursiveWatch(root);
      if (!ok) startPollingRoot(root);
    }
  }

  async function stopImpl(): Promise<void> {
    if (!running) return;
    stopping = true;
    running = false;
    for (const w of fsWatchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    fsWatchers.length = 0;
    for (const t of pollTimers) clearInterval(t);
    pollTimers.length = 0;
    pollRoots.clear();
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
  }

  return {
    start: startImpl,
    stop: stopImpl,
    on(listener) {
      listeners.add(listener);
    },
    off(listener) {
      listeners.delete(listener);
    },
    snapshot() {
      const arr = Array.from(known.values());
      arr.sort((a, b) => b.lastModified - a.lastModified);
      return arr;
    },
  };
}
