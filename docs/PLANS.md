# Plans

Working document. Captures what's on deck, what's medium-term, what's
deliberately out of scope, and the inspection-derived items that
haven't been addressed yet.

Versions in the "Doing soon" lane aren't promises — they're the
likely shape of the next ship. Versions in "Watching" are direction,
not commitment.

Last sweep: 2026-05-28 (post-v0.7.1, with the correctness + cleanup
batch in flight on `main` toward the next release).

---

## Just shipped (v0.7.1 — session-noise + cross-runtime accuracy)

Driven by real multi-terminal session sets. Fixes that lived only in the
TUI never reached the headless `--once` / `--notify` paths, so JSON output
diverged from the dashboard:

- **Headless `--once` inherited the TUI's session hygiene** — subagent
  filtering (`agent-<hex>`) and co-named-session disambiguation moved into
  shared modules (`src/sessions/subagents.ts`, `src/labels.ts`) and now
  feed both surfaces. New `label` field on the snapshot.
- **Project names fixed on multi-word Claude Code projects** — naming now
  prefers `basename(cwd)` (scanning past the metadata prelude) over the
  lossy last-hyphen-segment slug decode.
- **`exploring` narrative no longer contradicts its own signals** when the
  low-confidence fallback fires with edits present.
- **Current Codex desktop format** (`custom_tool_call`) recognized; added
  `codex-desktop-*` golden fixtures.
- Bumped `agent-gov-core` to `^1.2.1` (the v0.7.0 caret pointed at an
  unpublished version and broke `npm ci`).

---

## Just shipped (v0.7.0 — Native Antigravity Session Tracking)

First-class support for Google DeepMind's Antigravity transcript format (`~/.gemini/antigravity/brain`). Integrates seamlessly with the thread-safe `agent-gov-core@1.2.0` substrate parser to provide fully aligned session tracking and live TUI verdict support.

- **Stateless Sequential `toolUseId` Linkage**: Uses the new threadable `activeToolCalls` parameter from the substrate parser to map Antigravity's asymmetrical `replace_file_content` $\leftrightarrow$ `REPLACE_FILE_CONTENT` tools sequentially while avoiding any module-level state.
- **Empty `assistant_message` Conditionally Pruned**: Automatically checks for empty planner responses and suppresses empty placeholder messages.
- **`CommandLine` $\to$ `command` Normalization**: Auto-translates Antigravity parameters inside `unwrapArgs` so that existing verifiers and checkers require zero modification downstream.
- **Cwd-level Path Resolution**: Scans early lines in the session JSONL to locate and extract `Cwd` / `DirectoryPath` / `SearchPath`, and populates the event-level `cwd` for robust drift and relative path analyses.
- **Exit Code Extraction**: Grounded parsing of the verified `RUN_COMMAND` exit-code shapes (failure, completed successfully, and status error).
- **Orphan Cleanup**: Integrates memory-safe cleanup inside `parseCache.ts` to prune active tool call mappings once their corresponding events fall out of the cache's active window.
- **Golden Integration scenario**: Added `antigravity-converging.jsonl` golden replay case to the test corpus to ensure regression protection.

---

## Just shipped (v0.6.2 — Codex inspection fixes)

External Codex review caught four real bugs the v0.6.1 corpus + property
tests missed (because the corpus was Claude Code-only). All four fixed:

- **Multi-runtime adapter drift** — Cursor's `path` + Codex's `shell` /
  `apply_patch` were silently misclassified. New `src/normalize.ts`
  centralizes the canonical-name + file-path extraction; threaded
  through enrich / sequences / trajectory.
- **Relative paths false-tripped outside-repo drift** — `src/foo.ts`
  Writes were flagged as drift because the comparison didn't resolve
  against `cwd`. Now does; absent cwd, defensively treats as inside.
- **Watcher-vs-discovery project name order** — watcher derived project
  name before extracting cwd, missing the date-slug fallback. Swapped.
- **`assets/dashboard.svg` missing from npm tarball** — README image
  broken on npmjs.com. Added to package.json `files` whitelist.

Plus cross-runtime corpus fixtures (`cursor-converging.jsonl`,
`codex-converging.jsonl`) to lock the gap closed permanently.

The headline lesson: **the v0.6.1 "regression armor" framing was generous
because the corpus was monoculture**. A six-fixture corpus that only
exercises one runtime catches one-runtime bugs. Future corpus growth
should consciously cover the multi-runtime cross-section.

---

## In flight (Unreleased — correctness + cleanup batch)

The cleanup batch from the post-v0.6.1 internal inspection. Originally
pencilled in as v0.7.1, but v0.7.1 went to the session-noise/naming work
instead (see above), so the batch slipped to the current Unreleased cycle.
Most of it has now landed on `main`:

- ✅ **`## [Unreleased]` header + convention note** in CHANGELOG.md,
  cross-linked to the new `docs/RELEASING.md`. *(item 1)*
- ✅ **`docs/RELEASING.md`** — substrate-first dual-publish order,
  `npm publish --access=public`, `scripts/backfill-releases.mjs` usage,
  and the action.yml version-lockstep (action ref reads its own
  `package.json`). *(item 2)*
- ✅ **`PulseOptions.events` marked `@internal`** — the orchestrator
  fast-path is the only validated use; library consumers shouldn't rely
  on it. *(item 5)*
- ✅ **Hysteresis confidence-vs-bucket** — `orchestrator.ts` now clamps
  confidence to `min(prior, raw)` when hysteresis overrides the bucket, so
  the pill never shows a number computed for a bucket it isn't displaying.
  *(item 4)*
- ✅ **Verification vocabulary deduped** — the verification-command list +
  pass/fail tables were three divergent copies across enrich / sequences /
  trajectory; now a single `src/verification.ts`. Locking the corpus
  `expectedSequence` field in surfaced a latent bug it also fixes:
  `stuck_loop` never fired on real transcripts because Layer 2.5 read exit
  codes off the `tool_use` instead of the linked `tool_result` (the same
  gap Layer 3 closed in v0.6.1).
- ◐ **Edge-case corpus fixtures + `expectedSequence` harness** *(item 3)* —
  the harness now accepts `expectedSequence` (and `stuck.jsonl` asserts
  `stuck_loop`); the `doc-edits-no-tests` and `ssh-keys-cwd` fixtures
  landed (corpus is at 13 scenarios). **Still open:** the mixed-runtime
  fixture (Cursor + Claude Code lines in one `.jsonl`).
- ☐ **Audit the three duplication sites** *(item 6)* — still a deliberate
  call, not yet made. The verification-vocab dedup above retired one *new*
  duplication; the original three remain:
  - `parseCache.ts` duplicating per-line dispatch from
    `agent-gov-core/parsers`.
  - `enqueueWrite` per-path write queue in `src/aliases.ts` and
    `src/exceptions.ts` (~15 lines each, identical shape).
  - "Skip exploration when looking for verification" in
    `src/sequences.ts:findNextVerificationIdx`.

  Options: (1) promote into the substrate — one release retires vendored
  code; (2) extract a local `src/util/` helper; (3) leave as-is —
  duplication is tolerable below five sites. Decision criterion: does
  SessionTrail (or another suite consumer) want the same primitive? If
  yes → substrate; if no → local extract or leave.

---

## Doing soon (post-v0.7.1)

Things that are clearly the next layer, but not blocking the current
release.

### Grow the corpus from real dogfooding surprises

Treat the corpus as a regression artifact, not an upfront test
budget. Every time a real session classifies unexpectedly:
1. Anonymize the transcript window (strip PII, rewrite paths)
2. Drop into `test/corpus/`
3. Add a manifest entry with the bucket you *expected*
4. Watch CI fail
5. Fix the classifier, watch CI pass

Goal: 20 scenarios by v0.8 (at 13 now, after the doc-edits + ssh-keys
adds). The growth rate matters more than the specific count.

Plus, as Antigravity session logs land, we plan to systematically grow the corpus to include the stuck/exploring/done/drifting variants of the Antigravity runtime, dogfooded natively in v0.8.0.

**v0.6.2 meta-lesson — corpus monoculture is a real risk.** The
original corpus (v0.6.1, six fixtures) was Claude Code-only and
shipped alongside 222 unit tests + property tests. A Codex external
inspection (no special tooling, just running the existing parser
fixture through `pulse()`) caught four bugs the test suite missed —
because the cross-runtime adapter surface was never exercised
end-to-end. v0.6.2 added `cursor-converging.jsonl` and
`codex-converging.jsonl`, but the broader job is to keep the
multi-runtime cross-section in mind for every new fixture: every
bucket × every runtime should eventually have a corpus entry.

### SVG hero re-shoot from real output

The current `assets/dashboard.svg` is hand-drawn. It looks polished
*because* it's a mockup — every glyph hand-positioned. A 80-column
terminal user won't see exactly this layout.

Options, ranked by credibility:
1. Use `ink-testing-library` to render the actual components to text,
   then wrap the text in an SVG with proper monospace styling.
   Maximum credibility, moderate effort. Output reflects real
   component changes automatically when components evolve.
2. Take a real screenshot from a fresh dogfood session. Maximum
   credibility, zero scripting effort, but tied to one specific
   terminal/font/theme.
3. Keep the mockup with a footer caption: *"mockup; layout varies by
   terminal width."* Honest, lowest effort.

Default to option 3 until option 1 is built. Option 2 is the
fallback when the mockup goes stale.

### README restructure

Front-loaded headline + table is strong. The middle (aliases,
exceptions, notifications, CI integration) reads like reference docs
jammed into the marketing page.

Move to `docs/`:
- Full alias details (storage paths, file format, lookup precedence)
- Exception baseline schema + the `a`-key flow
- Notifications full reference (modes, platform behaviour, limitations)
- Detailed CI integration (the YAML examples, the `action.yml` input
  table)

Leave in README:
- Headline + comparison table
- Quickstart `npx` command
- Short feature pills with links into `docs/` for depth
- Architecture table
- Hero image
- Suite cross-links

Target: README under 200 lines. Currently north of 250.

### Drift detector precision tracking

The third inspector's point: `drifting` is doing the most work and
got both the exception baseline and the two-stage confirm. That's a
tell that false positives are a real concern.

Without runtime ground truth, the best proxy is **rate of exception
baseline appends per session** — every `a`-key press is a developer
saying "this finding was wrong, suppress it." Track in a small
optional telemetry shape (local-only, no network), report in
`AGENTPULSE_PROFILE=1` mode:

```
[agentpulse:profile] drift fp-rate (last 7d): 0.4 appends/session
```

If that number creeps up over time, the detectors need tightening.
If it stays near zero, they're calibrated.

### Promote one or more duplications into agent-gov-core@1.2.0

Per the duplication audit (item 6 in the Unreleased batch). The likely
candidates:
- `enqueueWrite` — clear substrate primitive (per-path async write
  queue), useful for any tool persisting per-session state.
- Per-line transcript dispatch — already partially in substrate; the
  remaining piece is the orchestrator-shape `readWindowFromCache`
  could itself be promoted.

Conservative pick: promote `enqueueWrite` only. Per-line dispatch
stays as parseCache's incremental-friendly variant until a second
consumer needs it (with full promotion of the incremental tail-read engine targeted as the primary v0.8.0 cleanup).

---

## Watching (no commitment)

Direction calls, not promises. Re-evaluate when the situation calls
for them.

### Hybrid rule-tree + LLM narrative (opt-in)

The third reviewer's point: "No LLM" is both the differentiator and
the ceiling. Rule-tree templated narrative will plateau on nuance.
A hybrid (deterministic rule-tree verdict + opt-in LLM-richer
narrative) is where users will eventually pull.

This *deliberately* violates the current "no LLM, anywhere" rule.
Worth being clear-eyed:

- The verdict pipeline stays deterministic forever. That's the wedge.
- The *narrative* layer could become pluggable — local default
  (current behaviour), opt-in plugin that calls an LLM with the
  enriched window + verdict as input.
- Plugin would be a separate npm package (`@conalh/agentpulse-narrative-llm`
  or similar). AgentPulse core never gains an LLM dep.
- Users who pull would have to opt in twice: install the plugin AND
  pass an explicit flag. Defaults stay local-only-no-LLM forever.

Not on the menu for v0.7. On the menu when someone files a real
"narrative is too templated" complaint with examples.

### SessionTrail substrate adoption

Same parser-migration pattern AgentPulse just did. SessionTrail
still vendors its own copy of the transcript parser; the v1.1.0
substrate has been ready since AgentPulse v0.5.0.

Blocked on: SessionTrail's own release cadence + whatever bug
backlog it has. Worth a focused session whenever SessionTrail
needs a release for other reasons.

### `agent-gov-core` `shell.ts` / `toml.ts` work

There were uncommitted local mods in the agent-gov-core working tree
during the v1.1.0 release — 91 lines across `src/shell.ts`,
`src/toml.ts`, and their tests. Left alone so the parser-migration
commit stayed clean. They're probably the foundation for an
agent-gov-core@1.1.1 or @1.2.0; worth a look in a separate session.

### Cross-tool meta-analysis surface

AgentPulse + SessionTrail + GovVerdict all produce structured output.
A higher-level "session timeline" view that correlates them (e.g.
"AgentPulse said this session was drifting at the same time
SessionTrail flagged scope creep") would be a strong story.

This is suite-level work and belongs in `agent-gov-core` or a new
`agent-gov-meta` repo, not AgentPulse. Watching, not doing.

---

## Out of scope (and why)

Hard commitments. These are the guardrails that make the rest of the
positioning durable.

### No LLM in the verdict pipeline

Forever. The whole point is deterministic templating. Verdict A on
this transcript → verdict A again on the same transcript next year,
regardless of model availability or API drift.

(See "Hybrid rule-tree + LLM narrative" under Watching — the
narrative layer is the only place an LLM could possibly enter, and
only as an explicit opt-in plugin.)

### No outbound network calls in any default code path

Forever. The detectors look at the transcript bytes. The output
goes to stdout / a local file / a local OS notification. Nothing
leaves the machine without the user explicitly running a `gh` /
`curl` / `npm publish` themselves.

### No hosted dashboard

The whole point is the TUI lives next to your editor, not in a
browser tab on someone else's server. A hosted version would be a
different product.

### No multi-session memory

Each `pulse()` invocation is a fresh read of the window. No
"remember what happened in this session 3 hours ago" beyond what's
already in the transcript file.

This is a UX call as much as an engineering one — sessions die when
you close the terminal; AgentPulse's verdict dies with them.

### No "AI to review AI" loop

Detectors are deterministic rules. The trajectory classifier is a
rule tree. The narrative is templated. Nowhere in the pipeline does
one model judge another. That's the credibility story.

---

## Open inspection-derived items (longer arc)

From the four-way external inspection round, things the Unreleased
cleanup batch doesn't cover but are worth tracking:

- **The "agent-gov suite is ambitious surface" warning** — five repos
  with cross-version dependencies. The substrate split helps. Not
  urgent today, will bite around the time SessionTrail wants its own
  v1.0 release.

- **The README front-loading then density drop-off** — see "README
  restructure" under Doing soon.

- **Drift bucket false-positive concern** — see "Drift detector
  precision tracking" under Doing soon.

- **parseCache.ts substrate-dispatch duplication** — see "Audit the
  three duplication sites" (item 6) in the Unreleased batch.

- **Corpus sample size = 1** — see "Grow the corpus from real
  dogfooding surprises" under Doing soon. The framing "regression
  armor that already paid for itself" was generous for a six-fixture
  set; the framing earns its weight at ~20 fixtures.

- **Hero SVG is a mockup, not a screenshot** — see "SVG hero re-shoot"
  under Doing soon.

- ✅ **`scripts/backfill-releases.mjs` is undocumented** — now covered by
  `docs/RELEASING.md` (Unreleased batch).

- ✅ **CHANGELOG has no Unreleased header** — added in the Unreleased batch.

---

## How to use this doc

When picking up after a break: scan **In flight** for the open items in
the current batch, or **Doing soon** for the next layer; pick one, ship
it. Cross it off here in the same commit that lands the change.

When something genuinely new comes up: drop it into **Doing soon** if
it's the next layer, or **Watching** if it's direction without
commitment. **Out of scope** only grows via a deliberate "we
considered and rejected this" call — never as an accident.

When a release lands: the CHANGELOG entry tells *what* shipped. This
doc tells *what's next*. Keep them complementary, not redundant.
