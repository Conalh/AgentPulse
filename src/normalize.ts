/**
 * v0.6.2 — cross-runtime event normalization.
 *
 * The README claims Claude Code / Cursor / Codex support, and the
 * substrate parsers in agent-gov-core v1.1.0 do parse all three line
 * formats correctly. But the enrichment / sequence / trajectory
 * layers in this package were originally written against the Anthropic
 * tool vocabulary (`Read` / `Edit` / `Write` / `Bash`) and the
 * Anthropic input shape (`toolInput.file_path`). That meant Cursor's
 * `toolInput.path` and Codex's `shell` / `apply_patch` tool names
 * silently classified as "other" — zero editing, zero verification,
 * no primary files. The corpus added in v0.6.1 was Claude Code-only,
 * so the gap stayed hidden.
 *
 * This module centralizes two normalization helpers used everywhere
 * the consumer layers reach into a `TranscriptEvent`:
 *
 *   - `canonicalToolName(name)` — maps per-runtime aliases onto the
 *     Anthropic-style canonical name so the action classifier's
 *     switch statement keeps working unchanged.
 *
 *   - `extractFilePath(toolInput)` — tries every known key for "the
 *     file this tool is touching" so path-cluster + primary-file
 *     accounting works regardless of which runtime emitted the event.
 *
 * Both are pure functions. No I/O, no logging, no exceptions.
 *
 * If the substrate (agent-gov-core) ever grows a "produce canonical
 * events" mode, this module becomes redundant and gets deleted.
 * Tracked in docs/PLANS.md under the duplication-audit lane.
 */

/**
 * Map per-runtime tool aliases onto the Anthropic-style canonical name.
 *
 * Codex equivalents:
 *   - `shell`        → Anthropic's `Bash` (arbitrary command exec)
 *   - `apply_patch`  → Anthropic's `Edit` (file content modification)
 *
 * Cursor uses the Anthropic vocabulary directly (`Read` / `Edit` /
 * `Write` / etc.) so no remapping is needed for tool names — only
 * the input-key normalization handled by `extractFilePath`.
 *
 * Unknown tool names pass through verbatim. The consumer layers'
 * `default` branches already handle them as `other`, which stays
 * the correct behaviour for genuinely unrecognized tools.
 */
export function canonicalToolName(name: string | undefined): string {
  if (!name) return '';
  switch (name) {
    case 'shell':
      return 'Bash';
    case 'apply_patch':
      return 'Edit';
    default:
      return name;
  }
}

/**
 * Extract the file path a tool is operating on, regardless of which
 * input key the runtime used.
 *
 * Key precedence (most-canonical to least):
 *   - `file_path` — Anthropic / Claude Code
 *   - `path`      — Cursor
 *   - `filePath`  — some older Cursor versions + custom tools
 *   - `notebook_path` — Anthropic NotebookEdit
 *
 * Returns `undefined` when none match or the value isn't a non-empty
 * string. Trajectory layer's `extractFilePath` already had this shape;
 * v0.6.2 lifts it out so enrichment + sequences match.
 */
export function extractFilePath(
  toolInput: Record<string, unknown> | undefined | null
): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const record = toolInput as Record<string, unknown>;
  const candidates = ['file_path', 'path', 'filePath', 'notebook_path'];
  for (const key of candidates) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }

  // v0.6.2: Codex's `apply_patch` arguments are intentionally not JSON;
  // the substrate parser falls back to `{ patch: <full-patch-text> }`.
  // The patch body uses `*** Add File: <path>` / `*** Update File: <path>` /
  // `*** Delete File: <path>` markers to identify the touched file(s).
  // We pluck the FIRST one — adequate for the "primary file" view, which
  // expects a single representative path per event. Multi-file patches
  // still get counted as editing actions (via the canonical Edit name),
  // they just contribute one path to the primary-files accounting.
  const patch = record.patch;
  if (typeof patch === 'string') {
    const m = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+?)\s*$/m.exec(patch);
    if (m && m[1]) return m[1];
  }

  return undefined;
}
