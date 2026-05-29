/**
 * Drift-kind namespace helpers — single source of truth for the
 * `agent_pulse.live_drift_<slug>` convention.
 *
 * `buildDrift` in trajectory.ts stamps every live-drift Finding's `kind`
 * with this namespace; the narrative renderer and the TUI drift-summary
 * banner strip it back off to show the user the meaningful suffix
 * (`shell_exfil`, `privileged_read`, `write_outside_repo`, …). Keeping the
 * prefix and the extractor together means the two ends can't drift apart
 * (the suffix-slice was previously copy-pasted with two different magic
 * offsets).
 */

/** Namespace prefix the orchestrator stamps onto every live-drift kind. */
export const DRIFT_KIND_PREFIX = 'agent_pulse.live_drift_';

/** The substring searched for when extracting a slug from a drift kind. */
const DRIFT_KIND_MARKER = '_drift_';

/** Build a fully-namespaced drift `kind` from a bare slug. */
export function driftKind(slug: string): string {
  return `${DRIFT_KIND_PREFIX}${slug}`;
}

/**
 * Extract the meaningful suffix from a drift `kind`, dropping everything
 * up to and including `_drift_`. Kinds without the marker pass through
 * unchanged.
 */
export function driftSlug(kind: string | undefined): string {
  const k = String(kind ?? '');
  const idx = k.lastIndexOf(DRIFT_KIND_MARKER);
  return idx >= 0 ? k.slice(idx + DRIFT_KIND_MARKER.length) : k;
}
