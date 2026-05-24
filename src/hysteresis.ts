/**
 * v0.5.4 — verdict hysteresis (a.k.a. "calm the flicker").
 *
 * Borderline sessions can bounce between buckets on consecutive refreshes
 * when their signals sit near a threshold — a flat_fail at pulse N and a
 * flat_pass at pulse N+1 flip the classifier between `stuck` and
 * `converging` even though the underlying work hasn't really changed
 * character. Pre-v0.5.4, the TUI pill flickered, OS notifications
 * double-fired, and the dashboard felt twitchy.
 *
 * This module damps the OUTPUT (what the orchestrator surfaces) without
 * touching the classifier's logic or output. The rule is simple:
 *
 *     A new bucket must be produced by **2 consecutive pulses** before
 *     it replaces the previously-stable bucket.
 *
 * Pure function over a small per-session state. Same six buckets, same
 * rules — just deferred surfacing. The user perceives this as "the
 * dashboard feels smarter / more intentional," not as a new feature.
 *
 * What's NOT damped: the narrative, signals, drift findings, and
 * confidence number stay tied to the latest pulse — only the bucket
 * LABEL on the pill is held back. So if a session just started failing
 * tests, the user sees "tests aren't passing" in the narrative on the
 * very next refresh; the pill colour just takes one more refresh to
 * follow. The narrative is always the truth; the pill is the consensus.
 *
 * First pulse: stableBucket initializes to the raw classifier output —
 * no dampening on session entry. A session that classifies as
 * `drifting` on its very first pulse alerts immediately.
 */

import type { TrajectoryBucket } from './types.js';

/** How many consecutive pulses must agree before flipping the stable
 *  bucket. 2 is the minimum useful threshold (1 = no dampening). */
export const HYSTERESIS_CONFIRMATIONS = 2;

export interface HysteresisState {
  /** The bucket currently surfaced to consumers. */
  stableBucket: TrajectoryBucket;
  /** The most recent classifier output, when it differs from stable.
   *  `null` means the latest pulse agreed with `stableBucket`. */
  pendingBucket: TrajectoryBucket | null;
  /** How many pulses in a row have produced `pendingBucket`. */
  pendingCount: number;
}

/**
 * Build the initial state for a session whose first classifier output
 * is `bucket`. The first observation IS the truth — no dampening
 * happens until the second observation disagrees.
 */
export function initialHysteresis(bucket: TrajectoryBucket): HysteresisState {
  return {
    stableBucket: bucket,
    pendingBucket: null,
    pendingCount: 0,
  };
}

export interface HysteresisStep {
  /** Updated state to persist for the next pulse. */
  state: HysteresisState;
  /** The bucket to surface to consumers right now. */
  stableBucket: TrajectoryBucket;
  /** True when this step caused `stableBucket` to change vs. the prior
   *  state. Useful for telemetry / debug logging. */
  flipped: boolean;
}

/**
 * Apply one pulse's worth of classifier output to the hysteresis state.
 * Pure — input state is not mutated; the returned `state` is the new
 * value to store.
 *
 * Cases:
 *  - `rawBucket === stableBucket` → no candidate, pending cleared
 *  - `rawBucket === pendingBucket` → increment confirmation count;
 *    flip stable to raw when count reaches HYSTERESIS_CONFIRMATIONS
 *  - `rawBucket` is a fresh disagreement → start a new candidate
 *    with count = 1 (does NOT flip yet — needs one more confirmation)
 */
export function applyHysteresis(
  state: HysteresisState,
  rawBucket: TrajectoryBucket
): HysteresisStep {
  // Case A: latest classifier output agrees with what we're already showing.
  // Reset any pending candidate; we're stable.
  if (rawBucket === state.stableBucket) {
    return {
      state: {
        stableBucket: state.stableBucket,
        pendingBucket: null,
        pendingCount: 0,
      },
      stableBucket: state.stableBucket,
      flipped: false,
    };
  }

  // Case B: latest classifier output continues the existing pending candidate.
  // Bump the count; flip stable when we hit the confirmation threshold.
  if (rawBucket === state.pendingBucket) {
    const nextCount = state.pendingCount + 1;
    if (nextCount >= HYSTERESIS_CONFIRMATIONS) {
      // Threshold reached — flip stable to the new bucket, clear pending.
      return {
        state: {
          stableBucket: rawBucket,
          pendingBucket: null,
          pendingCount: 0,
        },
        stableBucket: rawBucket,
        flipped: true,
      };
    }
    return {
      state: {
        stableBucket: state.stableBucket,
        pendingBucket: state.pendingBucket,
        pendingCount: nextCount,
      },
      stableBucket: state.stableBucket,
      flipped: false,
    };
  }

  // Case C: latest classifier output is a new disagreement.
  // Start a fresh candidate with count = 1.
  return {
    state: {
      stableBucket: state.stableBucket,
      pendingBucket: rawBucket,
      pendingCount: 1,
    },
    stableBucket: state.stableBucket,
    flipped: false,
  };
}
