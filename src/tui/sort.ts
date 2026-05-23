/**
 * Session-list ordering for the live dashboard.
 *
 * Pure, no React or Ink imports — so the comparator can be unit-tested
 * directly without the test renderer.
 */

import type { SessionState } from '../types.js';
import { fallbackLabel } from './SessionList.js';

/**
 * Urgency ordering used as the secondary sort key.
 *
 * Drifting and stuck are warning-shaped; converging is "in flight, keep
 * an eye"; exploring is "low info"; idle and done are "parked / over".
 * Pending (recap === null) sits just below the warning tier — new
 * sessions are worth seeing, but not as urgent as confirmed drift.
 */
export const URGENCY_RANK: Record<string, number> = {
  drifting: 0,
  stuck: 1,
  pending: 2, // synthetic — used when recap is null
  converging: 3,
  exploring: 4,
  idle: 5,
  done: 6,
};

export function urgencyOf(s: SessionState): number {
  if (!s.recap) return URGENCY_RANK.pending!;
  return URGENCY_RANK[s.recap.verdict.bucket] ?? 7;
}

/**
 * v0.4.5: project-grouped comparator. Same-project sessions cluster so
 * "everything happening on `ontology`" reads as one unit, even when one
 * session is `stuck` and another is `done`. Verdict pills still surface
 * per-row urgency at a glance.
 *
 * Key precedence:
 *   1. Project label (case-insensitive ascending)
 *   2. Urgency rank within the project
 *   3. Runtime name ascending (stable tie-break across runtimes)
 *   4. lastUpdated DESC for truly identical project+runtime
 *
 * Trade-off vs. the prior urgency-first sort (removed in v0.4.5): a
 * single drifting session in an alphabetically-late project no longer
 * floats to the top of the screen. The pill colour still makes it
 * visible — but it's a deliberate shift away from strict mission-control
 * toward project-grouped read. Users who want urgency-first can scan by
 * pill colour or jump with `↓`.
 */
export function compareByProject(a: SessionState, b: SessionState): number {
  const pa = fallbackLabel(a).toLowerCase();
  const pb = fallbackLabel(b).toLowerCase();
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ua = urgencyOf(a);
  const ub = urgencyOf(b);
  if (ua !== ub) return ua - ub;
  const ra = a.session.runtime;
  const rb = b.session.runtime;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return b.lastUpdated - a.lastUpdated;
}
