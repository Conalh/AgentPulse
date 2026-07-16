/**
 * v0.4.8 — short, scannable summary of drift-finding kinds for the
 * whitelist-preview banner.
 *
 * Strips the `agent_pulse.live_drift_` prefix (the orchestrator prefixes
 * every drift kind with this namespace) so the user sees the meaningful
 * suffix: `shell_exfil`, `privileged_read`, `write_outside_repo`, etc.
 *
 * The banner is one line at the bottom of the dashboard, so we cap the
 * output: first two kinds rendered in full, anything past that collapses
 * to `+N more`. Empty list → empty string (caller suppresses the parens
 * around the kinds list).
 *
 * Pure — no React, no Ink. Lives in its own module so the v0.4.8 test
 * file can pull it without booting the test renderer.
 */

import type { Finding } from 'agent-gov-core';
import { driftSlug } from '../drift.js';

export function summarizeDriftKinds(drifts: readonly Finding[]): string {
  const shortKinds = drifts.map((d) => driftSlug(d.kind));
  if (shortKinds.length === 0) return '';
  if (shortKinds.length <= 2) return shortKinds.join(', ');
  return `${shortKinds[0]}, ${shortKinds[1]}, +${shortKinds.length - 2} more`;
}
