/**
 * Shared display-label + collision-disambiguation helpers.
 *
 * Two surfaces render session lists: the live TUI (src/tui/SessionList.tsx)
 * and the headless `--once` snapshot (src/once.ts). Pre-v0.7.1 only the TUI
 * disambiguated co-named sessions — the JSON / text snapshot let two rows
 * land with identical labels, so users couldn't tell which terminal was
 * which. This module centralises the rule so both surfaces agree.
 *
 * The rule (kept consistent with the v0.4.4 SessionList implementation):
 *   - Two visible items collide when `<projectName>|<runtime>` is equal.
 *   - Aliased items don't participate in collision counting — the alias
 *     IS the disambiguator (v0.4.7 behaviour).
 *   - When a collision is detected, append ` · <first-N hex of id>`.
 */

/** Length of the hex tail used to disambiguate colliding labels. */
export const DISAMBIG_ID_LEN = 6;

/**
 * Shape we operate on. Both `SessionState` (TUI) and `SessionSnapshot`
 * (once.ts) can be projected onto this in a single map() — keeps the
 * helper free of surface-specific imports.
 */
export interface LabelInputs {
  id: string;
  projectName: string;
  runtime: string;
  /** v0.4.7: user-chosen alias. When present, it's the disambiguator and the
   *  hex tail is suppressed. Pass undefined when the surface doesn't support
   *  aliases (e.g. once.ts). */
  alias?: string;
}

export function labelCollisionKey(projectName: string, runtime: string): string {
  return `${projectName}|${runtime}`;
}

/**
 * Compute the disambiguator suffix for each input. Returns an array
 * aligned 1:1 with the input — empty strings for unique rows, a
 * ` · <hex>` suffix for colliding rows that aren't already aliased.
 *
 * Pure function. Surfaces decide how to render (TUI dims the suffix,
 * once.ts concatenates into the snapshot's `label` field).
 */
export function computeDisambigSuffixes(inputs: readonly LabelInputs[]): string[] {
  const counts = new Map<string, number>();
  for (const it of inputs) {
    if (it.alias) continue; // aliased rows don't drive collision detection
    const key = labelCollisionKey(it.projectName, it.runtime);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return inputs.map((it) => {
    if (it.alias) return '';
    const key = labelCollisionKey(it.projectName, it.runtime);
    if ((counts.get(key) ?? 0) < 2) return '';
    return ` · ${it.id.slice(0, DISAMBIG_ID_LEN)}`;
  });
}
