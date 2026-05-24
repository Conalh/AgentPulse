/**
 * Layer 5 — Narrative renderer.
 *
 * Pure function. No I/O. Takes the three upstream outputs and produces a
 * plain-English `PulseRecap`. Voice target: "explain like Im five but
 * informed". No marketing speak, no jargon, no emoji except the single
 * warning glyph reserved for the drifting bucket.
 */

import type {
  EnrichedWindow,
  OutcomeSignal,
  TrajectoryVerdict,
  PulseRecap,
} from './types.js';

export function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 seconds';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return totalSeconds + ' ' + (totalSeconds === 1 ? 'second' : 'seconds');
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return totalMinutes + ' ' + (totalMinutes === 1 ? 'minute' : 'minutes');
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourPart = hours + ' ' + (hours === 1 ? 'hour' : 'hours');
  if (minutes === 0) return hourPart;
  const minutePart = minutes + ' ' + (minutes === 1 ? 'minute' : 'minutes');
  return hourPart + ' ' + minutePart;
}

function topCluster(clusters: Record<string, number>): string | undefined {
  let bestKey: string | undefined;
  let bestCount = -Infinity;
  for (const [key, count] of Object.entries(clusters)) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey;
}

function tick(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return '`' + token + '`';
}

/**
 * v0.5.3: middle-ellipsis a long file path so a narrative line doesn't
 * wrap and push the Signals/Activity section down a row.
 *
 * Pre-v0.5.3, narratives like
 *   "Earlier in the window it made 12 changes to
 *    `C:\\Dev\\fit-ontology\\web\\app\\clients\\page.tsx` before going idle."
 * would wrap onto two lines in a typical 100-col terminal, and the
 * NARRATIVE_MIN_HEIGHT pad from v0.3.5 became the only thing keeping the
 * layout stable. Compressing to `…/app/clients/page.tsx` keeps the
 * single-line narrative cadence the rest of the dashboard reads in.
 *
 * Strategy:
 *   1. Normalize backslashes to forward slashes
 *   2. If already <= maxLen, return unchanged
 *   3. Keep the trailing N segments that fit under maxLen with a leading
 *      `…/` marker; always keep the basename
 *   4. If even the basename alone is too long, keep it anyway — we never
 *      mangle the filename itself, just the parent path
 */
function shortenPath(path: string | undefined, maxLen = 50): string | undefined {
  if (!path) return path;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.length <= maxLen) return normalized;

  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return normalized;
  const basename = segments[segments.length - 1]!;

  // Try walking back from the basename adding parent segments until the
  // total (with leading "…/") would exceed maxLen.
  let kept = basename;
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const candidate = segments[i] + '/' + kept;
    const withMarker = '…/' + candidate;
    if (withMarker.length > maxLen) break;
    kept = candidate;
  }
  return '…/' + kept;
}

function driftSummary(messages: string[], limit = 3): string {
  return messages.slice(0, limit).join(', ');
}

function verificationDescription(trend: OutcomeSignal['verificationTrend']): string {
  switch (trend) {
    case 'flat_fail':
      return "the tests aren't passing";
    case 'regressing':
      return 'tests started failing';
    case 'no_data':
      return 'without running tests to verify';
    case 'flat_pass':
      return 'tests are passing but the conversation keeps looping';
    case 'improving':
      return 'tests are getting better but the user is still pushing back';
    default:
      return 'verification is unclear';
  }
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderConverging(enriched: EnrichedWindow, outcome: OutcomeSignal): string {
  const topic = enriched.topics[0] ?? 'your code';
  const duration = humanDuration(enriched.durationMs);
  const cluster = tick(topCluster(enriched.pathClusters));
  const editCount = enriched.actionCounts.editing ?? 0;
  const primaryFile = tick(shortenPath(enriched.primaryFiles[0]));
  // v0.3.1: gate verification claims on actual verification SIGNAL, not raw
  // count. `npm test` runs without parseable pass/fail output still bump
  // actionCounts.verification, but verificationTrend stays `no_data`. Pre-fix,
  // the narrative said "ran the tests after each change" + "Looks like it
  // solved it" while the Signals line right below admitted "no verification
  // data — confidence reflects that". Don't lie next to the truth.
  const hasVerificationSignal =
    outcome.verificationTrend === 'improving' ||
    outcome.verificationTrend === 'flat_pass';

  const parts: string[] = [
    'Your agent has been working on **' + topic + '** for **' + duration + '**.',
  ];
  const middle: string[] = [];
  if (cluster) middle.push('It focused on **' + cluster + '**');
  if (editCount > 0 && primaryFile) {
    middle.push('made **' + editCount + '** changes to **' + primaryFile + '**');
  } else if (editCount > 0) {
    middle.push('made **' + editCount + '** changes');
  }
  // Only claim "ran the tests after each change" when there's actual
  // verification SIGNAL (improving or flat_pass). Counting npm test
  // invocations without parseable output isn't enough.
  if (hasVerificationSignal && (enriched.actionCounts.verification ?? 0) > 0) {
    middle.push('ran the tests after each change');
  }
  if (middle.length > 0) {
    parts.push(capitalizeFirst(middle.join(', and ')) + '.');
  }
  if (outcome.verificationTrend === 'improving') {
    parts.push('Tests went from failing to passing.');
    parts.push('Looks like it solved it.');
  } else if (outcome.verificationTrend === 'flat_pass') {
    parts.push('Tests are green.');
    parts.push('Looks like it solved it.');
  }
  // v0.3.1: NO closing "Looks like it solved it" when verification is
  // missing or failing — that's an overconfident claim that the original
  // narrative made unconditionally.
  return parts.join(' ');
}

function renderExploring(enriched: EnrichedWindow): string {
  const duration = humanDuration(enriched.durationMs);
  const uniqueFileCount = Math.max(
    enriched.primaryFiles.length,
    Object.keys(enriched.pathClusters).length
  );
  const cluster = tick(topCluster(enriched.pathClusters));
  const parts: string[] = [
    'Your agent has been exploring for **' + duration + '**.',
  ];
  if (uniqueFileCount > 0 && cluster) {
    parts.push('It looked at **' + uniqueFileCount + '** files, mostly under **' + cluster + '**.');
  } else if (uniqueFileCount > 0) {
    parts.push('It looked at **' + uniqueFileCount + '** files.');
  } else if (cluster) {
    parts.push("It's been reading around **" + cluster + '**.');
  }
  parts.push("No edits yet — it's still figuring out the shape.");
  return parts.join(' ');
}

function renderStuck(enriched: EnrichedWindow, outcome: OutcomeSignal): string {
  const topic = enriched.topics[0] ?? 'your code';
  const duration = humanDuration(enriched.durationMs);
  const editCount = enriched.actionCounts.editing ?? 0;
  const primaryFile = tick(shortenPath(enriched.primaryFiles[0]));
  const verifDesc = verificationDescription(outcome.verificationTrend);

  const parts: string[] = [
    'Your agent has been working on **' + topic + '** for **' + duration + '**',
  ];
  if (editCount > 0 && primaryFile) {
    parts.push(', with **' + editCount + '** edits to **' + primaryFile + '**');
  } else if (editCount > 0) {
    parts.push(', with **' + editCount + '** edits');
  }
  parts.push(', but ' + verifDesc + '.');
  const sentence = parts.join('');
  const tone = "The conversation has a 'try again' tone.";
  return sentence + ' ' + tone + ' Worth checking in.';
}

function renderDone(enriched: EnrichedWindow, outcome: OutcomeSignal): string {
  const idleAgo = humanDuration(outcome.idleGapMs);
  const editCount = enriched.actionCounts.editing ?? 0;
  const fileCount = enriched.primaryFiles.length;

  const parts: string[] = ['Your agent finished up about **' + idleAgo + '** ago.'];
  if (editCount > 0 && fileCount > 0) {
    parts.push(
      'It made **' + editCount + '** changes across **' + fileCount + '** ' +
        (fileCount === 1 ? 'file' : 'files') +
        ' and signed off with a completion message.'
    );
  } else if (editCount > 0) {
    parts.push('It made **' + editCount + '** changes and signed off with a completion message.');
  } else {
    parts.push('It signed off with a completion message.');
  }
  parts.push('Looks done.');
  return parts.join(' ');
}

function renderIdle(enriched: EnrichedWindow): string {
  // Find the freshness from the events directly — the trajectory layer
  // already computed this, but the narrative renderer doesn't take the
  // outcome's freshness as input, so we recompute it from the enriched
  // window. Cheap.
  let lastEventMs = 0;
  for (const ev of enriched.events) {
    if (typeof ev.timestamp === 'number' && ev.timestamp > lastEventMs) {
      lastEventMs = ev.timestamp;
    }
  }
  const freshnessMs =
    lastEventMs > 0 ? enriched.windowEnd - lastEventMs : enriched.durationMs;

  const editCount = enriched.actionCounts.editing ?? 0;
  const primaryFile = tick(shortenPath(enriched.primaryFiles[0]));
  const cluster = tick(topCluster(enriched.pathClusters));
  const isEmptyWindow =
    enriched.toolInvocationCount === 0 && enriched.userMessageCount === 0;

  // Truly-empty window: no events at all in the visible span. The session
  // is parked, full stop. Don't try to summarize "what happened earlier"
  // because nothing did.
  if (isEmptyWindow) {
    return (
      'Your agent has been quiet for the whole ' +
      humanDuration(enriched.durationMs) +
      ' window. No tool calls, no messages. Likely parked, waiting on you or external input.'
    );
  }

  const parts: string[] = [
    'Your agent has been quiet for **' + humanDuration(freshnessMs) + '**.',
  ];
  if (editCount > 0 && primaryFile) {
    parts.push(
      'Earlier in the window it made **' + editCount + '** ' +
        (editCount === 1 ? 'change' : 'changes') + ' to **' + primaryFile + '** before going idle.'
    );
  } else if (editCount > 0 && cluster) {
    parts.push(
      'Earlier in the window it made **' + editCount + '** ' +
        (editCount === 1 ? 'change' : 'changes') + ' under **' + cluster + '** before going idle.'
    );
  } else if (editCount > 0) {
    parts.push(
      'Earlier in the window it made **' + editCount + '** ' +
        (editCount === 1 ? 'change' : 'changes') + ' before going idle.'
    );
  } else if (cluster) {
    parts.push('Earlier in the window it was reading around **' + cluster + '**.');
  }
  parts.push('Likely parked, waiting on you or external input.');
  return parts.join(' ');
}

function renderDrifting(enriched: EnrichedWindow, verdict: TrajectoryVerdict): string {
  // v0.3.1: bucket-aware lede. Pre-fix, every drift was described as "things
  // outside the project" — which is genuinely wrong for `.ssh/id_rsa` reads
  // (those are PRIVILEGED PATH access, not "outside the project"), and
  // misleading for `curl|sh` (piped network exec). Now: pick the lead from
  // the first drift's kind slug so the user sees what actually happened.
  const duration = humanDuration(enriched.durationMs);
  const driftCount = verdict.drifts.length;
  const summary = driftSummary(verdict.drifts.map((d) => d.message));

  // Categorize. Kind slugs come from trajectory.ts buildDrift() as
  // `agent_pulse.live_drift_<slug>`; we look at the suffix.
  const slugs = verdict.drifts.map((d) => {
    const k = String(d.kind ?? '');
    const idx = k.lastIndexOf('_drift_');
    return idx >= 0 ? k.slice(idx + 7) : k;
  });
  const hasPrivileged = slugs.some((s) =>
    /(ssh|aws|kube|gnupg|credential|shadow|private)/i.test(s)
  );
  const hasShellExfil = slugs.some((s) => /shell_exfil/i.test(s));
  const hasOutsideWrite = slugs.some((s) => /outside_repo|write_outside/i.test(s));

  let lede: string;
  if (hasShellExfil) {
    lede = '⚠ Your agent piped network fetch into a shell';
  } else if (hasPrivileged) {
    lede = '⚠ Your agent touched a privileged path (SSH/AWS/credentials/system config)';
  } else if (hasOutsideWrite) {
    lede = '⚠ Your agent wrote outside the repo root';
  } else {
    lede = "⚠ Your agent is doing work but it's wandering";
  }

  const parts: string[] = [
    lede + '. In the last **' + duration + '** it triggered **' + driftCount + '** ' +
      (driftCount === 1 ? 'finding' : 'findings'),
  ];
  if (summary) parts.push(': ' + summary + '.');
  else parts.push('.');
  parts.push(' Pause and check.');
  return parts.join('');
}

/**
 * v0.3.2: Layer 2.5 sequence-pattern phrases. Appended to the bucket
 * narrative when verdict.sequence is set. Kept short and in the same
 * "explain it plainly" voice as the rest of the narrative.
 */
function sequencePhrase(verdict: TrajectoryVerdict): string | null {
  const seq = verdict.sequence;
  if (!seq || seq.pattern === 'none') return null;
  switch (seq.pattern) {
    case 'tdd_loop':
      return 'It ran tests after each change in a tight loop.';
    case 'refuse_to_verify':
      return "It's been editing without running anything to verify — worth checking.";
    case 'stuck_loop':
      return "It's stuck editing the same file and the tests keep failing.";
    case 'exploratory_edit':
      return 'It explored first, then started editing in that area.';
    default:
      return null;
  }
}

export function renderRecap(
  enriched: EnrichedWindow,
  outcome: OutcomeSignal,
  verdict: TrajectoryVerdict
): PulseRecap {
  let body: string;
  switch (verdict.bucket) {
    case 'converging':
      body = renderConverging(enriched, outcome);
      break;
    case 'exploring':
      body = renderExploring(enriched);
      break;
    case 'stuck':
      body = renderStuck(enriched, outcome);
      break;
    case 'done':
      body = renderDone(enriched, outcome);
      break;
    case 'drifting':
      body = renderDrifting(enriched, verdict);
      break;
    case 'idle':
      body = renderIdle(enriched);
      break;
    default:
      body = 'Your agent has been working for **' + humanDuration(enriched.durationMs) + '**.';
      break;
  }

  // v0.3.2: append a sequence-pattern phrase when one fired. We skip
  // appending to `drifting` (the warning lede already dominates that
  // narrative) and to `idle` (the sequence is about *active* shape and
  // the agent isn't currently active).
  //
  // v0.4.3: also skip stuck + refuse_to_verify. The stuck narrative already
  // ends with "...without running tests to verify. ... Worth checking in."
  // and the refuse_to_verify sequence phrase says "It's been editing
  // without running anything to verify — worth checking." Appending one
  // onto the other reads as a stutter (the user saw exactly this in the
  // wild — see the dashboard screenshot review).
  const seqPhrase = sequencePhrase(verdict);
  const stuckRefuseStutter =
    verdict.bucket === 'stuck' &&
    verdict.sequence?.pattern === 'refuse_to_verify';
  if (
    seqPhrase &&
    verdict.bucket !== 'drifting' &&
    verdict.bucket !== 'idle' &&
    !stuckRefuseStutter
  ) {
    body = body + ' ' + seqPhrase;
  }

  let narrative = body;
  if (verdict.confidence < 0.5 && verdict.bucket !== 'drifting') {
    narrative = 'Looks like ' + body.charAt(0).toLowerCase() + body.slice(1);
  }

  return {
    windowStart: enriched.windowStart,
    windowEnd: enriched.windowEnd,
    durationHuman: humanDuration(enriched.durationMs),
    verdict,
    narrative,
    enriched,
    outcome,
  };
}