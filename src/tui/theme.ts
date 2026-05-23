/**
 * Color + pill mappings for trajectory buckets.
 *
 * Kept as a pure module so it can be unit-tested without spinning up Ink.
 * Colors are the bare ink color names (passed straight to `<Text color>`).
 */

import type { TrajectoryBucket } from '../types.js';

export type BucketColor = 'green' | 'gray' | 'yellow' | 'blue' | 'red';

const COLORS: Record<TrajectoryBucket, BucketColor> = {
  converging: 'green',
  exploring: 'gray',
  stuck: 'yellow',
  done: 'blue',
  drifting: 'red',
  // v0.2.6: idle shares the gray family with exploring but uses a distinct
  // pill so the at-a-glance read is "this session is parked" rather than
  // "this session is researching".
  idle: 'gray',
};

const PILLS: Record<TrajectoryBucket, string> = {
  converging: '●',
  exploring: '◐',
  stuck: '▲',
  done: '■',
  drifting: '⚠',
  // Open circle — distinguishable from converging's filled ●, exploring's
  // half ◐, and done's square ■. Reads as "empty / waiting".
  idle: '○',
};

export function colorFor(bucket: TrajectoryBucket): BucketColor {
  return COLORS[bucket];
}

export function pillFor(bucket: TrajectoryBucket): string {
  return PILLS[bucket];
}

/** True when the verdict should be rendered with a dimmed bucket name. */
export function isLowConfidence(confidence: number): boolean {
  return confidence < 0.5;
}
