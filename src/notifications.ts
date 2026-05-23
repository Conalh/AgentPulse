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

/** Spawn an OS notification, fire-and-forget. */
function fireOsNotification(title: string, body: string): void {
  try {
    const plat = process.platform;
    if (plat === 'darwin') {
      // osascript handles its own escaping when args are passed individually,
      // but `display notification` is a single AppleScript expression, so we
      // assemble it and rely on a minimal escape pass for embedded quotes.
      const safeBody = body.replace(/"/g, '\\"');
      const safeTitle = title.replace(/"/g, '\\"');
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
      // missing, the spawn ENOENTs out and we eat the error.
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
