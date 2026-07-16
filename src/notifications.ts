/**
 * v0.4.2: transition notifications for `agentpulse live`.
 *
 * Fires a local notification (terminal bell, OS notification, or both) when
 * a session flips INTO a "needs eyes" bucket (`drifting` or `stuck`). The
 * intent is to let the user walk away from the TUI and still be alerted
 * when one of their agents goes off the rails.
 *
 * Trigger policy — only fire on transitions INTO `drifting`/`stuck`:
 *   - `null → drifting`           ✓ fire (first pulse already concerning)
 *   - `converging → drifting`     ✓ fire (something just broke)
 *   - `drifting → stuck`          ✓ fire (state worsened)
 *   - `drifting → drifting`       ✗ skip (already alerted)
 *   - `stuck → drifting`          ✗ skip (already alerted; both are gating)
 *   - `drifting → converging`     ✗ skip (clearing isn't worth a beep)
 *   - `null → converging`         ✗ skip (safe bucket)
 *
 * Channels are intentionally best-effort and fire-and-forget. Notification
 * failures must never crash the dashboard — `osascript`, `notify-send`, and
 * PowerShell are all spawned with `detached: true` and `stdio: 'ignore'`,
 * with errors swallowed.
 *
 * Windows limitation: a clean cross-version Windows toast is hard from
 * stdlib. The PowerShell `NotifyIcon` fallback works but leaves a tray
 * icon behind. We bail to bell on Windows when `os` is requested and the
 * BurntToast PowerShell module isn't present. Document this in CHANGELOG.
 */

import { spawn } from 'node:child_process';
import type { TrajectoryBucket } from './types.js';

export type NotifyMode = 'none' | 'bell' | 'os' | 'both';

export interface NotificationOptions {
  mode: NotifyMode;
}

export interface Notifier {
  /** Process a state transition. Returns true if a notification fired. */
  onTransition(
    from: TrajectoryBucket | null,
    to: TrajectoryBucket,
    sessionLabel: string
  ): boolean;
  /** Fire a one-shot notification (used by --once mode). Returns true on fire. */
  notifyOnce(body: string): boolean;
  /** Cleanup hook; reserved for future use. */
  stop(): void;
}

/** Buckets that warrant a notification when we transition INTO them. */
const ALERT_BUCKETS: ReadonlySet<TrajectoryBucket> = new Set([
  'drifting',
  'stuck',
]);

/**
 * Decide whether a (from → to) transition should fire a notification.
 * Exported for direct unit-testing of the policy.
 */
export function shouldNotify(
  from: TrajectoryBucket | null,
  to: TrajectoryBucket
): boolean {
  // Only fire on transitions INTO alert buckets.
  if (!ALERT_BUCKETS.has(to)) return false;
  // Skip alert↔alert transitions — we already beeped on the first one.
  if (from !== null && ALERT_BUCKETS.has(from)) return false;
  return true;
}

/** Write the BEL character to stderr. stderr is chosen because stdout might
 *  be in an alternate screen buffer for the TUI; stderr stays on the
 *  controlling terminal. */
function ringBell(): void {
  try {
    process.stderr.write('\x07');
  } catch {
    /* swallow */
  }
}

/**
 * Escape an arbitrary string for embedding inside an AppleScript
 * double-quoted string literal.
 *
 * The notification title/body are transcript-derived (the session label is
 * ultimately `basename(cwd)` read from the transcript, with no charset
 * sanitization), so they are untrusted input. Pre-fix this branch escaped
 * ONLY `"` — which is insufficient:
 *   - A label ending in a backslash turned the closing quote into an escaped
 *     quote (`\"`), so the string literal never terminated and the rest of
 *     the label was parsed AS AppleScript — an injection vector up to
 *     `do shell script`.
 *   - A raw newline/CR makes the single-line `display notification "..."`
 *     expression a syntax error (best case) or splits it (worst case).
 *
 * Implemented as an explicit per-character pass (rather than a regex with
 * control-character classes) so the source carries no literal control bytes:
 * control chars (code < 0x20, or DEL 0x7F) become spaces, a backslash is
 * escaped BEFORE the quote so our own escape isn't re-escaped, and a double
 * quote is escaped.
 */
function escapeAppleScriptStringLiteral(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
    } else if (ch === '\\') {
      out += '\\\\';
    } else if (ch === '"') {
      out += '\\"';
    } else {
      out += ch;
    }
  }
  return out;
}

/** Cap notification text length. Defends every platform branch against
 *  pathological multi-KB labels (a runaway path, a malformed transcript)
 *  becoming an oversized command string. Notification UIs truncate anyway. */
function clampNotificationText(s: string): string {
  const MAX = 200;
  return s.length <= MAX ? s : s.slice(0, MAX - 1) + '…';
}

/** Spawn an OS notification, fire-and-forget. */
function fireOsNotification(rawTitle: string, rawBody: string): void {
  try {
    const title = clampNotificationText(rawTitle);
    const body = clampNotificationText(rawBody);
    const plat = process.platform;
    if (plat === 'darwin') {
      // `display notification` is a single AppleScript expression, so we
      // assemble it and fully escape the embedded (untrusted) title/body for
      // an AppleScript string literal — see escapeAppleScriptStringLiteral.
      const safeBody = escapeAppleScriptStringLiteral(body);
      const safeTitle = escapeAppleScriptStringLiteral(title);
      const script = `display notification "${safeBody}" with title "${safeTitle}"`;
      const child = spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => {
        /* swallow — best-effort */
      });
      child.unref();
    } else if (plat === 'linux') {
      // notify-send is part of libnotify-bin on most distros. When it's
      // missing, the spawn ENOENTs out and we eat the error. Pure argv —
      // no shell, no string assembly — so no escaping is needed here.
      const child = spawn('notify-send', [title, body], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => {
        /* swallow — notify-send may not be installed */
      });
      child.unref();
    } else if (plat === 'win32') {
      // Windows fallback: PowerShell NotifyIcon. Not great — it leaks a
      // tray icon for the BalloonTip's lifetime. BurntToast would be
      // cleaner but isn't stdlib and requires a separate install. Users
      // who want clean Windows toasts can use `--notify both` (or run
      // `Install-Module -Name BurntToast` themselves and we'll pick it up).
      //
      // Every interpolated value lands inside a PowerShell SINGLE-quoted
      // string literal, where `'` is the only metacharacter — backtick,
      // `$`, `"`, `\`, and newlines are all literal. Doubling `'` to `''`
      // is therefore the complete and correct escaping for this context.
      const safeBody = body.replace(/'/g, "''");
      const safeTitle = title.replace(/'/g, "''");
      // Try BurntToast first; if the module is missing, the catch falls
      // through to the NotifyIcon balloon. Both branches are best-effort.
      const ps =
        `try { Import-Module BurntToast -ErrorAction Stop; ` +
        `New-BurntToastNotification -Text '${safeTitle}','${safeBody}' } ` +
        `catch { ` +
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
        `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
        `$n.BalloonTipTitle = '${safeTitle}'; ` +
        `$n.BalloonTipText = '${safeBody}'; ` +
        `$n.Visible = $true; ` +
        `$n.ShowBalloonTip(5000); ` +
        `Start-Sleep -Seconds 6; ` +
        `$n.Dispose() }`;
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }
      );
      child.on('error', () => {
        /* swallow — powershell may be unavailable in stripped-down envs */
      });
      child.unref();
    }
    // Other platforms (freebsd, aix, ...): silent no-op for `os` mode.
  } catch {
    /* swallow — never crash the dashboard over a notification */
  }
}

/**
 * Build the notifier for a given mode. `none` produces a noop notifier
 * (useful so callers don't have to branch).
 */
export function createNotifier(opts: NotificationOptions): Notifier {
  const mode = opts.mode;

  function fire(body: string): boolean {
    if (mode === 'none') return false;
    if (mode === 'bell' || mode === 'both') {
      ringBell();
    }
    if (mode === 'os' || mode === 'both') {
      fireOsNotification('AgentPulse', body);
    }
    return true;
  }

  function onTransition(
    from: TrajectoryBucket | null,
    to: TrajectoryBucket,
    sessionLabel: string
  ): boolean {
    if (mode === 'none') return false;
    if (!shouldNotify(from, to)) return false;
    const body = `${sessionLabel}: ${to}${from ? ` (was ${from})` : ''}`;
    return fire(body);
  }

  function notifyOnce(body: string): boolean {
    return fire(body);
  }

  function stop(): void {
    // No persistent resources to clean up — child processes are detached
    // and unrefed. Hook is here for API symmetry / future expansion.
  }

  return { onTransition, notifyOnce, stop };
}

/**
 * Exported for unit tests: the AppleScript string-literal escaper and the
 * length clamp. Lets a fuzz/property test feed transcript-derived labels
 * (containing `"`, backslash, backtick, `$(`, newlines) through the exact
 * escaping the macOS branch uses, without spawning `osascript`.
 */
export const __testables = {
  escapeAppleScriptStringLiteral,
  clampNotificationText,
};
