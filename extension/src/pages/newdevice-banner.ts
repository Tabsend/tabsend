import type { GroupResetState, NewDeviceNotice } from '@tabsend/shared'
import { groupResetCopy, newDeviceCopy, unreachableCopy } from '../lib/strings'
import type { UnreachableDevice } from '../lib/unreachable'

/**
 * Everything the new-device watch asks this browser to look at (PLANS.md P-10,
 * P-14 item 2, P-23), drawn into one container, top to bottom:
 *
 *  0. A reset that waits (P-18 item 12): someone asked the account page to remove
 *     every device. Danger-toned, first, with "Stop the reset" and "It was me". Once
 *     stopped, a one-line confirmation takes its place.
 *  1. One notice per device that joined, was never answered, and then vanished from
 *     the list; it stays until dismissed (GH7). Kept for records from before P-23:
 *     a device that joins is now told once as a notification and is just in the list.
 *  2. One card per device a send could not reach because the relay no longer has
 *     it (P-20): "Pair it again" or "Dismiss". Only where the page wires both.
 *
 * Shared by the popup and the manage screen so the two can never word it
 * differently. The pages decide what the buttons do.
 */
export interface DeviceNotices {
  vanished: readonly NewDeviceNotice[]
  /** The waiting reset, unless answered here. */
  groupReset?: GroupResetState | undefined
  /** A Stop is on its way to the relay: the buttons wait. */
  resetBusy?: boolean
  /** Why the last Stop failed; the card stays and says so. */
  resetError?: string | undefined
  /** This page stopped the reset: "Reset stopped. Nothing was removed." */
  resetStopped?: boolean
  /** Devices a send could not reach (P-20). */
  unreachable?: readonly UnreachableDevice[]
}

export interface DeviceNoticeActions {
  /** "Dismiss" on a joined-then-disappeared notice. */
  dismissVanished: (n: NewDeviceNotice) => void
  /** "Stop the reset". */
  stopReset: (reset: GroupResetState) => void
  /** "It was me" on the waiting reset. */
  dismissReset: (reset: GroupResetState) => void
  /** "Pair <device> again" on a device that isn't connected (P-20). */
  pairAgain?: (d: UnreachableDevice) => void
  /** "Dismiss" on a device that isn't connected (P-20). */
  dismissUnreachable?: (d: UnreachableDevice) => void
}

export function renderDeviceNotices(
  container: HTMLElement,
  notices: DeviceNotices,
  actions: DeviceNoticeActions,
): void {
  const now = Date.now()
  const cards: HTMLElement[] = []
  if (notices.groupReset) cards.push(groupResetCard(notices, notices.groupReset, actions))
  else if (notices.resetStopped) cards.push(resetStoppedLine())
  for (const n of notices.vanished) cards.push(vanishedCard(n, now, actions))
  const { pairAgain, dismissUnreachable } = actions
  if (pairAgain && dismissUnreachable) {
    for (const d of notices.unreachable ?? [])
      cards.push(unreachableCard(d, pairAgain, dismissUnreachable))
  }
  container.replaceChildren(...cards)
  container.classList.toggle('hidden', cards.length === 0)
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'linkish'
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}

function card(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'notice waiting new-device'
  el.setAttribute('role', 'status')
  return el
}

function textBlock(className: string, tag: 'div' | 'p', text: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.textContent = text
  return el
}

function groupResetCard(
  notices: DeviceNotices,
  reset: GroupResetState,
  actions: DeviceNoticeActions,
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'notice danger new-device group-reset'
  el.setAttribute('role', 'alert')
  const row = document.createElement('div')
  row.className = 'new-device-actions'
  const stop = button(notices.resetBusy ? groupResetCopy.stopping : groupResetCopy.stop, () =>
    actions.stopReset(reset),
  )
  const dismiss = button(groupResetCopy.dismiss, () => actions.dismissReset(reset))
  stop.disabled = Boolean(notices.resetBusy)
  dismiss.disabled = Boolean(notices.resetBusy)
  row.append(stop, dismiss)
  el.append(
    textBlock('new-device-title', 'div', groupResetCopy.title),
    textBlock('new-device-body', 'p', groupResetCopy.body(reset.requestedAt, reset.resetsAt)),
  )
  if (notices.resetError) el.append(textBlock('new-device-error', 'p', notices.resetError))
  el.append(row)
  return el
}

function resetStoppedLine(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'notice accent new-device'
  el.setAttribute('role', 'status')
  el.textContent = groupResetCopy.stopped
  return el
}

function vanishedCard(n: NewDeviceNotice, now: number, actions: DeviceNoticeActions): HTMLElement {
  const el = card()
  const row = document.createElement('div')
  row.className = 'new-device-actions'
  row.append(button(newDeviceCopy.vanishedDismiss, () => actions.dismissVanished(n)))
  el.append(
    textBlock('new-device-title', 'div', newDeviceCopy.vanishedTitle(n.label)),
    textBlock('new-device-body', 'p', newDeviceCopy.vanishedBody(n.createdAt, now)),
    row,
  )
  return el
}

/**
 * Danger-toned, like a failed send's own line: tabs go nowhere until it is
 * answered. The same words for a phone or a browser, because the cause and the
 * fix are the same for both.
 */
function unreachableCard(
  d: UnreachableDevice,
  pairAgain: (d: UnreachableDevice) => void,
  dismiss: (d: UnreachableDevice) => void,
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'notice danger new-device unreachable'
  el.setAttribute('role', 'status')
  const row = document.createElement('div')
  row.className = 'new-device-actions'
  row.append(
    button(unreachableCopy.pairAgain(d.label), () => pairAgain(d)),
    button(unreachableCopy.dismiss, () => dismiss(d)),
  )
  el.append(
    textBlock('new-device-title', 'div', unreachableCopy.title(d.label)),
    textBlock('new-device-body', 'p', unreachableCopy.body),
    row,
  )
  return el
}

/**
 * What a page remembers about the reset card while it is open (P-18 item 12), so a
 * live re-render neither brings back a card just answered nor drops the outcome.
 */
export interface ResetCardState {
  busy: boolean
  error?: string | undefined
  /** `requestedAt` of the reset this page stopped. */
  stoppedFor?: string | undefined
  /** `requestedAt` of the reset this page answered "It was me" to. */
  dismissedFor?: string | undefined
}

/** The reset part of `DeviceNotices`, from what the background reported and the page state. */
export function resetNotices(
  state: ResetCardState,
  pending: GroupResetState | undefined,
): Pick<DeviceNotices, 'groupReset' | 'resetBusy' | 'resetError' | 'resetStopped'> {
  const answered =
    pending !== undefined &&
    (pending.requestedAt === state.stoppedFor || pending.requestedAt === state.dismissedFor)
  return {
    groupReset: answered ? undefined : pending,
    resetBusy: state.busy,
    resetError: state.error,
    resetStopped: state.stoppedFor !== undefined,
  }
}

/**
 * "Stop the reset": the buttons wait while it goes; on success the card gives way to
 * "Reset stopped. Nothing was removed."; on failure the card stays with the reason.
 */
export async function runStopReset(
  state: ResetCardState,
  reset: GroupResetState,
  stop: () => Promise<unknown>,
  rerender: () => void,
): Promise<void> {
  if (state.busy) return
  state.busy = true
  state.error = undefined
  rerender()
  try {
    await stop()
    state.stoppedFor = reset.requestedAt
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
  } finally {
    state.busy = false
    rerender()
  }
}
