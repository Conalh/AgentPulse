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

AgentPulse is designed to have a small attack surface:

- **No outbound network calls** in any code path. It reads local transcript
  files and writes to the terminal.
- **No LLM**, no cloud, no telemetry. Classification is deterministic and runs
  entirely on your machine.
- **Reads transcripts read-only.** The only files it writes are the optional,
  user-triggered alias and exception baselines (`.agentpulse-aliases.json`,
  `.agentpulse-exceptions.json`) and an optional local OS notification.
- **Symlinks are not followed** during session discovery, to avoid escaping the
  configured roots.

Transcript content is treated as untrusted data: it is parsed and classified,
never executed. If you find a path where transcript input can cause AgentPulse
to execute code, write outside the intended baseline files, or make a network
request, that is a vulnerability — please report it.
