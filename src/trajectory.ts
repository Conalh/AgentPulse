// STUB — replaced by Agent #3 (outcome + trajectory workstream).
// See src/types.ts for the OutcomeSignal and TrajectoryVerdict contracts.

import type {
  EnrichedWindow,
  OutcomeSignal,
  TrajectoryVerdict,
  TrajectoryOptions,
} from './types.js';

export function readOutcomeSignal(_enriched: EnrichedWindow): OutcomeSignal {
  throw new Error('trajectory.readOutcomeSignal not yet implemented');
}

export function classifyTrajectory(
  _enriched: EnrichedWindow,
  _outcome: OutcomeSignal,
  _opts?: TrajectoryOptions
): TrajectoryVerdict {
  throw new Error('trajectory.classifyTrajectory not yet implemented');
}
