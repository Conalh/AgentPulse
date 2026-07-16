# Releasing AgentPulse

AgentPulse has three distribution surfaces:

1. **npm** — `@conalh/agentpulse`, containing the CLI and library exports.
2. **GitHub Action** — `action.yml`, which builds and runs the source at the
   consumer-selected git ref with the committed lockfile.
3. **GitHub Release** — the semver tag and human-readable notes from
   `CHANGELOG.md`.

The package version and git tag stay aligned. The Action no longer downloads a
second AgentPulse copy from npm, so a full commit-SHA pin identifies the code it
executes even if npm publication is delayed.

## Dependency order

AgentPulse depends on the public `agent-gov-core` npm package for transcript
parsers, shell tokenization, and report contracts. If a release needs a new
substrate API, publish that dependency first and confirm the required version is
available from the registry before updating AgentPulse's lockfile.

## Release checklist

1. Put user-visible work under `## [Unreleased]` in `CHANGELOG.md`.
2. Choose the version using semver. Before 1.0, minor versions may contain
   breaking changes as stated in the changelog.
3. Replace the unreleased heading with `## [X.Y.Z] — YYYY-MM-DD`, then add a new
   empty `## [Unreleased]` section above it.
4. Set the same version in `package.json` and `package-lock.json`.
5. Add the release title to `scripts/backfill-releases.mjs`.
6. Run the full local gate:

   ```sh
   npm ci
   npm test
   npm audit --omit=dev
   npm audit
   npm pack --dry-run
   ```

7. Publish the npm package:

   ```sh
   npm publish --access=public
   ```

8. Verify the registry reports the new version before exposing the tag:

   ```sh
   npm view @conalh/agentpulse version
   npx @conalh/agentpulse@X.Y.Z --help
   ```

9. Tag and push the verified commit:

   ```sh
   git tag vX.Y.Z
   git push origin main --tags
   ```

10. Create the GitHub Release from the matching changelog section:

    ```sh
    node scripts/backfill-releases.mjs --dry-run
    node scripts/backfill-releases.mjs
    ```

Do not cut the semver tag before npm accepts the matching package version. The
Action itself is source-pinned, but keeping the tag, package manifest, registry,
and release notes aligned makes the CLI and repository auditable as one release.

## Action execution and trust boundary

The composite Action performs these steps on the consumer's runner:

1. set up Node 24;
2. run `npm ci --ignore-scripts` in `${{ github.action_path }}`;
3. build the checked-out TypeScript source;
4. execute that local `dist/cli.js`.

Pinning `Conalh/AgentPulse` to a full commit SHA pins AgentPulse source and the
lockfile. npm remains the download source for the lockfile-pinned dependencies,
and `actions/setup-node` remains part of the workflow trust boundary.
