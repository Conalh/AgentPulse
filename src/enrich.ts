// STUB — replaced by Agent #2 (enrichment workstream).
// See src/types.ts for the EnrichedWindow contract.

import type { TranscriptEvent, EnrichedWindow, EnrichOptions } from './types.js';

export function enrichWindow(
  _events: TranscriptEvent[],
  _windowStart: number,
  _windowEnd: number,
  _opts?: EnrichOptions
): EnrichedWindow {
  throw new Error('enrich.enrichWindow not yet implemented');
}
