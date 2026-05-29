# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may include breaking changes.

<!--
Convention: land unreleased work under `## [Unreleased]`. At release time,
rename that header to `## [X.Y.Z] — YYYY-MM-DD`, bump package.json to match,
and add the title to scripts/backfill-releases.mjs so the GitHub Release can
be cut from this section. See docs/RELEASING.md.
-->

## [0.7.3] — 2026-05-28

### Internal
- Bumped `agent-gov-core` dependency `^1.2.1` → `^1.3.0` to align with the rest of the suite (all five detectors are on `^1.3.0`). No behavior change — AgentPulse uses core's transcript parsers and the `Finding`/`Report` contract, all unchanged across 1.2.1→1.3.0; the 1.3.0 additions (diff-input guards) are for PR-diff detectors and aren't on AgentPulse's path. Verdicts and report output are unchanged. Takes effect for the Action once `@conalh/agentpulse@0.7.3` is published to npm.

## [0.7.2] — 2026-05-28

A correctness-and-consistency pass across the classifier pipeline and the TUI. Several rules silently mis-fired on real (non-synthetic) sessions — duplicated verification vocabulary across three layers, a `stuck_loop` that never triggered on actual transcripts, prose-only sessions flagged as `stuck`, and an incremental parser that double-counted events on any non-ASCII transcript — alongside internal de-duplication of constants/namespaces and two TUI render/label fixes.

### Fixed — verification vocabulary was duplicated across three layers

The set of commands that count as a "verification" (running tests, a type checker, a linter, or a build) and the pass/fail result-text tables were maintained as three divergent copies — one each in `enrich.ts`, `sequences.ts`, and `trajectory.ts`. The lists had genuinely drifted (`go vet`, `cargo clippy`, `mypy`, `ruff`, `gradle`, `mvn`, `npm run`, `playwright`, `prettier` were recognized by the sequence detector but not the verification-trend computation), so a command could count toward the edit→verify cycle but not the pass/fail trend — or vice versa — silently. All three layers now share `src/verification.ts` (`isVerificationCommand` + `classifyResultText`); the trend layer gains the tools it was missing and switches from a loose substring match to the precise word-boundary regex the other layers already used.

### Fixed — `stuck_loop` never fired on real transcripts (only synthetic fixtures)

Layer 2.5's `detectStuckLoop` read the verification exit code off the Bash `tool_use` event, but the parser emits `tool_use` and `tool_result` as separate events with the exit code on the `tool_result` (keyed by `toolUseId`). So every real session's verification outcome resolved to indeterminate, no failures were counted, and a wedged edit→fail→edit→fail loop silently degraded to a healthy `tdd_loop`. `analyzeSequences` now links `tool_result` outcomes by id — the same fix `computeVerificationTrend` got in v0.6.1 — so `stuck_loop` fires on real transcripts. Locked in by a new `expectedSequence` assertion on the golden corpus.

### Fixed — prose-only sessions false-positived as `stuck`

A documentation session (5+ `.md` edits, no test command) tripped `refuse_to_verify` and flipped to `stuck`, because the detector counted every edit toward its ≥4 threshold. Editing a doc set legitimately has nothing to verify, so `detectRefuseToVerify` now counts only code edits — prose extensions (`.md`/`.mdx`/`.markdown`/`.txt`/`.rst`/`.adoc`/`.org`) don't count, and unknown paths still count as code (conservative toward firing). New `doc-edits-no-tests` corpus fixture guards the converging outcome; a `.ssh-keys` cwd fixture guards that the privileged-path detector doesn't misfire on hyphenated lookalikes.

### Fixed — incremental parse cache duplicated events on any non-ASCII session

The incremental tail-reader (`parseCache.ts`) tracks a **byte** offset of the last complete line, but it derived how far it advanced from a UTF-16 **string** index (`raw.lastIndexOf('\n')`). Any multibyte character — emoji, accents, CJK, all common in agent prose, code, and tool output — made the two diverge, so the next read rewound *before* the true position, re-parsed already-consumed lines, and appended them as duplicate events. Those duplicates inflate the edit/verification counts the classifier runs on, so the live dashboard could land on the wrong bucket for essentially any real session. (The whole-file `recap` path was unaffected; this was incremental-only — the live TUI and orchestrator.) The reader now finds the newline in the raw buffer (`0x0A` can't appear inside a UTF-8 multibyte sequence) so the offset is exact. New regression fixture reproduces the duplicate.

### Fixed — narrative privileged-path lede claimed coverage the detector lacked

`renderDrifting`'s privileged-path matcher tested for `gnupg` and `credential`, but `PRIVILEGED_PATH_RULES` only ever emits `ssh_path` / `aws_path` / `kube_path` / `etc_shadow` / `private_var` — so those terms were dead and the lede over-promised "credentials." The matcher and wording now reflect what's actually flagged (SSH/AWS/Kube/system paths).

### Changed — internal duplication cleanup

Default timing constants (`DEFAULT_WINDOW_MS`, `DEFAULT_REFRESH_INTERVAL_MS`, `DEFAULT_STALE_MS`) were re-spelled as literals across five files with two different spellings of the same value; they now live in `src/defaults.ts` and are imported everywhere. The `agent_pulse.live_drift_<slug>` namespace convention was likewise built in one place and parsed back with two divergent copies (one using a magic `+7`); a new `src/drift.ts` owns the prefix plus both directions (`driftKind` / `driftSlug`). No behaviour change. Also corrected stale comments (orchestrator coalescing "exactly once" → "~2 pulses max", the `exploring` bucket's "no edits yet", stacked JSDoc on the exceptions loader, the `DiscoverOptions.staleMs` default documented as "24 hours" when it is 1 hour, and `evictParseCache`'s "called by the watcher" — it's the orchestrator reacting to a watcher `remove` event).

### Fixed — the TUI re-rendered every second even with nothing to animate

`App`'s 1 s wall-clock interval drives only the whitelist-preview countdown banner, but it ran unconditionally for the whole session — so the root reconciled every second (children bail out via `React.memo`, but the parent render itself doesn't), the exact thrash the v0.5.3 self-clocking-footer refactor set out to remove. The interval now runs only while a preview banner is on screen.

### Fixed — session detail header disagreed with its own list row

The detail pane resolved its title as `projectName ?? id`, while the session list, the sort key, and the headless `--once` snapshot all use `fallbackLabel()`. So the same session could read as a 12-char hex id in the detail header but as the path-inferred name (e.g. "AgentPulse") in the list, an empty `projectName` rendered as a blank header, and — most visibly — a user's rename **alias** updated the list row but not the detail header. The detail pane now shares `fallbackLabel()` and applies the same alias prefix.

## [0.7.1] — 2026-05-28

Session-noise and cross-runtime accuracy pass, driven by real multi-terminal session sets. The TUI had quietly accumulated fixes that the headless `agentpulse live --once` path never inherited, so machine-readable output and `--notify` diverged from what the dashboard showed.

### Fixed — session noise the headless `--once` snapshot missed (#11)

Three dashboard-hygiene rules lived only inside the TUI (`src/tui/App.tsx`, `src/tui/SessionList.tsx`) where the `--once` path couldn't reach them. They are now in shared modules (`src/sessions/subagents.ts`, `src/labels.ts`) and wired into both surfaces:

- **SDK subagents leaked into the snapshot.** The TUI filtered `agent-<hex>.jsonl` subagent transcripts by default (the `--show-subagents` opt-in, since v0.2.3), but `--once` did not. A real session with one `lab` parent + four subagents reported five identical `lab` rows in JSON. `once.ts` now uses the shared `isSubagentTranscript()` predicate — same default-off behaviour, same `--show-subagents` opt-in. The predicate also catches the structural `<parent>/subagents/agent-<hex>.jsonl` layout where the parent's project name leaks into the child.
- **Co-named sessions were indistinguishable in JSON/notify.** `SessionList` has suffixed colliding `<project>|<runtime>` rows with ` · <hex>` since v0.4.4, but `--once` emitted bare `projectName`. Two parallel `AgentPulse` sessions (e.g. one Claude Code, one Codex) couldn't be told apart in output or notifications. A new `label` field on the snapshot carries the disambiguated string via the shared `computeDisambigSuffixes()` helper; `projectName` is preserved unchanged for existing programmatic consumers, and `--notify` bodies now use `label`.

### Fixed — project names were systematically wrong on multi-word Claude Code projects (#11)

`decodeSlug`'s last-hyphen-segment rule is structurally lossy: a slug like `C--FullStee-nutrition-experiment-lab` can't be split back into prefix + project because hyphens are both path-separator encodings and legal name characters, so every multi-word project decoded to its last segment (`lab`, `brief`, …). The transcript's first line carries the authoritative cwd, so naming now prefers `basename(cwd)` and falls back to slug-decode only when cwd is absent. Compounding it, `extractCwdFromFirstLine` was strictly first-line-only — but Claude Code transcripts open with `permission-mode` / `file-history-snapshot` lines before the first cwd-bearing message, so the cwd-first path never ran. It now scans up to 25 lines / 64 KB. A subagent-shaped cwd basename (`agent-<hex>`) is rejected so a project is never mislabelled as a tooling artifact.

### Fixed — `exploring` narrative contradicted its own signals (#11)

The low-confidence `exploring` fallback (`trajectory.ts:799`) fires regardless of edit count, but the narrative renderer unconditionally appended *"No edits yet — it's still figuring out the shape."* A session with 20 edits in the window directly contradicted its Signals line. `renderExploring` now branches on edit count and emits an honest hedge (*"Mixed signal: N edits in the window but no clear direction yet"*) when the fallback fires with edits present.

### Fixed — current Codex desktop session format

Recognizes the current Codex desktop transcript shape, including `custom_tool_call` / `custom_tool_call_output` events that the substrate parser doesn't yet model, so Codex desktop sessions classify (editing / verification / drift) instead of falling through to `other`. Adds `codex-desktop-*` golden corpus fixtures.

### Bumped — agent-gov-core `^1.2.1`

v0.7.0 pinned `^1.2.0` against an unpublished substrate version, so `npm ci` hit `ETARGET` in CI. Substrate has since shipped v1.2.0 + v1.2.1 (streaming reader patch on top of the Antigravity parser); the caret now matches the registry.

### Tests

240 tests pass (up from 228 at v0.7.0). New coverage for subagent filtering (both directions), co-named disambiguation, cwd-first naming across the metadata prelude, the `exploring`-with-edits narrative branch, and Codex desktop classification. Windows CI flake fixed by adding `maxRetries`/`retryDelay` to ~60 recursive `rmSync` teardowns (lazy handle release intermittently threw `ENOTEMPTY`/`EBUSY`).

## [0.7.0] — 2026-05-25

### Added — Native Antigravity Session Tracking

Added first-class support for Google DeepMind's Antigravity transcript format (`~/.gemini/antigravity/brain`). Integrates seamlessly with the thread-safe `agent-gov-core@1.2.0` substrate parser to provide fully aligned session tracking and live TUI verdict support.

- **Stateless Sequential `toolUseId` Linkage**: Uses the new threadable `activeToolCalls` parameter from the substrate parser to map Antigravity's asymmetrical `replace_file_content` $\leftrightarrow$ `REPLACE_FILE_CONTENT` tools sequentially while avoiding any module-level state.
- **Empty `assistant_message` Conditionally Pruned**: Automatically checks for empty planner responses and suppresses empty placeholder messages.
- **`CommandLine` $\to$ `command` Normalization**: Auto-translates Antigravity parameters inside `unwrapArgs` so that existing verifiers and checkers require zero modification downstream.
- **Cwd-level Path Resolution**: Scans early lines in the session JSONL to locate and extract `Cwd` / `DirectoryPath` / `SearchPath`, and populates the event-level `cwd` for robust drift and relative path analyses.
- **Exit Code Extraction**: Grounded parsing of the verified `RUN_COMMAND` exit-code shapes (failure, completed successfully, and status error).
- **Orphan Cleanup**: Integrates memory-safe cleanup inside `parseCache.ts` to prune active tool call mappings once their corresponding events fall out of the cache's active window.
- **Golden Integration scenario**: Added `antigravity-converging.jsonl` golden replay case to the test corpus to ensure regression protection.

## [0.6.2] — 2026-05-24

### Fixed — multi-runtime adapter drift (Codex external inspection)

The README claimed Claude Code / Cursor / Codex support, and the substrate parsers in `agent-gov-core@1.1.0` do parse all three line formats correctly. But the consumer layers in this package (enrichment, sequences, trajectory) were written against the Anthropic tool vocabulary and silently misclassified Cursor + Codex events.

A Codex inspection (post-v0.6.1) confirmed: running a real Codex fixture through `pulse()` counted both Codex tool calls as `other` — zero editing, zero verification, no primary files. Cursor's `toolInput.path` (vs Anthropic's `toolInput.file_path`) was equally invisible to the enrichment and sequence layers (the trajectory layer already handled both — partial coverage that made the gap easy to miss).

The shape of the fix:

- **New `src/normalize.ts`** centralizes two helpers used wherever a consumer reaches into a `TranscriptEvent`:
  - `canonicalToolName(name)` maps Codex's `shell` → `Bash` and `apply_patch` → `Edit`. Unknown names pass through verbatim.
  - `extractFilePath(toolInput)` tries `file_path` / `path` / `filePath` / `notebook_path` in order, plus an `apply_patch` fallback that parses `*** Add File: <path>` / `*** Update File: <path>` markers from the Codex patch body.

- **`src/enrich.ts:classifyToolUse`** routes the toolName through `canonicalToolName` before the switch. `getFilePath` delegates to the shared normalizer.
- **`src/sequences.ts:classifyEvent`** + `extractFilePath` — same treatment.
- **`src/trajectory.ts:isVerificationEvent`** accepts canonical `Bash` (so Codex `shell` lands). The Write-shaped drift detector also accepts canonical `Edit` (so Codex `apply_patch` participates).
- **MCP tool detection** stays keyed off the raw name (canonicalization only rewrites known runtime aliases, not MCP-prefix patterns).

### Fixed — relative paths false-tripped outside-repo drift

`isPathOutsideNormalizedRoot` compared the raw file path against the normalized root. A relative path like `src/utils/date.ts` never starts with `c:/dev/agentpulse/`, so every relative Write triggered the outside-repo detector — a false positive on legitimate edits. Cursor (and Codex's `apply_patch`) emit relative paths constantly.

- **`src/trajectory.ts:isPathOutsideNormalizedRoot`** now accepts an optional `cwd` parameter. New `isAbsolutePath` helper detects Unix `/...` and Windows `C:/...` shapes; relative paths get resolved against the event's `cwd` before comparison. When `cwd` is unavailable, the function defensively returns `false` (NOT outside) — a false negative on drift detection is strictly better than a false positive on legitimate edits.

### Fixed — watcher derived project name before extracting cwd

`src/sessions/watcher.ts` called `deriveProjectName(absPath, root.path)` BEFORE `extractCwdFromFirstLine`, missing the cwd-aware fallback that `src/sessions/discovery.ts` uses. For Codex's date-shaped slugs (`~/.codex/sessions/2026/05/23/...`), a newly-watched session showed worse labels (date stub) until the next discovery cycle picked it up.

- Swapped the call order to match discovery: extract cwd first, pass it into `deriveProjectName`. Three-line fix.

### Fixed — npm tarball missed the README hero image

`package.json` `files` whitelist included `dist`, `LICENSE`, `README.md`, `CHANGELOG.md` — but not `assets/`. The v0.6.1 README references `./assets/dashboard.svg`, so anyone viewing the README on npmjs.com saw a broken image. Added `assets/dashboard.svg` to the whitelist.

### Added — cross-runtime corpus fixtures

The golden corpus (added in v0.6.1) was Claude Code-only, which is exactly why the multi-runtime gap stayed hidden through 222 tests. v0.6.2 adds:

- `test/corpus/cursor-converging.jsonl` — Anthropic envelope with `toolInput.path` instead of `file_path`. Locks in the `extractFilePath` fix.
- `test/corpus/codex-converging.jsonl` — Codex `response_item` shape with `shell` + `apply_patch`. Locks in the canonical-name + apply_patch-path-extraction fixes.

Both expect `converging` with confidence ≥ 0.6. Pre-fix they would have landed as `exploring` or `idle`.

### Added — targeted relative-path drift tests

Three new tests in `trajectory.test.mjs`:

- Relative Write resolved against cwd inside repoRoot → no drift
- Relative Write without cwd → no drift (defensive default)
- Absolute Write outside repo still trips drift (regression check for the v0.6.2 narrowing)

### Tests

227 (was 222). Five new: two corpus scenarios + three trajectory tests.

### Bumped

- Action ref in `README.md` + `examples/agentpulse-pr-check.yml`: `@v0.6.1` → `@v0.6.2`.

## [0.6.1] — 2026-05-23

The "regression armor" batch — property tests (Gemini #9) + golden replay corpus (Gemini #3). Both items closed the inspection backlog. **Both invisible to users; both immediately earned their keep.**

### Added — golden replay corpus (Gemini #3)

`test/corpus/` is a small, labelled collection of representative transcript JSONLs paired with the bucket each must classify into. `test/corpus.test.mjs` reads `manifest.json`, runs the full `pulse()` pipeline against each fixture, and asserts the verdict. Six scenarios cover the six trajectory buckets — converging, stuck, exploring, done, drifting (shell_exfil), idle.

Adding a scenario: drop `<name>.jsonl` into `test/corpus/`, add a manifest entry with `{ file, endAt, windowMs, expectedBucket, minConfidence, expectedDriftCount }`, run `npm test`. New scenarios pick up automatically.

### Fixed — verification trend was silently `no_data` for ALL real parsed transcripts

The corpus surfaced this on its first run. `computeVerificationTrend` in `src/trajectory.ts` looked for `toolResultExitCode` on the `tool_use` event — the synthetic test fixture shape. But the real parser emits `tool_use` and `tool_result` as SEPARATE `TranscriptEvent` objects linked by `toolUseId`; exit codes live on the `tool_result`. So every real Claude Code / Cursor / Codex transcript yielded `verificationTrend === 'no_data'`, which meant **the `converging` bucket effectively never fired in production** — only in synthetic tests.

- Fix: `computeVerificationTrend` now builds a `toolUseId → tool_result` map up front and falls back to the linked `tool_result` when the `tool_use` itself has no exit code. Backward-compatible — the synthetic shape (exit code on the tool_use) still works.
- The corpus catches the symptom: `converging.jsonl` has a fail→pass test sequence and asserts the bucket is `converging` with confidence ≥ 0.6. Pre-fix that asserted, post-fix it passes.

This is the single biggest classifier-quality fix since v0.3.5. **Anyone running v0.5.x against a real session was getting a downgraded verdict** (likely `exploring` or `idle` instead of `converging`) anytime the agent did TDD-shaped work. v0.6.1 restores the intended behaviour.

### Added — property tests on the pure-core layers (Gemini #9)

`test/property.test.mjs` runs randomized-input fuzz loops (200 iterations each) over the pure-function surfaces and asserts invariants that must hold for ANY input:

- `classifyTrajectory`: confidence always in [0, 1], bucket always one of the six known values, deterministic (same inputs → same verdict), drifts array only non-empty on `drifting`
- `sparkline`: output length always equals requested width, empty-input fallback respected
- `parseDuration`: linearity (`N * parseDuration('1m') === parseDuration('Nm')`), malformed inputs reject without throwing
- `applyHysteresis`: input state never mutated, stable bucket only flips after two consecutive agreements
- `analyzeSequences`: pattern always in the known set, confidence in [0, 1]
- `readOutcomeSignal`: `idleGapMs` never negative

Hand-rolled `Math.random()` generator + seeded PRNG (set `AGENTPULSE_PROPERTY_SEED=<n>` to replay a specific run). Zero deps — fast-check would be a single-purpose addition and these invariants are simple enough.

### Fixed — CLI module side-effected on import

`src/cli.ts` called `main()` unconditionally at module load. Importing `parseDuration` from it (which the property tests needed) ran the CLI's main function, printed usage, and exited — breaking any consumer that wanted to use the file as a library. Guarded `main()` with the standard ESM idiom (`process.argv[1] === fileURLToPath(import.meta.url)`).

### Tests

222 (was 204). Eighteen new tests:
- 12 property tests covering invariants across `trajectory`, `sequences`, `sparkline`, `cli` (`parseDuration`), `hysteresis`, `outcome`
- 6 corpus scenarios (one per bucket) running end-to-end through the full pipeline

### Bumped

- Action ref in `README.md` + `examples/agentpulse-pr-check.yml`: `@v0.6.0` → `@v0.6.1`.

## [0.6.0] — 2026-05-23

### Added — incremental transcript parsing (Gemini #1)

The biggest perf win on the inspection backlog. Pre-v0.6, every live-mode refresh re-read the full transcript file end-to-end: a 2-hour Claude Code session with a 10 MB JSONL ate ~10 MB of disk I/O and N thousand `JSON.parse` calls every 30 s, of which most events were immediately dropped by the windowing filter. With N sessions in the dashboard, multiply by N.

v0.6.0 reads only what's new. Per-path state tracks the byte offset of the last complete line we've parsed; subsequent pulses tail-read `[lastOffset, currentSize)` instead of the whole file.

### How it works (`src/parseCache.ts`)

On each call to `readWindowFromCache(path, since, until)`:

- `stat` the file. Compare `mtimeMs` + `size` against the cached values.
- **No change**: return window-filtered cached events. Zero I/O beyond the stat.
- **Grew**: open the file, `read(buf, 0, size - lastOffset, lastOffset)` — exactly the new bytes. Parse appended lines, append to cached event list, advance `lastOffset` past the last complete `\n`. Bytes after the last `\n` (an in-progress line) get deferred to the next pulse.
- **Shrank or mtime regressed**: file was rotated/truncated. Evict the cache entry and full-re-read on this pulse.
- **Missing file**: throws (matches `parseTranscriptDir`'s contract; the orchestrator captures this into `SessionState.error`).

Cached events are pruned with a 1-hour margin past the window start so a 24-hour session doesn't grow memory without bound, while still tolerating `--window` resizes without a full re-read.

### Wiring

- **`PulseOptions.events`** (new) — caller-supplied pre-parsed events that bypass `pulse()`'s own parser entirely. CLI callers (`recap`, `live --once`) leave this unset; the orchestrator sets it.
- **`src/orchestrator.ts:runPulse`** — calls `readWindowFromCache(path, startAt, endAt, { silent: true })` first, then `pulse({ events, endAt, … })`. The explicit `endAt` keeps the window math consistent between the cache filter and pulse's internal startAt computation.
- **`evictParseCache(path)`** wired into the orchestrator's `remove(sessionId)` so the cache doesn't hang onto state for a deleted session.

### Substrate

No agent-gov-core change needed for this release. The substrate's v1.1.0 per-runtime line parsers (`parseAnthropicLine`, `parseCodexLine`, `isCodexLine`, etc.) and timestamp helpers (`coerceTimestamp`, `interpolateTimestamps`, `isRecord`) cover everything the cache needs. The cache is pure AgentPulse logic on top of the existing public surface.

### Expected speedup

For a 10 MB transcript on a 30 s refresh:

- **Pre-v0.6**: ~10 MB read + N thousand `JSON.parse` calls per pulse.
- **Post-v0.6**: typical pulse reads only what the agent appended in the last 30 s (often a few KB) + parses ~5–50 lines.

The bigger the transcript, the bigger the gain. CI / `live --once` mode is unaffected — that path keeps using `parseTranscriptDir` (whole-file, batch).

### Why a minor bump (v0.6.0)

`PulseOptions.events` is an additive optional field — fully backward-compatible. The behaviour change is internal (live-mode orchestrator routes through the cache); external API is unchanged. Calling this `v0.6.0` instead of `v0.5.7` to mark a meaningful internal performance shift, not because anything broke.

### Tests

204 (was 194). Ten new tests in `parseCache.test.mjs`:

- First-call full parse
- Second-call cache hit (no re-read)
- Tail-read only of appended bytes
- Window filter applied at each call (sliding window)
- Incomplete final line deferred to next read
- Rotation/truncation (file shrinks) evicts cache and re-reads
- Missing file throws (matches parseTranscriptDir contract)
- File disappearing between pulses throws on the next call
- `evictParseCache(path)` forces a full re-read
- Old events past the prune threshold drop out of the cached set

The orchestrator's existing 7 tests cover the integration; one test had to verify that "errors are captured" still works — the cache's new "throw on missing file" behaviour preserves it.

### Bumped

- Action ref in `README.md` + `examples/agentpulse-pr-check.yml`: `@v0.5.6` → `@v0.6.0`.

## [0.5.6] — 2026-05-23

### Added — mtime-keyed JSON file cache (Gemini #4)

`loadAliases` and `loadExceptions` are called on every pulse — with 10 sessions on a 30 s refresh, that's 20+ small JSON file reads per cycle, most returning identical content. v0.5.6 wraps both behind a shared process-wide cache that compares mtime before re-reading.

- **New `src/jsonCache.ts`** exports `readJsonCached(path, parse, whenMissing)` and `invalidateJsonCache(path)`. On every call: `stat` the file, compare mtime against cached value; mtime match → return cached parse output, mismatch (or ENOENT vs. present) → re-read + reparse + cache.
- **`aliases.ts:readAliasFile`** + **`exceptions.ts:loadExceptions`** now route through it. Same observable behaviour, fewer disk reads.
- **`setAlias` and `appendExceptions` invalidate the cache** after a successful write so the next read picks up the new content even if mtime resolution lags (Windows + some network filesystems can be ~1 s late).
- Failure modes (parse error, read error) are cached as `null` with an mtime sentinel of `0` — so a permanently-broken file doesn't get reparsed every pulse, but a fixed file is detected on the next mtime change.
- Most visible on Windows where small-file stat+read latency adds up. On a 10-session refresh, this is roughly a 20× reduction in alias/exception disk operations per cycle.

### Added — dev-only per-layer profiling (Gemini #10)

Set `AGENTPULSE_PROFILE=1` in the environment to log per-layer pulse timings to stderr:

```
[agentpulse:profile] parse: 142.3ms · enrich: 3.1ms · sequence: 0.4ms · exceptions: 0.2ms · classify: 1.1ms · narrative: 0.1ms
```

- Off by default — one env-var read per pulse, zero allocation in the hot path. Reads dynamically (not at module-load) so tests can toggle freely.
- Goes to stderr because stdout is in the TUI's alt-screen buffer during `agentpulse live` — any write to stdout there causes whole-window flicker on cmd.exe.
- Pairs naturally with the incremental-parse work coming in v0.6.0+: the per-layer numbers tell you immediately whether `parse:` actually dropped after a refactor.

### Tests

194 (was 183). Eleven new tests across two new files:

- `jsonCache.test.mjs` (9 tests): missing-file → fallback, valid-file → parsed, parser-not-re-invoked-on-cache-hit, mtime-change-forces-reread, malformed-JSON → fallback + cached as missing, missing-then-appearing detected, `invalidate()` forces re-read, `clear()` drops everything.
- `cli.test.mjs` (2 tests): `AGENTPULSE_PROFILE=1` produces the expected stderr line shape AND stdout JSON stays valid; absence of the env var produces no profile line.

### Bumped

- Action ref in `README.md` + `examples/agentpulse-pr-check.yml`: `@v0.5.5` → `@v0.5.6`.

## [0.5.5] — 2026-05-23

### CI speedup batch

Two compounding changes from the external inspection backlog (Gemini #5 + #6). No user-facing behaviour change in the live TUI; the GitHub Action and `live --once` mode both get visibly faster.

### Changed — `live --once` now runs sessions in parallel

Pre-fix, `runOnceMode` awaited each session's `pulse()` sequentially in a `for` loop. On CI runs against artifact directories with dozens of historical transcripts, this scaled linearly — and CI runs against artifact directories with dozens of historical transcripts is the whole point of `--once`.

- New `runConcurrent(tasks, concurrency)` helper in `src/once.ts` (exported for direct unit testing). Hand-rolled — 12 lines, zero deps. Spawns up to `concurrency` workers that pull tasks off the list in order; per-index result assignment preserves the original input order so the text report iterates sessions in their discovery order, same as the pre-fix loop.
- Default concurrency is `6`. Tunable via `AP_ONCE_CONCURRENCY=<N>` env var for users with unusual CI runner shapes (giant artifacts on slow disks → lower; fast NVMe + many sessions → higher).
- On a typical run with 24 historical transcripts, CI wall-clock for the analysis step drops from ~24 × per-session latency to ~ceil(24/6) × per-session latency — roughly 4× faster for that step.

### Changed — GitHub Action invokes the published npm package

The composite action used to `npm ci --omit=dev && npm run build` on every workflow run before invoking AgentPulse. That's 5-15 s of pure overhead and one extra failure mode (a transient npm registry hiccup mid-`ci` surfaces as "AgentPulse build failed" rather than a real signal).

- The action now resolves the version from its own checked-out `package.json` and invokes `npx --yes @conalh/agentpulse@${VERSION} live --once …`. First call populates the npm cache; second is a cache hit. The action's git ref (e.g. `Conalh/AgentPulse@v0.5.5`) and the npm version stay in lockstep automatically — no hardcoded version string in `action.yml` that could drift.
- The `Install AgentPulse dependencies + build` step is gone. The `actions/setup-node@v4` step stays — npx still needs node, and the runner-default node version isn't guaranteed across runners.
- The action ref in `README.md` and `examples/agentpulse-pr-check.yml` is bumped to `@v0.5.5`.

### Tests

183 (was 179). Four new tests on the `runConcurrent` helper:
- Preserves input order in the results array even when tasks resolve in reverse order
- Caps in-flight tasks at the configured concurrency value
- Empty task list returns an empty array
- `concurrency = 1` is strictly sequential (degenerate but legal — useful for debugging)

The action.yml change is verified by inspection — the workflow shape doesn't have a unit-test harness, but the script logic is straightforward shell + the existing `live --once` CLI surface is exhaustively tested.

## [0.5.4] — 2026-05-23

### Added — verdict hysteresis (the "feels smarter" change)

A new bucket must be produced by **two consecutive pulses** before the orchestrator surfaces it. Borderline sessions whose signals sat near a rule threshold used to bounce between buckets every refresh — pill colour flipping, OS notifications double-firing, the dashboard feeling twitchy even when nothing of consequence had changed.

Gemini's external inspection called this the biggest perceived-quality jump for zero new concepts. Same six buckets, same rules — just damped output. Users perceive it as "the dashboard feels intentional" rather than as a new feature.

### How it works

New `src/hysteresis.ts` module — pure, no I/O, no React. Each session in the orchestrator carries a small state:

```ts
interface HysteresisState {
  stableBucket: TrajectoryBucket;   // what consumers see
  pendingBucket: TrajectoryBucket;  // last classifier output if it disagrees
  pendingCount: number;             // how many pulses in a row
}
```

On every pulse the orchestrator runs `applyHysteresis(state, classifier.bucket)`. Three cases:

- **Agreement with stable** → reset pending, no flip
- **Continuation of pending** → bump count; flip to the new bucket once `pendingCount >= 2`
- **Fresh disagreement** → start a new candidate with `count = 1` (no flip)

A bounce like `converging → stuck → converging` produces zero pill changes — exactly the noise-suppression we want.

### What's dampened, what's not

Only the bucket label on the pill. The narrative, signals, drift findings, and confidence number stay tied to the latest pulse — so if tests just started failing, the user sees "tests aren't passing" in the narrative on the very next refresh; the pill colour just takes one more refresh to follow.

The narrative is the truth; the pill is the consensus.

### Notifications

The OS notifier reads `state.recap.verdict.bucket` — which is the damped bucket. So notifications get the same dampening for free: only a *confirmed* transition into `drifting` / `stuck` fires the bell. This was the most user-visible flicker source and it's gone.

### The trade-off

Hysteresis applies to **all** transitions, including entries into `drifting`. A session that flips `converging → drifting` takes one extra refresh (default 30 s) to show the warning. The trade-off is: zero false-positive notifications from a noisy pulse vs. ~30 s slower true-positive surfacing.

First-pulse exception: a session that classifies as `drifting` on its very first pulse alerts immediately. The hysteresis state initializes to whatever the first observation is — entries get full credit, only transitions wait.

### Tests

179 (was 168). Eleven new tests in `test/hysteresis.test.mjs` exhaust the state machine: initial entry doesn't dampen, same-bucket pulses clear pending, single disagreements don't flip, two-consecutive confirmations DO flip, three-bucket sequences reset the candidate, and the input state is never mutated.

The orchestrator wiring itself isn't covered by a new integration test — exercising real bucket transitions requires manipulating live transcript fixtures across pulses, which is brittle. The state machine is small enough that unit-test coverage + visual inspection of the wiring (a 25-line block in `runPulse`) is the right depth here.

## [0.5.3] — 2026-05-23

Six "render calm + correctness" fixes from the external Gemini + Cursor inspections. No new flags, no new public API — the dashboard just feels calmer, more responsive, and more correct.

### Fixed — sequence look-ahead missed real-world TDD loops (Cursor #1)

`countEditVerifyCycles` and `detectStuckLoop` looked ahead exactly 3 array positions for the next verification event after each edit. Real agents do exploration *between* iterations — `Edit(foo.ts) → Read(bar.ts) → Read(baz.ts) → Read(qux.ts) → Bash(npm test)` is a single TDD/stuck cycle, but pre-fix the verification fell past the 3-event window and the cycle was silently lost.

- Both helpers now skip over exploration events (`Read` / `Glob` / `Grep` / `LS`) without counting them toward the look-ahead budget. The budget still caps at 3 *non-exploration* events, so unrelated stretches of editing still cut off the search.
- New `findNextVerificationIdx(seq, startIdx, maxNonExplorationLookahead)` helper shared between both detectors.

### Fixed — `detectDrifts` re-normalized repoRoot per Write event (Cursor #2)

`isOutsideRepoRoot(filePath, repoRoot)` did `s.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()` on **both** arguments. The file path varies per event, but the repoRoot doesn't — it was being normalized N times for N Write events in the window.

- Split into `normalizePath(s)` + `isPathOutsideNormalizedRoot(filePath, normalizedRoot)`. `detectDrifts` now normalizes `repoRoot` exactly once at the top and reuses the pre-normalized string. Hot path on long windows.

### Added — vim-style wrap-around navigation (Cursor #3)

Pressing Up at the first row, or Down at the last row, used to be a no-op — the cursor sat against the edge. v0.5.3 wraps: Up at top jumps to bottom, Down at bottom jumps to top. Matches the convention everyone reaches for in terminal-only list nav.

### Fixed — Ink re-render thrash from the 1-second clock (Cursor #4)

Pre-v0.5.3 the App component held a `now` state that ticked every 1000 ms and was passed down as a prop to `SessionList` + `SessionDetail`. Because every "Xs ago" label needed `now`, the **entire Ink tree** re-diffed every second — visibly on cmd.exe, measurably on slower terminals.

- New `<TimeAgo timestamp prefix dim />` (`src/tui/TimeAgo.tsx`) is a self-clocking cell. It owns its own `setInterval` (unref'd so it doesn't keep the process alive) and renders just one label.
- `SessionList` no longer takes `now`. Each row's "updated Xs ago" cell is a `<TimeAgo>`. The pane itself is wrapped in `React.memo` so it only re-renders when sessions/selection actually change.
- `SessionDetail` similarly drops `now`. The footer (`Last refresh: … · next refresh: …`) is extracted into a self-clocking `<RefreshFooter>` subcomponent. Memoized.
- `App` still holds `now` for the whitelist-preview countdown banner, but the children no longer subscribe to it — so the App's 1 s tick rebuilds just the small footer banner, not the whole tree.

### Fixed — merged dual debounce in App (Gemini #7)

Two separate `useEffect`s each ran a 100 ms debounce — one for orchestrator events, one for watcher events. When a file change fired both within the same window (common during active coding), the dashboard did two `setStates` calls 100 ms apart and Ink did two diffs.

- One shared scheduler now. Both event sources call into the same `scheduleFlush()` closure; bursts from either side coalesce into a single flush.

### Fixed — long absolute paths wrapped in narratives (Gemini #8)

Narratives like "Earlier in the window it made 12 changes to `C:\Users\conno\Dev\fit-ontology\web\app\clients\dashboard\page.tsx` before going idle" wrapped onto two lines in a normal-width terminal — the v0.3.5 `NARRATIVE_MIN_HEIGHT` pad was the only thing keeping the detail box stable.

- New `shortenPath(path, maxLen=50)` middle-ellipsises paths over the threshold: keeps as many trailing segments as fit under `maxLen` with a leading `…/` marker, always preserves the basename.
- Wired into every `primaryFile` use site in `src/narrative.ts`. Same information, less wrap.

### Tests

168 (was 166). Two new regression tests:

- `analyzeSequences: stuck_loop tolerates interleaved reads between edit and verify` — constructs the exact failure shape (edit → 3 reads → fail verify) twice and asserts `stuck_loop` fires with `cycleCount: 2`
- `idle narrative with long file path renders single-line` — asserts a 65-char path is replaced with a `…/`-shortened form and the basename is preserved

The TimeAgo / memo refactor doesn't have a direct unit test (Ink test renderer can't easily measure re-render counts), but the existing component tests still pass with the new architecture, and the `.unref()` on the intervals keeps tests fast (sub-second instead of timing out on leaked timers).

## [0.5.2] — 2026-05-23

Four findings from the post-v0.5 internal inspection. None affect what the dashboard renders; all close real correctness or UX gaps.

### Fixed — rename mode could write to the wrong session (HIGH)

`src/tui/App.tsx` read `selectedId` at Enter-time when committing a rename. If the originally-selected session was removed by the watcher mid-rename (file deleted, project closed, etc.), the auto-fallback `useEffect` would jump `selectedId` to `visibleStates[0]` — and the typed alias would silently write to that fallback session instead. Narrow race window but a silent corruption.

- A new `renameTargetId` state captures the session id at `n`-press time. The Enter handler uses the captured id, not the current `selectedId`. `Esc` and the cleared-buffer path also clear the target.

### Fixed — concurrent `setAlias` / `appendExceptions` could lose writes (MEDIUM)

Both `src/aliases.ts:setAlias` and `src/exceptions.ts:appendExceptions` did `readFile → modify → writeFile` with no locking. Two near-concurrent calls would each read the pre-existing file, each write their own version, and the second silently wiped the first.

- Both modules now serialize writes via a **per-path promise queue**. The queue is keyed by resolved file path so different home dirs (and test tmpdirs) don't share a lane. A rejected earlier op doesn't block subsequent callers — the chain swallows internally so each caller gets exactly one error surface (their own `await`). Cleanup uses `.then(onOk, onErr)` rather than `.finally` to keep the cleanup branch terminal and prevent an unhandled-rejection chain when an op rejects.

### Fixed — notifier ignored aliases (MEDIUM)

`src/tui/index.ts` constructed the notification body label from `event.state.session.projectName ?? 'session'`. A user who'd aliased their session `CC1` still saw "AgentPulse: drifting" in the OS toast, not "CC1: drifting". And when `projectName` was undefined entirely (rare but real), the literal string `'session: drifting'` was useless.

- Label resolution now prefers `state.alias ?? projectName ?? \`session-<id-prefix>\``. Aliased users get their alias; un-aliased users get the project name; unknown-project users get a stable session-id stub instead of bare `'session'`.

### Fixed — stale `@v0.4.2` Action refs (LOW)

The README example, `examples/agentpulse-pr-check.yml`, and the action.yml comment all referenced `Conalh/AgentPulse@v0.4.2` — six releases out of date. First-time users copying the README would have pinned a 6-version-old git ref.

- All three locations bumped to `@v0.5.2`.

### Tests

166 (was 163). Three new tests:

- `aliases.test.mjs`: 5 concurrent `setAlias` calls preserve all entries (was a data-loss race)
- `aliases.test.mjs`: a failing write doesn't block subsequent callers
- `exceptions.test.mjs`: 5 concurrent `appendExceptions` calls preserve all fingerprints (was a data-loss race)

The rename-target capture and notifier-label changes are small enough that the existing TUI test fixtures cover their type contracts; their UX behaviour is verified manually (writing to a deleted session is a watcher-removal race that's hard to reproduce reliably in test, and the notifier change is a label-formatting tweak).

## [0.5.1] — 2026-05-23

### Fixed — orphan parser files shipping in the v0.5.0 tarball

The internal inspection that followed the v0.5.0 ship caught one real bug: `tsc` doesn't clean its `outDir`, so when v0.5.0 deleted `src/parser.ts` + `src/parsers/`, the previously-compiled artifacts under `dist/parser.{js,d.ts}` and `dist/parsers/{claude-code,codex,util}.{js,d.ts}` weren't removed. They got picked up by `npm pack`'s `dist/**/*.{js,d.ts}` glob and shipped to the registry.

The orphan `.js` files contained pre-v0.5 vendored-parser code; the orphan `.d.ts` files referenced a `./types.js` shape that no longer matches what's exported. Any tool importing by subpath (e.g. `agentpulse/dist/parser.js`) would have hit a stale, inconsistent surface. Normal `import 'agentpulse'` users were unaffected — the `exports` map limits the public surface to `.`.

- **`package.json` scripts** gained a `prebuild` step:

  ```json
  "prebuild": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\""
  ```

  Pure Node stdlib, cross-platform (works on Windows without `rimraf`). Every `npm run build` (and therefore every `prepare` / `prepublishOnly`) now starts from an empty `dist/`.

### Tarball metrics

- **Before** (v0.5.0): 62 files, 110.5 kB
- **After**  (v0.5.1): 54 files, 102.8 kB

8 orphan files dropped, ~7.7 kB saved.

### Tests

163 (unchanged). The clean step doesn't touch source or test coverage.

## [0.5.0] — 2026-05-23

### Parser surface moved to `agent-gov-core@1.1.0`

The Layer 1 transcript parser — `parseTranscript`, the per-runtime Claude Code / Cursor / Codex modules, and the `TranscriptEvent` / `EventKind` / `Runtime` / `ParseOptions` types — has been promoted into `agent-gov-core` as of its v1.1.0 release. AgentPulse v0.5.0 deletes its vendored copies and consumes the substrate version.

This was the v0.2/v1.1 cleanup the parser's v0.1 vendoring note flagged. SessionTrail had been carrying its own copy too; both tools now share one parser surface so format updates land once and propagate everywhere.

### Removed (from AgentPulse's source tree)

- `src/parser.ts` (206 lines) — the top-level `parseTranscript()` walker
- `src/parsers/claude-code.ts` (179 lines) — Claude Code / Cursor envelope parser
- `src/parsers/codex.ts` (178 lines) — Codex `response_item` / `session_meta` parser
- `src/parsers/util.ts` (134 lines) — shared helpers (`coerceTimestamp`, `interpolateTimestamps`, `extractToolResultText`, etc.)

Total: 697 lines deleted; identical surface lives in `agent-gov-core/src/parsers/`.

### Changed

- `src/index.ts` now does `export { parseTranscriptDir as parseTranscript } from 'agent-gov-core'` — the public `parseTranscript` name is preserved as a backwards-compat alias so v0.4.x library consumers keep working unchanged. The internal `pulse()` runner imports `parseTranscriptDir` directly.
- `src/types.ts` re-exports `TranscriptEvent`, `EventKind`, `Runtime`, `ParseOptions` from `agent-gov-core` so internal AgentPulse imports (`import type { TranscriptEvent } from '../types.js'`) keep working without churn across enrich.ts, trajectory.ts, sequences.ts, parser.test.mjs, etc.
- `package.json` peer pin bumped: `agent-gov-core: ^1.0.0` → `^1.1.0`. The caret picks up future substrate patches/minors automatically.
- The aggregate "skipped N malformed lines" warning prefix changed from `[agentpulse:parser]` to `[transcript-parser]` (brand-neutral, since multiple suite tools now share the parser).

### Compatibility

- **Library consumers** of AgentPulse (anyone using `import { parseTranscript } from 'agentpulse'`): no change. The alias keeps the v0.4.x API alive.
- **CLI users** of AgentPulse: no change. Same flags, same output.
- **Internal AgentPulse layers** (enrich, trajectory, sequences, narrative): no change. The Layer 1 types are re-exported from types.ts as before.

### Tests

163 (unchanged from v0.4.8). The existing `test/parser.test.mjs` keeps the same coverage; its import path flipped from `../dist/parser.js` to `../dist/index.js` and the test names + assertions are untouched. agent-gov-core@1.1.0 ships six additional parser tests at the substrate layer — total parser coverage across the two repos goes up, not down.

### Publishing order

`agent-gov-core@1.1.0` must publish to npm before `@conalh/agentpulse@0.5.0` — the caret pin `^1.1.0` won't resolve otherwise. The dual-publish dance:

```sh
# 1. Publish substrate first.
cd /path/to/agent-gov-core
npm publish

# 2. Refresh AgentPulse's lockfile against the registry copy.
cd /path/to/AgentPulse
npm install agent-gov-core@^1.1.0
npm test    # 163 should still pass

# 3. Publish AgentPulse.
npm publish --access=public
```

## [0.4.8] — 2026-05-23

### Changed — `a` is now a two-stage confirm

Pre-v0.4.8, pressing `a` on a `drifting` session wrote its findings to `.agentpulse-exceptions.json` immediately. A stray keypress could permanently whitelist findings the user never properly inspected. v0.4.8 inserts a preview step.

- **First `a` press** swaps the keybind footer for a yellow preview banner:

  ```
  ⚠ Whitelist 3 findings? (shell_exfil, privileged_read, +1 more) · press a to confirm (3s) · any key cancels
  ```

  The countdown ticks down each second using the dashboard's existing 1s tick — no new timer infrastructure.
- **Second `a` press within 3 seconds** commits the write. The drift set captured at preview time is what gets written — a background refresh during the window can't slip new findings into the commit silently.
- **Any other key** cancels the preview and then performs its normal action (arrow keys still move selection, `r` still refreshes, `q` still quits). No "modal state stuck on screen" failure mode.
- **3-second timeout** auto-cancels. A `useEffect` keyed on the preview state clears it when the window elapses.

### Architecture

- New `src/tui/driftSummary.ts` houses the pure `summarizeDriftKinds(drifts)` helper used by the banner — strips the `agent_pulse.live_drift_` namespace from each kind, renders ≤2 in full, collapses 3+ to `kind1, kind2, +N more`. Pure module, no React/Ink — unit-testable.
- `src/tui/App.tsx` gained a `whitelistPreview: { sessionId, drifts, expiresAt } | null` state, a stage-2 branch at the top of the `a` handler that runs the existing `appendExceptions` write only when a fresh matching preview is present, and a cancel-on-any-other-key clause at the top of the input handler.
- The `WHITELIST_PREVIEW_MS = 3000` constant tunes the window.

### Tests

163 (was 158). Five new `tui-helpers.test.mjs` tests covering `summarizeDriftKinds`:
- Empty list → empty string
- Single finding → namespace stripped
- 1–2 findings → comma-joined in full
- 3+ findings → first two + `+N more`
- Foreign-tool kind without the namespace prefix passes through unchanged

## [0.4.7] — 2026-05-23

### Added — agent aliases

When multiple agents run on the same project (e.g. two Claude Code windows + a Cursor + a Codex), even the v0.4.4 hex-tail disambiguator gets impersonal fast — you don't *want* to read `core · aaaaaa` and `core · bbbbbb`, you want `CC1` and `CC2`. v0.4.7 lets you name them.

- **Press `n`** on a selected row to drop into rename mode. The dashboard's footer becomes `Rename: <buffer>█ · Enter save · Esc cancel`. Typing feeds the buffer (no other keys fire — `q` won't quit mid-rename, `r` won't refresh). Enter commits, Esc cancels. Empty + Enter clears.
- **Aliases render in front** of the project name: `CC1 · AgentPulse (claude-code)`. The alias replaces the auto-generated hex tail from v0.4.4 — the alias IS the disambiguator.
- **Aliased rows don't inflate collision counts.** If you alias two of three colliding rows, the lone unaliased one stays clean (no spurious tail).

### Storage — two-tier, cwd wins over home

Two optional JSON files (mirrors the `.agentpulse-exceptions.json` pattern):

1. `<session.cwd>/.agentpulse-aliases.json` — per-project. Commit alongside your exception baseline if you want team-shared conventions.
2. `~/.agentpulse/aliases.json` — personal default. Writes via `n`-Enter land here by default; promoting an alias to the shared file is a manual copy/paste — intentional, so a shared file never gets written without your hand.

Both files share the schema:

```json
{
  "version": 1,
  "aliases": { "<sessionId>": "<freeform name>" }
}
```

Load is silent on missing / malformed files — aliases are a niceties layer, not required config. Writes refuse to clobber a malformed existing file (the user can fix by hand).

### Architecture

- New file `src/aliases.ts` — `loadAliases({ cwd?, home? })` returns a merged `Map<sessionId, alias>`; `setAlias(sessionId, alias, { home? })` writes the home file (creates `~/.agentpulse/` on first call); `homeAliasPath(home?)` exposed for tests.
- `src/orchestrator.ts` now calls `loadAliases({ cwd: session.cwd })` at the end of each pulse and threads the result into `SessionState.alias`. Cheap (small JSON read), runs at refresh cadence — `n`-Enter or an external file edit lands on the dashboard within one tick.
- `SessionState` gained an optional `alias?: string` field.
- `src/tui/SessionList.tsx` renders the alias in bold cyan in front of the project name when present; collision-count loop now skips aliased rows.
- `src/tui/App.tsx` owns the `n`-key rename mode: `renameMode` + `renameBuffer` state, an early-return branch at the top of `useInput` that intercepts all keystrokes while typing, and a footer that swaps from keybind hints to `Rename:` while active.

### Tests

158 (was 143). Twelve new alias-storage tests + three new SessionList rendering tests:
- Storage: empty / home-only / cwd-only / cwd-overrides-home / malformed-silent / non-string-rejection / mkdir-and-write / update-existing / empty-deletes / refuse-malformed-clobber / whitespace-trim / empty-sessionId-throws
- Rendering: alias-in-front, aliased-rows-no-hex-tail, aliased-rows-don't-inflate-collision-count

## [0.4.6] — 2026-05-23

### Fixed — Codex sessions rendered as "2026"

Codex stores transcripts at `~/.codex/sessions/<year>/<month>/<day>/<rollout>.jsonl`, and the year segment was leaking through `deriveProjectName` as a "project name" — the screenshot review showed a literal `2026 (codex)` row. None of the date-shape segments (year, month, day, ISO date) are ever real project names.

- **`src/sessions/discovery.ts`** — extended the `looksJunky` patterns in `deriveProjectName` to match pure-digit segments (`\d{1,4}`) and ISO dates (`\d{4}-\d{2}-\d{2}`). Junky slugs now force the cwd-basename fallback that the Windows `C--` case already used; when cwd is also missing, the function returns `undefined` so the UI's `inferProjectFromPaths` (which walks the recap's primary file paths) takes over.
- The Codex parser already extracts `cwd` from `session_meta.payload.cwd` in `extractCwdFromFirstLine`, so cwd is typically available and the fix lands cleanly — most rows now show the real project name (e.g. `AgentPulse (codex)` instead of `2026 (codex)`).

### Tests

143 (was 142). One new `sessions.test.mjs` test covering:
- date-shape slug + cwd → cwd basename wins
- date-shape slug + no cwd → undefined (never the date)
- ISO date shape gets the same treatment
- Sanity: non-date Codex slugs still decode normally

## [0.4.5] — 2026-05-23

### Changed — session list now clusters by project

When multiple agents run against the same repo — say Cursor + Claude Code + Codex all chewing on `ontology` — the dashboard now puts those rows adjacent so the project reads as one unit, regardless of bucket. Pre-fix (`v0.3.2`'s urgency-first sort), the three sessions landed in different buckets and scattered across the list.

**New sort key precedence** (`src/tui/sort.ts`):
1. Project label (case-insensitive ascending) — same-project sessions cluster
2. Urgency rank within the project — drifting/stuck float to the top of their group, idle/done sink
3. Runtime ascending — stable tie-break across runtimes for the same project
4. lastUpdated DESC — freshest first for truly identical project+runtime

**Trade-off**: a single drifting session in an alphabetically-late project no longer floats to the top of the screen. The verdict pill colour still surfaces urgency per row, and the v0.4.4 disambiguator still distinguishes within a cluster.

### Refactor

- Extracted `URGENCY_RANK`, `urgencyOf`, and the new `compareByProject` comparator into `src/tui/sort.ts`. Pure, no React/Ink imports — directly unit-testable.
- Exported `fallbackLabel` from `src/tui/SessionList.tsx` so the comparator clusters by the same project key the user sees rendered.

### Tests

142 (was 137). Five new sort tests:
- `URGENCY_RANK` ordering invariant (drifting < stuck < pending < converging < exploring < idle < done)
- Same-project clustering across alphabetical project order + runtime tie-break
- Within-project urgency precedence (drifting beats idle beats done)
- `lastUpdated` DESC tie-breaks identical project+runtime
- Project name comparison is case-insensitive (`AgentPulse` and `agentpulse` cluster)

## [0.4.4] — 2026-05-23

Last visible bug from the v0.4.3-screenshot review.

### Fixed — session list showed three identical "core (claude-code)" rows

When two or more visible sessions shared the same `projectName + runtime` combination — e.g. three separate Claude Code sessions of the same repo — the dashboard rendered them as three visually identical rows. To a viewer who doesn't know each row is a distinct session ID, this reads as a duplicate-rendering bug.

- **`src/tui/SessionList.tsx`** now pre-computes label collision counts once per render, and on any row whose `(label, runtime)` key appears ≥2 times in the visible set, appends a 6-char hex tail of the session id (e.g. `core · c3d456 (claude-code)`). Unique rows render exactly as before — no extra noise.
- The tail uses the same `dimColor` treatment as the existing runtime suffix, so the project name stays the visually dominant element.
- The label truncation budget (`LABEL_COL_WIDTH`) accounts for the tail when present, so long project names with a collision still fit in the column without wrap-flicker.
- Why 6 hex chars: 16M of space is well past collision-resistant for a ≤10-row list, but short enough that even `CapabilityEcho · c3d456 (claude-code)` (38 chars) fits in the column.

### Tests

137 (was 136). One new SessionList test that constructs three colliding rows + one unique row and asserts:
- Each colliding row carries its own session-id tail
- The unique row does NOT carry a tail
- The ` · ` separator appears exactly once per colliding row

## [0.4.3] — 2026-05-23

Three narrative-quality fixes — all driven by a dogfooded dashboard screenshot the user was about to use as the README hero image. Sometimes the bug only shows up when you're staring at the tool in production.

### Fixed — "working on bad for 20 minutes"

The narrative reads its topic word from `enriched.topics[0]`, which is the most-frequent non-stopword token in user messages. In a real noisy session, evaluative adjectives like `bad` / `good` / `looks` and conversational fillers like `thing` / `hmm` / `yeah` outranked the actual subject of work, producing broken-English narratives like "Your agent has been working on bad for 20 minutes."

- **`STOPWORDS` in `src/enrich.ts`** expanded with ~50 entries covering evaluative adjectives (`bad`, `good`, `great`, `weird`, `broken`, …), weak verbs (`looks`, `seems`, `want`, `need`, `try`, `said`, `think`, …), vague nouns (`thing`, `stuff`, `way`, `kind`, …), and conversational fillers (`hmm`, `yeah`, `nope`, `lol`, …). Still well under the 500-token guard the existing test asserts.
- **Regression test** in `test/enrich.test.mjs` lists 13 of these words and asserts none survive to `topics[]`; also asserts a real subject word (`authentication` / `login`) still wins.

### Fixed — duplicate "no verification" signal bullet

When the `refuse_to_verify` sequence pattern + ≥5 edits flipped a session to `stuck`, the TUI showed two bullets that said the same thing:

```
· 10 edits with no verification — agent isn't running anything
· 10 edits with no verification events in the window
```

The first came from the trajectory layer (`src/trajectory.ts`), the second from spreading `sequence.details` (whose only detail for this pattern was the same fact restated). Dropped the spread; one signal now.

- **`src/trajectory.ts`** — removed `signals.push(...sequence!.details)` in the `refuseToVerifyStuck` branch.
- **Regression test** in `test/sequences.test.mjs` asserts `verdict.signals.filter(/no verification/).length === 1`.

### Fixed — narrative stutter on stuck + refuse_to_verify

The stuck narrative ends "…but without running tests to verify. The conversation has a 'try again' tone. Worth checking in." — and then v0.3.2's sequence-phrase appendage tacked on "It's been editing without running anything to verify — worth checking." Two near-identical "verify" + "worth checking" tails back to back.

- **`src/narrative.ts`** — added a `stuckRefuseStutter` skip-clause to the sequence-phrase appendage. The stuck bucket already covers the refuse_to_verify content; the sequence phrase is suppressed in that one combination. Other bucket × sequence combinations still append as before.
- **Regression test** in `test/narrative.test.mjs` constructs a stuck + refuse_to_verify verdict and asserts the narrative says "worth checking" exactly once.

### Tests

136 (was 134). Two new tests; one tightened assertion in `sequences.test.mjs`.

## [0.4.2] — 2026-05-23

Two features ship together: the GitHub Action variant (CI integration on rails) and local notifications (walk away from the TUI and still hear when something flips).

### Added — GitHub Action

- **`action.yml` at repo root** — composite Action shape matching the rest of the gov-suite. `uses: Conalh/AgentPulse@v0.4.2` runs `agentpulse live --once --format json` + `--format text` against the workflow's transcript directories, parses the JSON for step outputs, streams the text into the step summary, and optionally posts a sticky PR comment that updates in place across pushes.
- **Inputs**: `transcript-dirs`, `window`, `stale`, `strict`, `no-detectors`, `hide-idle`, `show-subagents`, `max-sessions`, `comment-on-pr`, `github-token`.
- **Outputs**: `gating-finding`, `session-count`, `drifting-count`, `stuck-count`, `json-report-path` so downstream steps can branch on the result.
- **`examples/agentpulse-pr-check.yml`** — drop-in pull-request workflow that downloads transcripts from a CI artifact, runs AgentPulse, gates on `drifting`/`stuck`, and posts the verdict as a sticky PR comment.
- Self-contained at the git tag — `npm ci --omit=dev && npm run build` inside the action's checkout (same pattern as `GovVerdict@v0.2.1`), so no npm-publish dependency.

### Added — Notifications on state transitions

Walk away from the TUI and still hear it when an agent goes sideways.

- **`--notify <mode>` on `agentpulse live`** — fires a local notification when any session flips INTO `drifting` or `stuck`. Modes: `none` (default), `bell`, `os`, `both`. Opt-in by design; defaulting to bell would be nag-prone.
- **Trigger policy** (in `src/notifications.ts`): only fires on transitions INTO an alert bucket from a non-alert state. So `converging → drifting` fires; `drifting → drifting` doesn't (no double-alert); `drifting → idle` doesn't (clearing is silent). `null → drifting` (first pulse already concerning) fires.
- **`bell`** writes `\x07` to **stderr** (not stdout — stdout is in the alt-screen buffer for the TUI).
- **`os`** spawns a platform-native notifier, detached + fire-and-forget. macOS uses `osascript`, Linux uses `notify-send` (graceful failure when missing), Windows tries `New-BurntToastNotification` and falls back to a `System.Windows.Forms.NotifyIcon` balloon.
- **`--once` mode also honors `--notify`** — fires exactly one notification per invocation when any session is gating, regardless of session count. `--once` is a snapshot, not a monitor.

### Windows limitation

The PowerShell `NotifyIcon` fallback works but leaks a tray icon for the duration of the balloon (we `Dispose()` after a 6s sleep, which keeps the spawned PowerShell process alive briefly). Users who want clean Windows toasts can `Install-Module BurntToast` themselves — the spawn tries that first and only falls through to `NotifyIcon` on `Import-Module` failure. For a perfectly clean experience on Windows without BurntToast, prefer `--notify both` so you at least get the terminal bell as the reliable signal.

### Architecture

- New `src/notifications.ts` exports `createNotifier({ mode })`, `shouldNotify(from, to)`, `NotifyMode`. Pure stdlib — no new runtime deps. `child_process.spawn` with `detached: true` and `stdio: 'ignore'` so notification processes never block the orchestrator.
- TUI wiring (`src/tui/index.ts`): a second orchestrator listener (independent of the App component's render listener) tracks `previousBuckets: Map<sessionId, TrajectoryBucket>` and calls `notifier.onTransition(prev, next, label)` on every `session-updated`. Listener errors are swallowed by the orchestrator's existing try/catch around `emit()`.
- `LiveOptions.notify?: NotifyMode` threaded through `parseLiveCli`. Invalid values surface as a usage error (exit 2).
- Notifications are best-effort: every channel swallows its own errors. A missing `notify-send` on Linux or a stripped-down Windows env is a silent no-op, never a crash.

### Tests

134 (was 117). Seventeen new tests in `test/notifications.test.mjs` covering the policy table (null/safe/alert × null/safe/alert), bell-mode stderr capture, both-mode bell-still-rings, `notifyOnce` for `--once` mode, and `stop()` idempotency. The OS channel deliberately isn't asserted on by spawning real `osascript`/`notify-send`/`powershell.exe` — the public `onTransition` return value is the contract, and the spawn calls are detached + error-swallowed so cross-platform CI doesn't ring up the dev's machine.

## [0.4.1] — 2026-05-23

The interactive whitelist — Cursor's proposal from the inspection round, now real.

### Added

- **Press `a` on a drifting session to whitelist its findings.** The TUI's `useInput` handler picks up `a`, reads the currently-selected session's drift findings, and appends their fingerprints to `<session.cwd>/.agentpulse-exceptions.json`. The orchestrator then refreshes the session; `pulse()` loads the updated baseline; `detectDrifts` filters out the suppressed fingerprints; the verdict re-classifies away from `drifting` instantly. UX is one keypress → bucket clears.
- A green flash banner appears in the detail pane for 2 seconds: `"✓ whitelisted N findings — refreshing…"`. Confirms the action without nagging.
- The footer keybinding hint and `?` help overlay both document `a` clearly.

### Architecture

- New `src/exceptions.ts` exports `loadExceptions(searchPath?)` and `appendExceptions(searchPath, drifts)`. Both accept a directory or a full file path; both fail silently on missing/malformed input (exceptions are an optional baseline, not required config).
- New `PulseOptions.exceptionsPath?: string`. Falls back to `repoRoot` when unset, so the orchestrator inherits exception filtering for free — `session.cwd` was already being threaded as `repoRoot`. **Zero orchestrator changes needed.**
- New `TrajectoryOptions.exceptions?: Set<string>`. `detectDrifts` filters out matching findings AND their paired signal-array entries together (a naive drift-only filter would have leaked the suppressed concern back into the narrative).
- `buildDrift` now stamps `Finding.fingerprint = fingerprintFinding(drift)` so the same drift at the same site hashes to the same id across refreshes. Stable fingerprints are what makes the whitelist work — without them, the lookup would miss after the next pulse.

### File format

```json
{
  "version": 1,
  "exceptions": [
    {
      "kind": "agent_pulse.live_drift_shell_exfil",
      "fingerprint": "a1b2c3...",
      "approvedAt": "2026-05-23T22:00:00.000Z",
      "note": "approved by user via TUI"
    }
  ]
}
```

Lives at the session's working-directory root. Commit it to your repo and your CI gating (`agentpulse live --once --strict`) honors the same baseline.

### UX detail

- `a` is 300 ms-debounced (same pattern as the v0.2.9 `?` debounce). Holding the key down doesn't trigger dozens of disk writes.
- Pressing `a` on a non-drifting session is a silent no-op. Pressing it on a session without a `cwd` is also a no-op (no way to know where the exception file should live).

### Tests

117 (was 110). Seven new tests on the exceptions layer: missing-file, valid-file, malformed-file (silent failure), create-on-append, dedupe-by-fingerprint, append-roundtrip, direct-file-path.

## [0.4.0] — 2026-05-23

CI-ready release. AgentPulse can now run headless, emit structured JSON, and gate CI pipelines on agent state.

### Added

- **`agentpulse live --once`** — headless one-shot mode. Runs discovery + initial pulse per session, prints a snapshot, exits. No TUI, no Ink deps loaded. Lazy-loads via the same `import('./once.js')` pattern the TUI uses, so `agentpulse recap` invocations stay lean.

- **`--format json`** (for `--once` mode) — emits a structured snapshot of all sessions:

  ```json
  {
    "generatedAt": 1779573228301,
    "sessionCount": 3,
    "bucketCounts": { "drifting": 1, "converging": 1, "idle": 1 },
    "hasGatingFinding": true,
    "sessions": [
      { "id": "...", "projectName": "...", "runtime": "...",
        "bucket": "drifting", "confidence": 0.9, "narrative": "...",
        "signals": [...], "driftCount": 3, "transcriptPath": "..." }
    ]
  }
  ```

  Pipe into tmux status bars, Polybar, custom dashboards, or downstream policy tools.

- **`--strict`** (for `--once` mode) — exits `1` when any session is in `drifting` or `stuck`. Drop into a GitHub Action's pre-merge check to gate on agent state without writing your own JSON parser.

  ```yaml
  - run: npx @conalh/agentpulse@latest live --once --strict
  ```

### Architecture

- New file `src/once.ts` owns the headless runner. Pure function over `LiveOptions`; returns an exit code.
- `LiveOptions` gained three optional fields (`once`, `format`, `strict`); `TrajectoryVerdict` and the rendering pipeline unchanged.

### Tests

110 (was 104). Six new tests on the once-mode CLI surface: text format renders, JSON format parses, strict exit codes work, missing roots don't crash, invalid format is a usage error.

## [0.3.5] — 2026-05-23

### Fixed

- **Narrative and signals sections still shifted inside the (stable) detail box.** v0.3.4 pinned the outer box to `minHeight = 16`, which stopped the box itself from resizing. But the sections inside still varied: a 1-line narrative ("Your agent has been quiet for 12 minutes.") vs a 3-line narrative (with a long file path wrapping) pushed Signals/Activity down by 2 lines even though the outer box was the same height. Signals also varied 1-4 lines per session.
- Pinned `NARRATIVE_MIN_HEIGHT = 4` and `SIGNALS_MIN_HEIGHT = 5` on the inner section boxes. Short content gets bottom padding inside its section; long content still expands. Sections now hold their vertical position even when bucket transitions change narrative length.

This is the **fourth** fixed-dimension fix on the rendering layer. Pattern: pin every cell whose content varies on the axis it varies along.

## [0.3.4] — 2026-05-23

### Fixed

- **Detail pane resized vertically when navigating between sessions.** Pre-fix, `SessionDetail` sized itself to its content — short for idle sessions (~6 lines), tall for drifting (~16+ lines). Arrow-navigating up/down between sessions resized the bordered box each time, which shifted the global footer + RAGE branding up and down — visible "jerk" the user reported. Pinned `minHeight = 16` on the detail pane's outer Box: short content gets bottom padding, content-heavy verdicts (drifting with many findings) still expand. The footer + branding now stay at a fixed vertical position regardless of selection.

This is the third fixed-size-cell fix on the dashboard rendering layer:
- v0.2.3 pinned `SessionList` row width (no horizontal wrap on long slugs)
- v0.3.3 pinned the sparkline cell width (no horizontal jerk on sparkline content changes)
- v0.3.4 pins the `SessionDetail` minimum height (no vertical jerk on selection change)

General principle: any TUI cell whose content changes over time needs a pinned dimension on the dimension that varies, or the surrounding layout will visibly jitter.

## [0.3.3] — 2026-05-23

### Fixed

- **Activity sparkline row jerked between refreshes.** Pre-fix, the row was conditional on `events.length > 0` and the sparkline itself could return an empty string when no events fell into any bucket — both of which shifted the layout horizontally on every refresh tick. Pinned the sparkline cell to a fixed `Box width` (`SPARKLINE_WIDTH = 24`) and made the sparkline always return a string of exactly that width (spaces when empty). The trailing event-count text now holds its column even as the bucket pattern changes underneath.

## [0.3.2] — 2026-05-23

The sprint release. Five things land together: the long-promised sequence pattern detection, sharper converging rule, urgency-sorted session list, activity-density sparkline in the detail pane, and a tightened drift regex that fixes a false positive we caught in the wild.

### Added

- **Ordered action-sequence pattern detection** — the feature the v0.3.0 README originally claimed and v0.3.1 admitted didn't exist. New Layer 2.5 (`src/sequences.ts`) analyzes the chronological shape of events and emits a `SequenceSignal`:
  - **`tdd_loop`** — `(editing → verification)` cycles. ≥2 → 0.65 confidence, ramps to 0.85 at 3+. Bumps converging confidence to 0.9 when paired with converging-shape.
  - **`stuck_loop`** — ≥2 cycles editing the *same* file with verification failing. Overrides Rule 3 stuck at 0.85. Highest-priority pattern.
  - **`refuse_to_verify`** — ≥4 edits + zero verification events. 0.7 confidence. Combined with `editing >= 5`, the classifier flips the bucket to `stuck` regardless of verification trend.
  - **`exploratory_edit`** — ≥3 consecutive explorations followed by edits in the back half of the window. Supporting signal for converging.
- Each fires the appropriate narrative phrase appended to the bucket's recap.

- **Urgency sort in the session list.** Pre-fix, the list followed discovery order. Now: `drifting → stuck → pending → converging → exploring → idle → done`, with `lastUpdated DESC` as the tie-break within each tier. Mission-control read: anything that needs attention sits at the top.

- **Activity-density sparkline in `SessionDetail`.** Compact Unicode block-eighths `▁▂▃▄▅▆▇█` rendering of event timestamps across the window. Colored by current bucket. Lifted-in-spirit from agenttrace's metrics view; tells you at a glance "did the agent burst then go quiet" vs. "steady activity throughout."

### Fixed

- **`shell_exfil` regex false positive on `gh release create ...curl|sh...`-style commands.** Pre-fix, the regex scanned the entire command string and matched `curl | sh` inside heredoc'd release-note content (the exact command shipping v0.3.1, which described the drift detector itself, tripped its own rule). Tightened to require `curl|wget` at command start or right after a `&&`/`;`/`||`/`|` separator, with no quote chars between it and the pipe-to-shell. The remaining miss-case is content at start-of-line inside a heredoc, which needs real shell tokenization to catch and isn't worth that complexity here.

- **Smarter converging-without-verification rule (4b).** Pre-fix, the rule fired on `editing >= 5 AND (cluster >= 50% OR primaryFile)`. A session thrashing one file qualified. Now tighter: `editing >= 5 AND cluster >= 70% AND primary file edited at least 3 times`. That's "focused productive work," not "any session with edits." Confidence still 0.6 because verification signal is still absent.

### Tests

104 (was 85). Subagent's PR #8 added 13 sequence-pattern tests; this branch adds 6 sparkline helper tests.

## [0.3.1] — 2026-05-23

Honesty pass. Three independent inspection rounds (Claude / Gemini / Cursor) converged on the same diagnoses; this release is the union of their P0/P1 fixes plus alignment of the README with the code.

### Fixed (real bugs)

- **Orchestrator lost changes during in-flight pulse.** Pre-fix, a watcher event arriving mid-pulse piggybacked on the running promise and got a recap reflecting file state *before* the change. On actively-written transcripts, the dashboard could lag a full refresh cycle (30s) behind reality. Implemented the "running + dirty" 2-state flag: if a refresh arrives while one is in flight, `state.dirty = true`; the current pulse's `.finally` notices and immediately re-fires. Watcher floods still collapse to ~2 pulses max per batch, but no change is ever lost.
- **Windows case-insensitive path matching in the watcher.** `--roots c:\dev\transcripts` vs. an event arriving as `C:\Dev\transcripts\...` made `rootForPath` return `undefined`, every session label fell through to `session-<id>`. Now normalized lowercase comparison on win32; returned values keep original casing.
- **Codex parser race tagged Anthropic lines as Codex.** Once `codexSessionDetected` flipped true on a stray `session_meta`, every subsequent line was forced through the codex parser, whose default branch always returns a system event (never null) — so mixed-runtime files mistagged everything. Now: route to the codex parser only when the line itself is a codex shape, not based on a sticky flag.
- **`repoRoot` / `--repo` was accepted but never used for drift detection.** Hardcoded prefixes (`/tmp/`, `/var/`, `~/`) meant a Write to `C:\Dev\other-project\` from a session rooted at `C:\Dev\fit-ontology\` didn't flag as drift. Now plumbed through `pulse()` → `classifyTrajectory` → `detectDrifts`. Cross-project writes correctly flag. Legacy hardcoded check still fires when `repoRoot` is undefined for backwards compat.
- **Drifting narrative mislabeled findings.** Pre-fix, all drifts were described as "things outside the project" — wrong for `.ssh/id_rsa` reads (privileged path), misleading for `curl | sh` (piped network exec). Now bucket-aware lede: "touched a privileged path", "piped network fetch into a shell", "wrote outside the repo root", or the generic "wandering" fallback.
- **Converging narrative claimed tests ran when verification had no signal.** Rule 4b fires when `verificationTrend === 'no_data'`; the narrative still said "ran the tests after each change" + closed with "Looks like it solved it" while the Signals line right below admitted "no verification data". Now: the "ran the tests" phrase is gated on actual verification signal (`improving` or `flat_pass`), and "Looks like it solved it" only closes when tests actually went green.
- **Typo:** "its wandering" → "it's wandering" (collateral fix from the drifting narrative rewrite).

### Fixed (UX)

- **`**bold**` markdown showing literally in the TUI.** Narrative templates use `**` for emphasis (right source format for plain-text consumers), but the TUI rendered the asterisks verbatim. New `MdLine` helper in `SessionDetail` parses `**bold**` spans into Ink `<Text bold>` nodes. CLI recap text mode converts to ANSI bold escapes (`\x1b[1m...\x1b[22m`) so terminals render emphasis instead of literals.

### Changed (docs)

- **README rewrite.** Pre-fix, the README claimed sequence-pattern detection (`read-read-read-edit-test → exploratory edit`) that isn't implemented, and said AgentPulse "leverages SessionTrail's detectors" when `trajectory.ts` actually has inline stand-ins. Both claims removed. New README leads with `agentpulse live` (the headline feature post-v0.3), documents every `live` flag and keyboard shortcut, shows the verdict pill key, and adds a Windows terminal note. Sequence detection moved to the v0.4 plan; SessionTrail detector integration tied to the substrate v1.1.0 cleanup.

### Added

- **`.github/workflows/ci.yml`** — `npm test` matrix on Ubuntu + Windows, Node 20 + 22, plus a CLI smoke test (`node dist/cli.js --help`). Windows matters disproportionately for this project: half the v0.2.x changelog is Windows-specific fixes. Catching regressions on win32 in CI > catching them in screenshots from real users.

### Tests

85, unchanged. The bugs fixed here weren't caught by tests (they were caught by reading code carefully + dogfooding). v0.3.2 will add regression coverage for the orchestrator coalesce + the Windows path casing.

## [0.3.0] — 2026-05-23

### Added

- **Startup splash.** ~900 ms ANSI-Shadow ASCII rendering of `RAGE` in bold red, with `AgentPulse` and the tagline `live trajectory verdict · local · no LLM` underneath in cyan + dim. Mounts before the dashboard, fades into it as soon as the timer fires.
- **Header signature.** Title bar now reads `AgentPulse · by RAGE` (RAGE in bold red) — a small attribution in the chrome that's visible at all times without distracting from the data.
- **Footer signature.** Lower bar now ends with a small `▲RAGE` mark on the right side, matching the bucket-pill family.

### Why bump to 0.3.0

Pure additive visual change, no contract or behavior change to any layer. Bumping minor (not patch) because the dashboard's visual identity is now branded — that's a notable enough change in look-and-feel to warrant a minor version under the project's semver model.

## [0.2.11] — 2026-05-23

### Fixed

- **Stacked dashboard renders when discoveries or refreshes fire in rapid succession.** Pre-fix, every orchestrator event (`session-added`, `session-updated`, `session-removed`) and every watcher event (`add`, `change`, `remove`) immediately called `setStates(...)`, triggering an Ink re-render. When 5 sessions were discovered in the first 200ms, that's 5 setStates → 5 renders. Ink's diff calculation couldn't always finish one frame before the next was queued, especially on cmd.exe, producing the stacked-dashboards-with-mismatched-counts you could capture in a screenshot.
- 100 ms debounce on both event sources collapses bursts into a single batched setStates. Imperceptible delay (you still see live updates as your agent works) but cuts render-thrash entirely. Combined with the v0.2.8 alt-screen-buffer fix and the v0.2.9 `?` debounce, the rendering layer should now be stable across all the spam-test cases.

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
