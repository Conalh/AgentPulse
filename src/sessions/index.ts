// STUB — replaced by Workstream A (sessions: discovery + watcher).
// See src/types.ts for the contracts.

import type {
  DiscoveredSession,
  DiscoverOptions,
  SessionWatcher,
  WatcherOptions,
} from '../types.js';

export async function discoverSessions(
  _opts?: DiscoverOptions
): Promise<DiscoveredSession[]> {
  throw new Error('sessions.discoverSessions not yet implemented');
}

export function createSessionWatcher(_opts?: WatcherOptions): SessionWatcher {
  throw new Error('sessions.createSessionWatcher not yet implemented');
}
