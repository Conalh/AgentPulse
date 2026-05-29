# Releasing AgentPulse

AgentPulse ships in three coupled places that have to stay in lockstep:

1. **npm** — the `@conalh/agentpulse` package (the `agentpulse` CLI + the
   library surface).
2. **The GitHub Action** — `action.yml` at the repo root. It does **not**
   bundle the code; it `npx`-installs the published npm package at the
   version it resolves from its own `package.json` (see "Version lockstep"
   below).
3. **GitHub Releases** — human-readable release notes, cut from
   `CHANGELOG.md`.

Because the Action installs from npm, **the npm publish is the release**.
The git tag and GitHub Release are bookkeeping on top of it.

## The substrate comes first (dual publish)

AgentPulse depends on `agent-gov-core` (the sibling repo at
`../agent-gov-core`) for its parser surface, `Finding` schema, and
transcript-event types. `package.json` pins it with a caret, e.g.
`"agent-gov-core": "^1.2.1"`.

If a release needs a substrate change (a new parser shape, a type change,
a schema tweak), publish the substrate **first**:

1. In `agent-gov-core`: bump its version, `npm test`, `npm publish`, tag.
2. Wait until the new version is live on the registry.
3. In AgentPulse: bump the `agent-gov-core` dependency to the published
   version, then proceed with the AgentPulse release below.

Publishing AgentPulse against an unpublished substrate version is the
exact failure that shipped in v0.7.0 — the caret pointed at a version the
registry didn't have, so `npm ci` hit `ETARGET` in CI. Don't bump the
dependency caret ahead of the registry.

## Cutting an AgentPulse release

1. **Land the work** under `## [Unreleased]` in `CHANGELOG.md` as you go.
2. **Pick the version** per semver. Under v1.0, minor versions may include
   breaking changes (stated at the top of the changelog).
3. **Rename the changelog header** from `## [Unreleased]` to
   `## [X.Y.Z] — YYYY-MM-DD`.
4. **Bump `package.json`** `version` to `X.Y.Z`. This single field is what
   the Action resolves and what `npm publish` uploads — keep it equal to
   the tag.
5. **Add the release title** to the `TITLES` map in
   `scripts/backfill-releases.mjs` (specific and action-oriented, matching
   the existing entries — no marketing).
6. **Verify green:** `npm test` (this runs `npm run build` first).
7. **Publish to npm.** The package is scoped, so public access must be
   explicit:

   ```sh
   npm publish --access=public
   ```

   `prepublishOnly` rebuilds `dist/` automatically; the `files` allowlist
   in `package.json` controls exactly what ships (compiled `dist/`, the
   dashboard SVG, `LICENSE`, `README.md`, `CHANGELOG.md`).
8. **Tag and push:**

   ```sh
   git tag vX.Y.Z
   git push --tags
   ```

   Tags use the `vX.Y.Z` form.
9. **Cut the GitHub Release:**

   ```sh
   node scripts/backfill-releases.mjs --dry-run   # preview titles + sizes
   node scripts/backfill-releases.mjs             # create missing releases
   ```

   The script slices each `## [X.Y.Z]` body out of `CHANGELOG.md`, pairs
   it with the title from the `TITLES` map, and shells out to
   `gh release create`. It's idempotent — versions whose release already
   exists are skipped — so it doubles as the backfill tool for any tag
   that's missing notes.

## Version lockstep with the Action

`action.yml` never hardcodes a version. Its "Resolve AgentPulse version"
step reads `version` from the `package.json` at whatever git ref the
consumer pinned (`Conalh/AgentPulse@vX.Y.Z`), then `npx`-installs
`@conalh/agentpulse@<that version>`. So:

- The git tag, the `package.json` version, and the npm version are the
  same string by construction — there's no separate Action version to
  bump.
- A consumer pinned at `@v0.7.0` always runs npm `0.7.0`. Pinning at a
  branch runs whatever that branch's `package.json` says.

The practical rule: **bump `package.json`, tag with the matching `v`
prefix, publish that exact version to npm.** Anything that breaks that
equality breaks the Action.
