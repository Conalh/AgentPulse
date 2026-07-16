/**
 * Layer 2 — Semantic enrichment.
 *
 * Pure, deterministic transformation: TranscriptEvent[] → EnrichedWindow.
 * No I/O, no network, no LLM, no external libs beyond Node stdlib.
 *
 * See src/types.ts for the EnrichedWindow contract.
 */

import type {
  TranscriptEvent,
  EnrichedWindow,
  EnrichOptions,
  ActionClass,
  Runtime,
} from './types.js';
import {
  canonicalToolName,
  extractFilePath as extractFilePathFromInput,
} from './normalize.js';
import { isVerificationCommand } from './verification.js';

// ─────────────────────────────────────────────────────────────────────
// Stopwords — small English list. Frequency-based topic extraction with
// a stopword filter is sufficient for v0.1; TF-IDF is overkill.
// ─────────────────────────────────────────────────────────────────────

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'and', 'or', 'but', 'if', 'so', 'as', 'at', 'by', 'in', 'on',
  'for', 'from', 'with', 'into', 'onto', 'about', 'over', 'under', 'than',
  'then', 'that', 'this', 'these', 'those', 'there', 'here', 'where', 'when',
  'what', 'why', 'how', 'who', 'whom', 'which', 'whose',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'do', 'does', 'did', 'done', 'doing',
  'have', 'has', 'had', 'having',
  'i', 'you', 'me', 'my', 'mine', 'your', 'yours', 'we', 'us', 'our', 'ours',
  'they', 'them', 'their', 'theirs', 'he', 'she', 'his', 'her', 'hers', 'it',
  'its', 'one', 'ones',
  'just', 'only', 'also', 'too', 'very', 'really', 'quite', 'still', 'again',
  'not', 'no', 'yes', 'ok', 'okay',
  'get', 'got', 'getting', 'go', 'goes', 'going', 'gone',
  'make', 'made', 'makes', 'making',
  'see', 'saw', 'seen', 'seeing',
  'now', 'soon', 'later', 'before', 'after', 'while', 'during',
  'some', 'any', 'all', 'both', 'each', 'every', 'few', 'many', 'much', 'most',
  'other', 'others', 'another', 'such', 'same',
  'up', 'down', 'out', 'off', 'away', 'back',
  'pls', 'please', 'thanks', 'thank',
  'lets', "let's", 'let',
  's', 't', 'd', 'll', 're', 've', 'm',
  // v0.4.3: evaluative adjectives and conversational fillers. Without this
  // expansion, a noisy real session can surface "bad" / "good" / "looks" /
  // "thing" as the agent's *topic* — the narrative then reads
  // "working on bad for 20 minutes" which is broken English. None of these
  // words are real subjects of work, just sentiment / filler.
  'bad', 'good', 'great', 'fine', 'nice', 'cool', 'awesome', 'weird',
  'broken', 'wrong', 'right', 'sure', 'better', 'best', 'worse', 'worst',
  'big', 'small', 'long', 'short', 'hard', 'easy',
  'looks', 'look', 'looking', 'looked',
  'seems', 'seemed', 'seem', 'seeming',
  'want', 'wants', 'wanted', 'wanting',
  'need', 'needs', 'needed', 'needing',
  'try', 'tries', 'tried', 'trying',
  'said', 'says', 'say', 'saying',
  'think', 'thinks', 'thought', 'thinking',
  'guess', 'guesses', 'guessed', 'guessing',
  'maybe', 'probably', 'definitely', 'always', 'never', 'often',
  'thing', 'things', 'stuff', 'way', 'ways', 'kind', 'kinds', 'sort', 'sorts',
  'hmm', 'hm', 'yeah', 'yep', 'nope', 'lol', 'haha', 'hey', 'hi', 'hello',
  'oh', 'ah', 'wow', 'sorry', 'huh',
]);

// Exported for tests / introspection.
export const STOPWORD_COUNT: number = STOPWORDS.size;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  // Lowercase, replace anything that isn't a-z, 0-9, or apostrophe with space,
  // then split on whitespace and drop empties.
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function topNByCount(
  counts: Map<string, number>,
  n: number,
): string[] {
  // Deterministic tie-break: descending count, then ascending key.
  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, n)
    .map(([k]) => k);
}

function getFilePath(toolInput: Record<string, unknown> | undefined): string | undefined {
  // v0.6.2: delegate to the shared normalizer so Cursor (`path`) +
  // Anthropic (`file_path`) + NotebookEdit (`notebook_path`) all land.
  // Pre-fix this only checked `file_path`, so Cursor edits were
  // invisible to the path-cluster + primary-file accounting.
  return extractFilePathFromInput(toolInput);
}

/**
 * Bucket a file path by its top-2-segment parent directory.
 *
 * v0.2.5: when an event's `cwd` is provided, the cwd prefix is stripped
 * first so absolute paths cluster by their *project-relative* directory
 * rather than by their absolute path prefix. Pre-fix, every session
 * working under `C:/Dev/<project>/...` showed `top cluster C:/Dev covers
 * 99%`, which is useless because the umbrella directory tells you nothing
 * about what the agent is focused on.
 *
 * Examples (cwd = `C:/Dev/sample-app`):
 *   `C:/Dev/sample-app/app.py`           → `(project root)`
 *   `C:/Dev/sample-app/utils/foo.py`     → `utils`
 *   `C:/Dev/sample-app/src/api/foo.py`   → `src/api`
 *   `C:/Dev/other-project/foo.py`          → `C:/Dev/other-project` (no strip — outside cwd)
 *
 * No cwd (or cwd doesn't match):
 *   `src/auth/middleware.ts`               → `src/auth`
 *   `tests/unit/foo.test.ts`               → `tests/unit`
 *   `single.ts`                            → `(project root)`
 */
function pathClusterKey(filePath: string, cwd: string | undefined): string {
  let norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');

  if (cwd) {
    const cwdNorm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    if (cwdNorm.length > 0) {
      const prefix = cwdNorm + '/';
      // Case-insensitive comparison handles Windows drive-letter casing
      // (`C:/Dev` vs `c:/Dev`) without lower-casing the actual path slice
      // that we return.
      if (norm.toLowerCase().startsWith(prefix.toLowerCase())) {
        norm = norm.slice(prefix.length);
      } else if (norm.toLowerCase() === cwdNorm.toLowerCase()) {
        return '(project root)';
      }
    }
  }

  const parts = norm.split('/').filter((p) => p.length > 0);
  if (parts.length <= 1) return '(project root)';
  const dirParts = parts.slice(0, -1);
  if (dirParts.length === 0) return '(project root)';
  if (dirParts.length === 1) return dirParts[0]!;
  return `${dirParts[0]}/${dirParts[1]}`;
}

const NAVIGATION_PATTERNS: readonly RegExp[] = [
  /^\s*cd(\s|$)/,
  /^\s*ls(\s|$)/,
  /^\s*pwd(\s|$)/,
  /^\s*git\s+status(\s|$)/,
  /^\s*git\s+log(\s|$)/,
  /^\s*git\s+diff(\s|$)/,
  /^\s*git\s+branch(\s|$)/,
  /^\s*git\s+show(\s|$)/,
  /^\s*echo(\s|$)/,
  /^\s*which(\s|$)/,
  /^\s*whoami(\s|$)/,
];

const EXTERNAL_BASH_PATTERNS: readonly RegExp[] = [
  /^\s*curl(\s|$)/,
  /^\s*wget(\s|$)/,
  /^\s*http(\s|$)/,
  /^\s*httpie(\s|$)/,
  /^\s*gh\s+api(\s|$)/,
];

function classifyToolUse(event: TranscriptEvent): ActionClass {
  // v0.6.2: route through `canonicalToolName` so Codex's `shell` lands
  // as `Bash` and Codex's `apply_patch` lands as `Edit`. Pre-fix, both
  // fell through to the `default` branch and got tagged `other`, which
  // meant Codex sessions showed zero editing + zero verification.
  const rawName = event.toolName ?? '';
  const name = canonicalToolName(rawName);

  // MCP tools (any tool name starting with `mcp__`) → external. Keyed
  // off the raw name because canonicalization only rewrites known
  // runtime aliases.
  if (rawName.startsWith('mcp__')) return 'external';

  switch (name) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'exploration';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'editing';
    case 'WebFetch':
    case 'WebSearch':
      return 'external';
    case 'Bash': {
      const cmd = String(event.toolInput?.['command'] ?? '');
      // External Bash beats navigation/verification — `curl` is external even
      // though we never expect it to also be navigation.
      for (const re of EXTERNAL_BASH_PATTERNS) {
        if (re.test(cmd)) return 'external';
      }
      if (isVerificationCommand(cmd)) return 'verification';
      for (const re of NAVIGATION_PATTERNS) {
        if (re.test(cmd)) return 'navigation';
      }
      return 'other';
    }
    default:
      return 'other';
  }
}

function commandVerbOf(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) return tokens[0];
  return `${tokens[0]} ${tokens[1]}`;
}

// ─────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────

export function enrichWindow(
  events: TranscriptEvent[],
  windowStart: number,
  windowEnd: number,
  opts?: EnrichOptions,
): EnrichedWindow {
  const topicLimit = opts?.topicLimit ?? 5;
  const primaryFileLimit = opts?.primaryFileLimit ?? 3;
  const commandVerbLimit = opts?.commandVerbLimit ?? 5;

  // Filter to events inside the window. timestamp === 0 means "unknown" per
  // the parser contract; drop those.
  const inWindow = events.filter(
    (e) =>
      typeof e.timestamp === 'number' &&
      e.timestamp > 0 &&
      e.timestamp >= windowStart &&
      e.timestamp <= windowEnd,
  );

  // 1. Topic extraction from user prose.
  const topicCounts = new Map<string, number>();
  let userMessageCount = 0;
  for (const e of inWindow) {
    if (e.kind !== 'user_message') continue;
    userMessageCount += 1;
    const text = e.text ?? '';
    for (const tok of tokenize(text)) {
      if (STOPWORDS.has(tok)) continue;
      // Drop pure numeric tokens and single-character tokens — noise.
      if (tok.length < 2) continue;
      if (/^\d+$/.test(tok)) continue;
      topicCounts.set(tok, (topicCounts.get(tok) ?? 0) + 1);
    }
  }
  const topics = topNByCount(topicCounts, topicLimit);

  // 2. Path clusters from tool inputs that carry a file_path.
  const pathClusters: Record<string, number> = {};
  // 4. Primary files (Write/Edit/NotebookEdit edit counts per file).
  const editCounts = new Map<string, number>();
  // 3. Action classification counts.
  const actionCounts: Record<ActionClass, number> = {
    exploration: 0,
    editing: 0,
    verification: 0,
    external: 0,
    navigation: 0,
    other: 0,
  };
  // 5. Command verbs.
  const verbCounts = new Map<string, number>();
  // 6. Aggregates.
  const uniqueToolsSet = new Set<string>();
  let toolInvocationCount = 0;
  const runtimeUsage: Partial<Record<Runtime, number>> = {};

  for (const e of inWindow) {
    // Runtime usage covers all events, not just tool_use.
    if (e.runtime) {
      runtimeUsage[e.runtime] = (runtimeUsage[e.runtime] ?? 0) + 1;
    }

    if (e.kind !== 'tool_use') continue;

    toolInvocationCount += 1;
    const toolName = canonicalToolName(e.toolName);
    if (toolName) uniqueToolsSet.add(toolName);

    const fp = getFilePath(e.toolInput);
    if (fp) {
      // v0.2.5: per-event cwd lets cluster keys be project-relative, so a
      // session working entirely under `C:/Dev/foo/` clusters by its
      // subdirectories instead of by the absolute umbrella path.
      const cluster = pathClusterKey(fp, e.cwd);
      pathClusters[cluster] = (pathClusters[cluster] ?? 0) + 1;
    }

    const cls = classifyToolUse(e);
    actionCounts[cls] += 1;

    if (cls === 'editing' && fp) {
      editCounts.set(fp, (editCounts.get(fp) ?? 0) + 1);
    }

    if (toolName === 'Bash') {
      const cmd = String(e.toolInput?.['command'] ?? '');
      const verb = commandVerbOf(cmd);
      if (verb) verbCounts.set(verb, (verbCounts.get(verb) ?? 0) + 1);
    }
  }

  const primaryFiles = topNByCount(editCounts, primaryFileLimit);
  const commandVerbs = topNByCount(verbCounts, commandVerbLimit);
  const uniqueTools = [...uniqueToolsSet].sort();

  return {
    events: inWindow,
    windowStart,
    windowEnd,
    durationMs: windowEnd - windowStart,
    topics,
    pathClusters,
    actionCounts,
    primaryFiles,
    commandVerbs,
    uniqueTools,
    toolInvocationCount,
    userMessageCount,
    runtimeUsage,
  };
}
