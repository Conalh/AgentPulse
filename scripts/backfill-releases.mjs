#!/usr/bin/env node
/**
 * One-shot helper to backfill GitHub Releases for every tagged version
 * that's missing one. Reads CHANGELOG.md, slices out the per-version
 * body between `## [X.Y.Z]` headers, and shells out to `gh release
 * create` with a hand-written title.
 *
 * Idempotent: skips a version if its Release already exists.
 *
 * Usage:
 *   node scripts/backfill-releases.mjs           # backfill all
 *   node scripts/backfill-releases.mjs --dry-run # preview titles + sizes
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DRY_RUN = process.argv.includes('--dry-run');

// Hand-written titles for each version, matching the v0.4.0-v0.4.2 style
// (specific, action-oriented, no marketing). Edit here if any need a
// different lede.
const TITLES = {
  '0.4.3': "Narrative quality fixes (no more 'working on bad')",
  '0.4.4': 'Hex-tail disambiguator for same-label session rows',
  '0.4.5': 'Cluster the session list by project',
  '0.4.6': "Don't render Codex date folders as project names",
  '0.4.7': "Press 'n' to name your agents (aliases)",
  '0.4.8': "Whitelist preview — two-stage 'a' confirm",
  '0.5.0': 'Parser surface migrated to agent-gov-core@1.1.0',
  '0.5.1': 'Clean dist/ before build (orphan files fix)',
  '0.5.2': 'Four post-v0.5 inspection fixes (races + alias-aware notifier)',
  '0.5.3': 'Render calm + correctness — six fixes from external inspections',
  '0.5.4': 'Verdict hysteresis — calm the flicker',
  '0.5.5': 'CI speedup — parallel --once + Action uses the npm package',
  '0.5.6': 'JSON read cache + AGENTPULSE_PROFILE dev mode',
  '0.6.0': 'Incremental transcript parsing — biggest perf win',
  '0.6.1': 'Regression armor — property tests + golden corpus + classifier bug fix',
  '0.6.2': 'Codex external inspection fixes (cross-runtime file-paths + relative path drift)',
  '0.7.0': 'Native Antigravity session tracking support',
};

const VERSIONS = Object.keys(TITLES);

// Slice CHANGELOG.md into per-version bodies.
const md = readFileSync('CHANGELOG.md', 'utf8');
const sections = {};
{
  const lines = md.split('\n');
  let current = null;
  let buffer = [];
  for (const line of lines) {
    const m = line.match(/^## \[(\d+\.\d+\.\d+)\]/);
    if (m) {
      if (current) sections[current] = buffer.join('\n').trim();
      current = m[1];
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) sections[current] = buffer.join('\n').trim();
}

// Look up existing releases so we skip ones that already exist.
const existingResult = spawnSync('gh', ['release', 'list', '--limit', '100', '--json', 'tagName'], {
  encoding: 'utf8',
});
if (existingResult.status !== 0) {
  console.error('gh release list failed:', existingResult.stderr);
  process.exit(1);
}
const existing = new Set(
  JSON.parse(existingResult.stdout).map((r) => r.tagName)
);

console.error(`Found ${existing.size} existing releases. Backfilling missing ones.\n`);

const tmpDir = mkdtempSync(join(tmpdir(), 'agentpulse-release-'));
let created = 0;
let skipped = 0;

try {
  for (const version of VERSIONS) {
    const tag = `v${version}`;
    if (existing.has(tag)) {
      console.error(`  ${tag}  already exists — skipping`);
      skipped += 1;
      continue;
    }

    const body = sections[version];
    if (!body) {
      console.error(`  ${tag}  NO BODY in CHANGELOG.md — skipping`);
      continue;
    }

    const title = `${tag}: ${TITLES[version]}`;
    const notesFile = join(tmpDir, `${tag}.md`);
    writeFileSync(notesFile, body);

    if (DRY_RUN) {
      console.error(`  ${tag}  would create — title="${title}", body=${body.length} chars`);
      continue;
    }

    const result = spawnSync(
      'gh',
      ['release', 'create', tag, '--title', title, '--notes-file', notesFile],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      console.error(`  ${tag}  FAILED:`, result.stderr);
      process.exit(1);
    }
    console.error(`  ${tag}  created — ${title}`);
    created += 1;
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.error(`\n${DRY_RUN ? '[dry-run] ' : ''}Done. ${created} created, ${skipped} skipped.`);
