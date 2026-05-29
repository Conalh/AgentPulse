# AgentPulse

[![npm version](https://img.shields.io/npm/v/@conalh/agentpulse?color=7dcfff)](https://www.npmjs.com/package/@conalh/agentpulse)
[![CI](https://github.com/Conalh/AgentPulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Conalh/AgentPulse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-7dcfff)](#)
[![Cursor](https://img.shields.io/badge/Cursor-supported-7dcfff)](#)
[![Codex](https://img.shields.io/badge/Codex-supported-7dcfff)](#)
[![No LLM](https://img.shields.io/badge/no_LLM-deterministic-9ece6a)](#)
[![Local-only](https://img.shields.io/badge/local--only-no_network-9ece6a)](#)

**A live trajectory dashboard for AI coding agent sessions.** AgentPulse watches local Claude Code, Cursor, and Codex transcripts and classifies what each agent is doing right now: `converging`, `exploring`, `stuck`, `done`, `drifting`, or `idle`.

![AgentPulse dashboard — a selected session cycles through converging, stuck, and drifting verdicts in real time](./assets/demo.svg)

Drop it in a terminal next to your editor. You get an always-on read across local agent sessions without a model judge, hosted dashboard, telemetry, or outbound network calls.

```sh
npx @conalh/agentpulse@latest live
```

```mermaid
flowchart LR
    Claude["Claude Code<br/>transcripts"] --> Pulse
    Cursor["Cursor<br/>transcripts"] --> Pulse
    Codex["Codex<br/>sessions"] --> Pulse
    Pulse[("AgentPulse<br/>local trajectory classifier")] --> TUI["Live TUI<br/>verdict + narrative"]
    Pulse --> CI["CI snapshot<br/>--once --strict"]
    TUI --> User["Human sees<br/>converging · stuck · drifting"]

    classDef input fill:#1e293b,stroke:#334155,color:#e2e8f0
    classDef engine fill:#0f172a,stroke:#1e293b,color:#e2e8f0,stroke-width:2px
    classDef output fill:#0c4a6e,stroke:#0369a1,color:#e0f2fe
    class Claude,Cursor,Codex input
    class Pulse engine
    class TUI,CI,User output
```

Sample narrative on a converging session:

```
Your agent has been working on the login bug for 18 minutes. It focused
on `src/auth/`, made 3 changes to `session.ts`, and ran the tests after
each change. Tests went from failing to passing. Looks like it solved it.

Verdict: ● converging (confidence 0.85)
```

**See also:** [SessionTrail](https://github.com/Conalh/SessionTrail) for PR-time runtime-behavior review · [GovVerdict](https://github.com/Conalh/GovVerdict) for cross-tool rollups · [agent-gov-core](https://github.com/Conalh/agent-gov-core) for shared transcript/report primitives.

## Why this exists

AI agents can run for a long time while the human is not staring at every tool call. Sometimes they converge. Sometimes they explore. Sometimes they get stuck in the same failed loop. Sometimes they drift into privileged paths, network execution, or writes outside the repo.

AgentPulse exists to make that session state visible while the work is happening. It is deterministic local signal, not an LLM judging another LLM.

## What it shows

| Signal | What it means |
| --- | --- |
| **converging** | Focused edits plus verification, often with tests moving toward passing. |
| **exploring** | Reading and orientation, no meaningful edit trajectory yet. |
| **stuck** | Repeated edits/tests/failures, user pushback, or loop-like behavior. |
| **done** | Completion language plus idle gap. |
| **drifting** | Privileged-path access, network execution, or write outside repo. |
| **idle** | Activity has gone quiet or the window had no recent movement. |

## What makes it different

Several tools watch agent sessions. AgentPulse's wedge is the specific combination none of them cover:

| | Local-only | No LLM | Trajectory verdict | Per-session live dashboard | PR gate |
|---|---|---|---|---|---|
| LangSmith / Langfuse / AgentOps | ❌ cloud | ❌ LLM-judge | ❌ traces only | ⚠ | ⚠ |
| Claude Code Session Memory | ✅ | ❌ LLM | ⚠ structured | ❌ | ❌ |
| [agenttrace](https://github.com/luoyuctl/agenttrace) | ✅ | ✅ | ❌ metrics only | ⚠ TUI | ✅ |
| **AgentPulse** | ✅ | ✅ | ✅ | ✅ | ✅ |

The wedge is the combination. AgentPulse pairs naturally with agenttrace for cost/health metrics and with the rest of the agent-gov suite for PR-time gates.

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
| `--hide-idle` | off | Hide sessions with no activity in the window |
| `--max-sessions <N>` | `10` | Cap the displayed list |
| `--show-subagents` | off | Include `agent-<hex>` SDK-spawned subagent transcripts |
| `--no-detectors` | off | Skip the drifting bucket entirely |
| `--once` | off | Headless snapshot mode. Runs once, prints, exits. |
| `--format <fmt>` | `text` | With `--once`: `text` or `json`. |
| `--strict` | off | With `--once`: exit 1 if any session is `drifting` or `stuck`. |
| `--notify <mode>` | `none` | Local notification on transition into `drifting`/`stuck`: `none`, `bell`, `os`, `both`. |

**Keyboard:**

| Key | Action |
| --- | --- |
| ↑ ↓ / k j / w s | Move selection |
| r | Force refresh on selected session |
| a | Whitelist current session's drift findings; preview first, confirm within 3s |
| n | Name / rename the selected session alias |
| ? | Toggle help overlay |
| q / Ctrl-C | Quit |

## Agent aliases

When multiple agents work on the same project, the dashboard rows can look identical until you name them. Press `n` on a selected row, type an alias like `CC1`, `frontend`, or `backend`, and press Enter.

Aliases live in two optional JSON files:

- `<session.cwd>/.agentpulse-aliases.json` — per-project, commit if you want team-shared conventions.
- `~/.agentpulse/aliases.json` — personal default.

```json
{
  "version": 1,
  "aliases": {
    "c3d4566ef4c5": "CC1",
    "7a8b91234567": "CG1"
  }
}
```

## Exception baseline

Press `a` on a `drifting` session to preview the drift findings, then press `a` again within the confirmation window to append the selected fingerprints to `<session.cwd>/.agentpulse-exceptions.json`. AgentPulse refreshes and re-classifies the session immediately.

Commit the exception file to your repo when the behavior is intentionally approved. CI gating (`agentpulse live --once --strict` or the GitHub Action) honors the same baseline.

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

## Notifications

`--notify <mode>` fires a local notification when any session transitions into `drifting` or `stuck`.

| Mode | Effect |
| --- | --- |
| `none` | Silent |
| `bell` | Writes `\x07` to stderr |
| `os` | Native notification: `osascript` on macOS, `notify-send` on Linux, BurntToast/NotifyIcon on Windows |
| `both` | Bell + OS |

Best-effort: missing OS notification utilities are a silent no-op rather than a crash.

## CI integration

### GitHub Action

```yaml
- uses: Conalh/AgentPulse@v0.7.3
  with:
    transcript-dirs: agentpulse-transcripts
    strict: 'true'
    comment-on-pr: 'true'
```

The action runs `agentpulse live --once` against the provided transcript directory, writes a markdown summary to the GitHub step summary, optionally posts a sticky PR comment, and fails the workflow when `strict: true` and any session is `drifting` or `stuck`.

### Raw CLI

```sh
npx @conalh/agentpulse@latest live --once --strict --roots <transcript-dir>
```

Add `--format json` to pipe a structured snapshot into downstream tools.

## `agentpulse recap` — single-transcript mode

```sh
agentpulse recap --transcript-dir ~/.claude/projects/<your-project>/ --format json
```

Same pipeline, narrower input. Use `--watch` for a polling re-emit loop.

## What's intentionally not in scope

- **No LLM, anywhere.** Not for summarization, not for classification.
- **No outbound network calls.** Reads local transcript files, writes to terminal and optional local notifier.
- **No web UI / hosted dashboard.** TUI for live view, GitHub Action for PRs, JSON output for everything else.
- **No multi-session memory.** Each invocation reads the window and exits.
- **No “AI to review AI” loop.** Detectors are deterministic.

## Architecture

Deterministic pipeline. Each layer is pure where it can be; all layers share the `src/types.ts` contract.

| Layer | File | Input -> Output |
| --- | --- | --- |
| 1. Parser | `agent-gov-core/parsers/` (v1.1.0+) | Claude Code / Cursor / Codex / Antigravity JSONL -> `TranscriptEvent[]` |
| 2. Enrichment | `src/enrich.ts` | events -> keywords, cwd-relative path clusters, action classes |
| 2.5. Sequences | `src/sequences.ts` | events -> ordered-pattern signal (`tdd_loop` / `stuck_loop` / `refuse_to_verify` / `exploratory_edit`) |
| 3. Outcome | `src/trajectory.ts` | events -> verification trend, user tone, completion verbs, idle gap |
| 4. Trajectory | `src/trajectory.ts` | enrichment + outcome + sequence + exceptions -> six-bucket verdict |
| 5. Narrative | `src/narrative.ts` | verdict -> plain-English recap |

Live infrastructure on top: `src/sessions/` discovery/watcher, `src/orchestrator.ts`, `src/exceptions.ts`, `src/notifications.ts`, `src/once.ts`, and `src/tui/`.

## Design choices worth flagging

- **Local by default.** Zero network calls in any code path.
- **Deterministic.** Same transcript window in, same verdict out. No model drift, API outages, or rate limits.
- **Live sibling to SessionTrail.** AgentPulse is for watching now; SessionTrail is for PR-time transcript review.
- **Substrate-built.** Uses [`agent-gov-core`](https://github.com/Conalh/agent-gov-core) primitives where the contract overlaps.
- **Tested.** 245 tests (`npm test`), including hand-rolled **property tests** (a seeded, replayable PRNG, 200 iterations per invariant, no `fast-check` dependency) over the pure classifier layers, and a **labeled golden-replay corpus** — 13 transcript fixtures pinning all six trajectory buckets across the Claude Code, Cursor, Codex, and Antigravity runtimes, so a rule-tree tweak that flips a verdict is caught in CI.

## Windows terminal note

If you're running on Windows, prefer **Windows Terminal** over legacy cmd.exe. It works on cmd.exe, but Windows Terminal renders the dashboard more cleanly.

## Part of the agent-gov suite

| Repo | What it catches |
| --- | --- |
| [ScopeTrail](https://github.com/Conalh/ScopeTrail) | Agent config drift between PR base and head. |
| [PolicyMesh](https://github.com/Conalh/PolicyMesh) | Contradictory agent instructions and config drift that make behavior non-reproducible. |
| [CapabilityEcho](https://github.com/Conalh/CapabilityEcho) | Capability drift introduced by code, manifests, workflows, and Dockerfiles. |
| [TaskBound](https://github.com/Conalh/TaskBound) | Scope creep between the stated task and the actual diff. |
| [SessionTrail](https://github.com/Conalh/SessionTrail) | Risky runtime behavior in Cursor / Claude Code / Codex session transcripts. |
| **AgentPulse** *(this repo)* | Live local trajectory verdicts for active agent sessions. |
| [GovVerdict](https://github.com/Conalh/GovVerdict) | Merges JSON reports from the tools above into one deduped review. |
| [agent-gov-core](https://github.com/Conalh/agent-gov-core) | Shared parsers, the canonical `Finding` schema, and `mergeFindings`. |

MIT.
