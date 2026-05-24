/**
 * Root Ink component for `agentpulse live`.
 *
 * Subscribes to the orchestrator + watcher and re-renders on every state
 * change. Owns selection cursor, help overlay, and the wall-clock tick used
 * for "Xs ago" labels.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Finding } from 'agent-gov-core';
import type {
  OrchestratorEvent,
  PulseOrchestrator,
  SessionEvent,
  SessionState,
  SessionWatcher,
} from '../types.js';
import { appendExceptions } from '../exceptions.js';
import { setAlias } from '../aliases.js';
import { SessionList } from './SessionList.js';
import { SessionDetail } from './SessionDetail.js';
import { formatDelta } from './duration.js';
import { Splash } from './Splash.js';
import { compareByProject } from './sort.js';
import { summarizeDriftKinds } from './driftSummary.js';

export interface AppProps {
  orchestrator: PulseOrchestrator;
  watcher: SessionWatcher;
  refreshIntervalMs: number;
  onExit: () => void;
  /** Hide sessions with zero tool invocations in the window. Default false
   *  (idle sessions stay visible, dimmed via low confidence). */
  hideIdle?: boolean;
  /** Cap the displayed list. 0 disables the cap. Default unbounded when
   *  omitted (the CLI passes 10 by default). */
  maxSessions?: number;
  /** Show subagent transcripts (project names matching `agent-<hex>`).
   *  Default false — subagent sessions are ephemeral tooling artifacts and
   *  noise to the human watching their own work. */
  showSubagents?: boolean;
}

/** Subagent-shaped project names — Claude Code stores transcripts of agents
 *  spawned via the SDK under names like `agent-a92e01b8034a7c780`. These
 *  are tooling artifacts, not human-facing sessions. */
const SUBAGENT_NAME_RE = /^agent-[0-9a-f]{8,}/i;

function isSubagentSession(s: SessionState): boolean {
  const name = s.session.projectName ?? '';
  if (SUBAGENT_NAME_RE.test(name)) return true;
  // Also catch the raw-tail fallback case where projectName was empty and the
  // file's basename UUID would trip the same pattern.
  const tail = s.session.transcriptPath.split(/[\\/]/).pop() ?? '';
  return SUBAGENT_NAME_RE.test(tail);
}

const HELP_LINES = [
  '↑/↓, k/j, or w/s   move selection',
  'r                  force refresh on selected session',
  'a                  whitelist current session’s drift findings',
  'n                  name / rename the selected session (alias)',
  '?                  toggle help',
  'q / Ctrl-C         quit',
];

/**
 * v0.4.1: how long the post-whitelist flash message lingers in the detail
 * pane before clearing. 2 s is long enough to register the action but
 * short enough that the user isn't stuck reading "refreshing…" after the
 * refresh has already landed.
 */
const FLASH_DURATION_MS = 2000;

/**
 * v0.4.1: debounce window for the `a` key. Same shape as the help-toggle
 * ref above — protects against key-hold re-firing a disk write and
 * orchestrator refresh repeatedly. 300 ms is invisible to a single press
 * and cleanly throttles auto-repeat.
 */
const A_KEY_DEBOUNCE_MS = 300;

/**
 * v0.4.8: how long the whitelist preview lingers before auto-cancelling.
 * 3 seconds is enough to scan a short list of finding messages and
 * decide; long enough that a key-bounce won't expire it, short enough
 * that a user who walked away doesn't return to a primed disk-write.
 */
const WHITELIST_PREVIEW_MS = 3000;

export function App({
  orchestrator,
  watcher,
  refreshIntervalMs,
  onExit,
  hideIdle = false,
  maxSessions = 0,
  showSubagents = false,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [states, setStates] = useState<SessionState[]>(() => orchestrator.states());
  const [now, setNow] = useState<number>(() => Date.now());
  const [showHelp, setShowHelp] = useState<boolean>(false);
  // v0.2.9: debounce timestamp for the help-overlay toggle. See `?` handler.
  const lastHelpToggleRef = useRef<number>(0);
  // v0.4.1: same shape for the `a` key — a single press should not trigger
  // multiple disk writes if the key auto-repeats.
  const lastAKeyRef = useRef<number>(0);
  // v0.4.7: rename mode for the `n` key. When true, keystrokes feed
  // `renameBuffer` instead of the normal navigation/action handlers.
  // Enter commits (writes the alias to ~/.agentpulse/aliases.json and
  // re-pulses); Esc cancels.
  //
  // v0.5.2: also capture the TARGET session id at `n`-press time. The
  // selectedId can change mid-rename if the watcher removes the selected
  // session (the auto-fallback effect at line 252-259 jumps selectedId to
  // visibleStates[0]). Pre-fix, the Enter handler read `selectedId` and
  // could write the typed alias to the WRONG session — silent data
  // corruption. Now we use the captured id no matter what selectedId did
  // during the typing window.
  const [renameMode, setRenameMode] = useState<boolean>(false);
  const [renameBuffer, setRenameBuffer] = useState<string>('');
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  // v0.4.8: whitelist preview state. First `a` press shows the preview;
  // second `a` press within WHITELIST_PREVIEW_MS commits. Any other key
  // cancels the preview (but that key still does its normal thing).
  // `drifts` is captured at preview time so a refresh in the 3s window
  // can't sneak new findings into the commit set.
  const [whitelistPreview, setWhitelistPreview] = useState<{
    sessionId: string;
    drifts: Finding[];
    expiresAt: number;
  } | null>(null);
  // v0.4.1: transient flash message shown in the detail pane after a
  // successful whitelist write. Cleared after FLASH_DURATION_MS.
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);
  // v0.3.0: brief startup splash. Flips to false after 900ms so the
  // dashboard renders in-place over the splash (alt-screen handles the
  // clear).
  const [showSplash, setShowSplash] = useState<boolean>(true);
  useEffect(() => {
    const id = setTimeout(() => setShowSplash(false), 900);
    return () => clearTimeout(id);
  }, []);

  // Filter + cap. Filtering by "active in window" is purely a render concern —
  // the orchestrator still tracks every session, so an idle one becoming
  // active pops in on the next refresh without needing to be re-added.
  // A session counts as idle when its recap is missing or shows zero tool
  // invocations in the window. Sessions still mid-first-pulse (recap === null)
  // are kept visible regardless of showIdle so the dashboard isn't blank on
  // startup.
  const visibleStates = useMemo(() => {
    let v = states;
    if (!showSubagents) {
      v = v.filter((s) => !isSubagentSession(s));
    }
    if (hideIdle) {
      v = v.filter((s) => {
        if (s.recap === null) return true; // first pulse pending — keep visible
        return s.recap.enriched.toolInvocationCount > 0;
      });
    }
    // v0.4.5: project-grouped sort. Replaced v0.3.2's flat urgency sort
    // because users running multiple agents on the same repo wanted
    // "everything happening on ontology" to read as one unit. See
    // compareByProject for the new key precedence + trade-off notes.
    v = [...v].sort(compareByProject);
    if (maxSessions > 0 && v.length > maxSessions) {
      v = v.slice(0, maxSessions);
    }
    return v;
  }, [states, hideIdle, maxSessions, showSubagents]);

  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const initial = orchestrator.states();
    return initial.length > 0 ? initial[0]!.session.id : null;
  });

  // v0.2.11: debounce orchestrator + watcher events into a single batched
  // setStates call. Pre-fix, sessions discovered or refreshed in rapid
  // succession each triggered an immediate re-render. Ink's diff calculation
  // can't always finish one frame before the next is queued, and on cmd.exe
  // the result was stacked dashboards with mismatched session counts visible
  // simultaneously. 100 ms collapses a burst of events into one render —
  // imperceptible delay to a human but cuts render-thrash entirely.
  //
  // v0.5.3: merged the orchestrator + watcher debounces into a single
  // shared scheduler. Pre-fix, a watcher 'change' event firing in the
  // same 100 ms window as the resulting orchestrator 'session-updated'
  // produced TWO setStates calls 100 ms apart — and therefore two Ink
  // diff/render passes. With one shared timer, both sources collapse
  // into one flush.
  useEffect(() => {
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFlush = (): void => {
      if (pendingTimer) return; // already scheduled — coalesce
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        setStates(orchestrator.states());
      }, 100);
    };
    const onOrchestratorEvent = (_e: OrchestratorEvent): void => scheduleFlush();
    const onWatcherEvent = (_e: SessionEvent): void => scheduleFlush();
    orchestrator.on(onOrchestratorEvent);
    watcher.on(onWatcherEvent);
    return () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      orchestrator.off(onOrchestratorEvent);
      watcher.off(onWatcherEvent);
    };
  }, [orchestrator, watcher]);

  // Wall-clock tick — used by the whitelist-preview countdown banner.
  // v0.5.3: the "Xs ago" labels in SessionList/SessionDetail no longer
  // consume this tick (they're self-clocking via <TimeAgo> / RefreshFooter
  // now). App still re-renders each second so the countdown stays current,
  // but the children are React.memo'd against props that don't include
  // `now`, so they don't re-diff on every tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    id.unref?.();
    return () => clearInterval(id);
  }, []);

  // v0.4.8: auto-expire the whitelist preview when its window elapses.
  // The "any key cancels" branch in useInput handles the common case;
  // this catches the no-input case (user walked away after one `a`).
  useEffect(() => {
    if (!whitelistPreview) return;
    const remaining = whitelistPreview.expiresAt - Date.now();
    if (remaining <= 0) {
      setWhitelistPreview(null);
      return;
    }
    const id = setTimeout(() => {
      // Only clear if the same preview is still in place — a fresh
      // preview (or a commit/cancel) would have replaced state already.
      setWhitelistPreview((p) =>
        p && p.expiresAt === whitelistPreview.expiresAt ? null : p
      );
    }, remaining);
    return () => clearTimeout(id);
  }, [whitelistPreview]);

  // If the selected session disappears from the visible list, fall back to
  // the first visible one. (When the user toggles showIdle off, their previous
  // selection may now be hidden.)
  useEffect(() => {
    if (visibleStates.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const stillThere = visibleStates.some((s) => s.session.id === selectedId);
    if (!stillThere) setSelectedId(visibleStates[0]!.session.id);
  }, [visibleStates, selectedId]);

  // Keyboard input. Navigation operates over `visibleStates` so hidden idle
  // sessions don't appear in the up/down cycle.
  useInput((input, key) => {
    // v0.4.7: rename mode intercepts all keystrokes except Enter / Esc /
    // Backspace, so the user can type a name without `q` quitting or `r`
    // refreshing mid-typing. Held in component state so the input row
    // re-renders as the user types.
    if (renameMode) {
      if (key.escape) {
        setRenameMode(false);
        setRenameBuffer('');
        setRenameTargetId(null);
        return;
      }
      if (key.return) {
        // v0.5.2: commit using the TARGET id captured at `n`-press time,
        // not the current selectedId. If the originally-selected session
        // was removed by the watcher mid-rename, the auto-fallback effect
        // would have moved selectedId to a different session — and
        // pre-fix the typed alias would have written to that wrong
        // session. Capturing at entry-time eliminates the race.
        const target = renameTargetId;
        const value = renameBuffer;
        setRenameMode(false);
        setRenameBuffer('');
        setRenameTargetId(null);
        if (target) {
          // setAlias('', '') (empty after trim) deletes the entry — this is
          // the intentional "clear alias" path. Caller doesn't need to know.
          void setAlias(target, value)
            .then(() => orchestrator.refresh(target))
            .catch(() => {
              /* surfaced via SessionState.error on the next refresh */
            });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setRenameBuffer((b) => b.slice(0, -1));
        return;
      }
      // Printable single-char input only. Filter out control / meta /
      // multi-char sequences (arrow keys produce multi-char `input` plus
      // a key flag — those land in the upArrow/downArrow branches above,
      // but we still guard here).
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setRenameBuffer((b) => b + input);
      }
      return;
    }

    // v0.4.8: any non-`a` key (or `a` after preview expired) cancels the
    // whitelist preview. The cancelling key still does its normal thing
    // afterwards, so navigation / refresh / help-toggle all behave
    // exactly as before — pressing them just additionally clears a
    // primed write. This keeps the preview from getting stuck on the
    // screen when the user moves on.
    if (whitelistPreview) {
      const isAKey = input === 'a' && !key.ctrl && !key.meta;
      const isFresh = Date.now() < whitelistPreview.expiresAt;
      if (!isAKey || !isFresh) {
        setWhitelistPreview(null);
        // Fall through — let the key do its normal action below.
      }
    }

    if (input === 'q' || (key.ctrl && input === 'c')) {
      onExit();
      exit();
      return;
    }
    if (input === '?') {
      // v0.2.9: debounce. Rapid `?`-spam was causing the help overlay to
      // toggle faster than Ink could complete a render, producing stacked
      // dashboards (the overlay add/remove changes the screen height; if a
      // press lands mid-render, the next render diff can leak the previous
      // frame). 200 ms is invisible to a human pressing once but throttles
      // a held key down to single transitions.
      const now = Date.now();
      if (now - lastHelpToggleRef.current >= 200) {
        lastHelpToggleRef.current = now;
        setShowHelp((v) => !v);
      }
      return;
    }
    if (visibleStates.length === 0) return;

    const idx = Math.max(
      0,
      visibleStates.findIndex((s) => s.session.id === selectedId)
    );

    // Up: arrow / vim-k / WASD-w. Shifted variants honored so users with
    // sticky shift / caps lock aren't surprised.
    //
    // v0.5.3: wrap-around. Pressing Up at the top of the list jumps to the
    // bottom; Down at the bottom jumps to the top. Standard vim/Ranger
    // behaviour — at terminal-only list traversal this makes scanning a
    // medium-sized session list dramatically less frustrating.
    if (key.upArrow || input === 'k' || input === 'w' || input === 'W') {
      const next = idx === 0 ? visibleStates.length - 1 : idx - 1;
      setSelectedId(visibleStates[next]!.session.id);
      return;
    }
    if (key.downArrow || input === 'j' || input === 's' || input === 'S') {
      const next = idx === visibleStates.length - 1 ? 0 : idx + 1;
      setSelectedId(visibleStates[next]!.session.id);
      return;
    }
    if (input === 'r' && selectedId) {
      // Fire-and-forget; orchestrator emits 'session-updated' on completion.
      void orchestrator.refresh(selectedId).catch(() => {
        /* surfaced via SessionState.error */
      });
      return;
    }
    // v0.4.7: `n` — rename / name the selected session. Drops into rename
    // mode; subsequent keystrokes feed renameBuffer (see top of handler).
    // Pre-fills the buffer with the current alias so the user can edit
    // rather than just replace.
    //
    // v0.5.2: also capture the target session id so the commit on Enter
    // writes to THIS session even if the selection auto-falls-back
    // mid-typing (e.g. the watcher removes the selected session).
    if (input === 'n' && selectedId) {
      const state = visibleStates.find((s) => s.session.id === selectedId);
      if (state) {
        setRenameBuffer(state.alias ?? '');
        setRenameTargetId(state.session.id);
        setRenameMode(true);
      }
      return;
    }
    // v0.4.1: `a` — whitelist the current session's drift findings. Writes
    // an exception baseline at `<cwd>/.agentpulse-exceptions.json` and then
    // re-pulses so the verdict clears. Debounced (key-hold protection).
    //
    // v0.4.8: two-stage confirm. First `a` press SHOWS a preview banner
    // listing what's about to be written; the disk write only fires on
    // a second `a` press within WHITELIST_PREVIEW_MS. Any other key (or
    // a timeout) cancels. This protects against a mistaken keypress
    // permanently whitelisting findings the user couldn't see clearly.
    if (input === 'a' && selectedId) {
      const nowMs = Date.now();
      if (nowMs - lastAKeyRef.current < A_KEY_DEBOUNCE_MS) return;
      lastAKeyRef.current = nowMs;

      // Stage 2: a previewed write that matches this session and is still
      // fresh → commit. We use the drifts captured at preview time so a
      // refresh during the 3 s window can't slip new findings into the
      // commit set silently.
      if (
        whitelistPreview &&
        whitelistPreview.sessionId === selectedId &&
        nowMs < whitelistPreview.expiresAt
      ) {
        const { drifts } = whitelistPreview;
        const state = visibleStates.find((s) => s.session.id === selectedId);
        const sessionCwd = state?.session.cwd;
        setWhitelistPreview(null); // clear before async work
        if (!sessionCwd || drifts.length === 0) return;
        const count = drifts.length;
        void appendExceptions(sessionCwd, drifts)
          .then(() => {
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            setFlashMessage(
              `✓ whitelisted ${count} finding${count === 1 ? '' : 's'} — refreshing…`
            );
            flashTimerRef.current = setTimeout(() => {
              setFlashMessage(null);
              flashTimerRef.current = null;
            }, FLASH_DURATION_MS);
            return orchestrator.refresh(selectedId);
          })
          .catch(() => {
            /* surfaced via SessionState.error on the next refresh */
          });
        return;
      }

      // Stage 1: first press → set up the preview.
      const state = visibleStates.find((s) => s.session.id === selectedId);
      if (!state || !state.recap) return;
      const drifts = state.recap.verdict.drifts;
      if (drifts.length === 0) return; // nothing to whitelist
      if (!state.session.cwd) return; // no cwd → don't know where to write
      setWhitelistPreview({
        sessionId: selectedId,
        drifts,
        expiresAt: nowMs + WHITELIST_PREVIEW_MS,
      });
      return;
    }
  });

  const selectedState = useMemo(
    () => visibleStates.find((s) => s.session.id === selectedId) ?? null,
    [visibleStates, selectedId]
  );

  // Header shows total tracked sessions + how many are visible after filter,
  // so the user knows hidden sessions exist when the count diverges.
  const totalLabel =
    visibleStates.length === states.length
      ? `${states.length} session${states.length === 1 ? '' : 's'}`
      : `${visibleStates.length}/${states.length} sessions`;
  const headerRight = `${totalLabel}, refresh ${formatDelta(refreshIntervalMs)}`;

  // v0.3.0: splash for the first ~900ms. Returns before any of the dashboard
  // chrome so the splash is centered in the alt-screen frame.
  if (showSplash) {
    return <Splash />;
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold>AgentPulse</Text>
          <Text dimColor> · by </Text>
          <Text bold color="red">
            RAGE
          </Text>
        </Box>
        <Text dimColor>{headerRight}</Text>
      </Box>

      <Box borderStyle="round" flexDirection="column" paddingX={1}>
        <SessionList states={visibleStates} selectedId={selectedId} />
      </Box>

      <Box borderStyle="round" flexDirection="column">
        <SessionDetail
          state={selectedState}
          refreshIntervalMs={refreshIntervalMs}
          flashMessage={flashMessage}
        />
      </Box>

      {showHelp && (
        <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
          <Text bold>Keys</Text>
          {HELP_LINES.map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </Box>
      )}

      <Box paddingX={1} justifyContent="space-between">
        {renameMode ? (
          <Text>
            <Text dimColor>Rename: </Text>
            <Text color="cyan">{renameBuffer}</Text>
            <Text color="cyan">█</Text>
            <Text dimColor>  · Enter save · Esc cancel · empty + Enter clears</Text>
          </Text>
        ) : whitelistPreview && now < whitelistPreview.expiresAt ? (
          <Text>
            <Text color="yellow" bold>⚠ Whitelist </Text>
            <Text color="yellow" bold>
              {whitelistPreview.drifts.length}
            </Text>
            <Text color="yellow" bold>
              {' '}finding{whitelistPreview.drifts.length === 1 ? '' : 's'}?
            </Text>
            <Text dimColor>{' ('}</Text>
            <Text>{summarizeDriftKinds(whitelistPreview.drifts)}</Text>
            <Text dimColor>{') '}</Text>
            <Text dimColor>
              · press <Text bold color="yellow">a</Text> to confirm (
              {Math.max(0, Math.ceil((whitelistPreview.expiresAt - now) / 1000))}
              s) · any key cancels
            </Text>
          </Text>
        ) : (
          <Text dimColor>↑↓ / WS select · r refresh · a whitelist · n rename · ? help · q quit</Text>
        )}
        <Text dimColor>
          ▲<Text color="red" bold>RAGE</Text>
        </Text>
      </Box>
    </Box>
  );
}
