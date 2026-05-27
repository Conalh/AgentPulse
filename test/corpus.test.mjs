/**
 * Golden replay corpus (v0.6.1).
 *
 * For each scenario in `corpus/manifest.json`, parse the bundled
 * transcript fixture and assert that `pulse()` produces the labelled
 * bucket. This locks the classifier's behaviour on representative
 * real-world shapes so a tweak to the rule tree (or sequence
 * priorities, or detector wiring) that flips a bucket here is caught
 * immediately in CI.
 *
 * Adding a scenario:
 *   1. Drop `test/corpus/<name>.jsonl`
 *   2. Add an entry to `test/corpus/manifest.json`:
 *      { file, endAt, windowMs, expectedBucket, minConfidence, ... }
 *   3. Run `npm test`. The harness picks up new entries automatically.
 *
 * The fixtures use an anchored time (e.g. 2026-05-23T10:00:00Z) so
 * tests are reproducible. Each manifest entry sets `endAt` explicitly
 * so the window math is independent of wall-clock time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pulse } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(__dirname, 'corpus');
const MANIFEST = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8')
);

for (const scenario of MANIFEST.scenarios) {
  test(`corpus: ${scenario.file} → ${scenario.expectedBucket}`, async () => {
    // Copy the fixture into a tmpdir so pulse() can treat it as a
    // single-file "transcript directory" without polluting the corpus
    // dir. Mirrors the per-test isolation in parser.test.mjs.
    const tmp = mkdtempSync(join(tmpdir(), 'agentpulse-corpus-'));
    try {
      const dest = join(tmp, scenario.file);
      cpSync(join(CORPUS_DIR, scenario.file), dest);

      const endAt = Date.parse(scenario.endAt);
      const recap = await pulse({
        transcriptDir: dest,
        windowMs: scenario.windowMs,
        endAt,
        // Detectors enabled by default — disable explicitly when the
        // scenario tests a non-drift bucket so a coincidental
        // detector match doesn't poison the assertion.
        detectorsEnabled: scenario.expectedBucket === 'drifting'
          ? true
          : (scenario.detectorsEnabled ?? true),
        silent: true,
      });

      assert.equal(
        recap.verdict.bucket,
        scenario.expectedBucket,
        `${scenario.file}: expected bucket ${scenario.expectedBucket}, got ${recap.verdict.bucket}. ` +
          `Rationale: ${scenario.rationale}. ` +
          `Signals: ${recap.verdict.signals.join(' | ')}`,
      );
      assert.ok(
        recap.verdict.confidence >= scenario.minConfidence,
        `${scenario.file}: confidence ${recap.verdict.confidence} below threshold ${scenario.minConfidence}`,
      );
      if (typeof scenario.expectedDriftCount === 'number') {
        assert.equal(
          recap.verdict.drifts.length,
          scenario.expectedDriftCount,
          `${scenario.file}: expected ${scenario.expectedDriftCount} drift(s), got ${recap.verdict.drifts.length}`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
