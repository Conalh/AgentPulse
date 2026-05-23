# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may include breaking changes.

## [0.2.10] — 2026-05-23

### Added

- **Project-name inference from primary file paths.** When the slug decoder gives up and the label would otherwise fall through to `session-<id-prefix>`, the TUI now scans the recap's primary file paths for a known "umbrella" directory (`Dev`, `Code`, `projects`, `workspace`, `repos`, `work`, etc.) and uses the segment *immediately after* the umbrella as the project name.
- Example: a session stored at `~/.claude/projects/C--/<uuid>.jsonl` (slug is just `C--`, decoder returns undefined) whose primary file is `C:\Dev\AgentPulse\src\tui\App.tsx` is now labeled `AgentPulse` instead of `session-c3d4566e`.
- The inference is purely additive: existing decoded slugs still win, and sessions with no useful primary files still fall through to the session-id label.

## [0.2.9] — 2026-05-23

### Fixed

- **Rapid `?`-spam caused stacked dashboard renders.** Each `?` press toggles the help overlay, which changes the screen height (overlay appears or disappears). When presses landed faster than Ink could complete a render, the diff calculation got confused and the previous frame leaked under the new one. 200 ms debounce on the `?` handler eliminates the case — invisible to a normal human press but throttles a held-down key to single transitions. Other keybindings (selection nav, `r`, `q`) don't need the debounce because they don't change the screen layout.

## [0.2.8] — 2026-05-23

### Fixed

- **Cascading "ladder" of stacked dashboards on Windows cmd.exe.** Every refresh appended a fresh dashboard below the previous one instead of redrawing in place. Cause: Ink's in-place redraws rely on cursor-up + clear-line ANSI sequences, which cmd.exe (and some other terminals) don't fully honor — the previous frame leaks into scrollback.

  Fix: the TUI now enters the terminal's **alternate screen buffer** (`\x1b[?1049h`) before mounting Ink, hides the cursor, and restores both on exit. This is the same mode `htop`, `vim`, `less`, `k9s`, `lazygit`, and `btop` use — the entire dashboard lives in a separate screen that doesn't pollute scrollback, and your pre-TUI terminal contents restore cleanly when you press `q`.

  Restoration runs in three places (`finally` after normal Ink exit, SIGINT/SIGTERM handler, `process.once('exit')`) so you can't get stuck in alt screen even on a hard crash.

## [0.2.7] — 2026-05-23

### Fixed

- **Idle rule wasn't catching empty windows.** v0.2.6 added the idle bucket but gated it on `toolInvocationCount > 0` — meaning it only fired when the window had *some* activity earlier. A session that had been completely silent for 30 minutes (window has zero events) fell through to the 0.3-confidence "no decisive signal → exploring" fallback. That was backwards: a totally-empty window is the *clearest* case of idle, not the most ambiguous. The idle rule now fires for both cases:
  - **Empty windows** (no events at all) → idle at 0.85 confidence with signal `"no events in the window at all"`
  - **Stale windows** (had activity earlier but nothing in last 5 min) → idle at 0.75 confidence
- Narrative now distinguishes the two: empty-window idle reads "Your agent has been quiet for the whole 20-minute window. No tool calls, no messages. Likely parked, waiting on you or external input." Stale-window idle keeps the "earlier in the window it made X changes before going idle" framing.

### Test fixtures updated

The pre-v0.2.7 trajectory tests used `T0 + small offsets` for synthetic events, which put them ~19 minutes before windowEnd. The widened idle rule correctly identified those as stale and pre-empted the bucket the tests were verifying. Updated the converging / stuck / exploring / "NOT done" tests to use a `FRESH = WINDOW_END - 2min` anchor so synthetic events look fresh — which matches how real agent sessions actually shape their event timing. Idle-specific tests still use `T0 + offset` (genuinely stale).

### Tests

85, same count as v0.2.6, but the empty-window assertion now expects `idle` instead of `exploring`.

## [0.2.6] — 2026-05-23

### Added

- **`idle` trajectory bucket.** Sessions whose window contains historical activity but whose most recent event is older than 5 minutes now classify as `idle` instead of misleadingly reading `converging`. This was a real product-shape issue: a session that made 15 edits 18 minutes ago and then went quiet was being reported as "currently working" because the 20-minute window captures the whole stretch. The bucket order is now: `drifting → idle → done → stuck → converging → exploring → fallback`. Drift findings still win because they're worth surfacing even when the agent has gone quiet.
- Theme: `idle` uses gray with the `○` (open circle) pill — distinguishable from converging's filled `●`, exploring's half `◐`, and done's `■`. Reads as "empty / waiting".
- Narrative for `idle` bucket: "Your agent has been quiet for **N minutes**. Earlier in the window it made **X** changes to **`file`** before going idle. Likely parked, waiting on you or external input."

### Fixed

- **Lingering `C--` rows in the dashboard.** The slug decoder's last-ditch fallback was returning the original slug when stripping the `<letter>--` prefix left nothing meaningful. Now returns `undefined` in that case so the UI's own `session-<id-prefix>` fallback kicks in. Pre-fix: a row literally labeled `C--`. Post-fix: `session-3f4a82c1` or similar — stable, never blank.

### Tests

85 (was 82). Three new tests on the idle bucket: idle fires on stale activity, doesn't fire on fresh activity, doesn't fire when a completion verb was emitted (done wins).

## [0.2.5] — 2026-05-23

### Fixed

- **Whole-window flicker on every refresh tick.** Tracked it down to the parser's `console.warn("skipped N malformed lines")` — those writes interfere with Ink's screen-control sequences and cause a visible redraw flash each time the orchestrator refreshes a session (every 30s by default). The parser now accepts a `silent` flag in `ParseOptions`; `pulse()` forwards a `silent` option; the orchestrator passes `silent: true` on every invocation. The `recap` CLI still surfaces the skip count because there's no TUI to disrupt.

- **Cluster too shallow** — `top cluster C:/Dev covers 99% of activity` was useless because every project sat under that umbrella. The path clusterer now strips each event's `cwd` prefix before bucketing, so `C:/Dev/fit-ontology/utils/foo.py` clusters as `utils` instead of `C:/Dev`. Files outside the session's cwd retain absolute-path clustering (they're interesting in their own right). Files at the project root render as `(project root)` rather than `.` for narrative readability.

### Tests

82 (was 80). Two new regression tests on the cwd-aware clustering (Windows backslash + mixed-cwd scenarios).

## [0.2.4] — 2026-05-23

### Added

- **`w` / `s` keybindings** (and their shifted variants `W` / `S`) for moving the selection up and down in the live TUI. Pairs with the existing arrow keys and vim-style `k` / `j`. Easier for users who keep their hands on the left side of the keyboard — no need to reach for the arrow cluster or take a hand off the mouse.

Footer + help overlay both updated to advertise the new bindings.

## [0.2.3] — 2026-05-23

Third dogfooding patch. v0.2.2 fixed the classifier and slug edge cases; this one fixes the visual layout flicker and the noise from subagent transcripts.

### Fixed

- **List row flicker on timestamp ticks.** Long project names (the `agent-<long-hex>` subagent transcripts in particular) overflowed the 32-char label box and wrapped to a second line. Every `5s ago → 6s ago` timer tick recomputed the layout and the wrap point could shift slightly, causing the whole box to "breathe" once a second. Fixed by computing the label truncation budget from the runtime suffix length (`(claude-code)` is 14 chars, `(codex)` is 7) so the combined label+runtime column is always ≤ 38 chars and never wraps.

- **Last-ditch project name fallback.** When the slug fully fails and `cwd` is also missing, the label now falls back to `session-<id-prefix>` (e.g. `session-3f4a82c1`) instead of leaving a UUID-shaped tail or empty cell. Stable, recognizable, never blank.

### Added

- **Subagent transcript filter.** Project names matching `agent-<hex>` (the shape Claude Code uses for SDK-spawned subagent sessions) are now hidden by default. They're tooling artifacts, not the developer's own work. Pass `--show-subagents` to bring them back.

  (Funny side effect: previously the dashboard showed the three subagents that built AgentPulse v0.2 itself as ghost rows. Now AgentPulse doesn't watch its own birth certificate by default. Still does with `--show-subagents`.)

### Tests

80, unchanged.

## [0.2.2] — 2026-05-23

Second dogfooding patch. v0.2.1 fixed most of the "56 sessions of `C`" problem but introduced two new ones surfaced on the next real-world run: some sessions still showed up as `C--` (the `<letter>--` strip left the slug empty and the function fell back to the raw slug), heavily-editing sessions were misclassified as low-confidence exploring (the converging rule required verification data we didn't have), and the idle filter was hiding genuinely-active-this-hour Cursor / Codex sessions.

### Fixed

- **Slug decoder when the `<letter>--` strip leaves nothing.** Pre-fix, a slug of literally `C--` would strip to `''`, split to `[]`, and fall back to returning the original `C--`. Now returns an empty string in that case and `deriveProjectName` falls back to `cwd` basename, or — when even that doesn't help — to the prefix-stripped slug, so the dashboard never shows a raw `C--` cell.

- **Heavy editing without verification data no longer falls through to low-confidence exploring.** New `converging (no verification)` rule fires when `editing >= 5` AND (a cluster covers >= 50% OR a primary file is identified). Confidence 0.6 to reflect the missing test signal. A session in the middle of "Phase 7 — wire the text area into the dashboard" with 40 edits now reads as `converging` instead of `exploring (defaulting)`.

### Changed (defaults)

- **Idle filter inverted.** v0.2.1 hid sessions with zero tool invocations in the 20-min window by default; v0.2.2 shows them. The hide-by-default behavior was too aggressive — it disappeared Cursor and Codex sessions whenever they hadn't moved a tool in the most recent 20 minutes, even when the user was clearly still in them. The `--show-idle` flag is renamed `--hide-idle` (default off — pass it to opt back into v0.2.1 behavior).
- Idle sessions still get the low-confidence dimmed look via the trajectory's fallback signal, so they're visually distinct from active work.

### Tests

80 still passing. Smoke test against the existing transcript fixtures confirms the `done` verdict at 0.85 confidence is unchanged.

## [0.2.1] — 2026-05-23

Dogfooding patch — first real run of `agentpulse live` surfaced three UX issues that made the dashboard noisier than useful on a Windows checkout with months of Claude Code history. All three fixed.

### Fixed

- **Slug decoder mishandled Windows drive-letter prefix.** Claude Code stores projects under paths like `~/.claude/projects/C--Users-conno-Dev-AgentPulse/`. The pre-fix decoder grabbed the first segment, so every Windows-rooted session collapsed to the project name `C`. Now strips the `C--` / `D--` style prefix and takes the last meaningful segment. On a real Windows checkout this turned 30 sessions labeled `C` into 30 sessions labeled with their actual project names.

- **`deriveProjectName` accepts a `cwd` fallback.** When the slug still decodes to a single letter (legacy or malformed slug), and the transcript's first line carries a `cwd`, the project name falls back to `basename(cwd)`. Belt and braces.

### Changed (defaults)

- **`--stale` default tightened from `24h` to `1h`.** 24 hours was surfacing every transcript touched in the last day, drowning the "what's happening right now" intent. Set `--stale 24h` to recover the old behavior.

- **Idle sessions hidden by default.** Sessions with zero tool invocations in the current window are filtered from the displayed list. The orchestrator still tracks them (so a quiet session that picks back up pops in automatically), but the dashboard stays focused on what's actually running.

- **List capped at 10 sessions by default** (sorted lastModified DESC). Configurable.

### Added

- **`--show-idle`** flag — include zero-activity sessions in the list.
- **`--max-sessions <N>`** flag — adjust the cap (0 disables).
- Header now shows `visible/total sessions` when filtering hides anything, so it's obvious that more exist.

### Test count

80 (was 78). Two new regression tests on the slug decoder Windows path.

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
