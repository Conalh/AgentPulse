/**
 * Workstream A — Session discovery + filesystem watcher.
 *
 * Public surface:
 *   - `discoverSessions(opts?)`  → one-shot scan of transcript roots
 *   - `createSessionWatcher(opts?)` → long-lived watcher emitting
 *     add/change/remove events
 *
 * Contracts live in `../types.ts`. Pure node stdlib (no external deps).
 */

export { discoverSessions } from './discovery.js';
export { createSessionWatcher } from './watcher.js';
export { isSubagentTranscript, SUBAGENT_NAME_RE } from './subagents.js';
