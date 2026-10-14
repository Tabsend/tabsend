import type { NewDeviceNotice } from '@tabsend/shared'
import { newDeviceCopy } from '../lib/strings'

/**
 * Everything the new-device watch asks this browser to look at (PLANS.md P-10,
 * P-14 items 1 and 2), drawn into one container, top to bottom:
 *
 *  1. The first look: ONE card listing the other devices in the first list, with
 *     "All of these are mine" and a way to remove any (GH6).
 *  2. One notice per device that joined, was never answered, and then vanished from
 *     the list; it stays until dismissed (GH7).
 *  3. One banner per device that joined since and has not been answered.
 *
 * Shared by the popup and the manage screen so the two can never word it
 * differently. The pages decide what the buttons do.
 */
export interface DeviceNotices {
  review: readonly NewDeviceNotice[]
  vanished: readonly NewDeviceNotice[]
  newDevices: readonly NewDeviceNotice[]
}

export interface DeviceNoticeActions {
  /** "Yes, it's mine" on one new device. */
  confirm: (n: NewDeviceNotice) => void
  /** Remove one device (from its banner or from the first-look card). */
  remove: (n: NewDeviceNotice) => void
  /** "All of these are mine" on the first-look card. */
  confirmReview: () => void
  /** "Dismiss" on a joined-then-disappeared notice. */
  dismissVanished: (n: NewDeviceNotice) => void
}

export function renderDeviceNotices(
  container: HTMLElement,
  notices: DeviceNotices,
  actions: DeviceNoticeActions,
): void {
  const now = Date.now()
  const cards: HTMLElement[] = []
  if (notices.review.length > 0) cards.push(reviewCard(notices.review, actions))
  for (const n of notices.vanished) cards.push(vanishedCard(n, now, actions))
  for (const n of notices.newDevices) cards.push(newDeviceCard(n, now, actions))
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

function reviewCard(
  devices: readonly NewDeviceNotice[],
  actions: DeviceNoticeActions,
): HTMLElement {
  const el = card()
  el.append(
    textBlock('new-device-title', 'div', newDeviceCopy.reviewTitle),
    textBlock('new-device-body', 'p', newDeviceCopy.reviewBody),
  )
  for (const n of devices) {
    const row = document.createElement('div')
    row.className = 'new-device-row'
    const name = document.createElement('span')
    name.textContent = n.label
    const remove = button(newDeviceCopy.reviewRemove, () => actions.remove(n))
    remove.setAttribute('aria-label', newDeviceCopy.reviewRemoveLabel(n.label))
    row.append(name, remove)
    el.append(row)
  }
  const actionsRow = document.createElement('div')
  actionsRow.className = 'new-device-actions'
  actionsRow.append(button(newDeviceCopy.reviewConfirm, () => actions.confirmReview()))
  el.append(actionsRow)
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

function newDeviceCard(n: NewDeviceNotice, now: number, actions: DeviceNoticeActions): HTMLElement {
  const el = card()
  const row = document.createElement('div')
  row.className = 'new-device-actions'
  row.append(
    button(newDeviceCopy.confirm, () => actions.confirm(n)),
    button(newDeviceCopy.remove, () => actions.remove(n)),
  )
  el.append(
    textBlock('new-device-title', 'div', newDeviceCopy.bannerTitle(n.label)),
    textBlock('new-device-body', 'p', newDeviceCopy.bannerBody(n.createdAt, now)),
    row,
  )
  return el
}
