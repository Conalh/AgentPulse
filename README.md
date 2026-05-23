# AgentPulse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Live trajectory verdict for AI coding agent sessions. Local-only. No LLM.**

AgentPulse watches your Claude Code, Cursor, and Codex transcript files and classifies what each agent is doing right now — `converging`, `exploring`, `stuck`, `done`, `drifting`, or `idle` — in a two-pane terminal dashboard. Deterministic templating over local signal. No outbound network calls, no language model, no cloud.

```sh
npx agentpulse@latest live
```

That's the headline command. Drop it in a terminal window next to your editor and you get an always-on read on every session in `~/.claude/projects/`, `~/.cursor/projects/`, and `~/.codex/sessions/`.

Sample readout:

```
Your agent has been working on the login bug for 18 minutes. It focused
on `src/auth/`, made 3 changes to `session.ts`, and ran the tests after
each change. Tests went from failing to passing. Looks like it solved it.

Verdict: ● converging (confidence 0.85)
```

Part of the [agent-gov suite](https://github.com/Conalh/agent-gov-core).

## What makes it different

Several tools watch agent sessions. AgentPulse's wedge is the specific combination none of them cover:

| | Local-only | No LLM | Trajectory verdict | Per-session live dashboard | PR gate (planned) |
|---|---|---|---|---|---|
| LangSmith / Langfuse / AgentOps | ❌ cloud | ❌ LLM-judge | ❌ traces only | ⚠ | ⚠ |
| Claude Code Session Memory | ✅ | ❌ LLM | ⚠ structured | ❌ | ❌ |
| [agenttrace](https://github.com/luoyuctl/agenttrace) | ✅ | ✅ | ❌ metrics only | ⚠ TUI | ✅ |
| **AgentPulse** | ✅ | ✅ | ✅ | ✅ | 🚧 v0.4 |

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

**Keyboard:**

| Key | Action |
| --- | --- |
| ↑ ↓ / k j / w s | Move selection |
| r | Force refresh on selected session |
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

## GitHub Action (v0.4.2+)

Drop AgentPulse into a pull-request workflow to gate the build on `drifting` / `stuck` sessions:

```yaml
- uses: Conalh/AgentPulse@v0.4.2
  with:
    transcript-dirs: agentpulse-transcripts
    strict: 'true'
    comment-on-pr: 'true'
```

The action runs `agentpulse live --once` against the provided transcript directory, emits a markdown summary to the GitHub step summary, optionally posts a sticky PR comment, and (with `strict: true`) fails the workflow when any session is in `drifting` or `stuck`. Full input / output reference and an example PR-check workflow live in [`action.yml`](./action.yml) and [`examples/agentpulse-pr-check.yml`](./examples/agentpulse-pr-check.yml).

## `agentpulse recap` — one-shot mode

For piping into scripts, CI, or your own dashboards:

```sh
agentpulse recap --transcript-dir ~/.claude/projects/<your-project>/ --format json
```

Same pipeline as `live`, but exits after one run. Use `--watch` for a polling re-emit loop (text or NDJSON).

## What's intentionally NOT in scope

- **No LLM, anywhere.** Not for summarization, not for classification. The whole point is determinism.
- **No outbound network calls.** Reads your local transcript files, writes to your terminal. That's it.
- **No web UI / dashboard.** TUI first, possibly a GitHub Action for PR comments later (v0.4). Nothing hosted.
- **No multi-session memory.** Each invocation reads the window and exits.

## Architecture

Five-layer deterministic pipeline. Each layer is pure where it can be; all layers share the `src/types.ts` contract.

| Layer | File | Input → Output |
| --- | --- | --- |
| Parser | `src/parser.ts` | Claude Code / Cursor / Codex JSONL → `TranscriptEvent[]` |
| Enrichment | `src/enrich.ts` | events → keywords, cwd-relative path clusters, action classes |
| Outcome | `src/trajectory.ts` | events → verification trend, user tone, completion verbs, idle gap |
| Trajectory | `src/trajectory.ts` | enrichment + outcome → six-bucket verdict |
| Narrative | `src/narrative.ts` | verdict → plain-English recap |

Live infrastructure on top:

- `src/sessions/` — auto-discovery + filesystem watcher
- `src/orchestrator.ts` — multi-session pulse runner with concurrent-refresh coalescing
- `src/tui/` — Ink TUI components

## Principles

- **Local by default.** Zero network calls in any code path.
- **Deterministic.** Same transcript window in, same verdict out. No model drift, no API outages, no rate limits.
- **MIT.** No telemetry. No commercial offering.
- **Substrate-built.** Wires [`agent-gov-core`](https://github.com/Conalh/agent-gov-core) primitives where the contract overlaps. The substrate's parser, Finding schema, and detector library are the eventual home for code currently vendored here (see `CHANGELOG.md` for the v0.2/v1.1 cleanup path).

## Windows terminal note

If you're running on Windows, prefer **Windows Terminal** over the legacy cmd.exe. cmd.exe has known ANSI limitations that this project routes around (the alt-screen-buffer fix in v0.2.8 was specifically for cmd.exe). It works on cmd.exe, but Windows Terminal renders the dashboard more cleanly.

## Used with

- [agent-gov-core](https://github.com/Conalh/agent-gov-core) — the substrate (Finding schema, fingerprint, MCP canonical normalization)
- [SessionTrail](https://github.com/Conalh/SessionTrail) — PR-time runtime-behavior review. AgentPulse is the live-view sibling.
- [GovVerdict](https://github.com/Conalh/GovVerdict) — cross-tool meta-reviewer. AgentPulse verdicts can roll up.

## License

MIT.
