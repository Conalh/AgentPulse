# AgentPulse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Live trajectory verdict for AI coding agent sessions. Local-only. No LLM.**

AgentPulse reads Claude Code, Cursor, and Codex transcripts from your machine, classifies what the agent is doing (`Converging` / `Exploring` / `Stuck` / `Done` / `Drifting`), and renders it as plain English. Designed to run on a rolling window so you can answer "what is my agent up to right now" in one glance, without trusting a cloud service or a language model to summarize it for you.

```
Your agent has been working on the login bug for 18 minutes.
It focused on src/auth/, made 3 changes to session.ts, and ran the
auth tests after each change. Tests went from failing to passing.
Looks like it solved it.

Verdict: converging (high confidence)
```

Part of the [agent-gov suite](https://github.com/Conalh/agent-gov-core).

## What makes it different

There are excellent tools for AI session observability — [agenttrace](https://github.com/luoyuctl/agenttrace) does deterministic local metrics, [LangSmith](https://smith.langchain.com/) / [Langfuse](https://langfuse.com/) / [AgentOps](https://www.agentops.ai/) do production-grade tracing, and Claude Code itself ships [Session Memory](https://docs.anthropic.com/) for in-app summaries. AgentPulse fills one specific gap none of them cover:

| | Local-only | No LLM | Trajectory verdict | Suite-integrated drift | PR gate |
|---|---|---|---|---|---|
| LangSmith / Langfuse / AgentOps | ❌ cloud | ❌ LLM-judge | ❌ traces only | ❌ | ⚠ |
| Claude Session Memory | ✅ | ❌ LLM | ⚠ structured | ❌ | ❌ |
| agenttrace | ✅ | ✅ | ❌ metrics only | ❌ | ✅ |
| **AgentPulse** | ✅ | ✅ | ✅ | ✅ | ✅ |

The wedge is the combination, not any single column. AgentPulse pairs naturally with agenttrace (metrics + health) and with the rest of the agent-gov suite (PR-time gates) to give a full picture.

## What it does (in one paragraph)

A deterministic, no-LLM templater that takes the last N minutes of an agent's transcript, extracts keywords from the user's own messages (the semantic anchor), clusters file paths by directory, classifies tool invocations into action classes (exploration / editing / verification / external / navigation), detects sequence patterns over time (`read-read-read-edit-test` = exploratory edit; `edit-test-edit-test` = TDD; many-edits-no-tests = risky), reads outcome signals (test exit codes, user-tone tokens, idle gap), and emits a five-bucket trajectory verdict plus a plain-English recap. When the suite's existing detectors fire on the windowed events (`session_trail.privileged_path_access`, etc.), the bucket flips to `drifting` — the trajectory is "the agent is doing work, but it's wandering into stuff it shouldn't."

## Install

```sh
npm install agentpulse
# or run directly via npx, no install required
npx agentpulse@latest recap --transcript-dir ~/.claude/projects/<your-project>/ --window 20m
```

## CLI

```
agentpulse recap --transcript-dir <path> [options]

  --transcript-dir <path>   Directory of transcript JSONL files (required).
  --window <duration>       Rolling window. Default: 20m. Accepts 5m, 1h, 30s.
  --watch                   Re-emit the recap on a fixed cadence.
  --watch-interval <dur>    How often to re-emit in watch mode. Default: 30s.
  --repo <path>             Repository root, for drift detection. Default: cwd.
  --no-detectors            Skip the drift bucket entirely (no suite detectors).
  --format <fmt>            Output format: text (default), json.
  --output <path>           Write to file instead of stdout.
```

## What's intentionally NOT in scope

- **No LLM, anywhere.** Not for summarization, not for classification, not optional. The whole point is determinism.
- **No outbound network calls.** Reads your local transcript files, writes to your terminal. That's it.
- **No web UI / dashboard.** CLI first, possibly an Action for posting verdicts to PR comments later. Nothing hosted.
- **No risky-pattern detection beyond what already lives in [SessionTrail](https://github.com/Conalh/SessionTrail).** AgentPulse leverages SessionTrail's detectors for the `drifting` bucket but doesn't reinvent them.
- **No multi-session memory.** Each invocation reads the window and exits. State lives on disk in the transcript files.

## Principles

- **Local by default.** Zero network calls in any code path. Verified by the substrate's ReDoS / no-outbound test harness.
- **Deterministic.** Same transcript window in, same verdict out. No model drift, no API outages, no rate limits.
- **MIT.** No telemetry. No commercial offering.
- **Substrate-built.** Wires [`agent-gov-core`](https://github.com/Conalh/agent-gov-core) primitives (`Finding`, fingerprint, MCP canonical) for the drift bucket. No reinvention.

## Used with

- [agent-gov-core](https://github.com/Conalh/agent-gov-core) — the substrate (Finding schema, fingerprint, MCP canonical normalization)
- [SessionTrail](https://github.com/Conalh/SessionTrail) — PR-time runtime-behavior review. AgentPulse is the live-view sibling.
- [GovVerdict](https://github.com/Conalh/GovVerdict) — cross-tool meta-reviewer. AgentPulse verdicts can roll up.

## License

MIT.
