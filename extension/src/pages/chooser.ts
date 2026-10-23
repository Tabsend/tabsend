import type { Endpoint } from '@tabsend/shared'
import { ext } from '../lib/ext'
import { isRelayDown } from '../lib/health'
import type { ChooserRow, ChooserView, HeldTab, SendResult, StateView } from '../lib/model'
import {
  goneTargetCopy,
  heldTabLabel,
  heldTabsHeading,
  multiSelectionLine,
  pendingRow,
  relayDownLine,
  sendBanner,
  sendFailureLine,
} from '../lib/strings'
import { renderDeviceNotices } from './newdevice-banner'
import { wirePairingBox } from './pairing-box'
import { rpcOk } from './rpc-client'

/**
 * The toolbar popup chooser (MVP slice of INTERACTION_FLOWS §3.1): ordered
 * target rows (device tile, name, "Kind · status"); click a row to send; a zero-target empty
 * state that links to first-run; and a persistent "+ New browser" pill in the
 * header — same spot whether the list is empty, has one device, or several —
 * so pairing another profile is never just a small footer link away.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const statusEl = $('status')
const relayEl = $('relay-down')
const newDevicesEl = $('new-devices')
const multiEl = $('multi')
const emptyEl = $('empty')
const targetsEl = $('targets')
const pendingEl = $('pending')
const heldEl = $('held')
const confirmEl = $('confirm')
const selfLabel = $('self-label')

// Once a send is initiated from this popup we freeze the view — a live WS
// refresh must never re-render (and wipe the ✓ / re-trigger auto-send) while the
// popup is completing a send and closing.
let sending = false

// How many highlighted tabs a row click sends (variant A: every row sends the
// whole selection). Queried once on open; 1 means everything looks as today.
let selectedCount = 1

// The state the popup opened with, so a repaint after moving a held tab can
// redraw the whole view the same way the live refresh does.
let currentState: StateView | undefined

function show(el: HTMLElement, visible: boolean): void {
  el.classList.toggle('hidden', !visible)
}

function relativeLastSeen(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

type DeviceIcon = 'phone' | 'browser' | 'laptop'

/** Which picture and word a target gets. Console endpoints never reach the list. */
function deviceIcon(endpoint: Endpoint): DeviceIcon {
  if (endpoint.kind === 'mobile') return 'phone'
  if (endpoint.kind === 'console') return 'laptop'
  return 'browser'
}

function deviceKindWord(endpoint: Endpoint): string {
  const icon = deviceIcon(endpoint)
  return icon === 'phone' ? 'Phone' : icon === 'laptop' ? 'Computer' : 'Browser'
}

/** Stroke icon geometry (24×24, currentColor) — built as nodes, never from a string. */
const ICON_SHAPES: Record<DeviceIcon, Array<[string, Record<string, string>]>> = {
  phone: [
    ['rect', { x: '6.5', y: '2.5', width: '11', height: '19', rx: '2.5' }],
    ['path', { d: 'M10.5 18h3' }],
  ],
  browser: [
    ['rect', { x: '2.5', y: '4', width: '19', height: '16', rx: '2.5' }],
    ['path', { d: 'M2.5 9h19' }],
    ['path', { d: 'M6 6.5h.01M8.5 6.5h.01' }],
  ],
  laptop: [
    ['rect', { x: '4', y: '4.5', width: '16', height: '11', rx: '1.5' }],
    ['path', { d: 'M2 19.5h20' }],
  ],
}

function deviceTile(endpoint: Endpoint): HTMLSpanElement {
  const tile = document.createElement('span')
  tile.className = 'tile'
  tile.setAttribute('aria-hidden', 'true')
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }))
    svg.setAttribute(k, v)
  for (const [name, attrs] of ICON_SHAPES[deviceIcon(endpoint)]) {
    const el = document.createElementNS(ns, name)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    svg.append(el)
  }
  tile.append(svg)
  return tile
}

function renderRow(row: ChooserRow): HTMLLIElement {
  const li = document.createElement('li')
  const btn = document.createElement('button')
  btn.dataset.endpointId = row.endpoint.id
  // Never announce a presence we can't stand behind: with the relay unreachable
  // the list is a snapshot, and reading out "online" from it is the spoken
  // version of the green dot that started this (dogfood 2026-08-05).
  const presence = !row.presenceKnown
    ? `status unknown, last seen ${relativeLastSeen(row.endpoint.lastSeenAt)}`
    : row.endpoint.presence === 'online'
      ? 'online'
      : `offline, last seen ${relativeLastSeen(row.endpoint.lastSeenAt)}`
  const verb = selectedCount > 1 ? `Send ${selectedCount} tabs to` : 'Send to'
  btn.setAttribute(
    'aria-label',
    `${verb} ${row.endpoint.label}${row.isPrimary ? ', primary' : ''}, ${presence}`,
  )

  // Presence is said in WORDS on the second line ("Browser · online"), not by a
  // coloured dot: the same three answers the dot gave (online / offline /
  // can't tell), plus the last-seen age wherever online isn't a known fact.
  btn.append(deviceTile(row.endpoint))

  const text = document.createElement('span')
  text.className = 'row-text'

  const nameLine = document.createElement('span')
  nameLine.className = 'row-name'
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = row.endpoint.label
  nameLine.append(label)
  // The primary device carries a small "Main" label (APP_UI.md "Device row"),
  // which replaced the ★. The button's aria-label already says "primary", so
  // this is decorative for assistive tech.
  if (row.isPrimary) {
    const main = document.createElement('span')
    main.className = 'main-tag'
    main.setAttribute('aria-hidden', 'true')
    main.textContent = 'Main'
    nameLine.append(main)
  }

  const sub = document.createElement('span')
  sub.className = 'row-sub'
  sub.append(`${deviceKindWord(row.endpoint)} · `)
  // `.last-seen` is the status word: sendTo() swaps it for "sending…" and back.
  const status = document.createElement('span')
  status.className = 'last-seen'
  if (row.presenceKnown && row.endpoint.presence === 'online') {
    status.classList.add('online')
    status.textContent = 'online'
  } else {
    // A long-offline endpoint reads as "inactive" (stale policy) rather than a
    // fresh "last seen"; still selectable — presence never gates a send.
    const age = row.stale ? 'inactive' : `seen ${relativeLastSeen(row.endpoint.lastSeenAt)}`
    // Unknown is a different KIND of answer from offline, so it says so: with
    // the relay unreachable the list is a snapshot, and only the age is fact.
    status.textContent = row.presenceKnown
      ? row.stale
        ? age
        : `offline · ${age}`
      : `status unknown · ${age}`
  }
  sub.append(status)
  text.append(nameLine, sub)
  btn.append(text)

  btn.addEventListener('click', () => {
    void sendTo(row.endpoint.id, btn)
  })
  li.append(btn)
  return li
}

/**
 * Show a LEGIBLE, calm send outcome and then close — never flash-and-vanish
 * (dogfood pass-2 #6).
 *
 * The tone comes from `sendBanner`, so this panel obeys the same rule as the
 * in-page banner: the green ✓ and the word "Sent" are reserved for a send the
 * relay actually took. A tab merely held in the local queue gets the amber ↑ and
 * "Waiting to send" — it used to get the full green tick with a small grey note
 * underneath, which read as success at a glance and hid the outage entirely.
 */
function showOutcome(send: SendResult): void {
  const banner = sendBanner(send)
  confirmEl.replaceChildren()
  confirmEl.classList.remove('pending', 'error')
  if (banner.tone !== 'success') confirmEl.classList.add(banner.tone)

  // One line: the outcome's glyph and words, in the outcome's colour.
  const tick = document.createElement('span')
  tick.className = 'tick'
  tick.setAttribute('aria-hidden', 'true')
  tick.textContent = banner.tone === 'success' ? '✓' : banner.tone === 'pending' ? '↑' : '!'
  const headline = document.createElement('span')
  headline.textContent = banner.headline
  const to = document.createElement('div')
  to.className = 'to'
  to.append(tick, headline)
  confirmEl.append(to)
  if (banner.title) {
    const sub = document.createElement('div')
    sub.className = 'sent-title'
    sub.textContent = banner.title
    confirmEl.append(sub)
  }
  if (banner.detail) {
    const sub = document.createElement('div')
    sub.className = 'note'
    sub.textContent = banner.detail
    confirmEl.append(sub)
  }
  show(emptyEl, false)
  show(targetsEl, false)
  show(pendingEl, false)
  show(heldEl, false)
  show(statusEl, false)
  show(relayEl, false)
  show(multiEl, false)
  confirmEl.classList.add('visible')
  // A confirmation is a glance; a diagnosis has to be readable before the popup
  // takes itself away — and an error keeps the popup open until dismissed.
  if (banner.tone === 'success') setTimeout(() => window.close(), 1400)
  else if (banner.tone === 'pending') setTimeout(() => window.close(), 3600)
}

async function sendTo(targetEndpointId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true
  sending = true
  // Say the click landed, synchronously, before any awaiting starts. A disabled
  // button only dims, which during a slow round trip is indistinguishable from
  // the click having been missed — so people click again.
  btn.classList.add('sending')
  let note = btn.querySelector<HTMLElement>('.last-seen')
  const restore = note?.textContent ?? null
  if (!note) {
    note = document.createElement('span')
    note.className = 'last-seen'
    btn.append(note)
  }
  note.textContent = 'sending…'
  // Put the row back the way it was, so a failure leaves an honest list behind
  // (the view is frozen while `sending`, so nothing else will repaint it).
  const undoSendingState = (): void => {
    btn.classList.remove('sending')
    if (restore === null) note.remove()
    else note.textContent = restore
  }
  const res = await rpcOk<{ ok: true; send: SendResult }>({ type: 'sendTo', targetEndpointId })
  const send = res.send
  // `ok` alone no longer means delivered — a queued-locally send is ok:true with
  // a failure attached, and showOutcome picks the tone from that, not from `ok`.
  if (send.ok) {
    showOutcome(send)
  } else {
    btn.disabled = false
    undoSendingState()
    // The view stays frozen (`sending` untouched): a live WS refresh re-renders
    // the row list and would wipe the diagnosis before it could be read.
    const check = document.createElement('span')
    check.className = 'check error'
    check.textContent = '✗'
    btn.append(check)
    // The message STAYS — the popup is still open and this is the only place
    // the reason is written down. Only the row's ✗ marker times out.
    statusEl.textContent = send.failure ? sendFailureLine(send.failure) : (send.error ?? '')
    statusEl.classList.add('error')
    show(statusEl, true)
    setTimeout(() => check.remove(), 2000)
  }
}

/**
 * The standing relay-outage strip. Rendered from the persisted health verdict,
 * so opening the popup ten minutes into an outage explains itself — instead of
 * showing a normal device list built from the cache while every send queues.
 */
function renderRelayHealth(view: ChooserView): void {
  const now = Date.now()
  if (!isRelayDown(view.relay, now) || !view.relay) {
    show(relayEl, false)
    return
  }
  const reference = view.relay.lastOkAt ?? view.relay.since
  const minutes = Math.max(0, Math.round((now - Date.parse(reference)) / 60000))
  relayEl.textContent = relayDownLine(view.relay.relayUrl, minutes)
  show(relayEl, true)
}

/**
 * "New device: X. Was this you?" (PLANS.md P-10). Removing needs a confirmation
 * dialog, which a popup cannot hold open, so "Remove it" hands over to the
 * manage screen and asks there.
 */
function renderNewDevices(view: ChooserView): void {
  renderDeviceNotices(
    newDevicesEl,
    // `?? []`: a popup from this build can meet a service worker that is still the old one.
    { review: view.review ?? [], vanished: view.vanished ?? [], newDevices: view.newDevices ?? [] },
    {
      confirm: (n) => {
        renderNewDevices({
          ...view,
          newDevices: (view.newDevices ?? []).filter((d) => d.id !== n.id),
        })
        void rpcOk({ type: 'confirmNewDevice', endpointId: n.id }).catch(() => undefined)
      },
      remove: (n) => {
        void ext.tabs.create({
          url: ext.runtime.getURL(`firstrun.html#remove=${encodeURIComponent(n.id)}`),
        })
        window.close()
      },
      confirmReview: () => {
        renderNewDevices({ ...view, review: [] })
        void rpcOk({ type: 'confirmReview' }).catch(() => undefined)
      },
      dismissVanished: (n) => {
        renderNewDevices({ ...view, vanished: (view.vanished ?? []).filter((d) => d.id !== n.id) })
        void rpcOk({ type: 'dismissVanished', endpointId: n.id }).catch(() => undefined)
      },
    },
  )
}

function renderChooser(view: ChooserView, state: StateView): void {
  show(statusEl, false)
  selfLabel.textContent = state.selfLabel ?? ''
  renderRelayHealth(view)
  renderNewDevices(view)

  if (!view.registered || view.targets.length === 0) {
    show(emptyEl, true)
    show(targetsEl, false)
    show(pendingEl, false)
    // Still list tabs held here: with the only other device removed, a tab
    // held for it would otherwise be invisible, and so impossible to discard.
    if (view.registered) renderHeld(view, () => 'a device')
    else show(heldEl, false)
    return
  }

  show(emptyEl, false)
  show(targetsEl, true)
  targetsEl.replaceChildren(...view.targets.map(renderRow))

  // Always require an explicit click to send, even with exactly one target —
  // auto-sending on open (the old "one-row chooser is friction" rule) made the
  // popup flash-close before the "Pair a device" footer could ever be reached,
  // and silently sent the current tab on a bare icon click (dogfood 2026-07-21).

  const labelFor = (id: string): string =>
    view.targets.find((t) => t.endpoint.id === id)?.endpoint.label ?? 'a device'

  // One ⏳ row per target the RELAY is holding for (sent-but-unacked, §3.1) —
  // "it's on its way, that device is asleep".
  if (view.pending.length > 0) {
    pendingEl.replaceChildren(
      ...view.pending.map((p) => {
        const line = document.createElement('div')
        line.textContent = pendingRow(p.count, labelFor(p.targetEndpointId))
        return line
      }),
    )
    show(pendingEl, true)
  } else {
    show(pendingEl, false)
  }

  renderHeld(view, labelFor)
}

/**
 * The tabs still sitting on THIS browser, named.
 *
 * Until now the only sign of a held tab was a count, and during a relay outage
 * even that vanished (the count's source was the relay's own outbox, which is
 * unreachable precisely when it matters). So a user whose relay had been down
 * for an hour could see nothing at all — no list, no count, no way to find out
 * which tabs were stuck or whether they'd been lost. This is that list.
 */
function renderHeld(view: ChooserView, labelFor: (id: string) => string): void {
  if (view.held.length === 0) {
    show(heldEl, false)
    return
  }
  heldEl.replaceChildren()

  const heading = document.createElement('div')
  heading.className = 'held-heading'
  heading.textContent = heldTabsHeading(view.held.length)
  heldEl.append(heading)

  // Newest first: the tab you just sent is the one you're wondering about.
  const rows = [...view.held].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  for (const item of rows) {
    const row = document.createElement('div')
    row.className = 'held-row'

    const name = document.createElement('span')
    name.className = 'held-title'
    name.textContent = heldTabLabel(item)
    // The full URL on hover — the list stays one line per tab, but the tab is
    // still identifiable when two pages share a title.
    if (item.url) name.title = item.url

    if (item.targetGone) {
      // Its device left the group, so "→ <device>" would point nowhere. Say
      // so, and offer the devices it may go to instead (P-15 item 3).
      row.classList.add('gone')
      row.append(name, cancelButton(item, row), goneTargetChoice(item, view))
    } else {
      const to = document.createElement('span')
      to.className = 'held-to'
      // The label saved at send time first: the device list only names devices
      // that are still in it.
      to.textContent = `→ ${item.targetLabel ?? labelFor(item.targetEndpointId)}`
      row.append(name, to, cancelButton(item, row))
    }
    heldEl.append(row)
  }
  show(heldEl, true)
}

/** Up to this many devices get a button each; more get a menu. */
const MAX_RETARGET_BUTTONS = 3

/**
 * "S24 is no longer in your group. Send to: Pixel · Arc", under a held tab
 * whose device is gone. Choosing a device seals the tab again for that device
 * and puts it back in the queue; it then sends like any held tab.
 */
function goneTargetChoice(item: HeldTab, view: ChooserView): HTMLElement {
  const box = document.createElement('div')
  box.className = 'held-gone'
  const line = document.createElement('div')
  line.textContent = goneTargetCopy.removedLine(item.targetLabel, item.removedHere === true)
  box.append(line)

  // Without a web address there is nothing to seal again, and nothing is
  // offered; the × is still there.
  if (!item.choices) return box
  // The rows' order, kept to the devices the background allows for this tab
  // (`heldTabChoices`): accepted and answered for, never this browser, a
  // console, or a device it removed. The send checks the same list again.
  const allowed = new Set(item.choices)
  const others = view.targets.map((t) => t.endpoint).filter((e) => allowed.has(e.id))
  if (others.length === 0) {
    const none = document.createElement('div')
    none.textContent = goneTargetCopy.noOtherDevice
    box.append(none)
    return box
  }

  const choices = document.createElement('div')
  choices.className = 'held-gone-choices'
  const controls: Array<HTMLButtonElement | HTMLSelectElement> = []
  const pick = (endpointId: string): void => {
    for (const c of controls) c.disabled = true
    void retarget(item.id, endpointId)
  }
  if (others.length <= MAX_RETARGET_BUTTONS) {
    const lead = document.createElement('span')
    lead.textContent = goneTargetCopy.sendTo
    choices.append(lead)
    for (const endpoint of others) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'linkish'
      btn.textContent = endpoint.label
      btn.setAttribute('aria-label', goneTargetCopy.sendToAria(heldTabLabel(item), endpoint.label))
      btn.addEventListener('click', () => pick(endpoint.id))
      controls.push(btn)
      choices.append(btn)
    }
  } else {
    const select = document.createElement('select')
    select.setAttribute('aria-label', `${goneTargetCopy.sendToMenu} ${heldTabLabel(item)}`)
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = goneTargetCopy.sendToMenu
    placeholder.disabled = true
    placeholder.selected = true
    select.append(placeholder)
    for (const endpoint of others) {
      const option = document.createElement('option')
      option.value = endpoint.id
      option.textContent = endpoint.label
      select.append(option)
    }
    select.addEventListener('change', () => {
      if (select.value) pick(select.value)
    })
    controls.push(select)
    choices.append(select)
  }
  box.append(choices)
  return box
}

/**
 * Move the tab, then draw the list again from storage: the row now reads
 * "→ <new device>" like any held tab, and leaves once the drain sends it.
 */
async function retarget(id: string, targetEndpointId: string): Promise<void> {
  await rpcOk({ type: 'retargetHeld', id, targetEndpointId }).catch(() => undefined)
  const res = await rpcOk<{ ok: true; chooser: ChooserView }>({
    type: 'getChooser',
    cached: true,
  }).catch(() => undefined)
  if (res && currentState && !sending) renderChooser(res.chooser, currentState)
}

/**
 * The way out of a wait the user no longer wants.
 *
 * The list was read-only, so a tab pointed at a relay that was never coming back
 * could only be watched. This abandons it: a pure local delete, nothing sent,
 * nothing retracted — the same principle as an undo inside the quick-send window.
 *
 * Worded "Stop waiting" rather than "Cancel" for the reason the background
 * comment spells out: it cannot unsend. It stops Tabsend trying, and an item
 * already mid-POST may still land. "Cancel" would promise a reach this has never
 * had, on the one surface where the user is least able to check.
 *
 * The row goes immediately rather than after a re-render. The popup closes on
 * almost every other action, so there is no repaint to wait for, and a list that
 * sat there unchanged for a round trip would read as a click that missed.
 */
function cancelButton(item: HeldTab, row: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'held-cancel'
  btn.textContent = '×'
  btn.title = 'Stop waiting to send this tab'
  btn.setAttribute('aria-label', `Stop waiting to send ${heldTabLabel(item)}`)
  btn.addEventListener('click', () => {
    btn.disabled = true
    row.remove()
    if (heldEl.querySelectorAll('.held-row').length === 0) show(heldEl, false)
    else {
      const heading = heldEl.querySelector('.held-heading')
      if (heading)
        heading.textContent = heldTabsHeading(heldEl.querySelectorAll('.held-row').length)
    }
    void rpcOk({ type: 'cancelHeld', id: item.id }).catch(() => undefined)
  })
  return btn
}

function openFirstRun(): void {
  void ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
  window.close()
}

function openSettings(): void {
  void ext.runtime.openOptionsPage()
  window.close()
}

function openHistory(): void {
  void ext.tabs.create({ url: ext.runtime.getURL('history.html') })
  window.close()
}

async function main(): Promise<void> {
  show(statusEl, true)
  $('open-firstrun').addEventListener('click', openFirstRun)
  wirePairingBox({
    trigger: $<HTMLButtonElement>('pair-header'),
    box: $('pairing-box'),
    qr: $('pairing-qr'),
    link: $<HTMLInputElement>('pairing-link'),
    note: $('pairing-note'),
    localOnly: $('pairing-local-only'),
    copy: $<HTMLButtonElement>('copy-link'),
    copyNote: $('copy-note'),
  })
  $('settings-footer').addEventListener('click', openSettings)
  $('history-footer').addEventListener('click', openHistory)

  // Both in flight at once, and the chooser one asks for the CACHED build: the
  // popup used to await a storage-only `getState`, then a `getChooser` that went
  // to the relay twice, showing "Loading…" for all of it. Rows now appear as
  // soon as the service worker can read storage.
  const [stateRes, cachedRes, selectionRes] = await Promise.all([
    rpcOk<{ ok: true; state: StateView }>({ type: 'getState' }),
    rpcOk<{ ok: true; chooser: ChooserView }>({ type: 'getChooser', cached: true }),
    rpcOk<{ ok: true; selection: { count: number } }>({ type: 'getSelection' }),
  ])
  if (!stateRes.state.registered) {
    openFirstRun()
    return
  }
  const state = stateRes.state
  currentState = state
  // Variant A: with several tabs highlighted, say so once, above the list — the
  // rows themselves stay exactly as they are, each one sends the whole selection.
  selectedCount = Math.max(1, selectionRes.selection.count)
  if (selectedCount > 1) {
    multiEl.textContent = multiSelectionLine(selectedCount)
    show(multiEl, true)
  }
  // Only when the cache actually has rows. An empty cache (first open after
  // pairing) would otherwise flash the "pair a device" empty state for a round
  // trip and then replace it with the device list, which reads as a glitch —
  // "Loading…" is the honest thing to show while we genuinely don't know.
  if (cachedRes.chooser.targets.length > 0) renderChooser(cachedRes.chooser, state)

  // The real thing, which also refreshes presence dots, the ⏳ outbox row and
  // the relay-health strip. A send started before it lands must not be wiped.
  const chooserRes = await rpcOk<{ ok: true; chooser: ChooserView }>({ type: 'getChooser' })
  if (!sending) renderChooser(chooserRes.chooser, state)

  // Live updates while the popup is open: the SW pushes a 'refresh' over this
  // port when a WS presence/ack/endpoint event lands, so the dots and the ⏳
  // pending row stay current without polling. Socket down ⇒ no refreshes, no harm.
  try {
    const port = ext.runtime.connect({ name: 'chooser' })
    port.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type !== 'refresh' || sending) return
      void rpcOk<{ ok: true; chooser: ChooserView }>({ type: 'getChooser' }).then((res) => {
        if (!sending) renderChooser(res.chooser, state)
      })
    })
  } catch {
    // connect can throw if the SW is mid-reload — the initial render still stands.
  }
}

void main()
