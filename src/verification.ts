/**
 * Shared verification vocabulary + result-text pass/fail classification.
 *
 * Two layers ask the same questions about a shell tool call:
 *   - Layer 3 (`trajectory.ts`) — the verification-*trend* computation
 *     ("did tests go fail→pass across the window?").
 *   - Layer 2.5 (`sequences.ts`) — the edit→verify *cycle* detector
 *     ("is this an edit immediately followed by running the tests?").
 *
 * Before this module each layer kept its OWN copy of the answer.
 * `trajectory.ts` matched a substring list (`VERIFICATION_HINTS`),
 * `sequences.ts` matched a regex list (`VERIFICATION_PATTERNS`), and
 * BOTH carried byte-identical FAIL/PASS pattern tables. The two
 * command lists had genuinely diverged — `go vet`, `cargo clippy`,
 * `mypy`, `ruff`, `gradle`, `mvn`, `npm run`, `playwright`, `prettier`
 * were recognized by the sequence detector but not the trend
 * computation. So a command could count as a verification for the
 * edit→verify cycle but not the pass/fail trend (or the reverse), and
 * a session's bucket could come out right for the wrong reason — or
 * wrong — *silently*. That is the same class of gap as the v0.6.1
 * (`tool_use` vs `tool_result` exit codes) and v0.6.2 (Codex `shell`
 * vs `Bash`) bugs: one layer recognizes a shape and a sibling layer
 * doesn't.
 *
 * This module is the single source of truth. Pure functions, no I/O.
 *
 * The matcher is the regex (word-boundary) form `enrich.ts` and
 * `sequences.ts` already used — strictly more precise than the trend
 * layer's old `cmd.includes('test')` substring list, which counted
 * `echo "latest"` as a test run. The vocabulary is the union of what
 * the three layers recognized, so the trend layer additionally gains
 * the tools it was previously missing (`go vet`, `cargo clippy`,
 * `mypy`, `ruff`, `gradle`, `mvn`, `npm run`, …).
 */

/**
 * Commands that count as a verification step (running tests, a type
 * checker, a linter, or a build). Word-boundary anchored so a token
 * embedded in a larger word (`latest`, `rebuilding`) doesn't match.
 */
const VERIFICATION_PATTERNS: readonly RegExp[] = [
  // package-runner verbs
  /\bnpm\s+(test|run|build|lint|run-script)\b/,
  /\bnpx\s+(vitest|jest|mocha|playwright|tsc|eslint|prettier|tap|ava)\b/,
  /\byarn\s+(test|run|build|lint|check)\b/,
  /\bpnpm\s+(test|run|build|lint|check)\b/,
  // python
  /\bpytest\b/,
  /\bpython\s+-m\s+(pytest|unittest)\b/,
  /\bunittest\b/,
  /\bmypy\b/,
  /\bruff\b/,
  // rust
  /\bcargo\s+(test|build|check|clippy)\b/,
  // go
  /\bgo\s+(test|build|vet)\b/,
  // jvm
  /\bgradle\b/,
  /\bmvn\b/,
  // ruby / php
  /\brake\s+test\b/,
  /\brspec\b/,
  /\bphpunit\b/,
  // make (any subcommand — `make`, `make test`, `make check`)
  /\bmake\b/,
  // bare tool invocations
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\beslint\b/,
  /\btsc\b/,
];

/**
 * Does this shell command look like a verification step? Pass the raw
 * command string (any case). Empty / whitespace-only commands are not
 * verifications.
 */
export function isVerificationCommand(command: string): boolean {
  if (!command) return false;
  // Lowercase so the lowercase-literal patterns match regardless of case
  // (`NPM TEST`, `Cargo Test`). Matches the trend layer's prior behaviour,
  // which lowercased before substring-matching.
  const lower = command.toLowerCase();
  return VERIFICATION_PATTERNS.some((re) => re.test(lower));
}

const FAIL_PATTERNS: readonly RegExp[] = [
  /\bFAIL\b/,
  /\bFAILED\b/,
  /\bfailing\b/i,
  /\d+\s+failed\b/i,
  /\bTests?:\s*\d+\s*failed/i,
  // The bare `/\berror\b/i` here used to flip ANY result text mentioning
  // the word "error" to a failure — including an error-handling test name
  // ("handles error gracefully ... ok"), a logged-but-recovered error, or
  // a help string. Since this table is only consulted when no exit code is
  // present (callers prefer the exit code; see `verificationOutcome` /
  // `verificationPassed`), that incidental match could mark a passing or
  // indeterminate run as `fail` and bias the stuck/converging/sequence
  // verdicts. Narrowed to runner-shaped error contexts so the word "error"
  // alone no longer counts; genuinely-red output still matches.
  /^\s*error:/im,            // "Error:" at line start (node, generic CLIs)
  /\bnpm\s+err!/i,           // npm ERR!
  /\berror\s+TS\d+/i,        // tsc diagnostic, e.g. "error TS2304"
  /\b\d+\s+errors?\b/i,      // "3 errors", "1 error"
  /\bcompilation failed\b/i,
  /\bbuild failed\b/i,
  /\bcommand failed\b/i,
];

const PASS_PATTERNS: readonly RegExp[] = [
  /\bpassing\b/i,
  /\bPASS\b/,
  /\bPASSED\b/,
  /\bTests?:\s*\d+\s*passed/i,
  /\d+\s+passed\b/i,
  /\bok\s+\d+/i,
];

/**
 * Classify a verification command's result *text* (not its exit code —
 * callers check that first when present). Returns `null` when the text
 * is empty or matches neither table — those events are indeterminate
 * and should be skipped by the caller.
 *
 * When both a fail and a pass pattern fire (e.g. "1 failed, 3 passed"),
 * failure dominates — that's how every test runner reports a red build.
 */
export function classifyResultText(text: string | undefined | null): 'pass' | 'fail' | null {
  if (!text) return null;
  const hasFail = FAIL_PATTERNS.some((re) => re.test(text));
  const hasPass = PASS_PATTERNS.some((re) => re.test(text));
  if (hasFail) return 'fail';
  if (hasPass) return 'pass';
  return null;
}
