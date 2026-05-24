# AgentPulse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Live trajectory verdict for AI coding agent sessions. Local-only. No LLM.**

![AgentPulse dashboard — seven sessions, one selected and reading converging](./assets/dashboard.svg)

AgentPulse watches your Claude Code, Cursor, and Codex transcript files and classifies what each agent is doing right now — `converging`, `exploring`, `stuck`, `done`, `drifting`, or `idle` — in a two-pane terminal dashboard. Deterministic templating over local signal. No outbound network calls, no language model, no cloud.

```sh
npx @conalh/agentpulse@latest live
```

That's the headline command. Drop it in a terminal window next to your editor and you get an always-on read on every session in `~/.claude/projects/`, `~/.cursor/projects/`, and `~/.codex/sessions/`.

Sample narrative on a converging session:

```
Your agent has been working on the login bug for 18 minutes. It focused
on `src/auth/`, made 3 changes to `session.ts`, and ran the tests after
each change. Tests went from failing to passing. Looks like it solved it.

Verdict: ● converging (confidence 0.85)
```

Part of the [agent-gov suite](https://github.com/Conalh/agent-gov-core).

## What makes it different

Several tools watch agent sessions. AgentPulse's wedge is the specific combination none of them cover:

| | Local-only | No LLM | Trajectory verdict | Per-session live dashboard | PR gate |
|---|---|---|---|---|---|
| LangSmith / Langfuse / AgentOps | ❌ cloud | ❌ LLM-judge | ❌ traces only | ⚠ | ⚠ |
| Claude Code Session Memory | ✅ | ❌ LLM | ⚠ structured | ❌ | ❌ |
| [agenttrace](https://github.com/luoyuctl/agenttrace) | ✅ | ✅ | ❌ metrics only | ⚠ TUI | ✅ |
| **AgentPulse** | ✅ | ✅ | ✅ | ✅ | ✅ |

The wedge is the combination. AgentPulse pairs naturally with agenttrace (which covers cost/health metrics) and with the rest of the [agent-gov suite](https://github.com/Conalh/agent-gov-core) (which covers PR-time gates).

## `agentpulse live` — the live dashboard

```sh
agentpulse live [options]
```

**Options:**

| Flag | Default | Effect |
| --- | --- | --- |
| `--window <duration>` | `20m` | Recap window per session (`5m`, `1h`, etc.) |
| `--refresh <duration>` | `30s` | Background refresh cadence. Watcher fires sub-second on file changes regardless. |
| `--roots <p1,p2,...>` | platform defaults | Override discovery roots (comma-separated) |
| `--stale <duration>` | `1h` | Skip sessions older than this |
| `--hide-idle` | off | Hide sessions with no activity in the window (default: visible, grey-dimmed) |
| `--max-sessions <N>` | `10` | Cap the displayed list |
| `--show-subagents` | off | Include `agent-<hex>` SDK-spawned subagent transcripts |
| `--no-detectors` | off | Skip the drifting bucket entirely |
| `--once` | off | Headless snapshot mode. Runs once, prints, exits. No TUI. (v0.4.0+) |
| `--format <fmt>` | `text` | With `--once`: `text` (human) or `json` (structured snapshot). (v0.4.0+) |
| `--strict` | off | With `--once`: exit 1 if any session is `drifting` or `stuck`. (v0.4.0+) |
| `--notify <mode>` | `none` | Local notification on transition INTO `drifting`/`stuck`. Modes: `none`, `bell`, `os`, `both`. (v0.4.2+) |

**Keyboard:**

| Key | Action |
| --- | --- |
| ↑ ↓ / k j / w s | Move selection |
| r | Force refresh on selected session |
| **a** | **Whitelist current session's drift findings** — first press shows preview, second press within 3s commits (v0.4.1+, two-stage in v0.4.8+) |
| **n** | **Name / rename the selected session** (alias) (v0.4.7+) |
| ? | Toggle help overlay |
| q / Ctrl-C | Quit |

**Verdict pills:**

| Pill | Meaning |
| --- | --- |
| ● green converging | Actively editing with focus, often with verification |
| ◐ gray exploring | Reading around, no edits yet |
| ▲ yellow stuck | Edits + tests failing + user pushing back |
| ■ blue done | Completion verb + idle gap |
| ⚠ red drifting | Privileged-path access, network exec, or write outside repo |
| ○ gray idle | Window had activity earlier OR is silent; agent is parked |

## Agent aliases (v0.4.7+)

When multiple agents work on the same project — say two Claude Code windows + a Cursor + a Codex — the dashboard rows look identical until you name them. Press `n` on a selected row to drop into rename mode, type whatever helps you tell them apart (`CC1`, `CC2`, `frontend`, `backend`), and press Enter. The alias appears in front of the project name (`CC1 · AgentPulse (claude-code)`) and replaces the auto-generated hex disambiguator.

Aliases live in two optional JSON files (cwd wins over home):

- **`<session.cwd>/.agentpulse-aliases.json`** — per-project, commit alongside `.agentpulse-exceptions.json` if you want team-shared conventions.
- **`~/.agentpulse/aliases.json`** — your personal default, persists across machines if you sync your home dir.

`n`-then-Enter writes to the home file by default; promoting an alias to the shared per-project file is a manual copy/paste — intentional, so a shared file never gets written without you knowing.

Empty + Enter clears the alias.

```json
{
  "version": 1,
  "aliases": {
    "c3d4566ef4c5": "CC1",
    "7a8b91234567": "CG1"
  }
}
```

## Exception baseline (v0.4.1+)

Press `a` on a `drifting` session to surface a **whitelist preview** in the footer — kind summary, count, 3-second confirmation window. Press `a` again within the window to commit; any other key cancels. AgentPulse appends the previewed fingerprints to `<session.cwd>/.agentpulse-exceptions.json`, refreshes the session, and the verdict re-classifies away from `drifting` instantly.

The two-stage confirm (v0.4.8+) protects against a stray keypress permanently whitelisting findings the user couldn't see clearly. The captured drift set is the one written — a refresh during the 3-second window can't slip new findings into the commit silently.

The exception file is a simple JSON list keyed by stable `Finding.fingerprint`:

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

Commit it to your repo. CI gating (`agentpulse live --once --strict` or the GitHub Action) honors the same baseline — the trajectory layer reads it the same way the TUI does.

## Notifications (v0.4.2+)

`--notify <mode>` fires a local notification when any session transitions INTO `drifting` or `stuck`. Useful when you're not actively staring at the TUI.

| Mode | Effect |
| --- | --- |
| `none` (default) | Silent |
| `bell` | Writes `\x07` to stderr (terminal beep) |
| `os` | Native notification — `osascript` on macOS, `notify-send` on Linux, BurntToast/NotifyIcon on Windows |
| `both` | Bell + OS |

Trigger policy: fires only on safe-to-alert transitions. `converging → drifting` fires; `drifting → drifting` doesn't (no double-alert); `drifting → idle` doesn't (clearing is silent).

Best-effort: a missing `notify-send` on Linux, or a stripped-down Windows env, is a silent no-op rather than a crash.

## CI integration

Two ways to gate a pipeline on agent state:

### GitHub Action (v0.4.2+)

```yaml
- uses: Conalh/AgentPulse@v0.6.1
  with:
    transcript-dirs: agentpulse-transcripts
    strict: 'true'
    comment-on-pr: 'true'
```

The action runs `agentpulse live --once` against the provided transcript directory, emits a markdown summary to the GitHub step summary, optionally posts a sticky PR comment that updates in place across pushes, and (with `strict: true`) fails the workflow when any session is in `drifting` or `stuck`. Full input/output reference in [`action.yml`](./action.yml); a complete PR-check workflow at [`examples/agentpulse-pr-check.yml`](./examples/agentpulse-pr-check.yml).

### Raw CLI (any CI)

If you're not on GitHub Actions:

```sh
npx @conalh/agentpulse@latest live --once --strict --roots <transcript-dir>
```

Exits 1 if any session is `drifting`/`stuck`. Add `--format json` to pipe a structured snapshot into downstream tools.

### Exception baseline in CI

Commit `.agentpulse-exceptions.json` to your repo — both the Action and the raw CLI read it from the session's cwd. A finding whitelisted via the TUI's `a` key locally stops gating CI too.

## `agentpulse recap` — single-transcript mode

For piping a single transcript into scripts or dashboards (vs. the multi-session discovery the `live` subcommand does):

```sh
agentpulse recap --transcript-dir ~/.claude/projects/<your-project>/ --format json
```

Same pipeline, narrower input. Use `--watch` for a polling re-emit loop.

## What's intentionally NOT in scope

- **No LLM, anywhere.** Not for summarization, not for classification. The whole point is determinism.
- **No outbound network calls.** Reads your local transcript files, writes to your terminal (and optionally the local OS notifier). Nothing leaves the machine.
- **No web UI / hosted dashboard.** TUI for the live view, GitHub Action for PRs, JSON output for everything else. Nothing hosted.
- **No multi-session memory.** Each invocation reads the window and exits.
- **No "AI to review AI" loop.** Detectors are deterministic. The trajectory classifier is a rule tree, not a model.

## Architecture

Deterministic pipeline. Each layer is pure where it can be; all layers share the `src/types.ts` contract.

| Layer | File | Input → Output |
| --- | --- | --- |
| 1. Parser | `agent-gov-core/parsers/` (v1.1.0+) | Claude Code / Cursor / Codex JSONL → `TranscriptEvent[]` |
| 2. Enrichment | `src/enrich.ts` | events → keywords, cwd-relative path clusters, action classes |
| 2.5. Sequences | `src/sequences.ts` | events → ordered-pattern signal (`tdd_loop` / `stuck_loop` / `refuse_to_verify` / `exploratory_edit`) |
| 3. Outcome | `src/trajectory.ts` | events → verification trend, user tone, completion verbs, idle gap |
| 4. Trajectory | `src/trajectory.ts` | enrichment + outcome + sequence + exceptions → six-bucket verdict |
| 5. Narrative | `src/narrative.ts` | verdict → plain-English recap |

Live infrastructure on top:

- `src/sessions/` — auto-discovery + filesystem watcher
- `src/orchestrator.ts` — multi-session pulse runner with concurrent-refresh coalescing
- `src/exceptions.ts` — `.agentpulse-exceptions.json` reader/writer (v0.4.1+)
- `src/notifications.ts` — bell + cross-platform OS notifications on state transitions (v0.4.2+)
- `src/once.ts` — headless `--once` runner for CI (v0.4.0+)
- `src/tui/` — Ink TUI components

## Principles

- **Local by default.** Zero network calls in any code path.
- **Deterministic.** Same transcript window in, same verdict out. No model drift, no API outages, no rate limits.
- **MIT.** No telemetry. No commercial offering.
- **Substrate-built.** Wires [`agent-gov-core`](https://github.com/Conalh/agent-gov-core) primitives where the contract overlaps. The Layer 1 transcript parser lives in `agent-gov-core@1.1.0+` (promoted out of AgentPulse v0.5.0 — see CHANGELOG); the Finding schema and detector library follow the same pattern.

## Windows terminal note

If you're running on Windows, prefer **Windows Terminal** over the legacy cmd.exe. cmd.exe has known ANSI limitations that this project routes around (the alt-screen-buffer fix in v0.2.8 was specifically for cmd.exe). It works on cmd.exe, but Windows Terminal renders the dashboard more cleanly.

## Used with

- [agent-gov-core](https://github.com/Conalh/agent-gov-core) — the substrate (Finding schema, fingerprint, MCP canonical normalization)
- [SessionTrail](https://github.com/Conalh/SessionTrail) — PR-time runtime-behavior review. AgentPulse is the live-view sibling.
- [GovVerdict](https://github.com/Conalh/GovVerdict) — cross-tool meta-reviewer. AgentPulse verdicts can roll up.

## License

MIT.
