/**
 * Shared predicate for recognising Claude Code SDK subagent transcripts.
 *
 * Claude Code stores transcripts of agents spawned via the SDK under
 * names like `agent-a92e01b8034a7c780`. They live next to the parent
 * session's transcript and look identical structurally, but they're
 * ephemeral tooling artifacts — not the developer's own work.
 *
 * Pre-v0.7.1 each surface (TUI App, `--once` headless mode, JSON
 * snapshot) had to know about this separately; the TUI filtered them
 * but `once.ts` did not, so `agentpulse live --once` snapshots showed
 * every parent session 1+N times (once for the parent, once per
 * SDK-spawned subagent). One shared predicate keeps the two surfaces
 * honest.
 */

/** Subagent-shaped project names — `agent-<hex>` where hex is 8+ chars. */
export const SUBAGENT_NAME_RE = /^agent-[0-9a-f]{8,}/i;

/**
 * True when the session looks like an SDK-spawned subagent transcript.
 *
 * Checks both `projectName` (the discovered label) and the transcript
 * file's basename: in some Claude Code layouts the slug decode fails
 * and the basename UUID would trip the same pattern as a project name
 * would — covering both keeps the predicate the same regardless of
 * which surface called it.
 */
export function isSubagentTranscript(
  projectName: string | undefined,
  transcriptPath: string
): boolean {
  if (projectName && SUBAGENT_NAME_RE.test(projectName)) return true;
  const tail = transcriptPath.split(/[\\/]/).pop() ?? '';
  if (SUBAGENT_NAME_RE.test(tail)) return true;
  // v0.7.1: also catch the structural case — Claude Code stores SDK
  // subagent transcripts under `<parent>/subagents/agent-<hex>.jsonl`,
  // so a path containing the `subagents` segment with an agent-shaped
  // file is unambiguously a subagent regardless of how the project
  // name decoded.
  const segments = transcriptPath.split(/[\\/]/);
  const subIdx = segments.indexOf('subagents');
  if (subIdx >= 0 && subIdx < segments.length - 1) {
    return SUBAGENT_NAME_RE.test(segments[subIdx + 1] ?? '');
  }
  return false;
}
