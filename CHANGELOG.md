# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may include breaking changes.

## [0.1.0] — Unreleased

Initial release. Live trajectory verdict for AI coding agent sessions.

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
