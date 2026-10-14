import type { Endpoint, SendPayload } from '@tabsend/shared'
import { ext } from '../lib/ext'
import type { PendingUndo } from '../lib/model'
import {
  getCachedEndpoints,
  getPendingUndo,
  getPrefs,
  getSettings,
  setPendingUndo,
} from '../lib/storage'
import { sendingBanner } from '../lib/strings'
import { fetchEndpoints, targetEndpoints } from './endpoints'
import { showFeedback } from './feedback'
import { captureSelectedTabs, sendToTarget } from './send'
import { currentSession } from './session'

/**
 * Quick-send + the 4s undo window (ADR-0008, AMENDED — see chunk-5a report).
 *
 * ADR-0008 originally chose "toast-only, no undo". This chunk's task adds a 4s
 * undo window, reconciled with that ADR's "no retraction message to build": the
 * send is HELD LOCALLY for the window and only dispatched when it elapses, so an
 * undo is a pure local delete — nothing is ever transmitted that must be
 * retracted. The hold is persisted (not just an in-SW timer) so a service-worker
 * suspension inside the window can't drop the send: a later wake (boot or the
 * poll alarm, via flushUndo) dispatches it. Correctness is never traded away.
 */
export const UNDO_WINDOW_MS = 4000

function openFirstRun(): Promise<unknown> {
  return ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
}

/** Open the rich chooser as a popup WINDOW (Chrome can't reliably openPopup). §2.5 */
function openChooserWindow(): Promise<unknown> {
  return ext.windows.create({
    type: 'popup',
    url: ext.runtime.getURL('chooser.html'),
    width: 360,
    height: 500,
  })
}

/**
 * The targets to CHOOSE from — cache first, network only when there is no cache.
 *
 * Nothing is sealed against this list: quick-send stores the chosen endpoint's
 * id and label in the undo record, and the real send re-resolves the endpoint
 * (and so its key) from the relay when the undo window elapses. So the only
 * things a stale entry can get wrong are which target is picked and how it is
 * spelled in the toast, and neither is worth the round trip this used to spend
 * BEFORE the hotkey produced any feedback at all — the user pressed a key and
 * watched nothing happen for as long as the relay took to answer.
 *
 * The refresh still happens, just not in front of the user.
 */
async function resolveTargets(): Promise<Endpoint[]> {
  const cached = await getCachedEndpoints()
  if (cached.length > 0) {
    void fetchEndpoints().catch(() => undefined) // keep the cache warm for next time
    return targetEndpoints(cached)
  }
  let endpoints: Endpoint[]
  try {
    endpoints = await fetchEndpoints()
  } catch {
    endpoints = cached
  }
  return targetEndpoints(endpoints)
}

/**
 * The blind-fire path (quick-send toolbar mode click, or the "send to primary"
 * hotkey). Adaptive rule (§2.7): n=0 → onboarding; n=1 → that target; n≥2 →
 * primary, or open the chooser when no primary is learned yet.
 */
export async function quickSend(): Promise<void> {
  const session = await currentSession()
  if (!session) {
    await openFirstRun()
    return
  }

  const targets = await resolveTargets()
  if (targets.length === 0) {
    await openFirstRun()
    return
  }

  let target: Endpoint | undefined
  if (targets.length === 1) {
    target = targets[0]
  } else {
    const prefs = await getPrefs()
    target = targets.find((t) => t.id === prefs.primaryTargetId)
  }
  if (!target) {
    // n≥2 with no primary learned yet — you can't quick-send to nothing (§2.2).
    await openChooserWindow()
    return
  }

  // The whole highlighted selection — quick-send goes through the same pipeline
  // as every other surface, so a multi-tab selection quick-sends as one batch.
  const payloads = await captureSelectedTabs()
  const first = payloads[0]
  if (!first) {
    await showFeedback({
      tone: 'error',
      headline: "Couldn't send",
      detail: "There's nothing sendable in this tab.",
    })
    return
  }

  // The tab we're standing on now — the outcome banner (up to 4s later, possibly
  // after a worker restart) must come back HERE, not to whatever is active then.
  const tabId = await activeTabId()
  const undoId = await armUndoableSend(target, payloads, tabId)

  const settings = await getSettings()
  if (settings.showSuccessToast) {
    // "Sending", not "Sent". Nothing has left the machine yet — that is the
    // entire point of the undo window, and the old copy claimed otherwise, which
    // is why a relay outage during the window went completely unremarked.
    const opts = tabId === undefined ? {} : { tabId }
    await showFeedback(sendingBanner(target.label, first.title, first.favicon, payloads.length), {
      ...opts,
      undoId,
      durationMs: UNDO_WINDOW_MS,
    })
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id
}

async function armUndoableSend(
  target: Endpoint,
  payloads: SendPayload[],
  tabId?: number,
): Promise<string> {
  // Never stack: dispatch any still-armed send immediately before arming a new one.
  await flushUndo(true)
  const undo: PendingUndo = {
    id: crypto.randomUUID(),
    targetEndpointId: target.id,
    targetLabel: target.label,
    payloads,
    dispatchAt: Date.now() + UNDO_WINDOW_MS,
    ...(tabId === undefined ? {} : { tabId }),
  }
  await setPendingUndo(undo)
  // Fast path: dispatch when the window elapses. The poll alarm + boot flush are
  // the durable fallback if this SW is torn down before the timer fires.
  setTimeout(() => void flushUndo(), UNDO_WINDOW_MS + 50)
  return undo.id
}

let flushing = false

/**
 * Dispatch the armed undo-send if its window has elapsed (or `force`). Claims the
 * record before dispatching so a concurrent flush (timer vs. poll) can't double-send.
 *
 * `sendToTarget` reports the REAL outcome onto the originating tab, replacing the
 * optimistic "Sending…" banner. Before this, the result was discarded here — so a
 * quick-send into a dead relay showed a cheerful confirmation and then nothing
 * at all, which is exactly how a broken relay stayed invisible for days.
 */
export async function flushUndo(force = false): Promise<void> {
  if (flushing) return
  const pending = await getPendingUndo()
  if (!pending) return
  if (!force && Date.now() < pending.dispatchAt) return
  flushing = true
  try {
    await setPendingUndo(null) // claim
    const opts = pending.tabId === undefined ? {} : { feedbackTabId: pending.tabId }
    await sendToTarget(pending.targetEndpointId, pending.payloads, opts)
  } finally {
    flushing = false
  }
}

/** Undo the armed send (from the toast's Undo button). A pure local delete. */
export async function undoSend(id: string): Promise<void> {
  const pending = await getPendingUndo()
  if (pending && pending.id === id) await setPendingUndo(null)
}
