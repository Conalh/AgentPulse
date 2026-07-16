# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[**Report a vulnerability**](https://github.com/Conalh/AgentPulse/security/advisories/new)
flow rather than opening a public issue. I'll acknowledge the report and work
with you on a fix and coordinated disclosure.

## Supported versions

Fixes land on the latest published version. Pin a release tag
(`Conalh/AgentPulse@vX.Y.Z`) in CI and bump deliberately; the npm `latest`
dist-tag always points at the newest release.

## Security posture

The AgentPulse CLI and library are designed to have a small attack surface:

- **No application-level outbound network calls.** After installation, the CLI
  reads local transcript files and writes to the terminal. The composite GitHub
  Action checks out the user-selected git ref, installs its lockfile-pinned
  dependencies from npm with lifecycle scripts disabled, builds that source,
  and runs the resulting CLI.
- **No LLM**, no cloud, no telemetry. Classification is deterministic and runs
  entirely on your machine.
- **Reads transcripts read-only.** The only files it writes are the optional,
  user-triggered alias and exception baselines (`.agentpulse-aliases.json`,
  `.agentpulse-exceptions.json`) and an optional local OS notification.
- **Symlinks are not followed** during session discovery, to avoid escaping the
  configured roots.

Hosted workflow output persists beyond the job. The Action redacts paths by
default in v0.8.1 and later; use `redact: all` when project labels, narratives,
or topic keywords may also be sensitive. Never publish raw transcript artifacts
unless they have been reviewed and intentionally declassified.

Transcript content is treated as untrusted data: it is parsed and classified,
never executed. If you find a path where transcript input can cause AgentPulse
to execute code, write outside the intended baseline files, or make a network
request, that is a vulnerability — please report it.
