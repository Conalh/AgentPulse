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
  const primaryFile = tick(enriched.primaryFiles[0]);

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
  if ((enriched.actionCounts.verification ?? 0) > 0) {
    middle.push('ran the tests after each change');
  }
  if (middle.length > 0) {
    parts.push(capitalizeFirst(middle.join(', and ')) + '.');
  }
  if (outcome.verificationTrend === 'improving') {
    parts.push('Tests went from failing to passing.');
  } else if (outcome.verificationTrend === 'flat_pass') {
    parts.push('Tests are green.');
  }
  parts.push('Looks like it solved it.');
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
  const primaryFile = tick(enriched.primaryFiles[0]);
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
  const primaryFile = tick(enriched.primaryFiles[0]);
  const cluster = tick(topCluster(enriched.pathClusters));

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
  const duration = humanDuration(enriched.durationMs);
  const driftCount = verdict.drifts.length;
  const summary = driftSummary(verdict.drifts.map((d) => d.message));
  const parts: string[] = [
    '⚠ Your agent is doing work but its wandering. In the last **' + duration + '** it touched **' + driftCount + '** ' +
      (driftCount === 1 ? 'thing' : 'things') +
      ' outside the project',
  ];
  if (summary) parts.push(': ' + summary + '.');
  else parts.push('.');
  parts.push(' Pause and check.');
  return parts.join('');
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