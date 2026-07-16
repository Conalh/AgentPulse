# AgentPulse roadmap

Last updated: 2026-07-16

AgentPulse is a deterministic, local-first trajectory monitor for AI coding
sessions. The roadmap favors classifier accuracy, privacy, and reproducible
automation over hosted features or model-generated judgments.

## Delivered through v0.8.1

- Live terminal dashboard and one-shot text/JSON reporting.
- Claude Code, Cursor, Codex, Codex desktop, and Antigravity transcript support.
- Six trajectory buckets with human-readable evidence and confidence.
- Incremental transcript parsing, bounded discovery, session aliases, exception
  baselines, transition notifications, and deterministic hysteresis.
- Drift rules for privileged paths, shell-piped network fetches, and writes
  outside the repository root, with the detector limits stated explicitly.
- GitHub Action gating with fail-closed analysis errors, optional sticky PR
  comments, and path-redacted hosted output by default.
- Cross-platform Node 22/24 CI, 296 tests, property checks, and a labeled replay
  corpus covering every trajectory bucket.

## Next

- Expand the replay corpus across every supported runtime and include more
  mixed-runtime, malformed-input, and large-session fixtures.
- Improve shell coverage for PowerShell download-and-execute patterns and
  nested interpreter forms without weakening false-positive controls.
- Add npm provenance and a release-time package smoke workflow once trusted
  publishing is configured for the package.
- Add repeatable performance fixtures for discovery, incremental parsing, and
  terminal refresh behavior on large transcript sets.
- Publish a stable JSON schema for one-shot reports before declaring a 1.0 API.

## Later, only with a separate design

- New trajectory buckets or breaking changes to existing bucket semantics.
- Additional transcript runtimes that do not expose enough structured evidence
  for deterministic classification.
- Broader security detectors beyond the three documented rule families.

## Non-goals

- LLM-based classification or summarization.
- A hosted dashboard, telemetry service, or cloud transcript store.
- Executing transcript content or automatically taking control of an agent.
- Claiming that a clean result proves a session is safe.
