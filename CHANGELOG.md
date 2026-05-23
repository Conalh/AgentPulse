# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may include breaking changes.

## [0.2.0] — 2026-05-23

**Live multi-session TUI** — new `agentpulse live` subcommand that auto-discovers active agent sessions, runs the AgentPulse pipeline per session on a rolling refresh, and renders a two-pane Ink TUI with color-coded verdict pills and live updates.

### Added

- `agentpulse live` subcommand. Discovers transcripts in `~/.claude/projects/`, `~/.cursor/projects/`, `~/.codex/sessions/` by default; override via `--roots <p1,p2,...>`. Filters out sessions older than `--stale` (default 24h).
- Multi-session orchestrator (`createOrchestrator`) — per-session refresh timers, concurrent-refresh coalescing via in-flight promise tracking, error capture per session so one bad transcript doesn't take down the dashboard.
- Filesystem watcher (`createSessionWatcher`) — recursive `fs.watch` with polling fallback on platforms that don't support it; 300ms per-file debounce; stat-only probes (no whole-file rereads).
- Ink-based TUI — left pane lists sessions with color-coded verdict pills (●converging / ◐exploring / ▲stuck / ■done / ⚠drifting); right pane shows narrative + signals + drift summary for the selected session. Keyboard: ↑↓/jk to navigate, `r` to force refresh, `?` for help, `q`/Ctrl-C to exit.
- TUI deps (`ink`, `react`) added but lazy-loaded — the existing `agentpulse recap` path imports zero TUI code and stays lean.

### Changed

- `tsconfig.json` — added `jsx: react-jsx` to support TUI `.tsx` files.
- CLI — `agentpulse --help` now lists both `recap` and `live` subcommands.

### Architecture

Three parallel workstreams developed concurrently against locked `src/types.ts` contracts:

- **Workstream A** (`src/sessions/`) — `discoverSessions` + `createSessionWatcher`. Pure Node stdlib.
- **Workstream B** (`src/orchestrator.ts`) — `createOrchestrator` — multi-session state map + per-session refresh loop.
- **Workstream C** (`src/tui/`) — `runLiveTui` + Ink components. New deps only here.

This time the parallel agents ran in isolated git worktrees (lesson from v0.1) — zero checkout contention, clean PRs, fast-forward merges.

### Test count

78 tests passing (53 from v0.1 + 25 new across the three workstreams).

## [0.1.0] — 2026-05-23

Initial release. Live trajectory verdict for AI coding agent sessions. Local-only, deterministic, no LLM, no outbound network calls.

### Validated end-to-end

- Five-layer pipeline integrates cleanly: parser → enrich → outcome/trajectory → narrative → CLI
- 53 tests across all layers, all passing
- Smoke-tested against real Claude Code / Cursor / Codex transcript fixtures — produces plain-English verdicts at sensible confidence levels
- Build clean with `tsc` strict mode

### Built in parallel

Four feature branches developed concurrently against a locked `src/types.ts` contract, then merged in layer order. Each layer's PR is independently passable; synthesis required only one test update to reflect non-stub pipeline behavior.

### Architecture

Five-layer deterministic pipeline:

1. **Parser** (`src/parser.ts`) — Claude Code / Cursor / Codex JSONL → normalized `TranscriptEvent[]`. Adapted from SessionTrail's transcript parser for v0.1; the v0.2 cleanup will factor this into `agent-gov-core` so all consumers share one parser.
2. **Enrichment** (`src/enrich.ts`) — `TranscriptEvent[]` → `EnrichedWindow` with TF-IDF keyword extraction, directory-token path clustering, action classification, command-verb extraction.
3. **Outcome signal** (`src/trajectory.ts`) — verification trend (test exit codes), user-tone tokens, completion verbs, idle gap.
4. **Trajectory classifier** (`src/trajectory.ts`) — five buckets: `converging` / `exploring` / `stuck` / `done` / `drifting`. The `drifting` bucket runs the agent-gov-core detector suite over the window.
5. **Narrative** (`src/narrative.ts`) — templated plain-English render per bucket.

### Known v0.2 cleanups

- Factor the transcript parser into `agent-gov-core` (substrate minor bump → 1.1.0) so SessionTrail, AgentPulse, and any future consumer share one parser instead of vendoring.
- Add a GitHub Action variant that posts the verdict as a PR comment.
- Optionally expose the trajectory verdict via OpenTelemetry GenAI semconv span attributes.
