# Live Session Staleness Design

## Status

Approved on 2026-07-16.

## Problem

AgentPulse initially applies `--stale` while discovering transcript files, but
its live watcher does not preserve that boundary. On Windows with Node 24, the
watcher uses polling and probes every historical `.jsonl` file. A previously
unknown old transcript is therefore emitted as a live session even though the
initial discovery correctly excluded it.

The TUI compounds the problem by labeling the orchestrator's most recent recap
time as `updated ... ago`. Periodic recap refreshes make an untouched historical
transcript look recently active.

## Required Behavior

- A transcript older than `staleMs` must not be added by any watcher path.
- A known session must be removed when its transcript becomes older than
  `staleMs`, even if AgentPulse remains open and no filesystem event occurs.
- New transcript activity after expiration must make the session eligible to be
  added again.
- `staleMs: Infinity` must continue to disable staleness filtering.
- The session list must show transcript activity time, not recap refresh time.
- The detail pane may continue to show recap refresh timing separately.

## Design

The session watcher remains the authority for membership in the live session
set.

1. Apply the same modification-time cutoff used by `discoverSessions()` inside
   the watcher's probe path. A stale unknown file is ignored. A stale known file
   is removed from watcher state and emits one `remove` event.
2. Schedule expiration from the earliest known `lastModified + staleMs`
   deadline. When the deadline arrives, sweep the small known-session map,
   remove every expired session, emit removal events, and schedule the next
   deadline. Do not create this timer when staleness is disabled or no sessions
   are known.
3. Cancel the expiration timer when the watcher stops. File changes continue to
   flow through the normal probe path, so a previously expired transcript with
   a fresh modification time is added again.
4. Render the list timestamp from `session.lastModified` with an `activity`
   label. Keep `SessionState.lastUpdated` for recap scheduling and the detail
   pane's `Last refresh` display.

This keeps discovery, polling, filesystem watching, watcher snapshots, and the
TUI consistent. Filtering only in the polling loop would leave non-polling
platforms unable to age sessions out. Filtering only in the TUI would leave
stale sessions consuming orchestrator work and appearing through non-TUI APIs.

## Tests

- A polling root that appears after watcher startup and contains an old
  transcript must not emit `add` or enter the snapshot.
- A known fresh session must emit `remove` and leave the snapshot after its
  staleness deadline without a filesystem event.
- Updating an expired transcript must allow it to be added again.
- A session row with a recent recap but older transcript modification must show
  the transcript activity age, not the recap age.
- The complete build and test suite must pass.

## Scope

No CLI flags, public data types, dependencies, parser behavior, trajectory
classification, or default timing values change. This fix does not delete or
modify transcript files; it only controls which files AgentPulse treats as live.
