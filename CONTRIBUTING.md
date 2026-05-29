# Contributing

Thanks for your interest in AgentPulse. It's a small, deterministic TypeScript
project — contributions that keep it that way are very welcome.

## Setup

Requires Node `>=20`.

```sh
npm ci
npm run build   # tsc -> dist/
npm test        # build + node --test (full suite)
```

`npm test` runs the build first, so a type error fails the suite. The dist
binary is also smoke-tested in CI (`node dist/cli.js --help`).

## Invariants to preserve

These are load-bearing design constraints, not preferences. A PR that breaks one
will be sent back:

- **No LLM.** Classification is rule-based and deterministic. Same transcript
  window in, same verdict out.
- **No outbound network calls** in any code path.
- **No new runtime dependencies** without a clear reason — the dependency list
  is intentionally tiny.
- **Cross-platform.** Windows is a first-class target (much of the changelog is
  Windows path/terminal fixes). CI runs Ubuntu and Windows on Node 20 and 22.

## Tests

The classifier is guarded two ways, and changes to the rule tree usually need to
touch both:

- **Property tests** (`test/property.test.mjs`) — seeded PRNG, 200 iterations
  per invariant, over the pure classifier layers.
- **Golden corpus** (`test/corpus/`) — labeled transcript fixtures pinning all
  six trajectory buckets across the Claude Code, Cursor, Codex, and Antigravity
  runtimes. If a change legitimately flips a verdict, update the fixture in the
  same PR and explain why.

Add or update tests alongside behavior changes. New buckets, detectors, or
narrative phrasing should come with a fixture that pins the expected output.

## Pull requests

- Keep PRs focused; one logical change per PR.
- Run `npm test` locally before opening.
- Update `CHANGELOG.md` under the `## [Unreleased]` header for user-visible
  changes.
