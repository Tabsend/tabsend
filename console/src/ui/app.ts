import {
  defaultDeviceName,
  type Endpoint,
  endpointLabel,
  resolveBrowserName,
} from '@tabsend/shared'
import { type Controller, detectPlatform, type GroupHistoryStatus } from '../lib/controller'
import type { DeviceRow, HistoryEntry } from '../lib/model'
import { effect, signal } from '../lib/store'
import { absoluteTime, relativeTime } from '../lib/time'
import {
  batchHeading,
  deliveryBadge,
  groupHistory,
  type HistoryGroup,
  hostOf,
  resolveEntryLabel,
  SEALED_ROW_NOTE,
  SEALED_ROW_TITLE,
  toDeviceRows,
} from '../lib/view'
import { el, replaceChildren, svg } from './dom'
import { qrSvg } from './qr'

/**
 * The console UI. A handful of panels re-rendered by `effect()`s that read the
 * controller's signals. Dialogs (rename, remove, unpair confirm) live in a UI-local
 * signal so a 20-second poll re-render can't clobber an in-progress edit.
 */

type Tab = 'devices' | 'history' | 'account'
type Dialog =
  | { kind: 'rename'; endpoint: Endpoint }
  | { kind: 'remove'; endpoint: Endpoint; isSelf: boolean }
  | { kind: 'unpair' }
  | null

const LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`

export function mountApp(root: HTMLElement, controller: Controller): void {
  const activeTab = signal<Tab>('devices')
  const dialog = signal<Dialog>(null)

  const header = el('header', { class: 'app-header' })
  const panel = el('main', { class: 'app-main' })
  const statusBar = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' })
  const modalHost = el('div', { class: 'modal-host' })

  replaceChildren(root, header, panel, statusBar, modalHost)

  // --- header ---------------------------------------------------------------
  effect(() => {
    const session = controller.session.get()
    const conn = controller.connection.get()
    const brand = el('div', { class: 'brand' }, svg(LOGO), el('span', {}, 'Tabsend Console'))
    const right = el('div', { class: 'header-right' })
    if (session) {
      right.append(
        connBadge(conn),
        el('span', { class: 'self-label', title: 'This console' }, session.label),
      )
    }
    replaceChildren(header, brand, right)
  })

  // --- main panel -----------------------------------------------------------
  effect(() => {
    const phase = controller.phase.get()
    if (phase === 'loading') {
      replaceChildren(panel, el('p', { class: 'muted center' }, 'Loading…'))
      return
    }
    if (phase === 'onboarding') {
      replaceChildren(panel, renderOnboarding(controller))
      return
    }
    replaceChildren(
      panel,
      renderNewDevices(controller, dialog),
      renderTabs(activeTab),
      renderTabBody(controller, activeTab, dialog),
    )
  })

  // --- status line ----------------------------------------------------------
  effect(() => {
    const s = controller.status.get()
    statusBar.className = `status ${s.kind}`
    statusBar.textContent = s.message
  })

  // --- dialogs + pairing modal ---------------------------------------------
  effect(() => {
    const d = dialog.get()
    const pairing = controller.pairing.get()
    if (pairing) {
      replaceChildren(modalHost, renderPairingModal(controller))
      return
    }
    if (!d) {
      replaceChildren(modalHost)
      return
    }
    replaceChildren(modalHost, renderDialog(controller, d, dialog))
  })
}

// --- connection badge --------------------------------------------------------

function connBadge(conn: string): HTMLElement {
  const label = conn === 'live' ? 'Live' : conn === 'polling' ? 'Polling' : 'Offline'
  return el(
    'span',
    { class: `conn conn-${conn}`, title: connTitle(conn) },
    el('span', { class: 'dot' }),
    label,
  )
}

function connTitle(conn: string): string {
  if (conn === 'live') return 'Real-time updates over the WebSocket fast path'
  if (conn === 'polling') return 'WebSocket down — refreshing every 20s (nothing is lost)'
  return 'Not connected to the relay'
}

// --- onboarding --------------------------------------------------------------

function renderOnboarding(controller: Controller): HTMLElement {
  const input = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'https://your-relay/pair#c=…',
    autocomplete: 'off',
    spellcheck: false,
  }) as HTMLInputElement
  // Seed the name with the machine this console runs on, so two consoles in one
  // group aren't both "Web console". The browser half stays generic unless the
  // browser actually named itself: a console isn't a send target, so "which
  // browser" matters less here than "which machine". The relay de-duplicates
  // whatever we end up sending.
  const seed = (browser: string): string =>
    endpointLabel(browser, defaultDeviceName(detectPlatform()))
  const name = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'Name this console (e.g. "Ben\'s web console")',
    value: seed('Web console'),
  }) as HTMLInputElement
  void resolveBrowserName().then((suggestion) => {
    // Only an identified browser is worth naming, and never over live typing.
    if (!suggestion.confident || name.value !== seed('Web console')) return
    name.value = seed(`${suggestion.value} console`)
  })

  const submit = (): void => {
    void controller.join(input.value, name.value)
  }
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') submit()
  })

  return el(
    'section',
    { class: 'card onboarding' },
    el('h1', {}, 'Pair this console'),
    el(
      'p',
      { class: 'muted' },
      'The console is a device in your Tabsend group. Open Tabsend on an already-paired browser, choose ',
      el('em', {}, 'Add a device'),
      ', and paste its pairing link here.',
    ),
    el('label', { class: 'field-label' }, 'Pairing link'),
    input,
    el('label', { class: 'field-label' }, 'Console name'),
    name,
    el('button', { class: 'btn primary', onClick: submit }, 'Pair console'),
    el(
      'p',
      { class: 'note' },
      'End-to-end encrypted: the console reads your group history with a key the relay never holds. ',
      'It never opens tabs and is never a send target.',
    ),
  )
}

// --- what the new-device watch asks this console to look at (PLANS.md P-10) ---

/**
 * Above the tabs, so it shows whichever tab is open. Top to bottom: the first-look
 * card (one answer for the whole first list), one notice per device that joined and
 * then disappeared, and one banner per joined device not yet answered. The words
 * match every other client.
 */
function renderNewDevices(controller: Controller, dialog: { set(d: Dialog): void }): HTMLElement {
  const host = el('div', { class: 'new-devices' })
  // A time the relay sent that cannot be read says "recently", like the phones do.
  const when = (iso: string): string => {
    const text = relativeTime(iso)
    return text === 'unknown' ? 'recently' : text
  }
  const removeButton = (id: string, text: string): HTMLElement => {
    const endpoint = controller.endpoints.get().find((e) => e.id === id)
    return endpoint
      ? el(
          'button',
          {
            class: 'btn small danger',
            'aria-label': `${text} ${endpoint.label}`,
            onClick: () => dialog.set({ kind: 'remove', endpoint, isSelf: false }),
          },
          text,
        )
      : el('span')
  }
  effect(() => {
    const review = controller.review.get()
    const vanished = controller.vanished.get()
    const notices = controller.newDevices.get()
    // The list the remove buttons look devices up in; read here so a removal redraws.
    controller.endpoints.get()
    const cards: HTMLElement[] = []
    if (review.length > 0) {
      cards.push(
        el(
          'div',
          { class: 'new-device', role: 'status' },
          el('div', { class: 'new-device-title' }, 'Check your devices'),
          el(
            'p',
            { class: 'new-device-body' },
            "Your group has these devices. A device you don't know could read the links you send, so remove it.",
          ),
          ...review.map((n) =>
            el(
              'div',
              { class: 'new-device-row' },
              el('span', {}, n.label),
              removeButton(n.id, 'Remove'),
            ),
          ),
          el(
            'div',
            { class: 'new-device-actions' },
            el(
              'button',
              { class: 'btn small', onClick: () => controller.confirmReview() },
              'All of these are mine',
            ),
          ),
        ),
      )
    }
    for (const n of vanished) {
      cards.push(
        el(
          'div',
          { class: 'new-device', role: 'status' },
          el('div', { class: 'new-device-title' }, `${n.label} joined, then disappeared`),
          el(
            'p',
            { class: 'new-device-body' },
            `It joined ${when(n.createdAt)} and is no longer in your list. Your relay may be hiding it. It could have read the links sent while it was listed. If you removed it yourself, you can dismiss this.`,
          ),
          el(
            'div',
            { class: 'new-device-actions' },
            el(
              'button',
              { class: 'btn small', onClick: () => controller.dismissVanished(n.id) },
              'Dismiss',
            ),
          ),
        ),
      )
    }
    for (const n of notices) {
      cards.push(
        el(
          'div',
          { class: 'new-device', role: 'status' },
          el('div', { class: 'new-device-title' }, `New device: ${n.label}`),
          el(
            'p',
            { class: 'new-device-body' },
            `Joined ${when(n.createdAt)}. Was this you? If it isn't yours, remove it. It could read the links you send.`,
          ),
          el(
            'div',
            { class: 'new-device-actions' },
            el(
              'button',
              { class: 'btn small', onClick: () => controller.confirmNewDevice(n.id) },
              "Yes, it's mine",
            ),
            removeButton(n.id, 'Remove it'),
          ),
        ),
      )
    }
    replaceChildren(host, ...cards)
  })
  return host
}

// --- tabs --------------------------------------------------------------------

function renderTabs(activeTab: { get(): Tab; set(t: Tab): void }): HTMLElement {
  const tab = (id: Tab, label: string): HTMLElement =>
    el(
      'button',
      {
        class: `tab ${activeTab.get() === id ? 'active' : ''}`,
        onClick: () => activeTab.set(id),
      },
      label,
    )
  return el(
    'nav',
    { class: 'tabs' },
    tab('devices', 'Devices'),
    tab('history', 'History'),
    tab('account', 'Account'),
  )
}

function renderTabBody(
  controller: Controller,
  activeTab: { get(): Tab },
  dialog: { set(d: Dialog): void },
): HTMLElement {
  const host = el('div', { class: 'tab-body' })
  // Nested effect: re-render the active tab's body when its data changes.
  effect(() => {
    const tab = activeTab.get()
    if (tab === 'devices') replaceChildren(host, renderDevices(controller, dialog))
    else if (tab === 'history') replaceChildren(host, renderHistory(controller))
    else replaceChildren(host, renderAccount(controller, dialog))
  })
  return host
}

// --- devices panel -----------------------------------------------------------

function renderDevices(controller: Controller, dialog: { set(d: Dialog): void }): HTMLElement {
  const session = controller.session.get()
  // An offline connection means this list is the last one that arrived, so its
  // presence is a snapshot of unknown age rather than a live verdict.
  const rows = toDeviceRows(
    controller.endpoints.get(),
    session,
    Date.now(),
    controller.connection.get() !== 'offline',
  )

  const list = el('ul', { class: 'device-list' })
  if (rows.length === 0) {
    list.append(el('li', { class: 'muted' }, 'No devices yet.'))
  }
  for (const row of rows) list.append(renderDeviceRow(row, dialog))

  return el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h2', {}, 'Devices'),
      el(
        'button',
        { class: 'btn primary', onClick: () => void controller.addDevice() },
        'Add a device',
      ),
    ),
    el(
      'p',
      { class: 'muted' },
      'Everything in your group. Rename or remove any device; the console is excluded from send choosers.',
    ),
    list,
  )
}

function renderDeviceRow(row: DeviceRow, dialog: { set(d: Dialog): void }): HTMLElement {
  const meta = el('div', { class: 'device-meta' })
  const tags: HTMLElement[] = []
  if (row.isSelf) tags.push(el('span', { class: 'tag tag-self' }, 'this console'))
  if (row.isConsole && !row.isSelf) tags.push(el('span', { class: 'tag' }, 'console'))
  if (row.stale) tags.push(el('span', { class: 'tag tag-stale' }, 'inactive'))

  meta.append(
    el('span', { class: `dot ${row.presenceKnown ? row.presence : 'unknown'}` }),
    el('span', { class: 'device-name' }, row.endpoint.label),
    ...tags,
  )

  const sub = el(
    'div',
    { class: 'device-sub muted' },
    kindLabel(row.endpoint),
    ' · ',
    el('span', { title: absoluteTime(row.endpoint.lastSeenAt) }, row.lastSeenLabel),
  )

  const actions = el(
    'div',
    { class: 'device-actions' },
    el(
      'button',
      { class: 'btn small', onClick: () => dialog.set({ kind: 'rename', endpoint: row.endpoint }) },
      'Rename',
    ),
    el(
      'button',
      {
        class: 'btn small danger',
        onClick: () => dialog.set({ kind: 'remove', endpoint: row.endpoint, isSelf: row.isSelf }),
      },
      'Remove',
    ),
  )

  return el(
    'li',
    { class: `device ${row.stale ? 'is-stale' : ''}` },
    el('div', { class: 'device-info' }, meta, sub),
    actions,
  )
}

function kindLabel(endpoint: Endpoint): string {
  const kind =
    endpoint.kind === 'extension'
      ? 'Browser'
      : endpoint.kind === 'mobile'
        ? 'Phone'
        : endpoint.kind === 'console'
          ? 'Console'
          : 'Helper'
  const browser = endpoint.browser ? ` · ${cap(endpoint.browser)}` : ''
  const platform = endpoint.platform !== 'unknown' ? ` · ${platformLabel(endpoint.platform)}` : ''
  return `${kind}${browser}${platform}`
}

// --- history panel -----------------------------------------------------------
//
// One merged timeline of EVERY transfer in the group, newest first, each row
// carrying what became of it [ADR-0028]. The console is never one of the two ends
// itself, so every row names both: "Source → Target", with the arrow only ever
// between two device names.
//
// Direction is carried by mail imagery, not a bare arrow [ADR-0028 §9]: a paper
// plane at the end that sent, a tray at the end that was meant to receive. On the
// other clients one of those two ends is the device you are holding, which is
// what makes a single glyph in the gutter meaningful there. Here neither end ever
// is, so the glyphs travel WITH the names instead of standing in for them: a lone
// arrow or a lone icon in a third-party row says nothing about who is who, and an
// icon in the left gutter of a list reads as a drag handle.

/** Feather-style paper plane: the end that sent. */
const PLANE = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`
/** Feather-style tray: the end it was addressed to. */
const TRAY = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`

function renderHistory(controller: Controller): HTMLElement {
  const entries = controller.history.get()
  const endpoints = controller.endpoints.get()
  const status = controller.groupHistory.get()
  const awaitingKey = controller.awaitingGroupKey.get()

  const list = el('ol', { class: 'history-list' })
  if (entries.length === 0) {
    list.append(el('li', { class: 'muted empty' }, emptyHistoryText(status)))
  }
  for (const group of groupHistory(entries)) list.append(renderHistoryGroup(group, endpoints))

  return el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h2', {}, 'History'),
      entries.length > 0
        ? el(
            'button',
            {
              class: 'btn small',
              title:
                'Empties this browser cache. Group history comes back from the relay on the next refresh. Older per-console copies only exist here, so those are gone for good.',
              onClick: () => void controller.clearHistory(),
            },
            'Clear local copy',
          )
        : null,
    ),
    el('p', { class: 'muted' }, historyIntro(status)),
    // Retention is stated on the surface, not buried in a config file: this list
    // is not permanent and a reader planning to come back for a link deserves to
    // know that before they need it.
    status === 'ready'
      ? el(
          'p',
          { class: 'note muted' },
          'The relay keeps group history for a limited window and then drops it. This browser caches what you see here, so the panel still reads while the relay is unreachable.',
        )
      : null,
    // An old relay is a state, not a failure: the panel keeps working on the
    // copies it always ran on, and says which of the two it is showing.
    status === 'unavailable'
      ? el(
          'p',
          { class: 'note warn' },
          'This relay does not serve group history yet, so this list holds only the copies senders sealed to this console, and it cannot say whether a tab arrived. Update the relay to see every transfer in the group.',
        )
      : null,
    awaitingKey && status === 'ready'
      ? el(
          'p',
          { class: 'note warn' },
          'No group history key has reached this console yet, so transfers are listed without their content. A key arrives from another paired device the next time one is awake. This console never creates one itself.',
        )
      : null,
    list,
  )
}

function historyIntro(status: GroupHistoryStatus): string {
  if (status === 'unavailable') {
    return 'Tabs sent within your group, sealed by the sender and decrypted here.'
  }
  return 'Every transfer in your group, newest first, with what became of it. This includes tabs sent before this console was paired, and tabs that never arrived.'
}

function emptyHistoryText(status: GroupHistoryStatus): string {
  if (status === 'unavailable') {
    return 'Nothing here yet. This relay does not serve group history, so only tabs a sender sealed a copy of to this console can appear.'
  }
  return 'Nothing here yet. When a device in your group sends a tab, it appears here with what became of it.'
}

/**
 * A single send renders as one row. A multi-tab send renders as ONE block: the
 * route is stated once in the header and the tabs sit under it, so five tabs sent
 * together no longer read as five separate sends.
 */
function renderHistoryGroup(group: HistoryGroup, endpoints: Endpoint[]): HTMLElement {
  const first = group.entries[0]
  if (!group.batchId || !first) {
    return renderHistoryEntry(first as HistoryEntry, endpoints)
  }

  const head = el(
    'div',
    { class: 'batch-head' },
    el('span', { class: 'batch-count' }, batchHeading(group)),
    el('span', { class: 'sep' }, '·'),
    routeNode(first, endpoints),
    el('span', { class: 'sep' }, '·'),
    el(
      'span',
      { class: 'muted', title: absoluteTime(first.sentAt) },
      `sent ${relativeTime(first.sentAt)}`,
    ),
  )

  const inner = el('ol', { class: 'batch-list' })
  for (const entry of group.entries) inner.append(renderHistoryEntry(entry, endpoints, false))
  return el('li', { class: 'entry-group' }, head, inner)
}

/** "✈ Source → 📥 Target" — both ends named, each carrying its own mail glyph. */
function routeNode(entry: HistoryEntry, endpoints: Endpoint[]): HTMLElement {
  return el(
    'span',
    { class: 'entry-route muted' },
    el(
      'span',
      { class: 'mail-end', title: 'Sent by' },
      svg(PLANE),
      resolveEntryLabel(entry, 'source', endpoints),
    ),
    el('span', { class: 'arrow' }, ' → '),
    el(
      'span',
      { class: 'mail-end', title: 'Sent to' },
      svg(TRAY),
      resolveEntryLabel(entry, 'target', endpoints),
    ),
  )
}

function renderHistoryEntry(
  entry: HistoryEntry,
  endpoints: Endpoint[],
  showRoute = true,
): HTMLElement {
  const url = entry.url
  const href = url ? safeHref(url) : null
  // A row we hold but cannot open is still a true record that the transfer
  // happened, so it keeps its place in the timeline and says what is missing.
  const titleText = url
    ? entry.title && entry.title.trim() !== ''
      ? entry.title
      : hostOf(url)
    : SEALED_ROW_TITLE

  const titleNode = href
    ? el(
        'a',
        { class: 'entry-title', href, target: '_blank', rel: 'noopener noreferrer' },
        titleText,
      )
    : el(
        'span',
        { class: `entry-title ${url ? '' : 'sealed'}`, title: url ? undefined : SEALED_ROW_NOTE },
        titleText,
      )

  const badge = deliveryBadge(entry)
  const foot = el(
    'div',
    { class: 'entry-foot muted' },
    url ? el('span', { class: 'entry-host' }, hostOf(url)) : null,
    url ? el('span', { class: 'sep' }, '·') : null,
    el('span', { title: absoluteTime(entry.sentAt) }, `sent ${relativeTime(entry.sentAt)}`),
    badge
      ? el('span', { class: `state state-${badge.state}`, title: badge.note }, badge.label)
      : null,
    url
      ? el('button', { class: 'btn tiny', onClick: (e) => void copy(url, e) }, 'Copy link')
      : null,
  )

  const icon = faviconNode(entry.favicon)
  // Inside a batch block the route is already in the header, so repeating it on
  // every tab would just be the same two device names five times over.
  return el(
    'li',
    { class: 'entry' },
    icon,
    el(
      'div',
      { class: 'entry-body' },
      showRoute ? el('div', { class: 'entry-route-line' }, routeNode(entry, endpoints)) : null,
      titleNode,
      foot,
    ),
  )
}

/** Only render a favicon when it is a self-contained data: URL — never fetch a remote
 *  favicon, which would leak the recorded browsing to that origin (privacy). */
function faviconNode(favicon: string | undefined): HTMLElement {
  if (favicon?.startsWith('data:')) {
    return el('img', { class: 'entry-icon', src: favicon, alt: '', width: 16, height: 16 })
  }
  return el('span', { class: 'entry-icon placeholder', 'aria-hidden': 'true' })
}

async function copy(text: string, ev?: Event): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    const btn = ev?.target as HTMLElement | undefined
    if (btn) {
      const prev = btn.textContent
      btn.textContent = 'Copied'
      setTimeout(() => {
        btn.textContent = prev
      }, 1200)
    }
  } catch {
    // clipboard blocked — no-op; the link is still visible/hoverable
  }
}

// --- account panel -----------------------------------------------------------

function renderAccount(controller: Controller, dialog: { set(d: Dialog): void }): HTMLElement {
  const session = controller.session.get()
  const relayText =
    session && session.relayUrl !== '' ? session.relayUrl : 'same origin as this page'
  const push = controller.pushEnabled.get()
  const keys = controller.keyring.get().length

  return el(
    'section',
    { class: 'panel' },
    el('h2', {}, 'Account'),

    el(
      'div',
      { class: 'kv' },
      kv('Relay', relayText),
      kv('Group', session?.groupId ?? '—'),
      kv('This console', session?.endpointId ?? '—'),
      kv(
        'Push wake',
        push ? 'enabled on this relay' : 'not configured (the console pulls; it needs no push)',
      ),
      // A count, not the keys: it answers "why can this console not read that
      // row", which is the only question the number is good for. More than one is
      // normal, because a rotated key is kept so older history stays readable.
      kv('History keys', keys === 0 ? 'none received yet' : `${keys} held`),
    ),

    el('h3', {}, 'Getting back in'),
    el(
      'p',
      { class: 'muted' },
      'There is no recovery phrase and no backup credential (ADR-0021). Adding a device — including this console — always works the same way: an already-paired device creates a pairing link.',
    ),
    el(
      'div',
      { class: 'note' },
      'If you ever lose every paired device at once, there is nothing left to restore: the group’s remaining endpoints are dead, and its history is end-to-end encrypted to keys that no longer exist. Preserve the old relay state, start the relay with a new empty database, and pair your devices again.',
    ),

    el('h3', {}, 'This console'),
    el(
      'p',
      { class: 'muted' },
      'Unpair removes this console’s keys and history from THIS browser only. To remove it from the group everywhere, use ',
      el('em', {}, 'Remove'),
      ' on its row in Devices.',
    ),
    el(
      'button',
      { class: 'btn danger', onClick: () => dialog.set({ kind: 'unpair' }) },
      'Unpair this console',
    ),
  )
}

function kv(key: string, value: string): HTMLElement {
  return el(
    'div',
    { class: 'kv-row' },
    el('span', { class: 'kv-key' }, key),
    el('span', { class: 'kv-val' }, value),
  )
}

// --- dialogs -----------------------------------------------------------------

function renderDialog(
  controller: Controller,
  d: NonNullable<Dialog>,
  dialog: { set(x: Dialog): void },
): HTMLElement {
  const close = (): void => dialog.set(null)
  if (d.kind === 'rename') return renderRenameDialog(controller, d.endpoint, close)
  if (d.kind === 'remove') return renderRemoveDialog(controller, d.endpoint, d.isSelf, close)
  return renderUnpairDialog(controller, close)
}

function overlay(...children: HTMLElement[]): HTMLElement {
  const card = el('div', { class: 'dialog card' }, ...children)
  return el('div', { class: 'overlay' }, card)
}

function renderRenameDialog(
  controller: Controller,
  endpoint: Endpoint,
  close: () => void,
): HTMLElement {
  const input = el('input', {
    class: 'field',
    type: 'text',
    value: endpoint.label,
  }) as HTMLInputElement
  const save = (): void => {
    const label = input.value.trim()
    if (label !== '' && label !== endpoint.label) void controller.rename(endpoint.id, label)
    close()
  }
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') save()
  })
  return overlay(
    el('h3', {}, 'Rename device'),
    el('label', { class: 'field-label' }, 'Label'),
    input,
    dialogButtons(close, el('button', { class: 'btn primary', onClick: save }, 'Save')),
  )
}

function renderRemoveDialog(
  controller: Controller,
  endpoint: Endpoint,
  isSelf: boolean,
  close: () => void,
): HTMLElement {
  const consequence = isSelf
    ? 'This is this console. Removing it ends this session and clears its local history; you would re-pair to use the console again.'
    : `“${endpoint.label}” will stop receiving tabs and disappear from every device’s chooser. Any tabs still queued for it are dropped. It must be re-paired to rejoin.`
  return overlay(
    el('h3', {}, 'Remove device'),
    el('p', { class: 'muted' }, consequence),
    dialogButtons(
      close,
      el(
        'button',
        {
          class: 'btn danger',
          onClick: () => {
            void controller.remove(endpoint.id)
            close()
          },
        },
        'Remove',
      ),
    ),
  )
}

function renderUnpairDialog(controller: Controller, close: () => void): HTMLElement {
  return overlay(
    el('h3', {}, 'Unpair this console'),
    el(
      'p',
      { class: 'muted' },
      'Removes this console’s keys and recorded history from this browser only. The group keeps the endpoint until you Remove it from Devices.',
    ),
    dialogButtons(
      close,
      el(
        'button',
        {
          class: 'btn danger',
          onClick: () => {
            controller.unpair()
            close()
          },
        },
        'Unpair',
      ),
    ),
  )
}

function dialogButtons(close: () => void, confirm: HTMLElement): HTMLElement {
  return el(
    'div',
    { class: 'dialog-actions' },
    el('button', { class: 'btn', onClick: close }, 'Cancel'),
    confirm,
  )
}

// --- pairing modal ("add a device") -----------------------------------------

function renderPairingModal(controller: Controller): HTMLElement {
  const pairing = controller.pairing.get()
  if (!pairing) return el('div')
  const close = (): void => controller.dismissPairing()

  const qr = el('div', { class: 'qr' })
  qr.append(svg(qrSvg(pairing.qrLink, { cellSize: 5 })))

  return overlay(
    el('h3', {}, 'Add a device'),
    el(
      'p',
      { class: 'muted' },
      'Scan this QR with a phone, or copy the link to a browser extension. It expires soon.',
    ),
    qr,
    el(
      'div',
      { class: 'pair-actions' },
      el(
        'button',
        { class: 'btn small', onClick: (e) => void copy(pairing.link, e) },
        'Copy pairing link',
      ),
    ),
    // A loopback link isn't an error — the mint succeeded — so this sits beside
    // the QR rather than replacing it: pairing a second client on this same
    // machine still works. Everything else scanning it would dead-end silently.
    ...(pairing.localOnly
      ? [
          el(
            'p',
            { class: 'note warn' },
            `This link points at ${pairing.relayUrl}, which only works for another browser on this same computer — a phone or another device cannot use it. To pair those, the relay needs to be reachable on your network, and this console connected to it at that address.`,
          ),
        ]
      : pairing.routeNote
        ? [el('p', { class: 'note warn' }, pairing.routeNote)]
        : []),
    el(
      'p',
      { class: 'note muted' },
      `Expires ${absoluteTime(pairing.expiresAt)}. Mint a new one if it lapses.`,
    ),
    dialogButtons(close, el('button', { class: 'btn primary', onClick: close }, 'Done')),
  )
}

// --- small helpers -----------------------------------------------------------

function safeHref(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? url : null
  } catch {
    return null
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function platformLabel(p: string): string {
  const map: Record<string, string> = {
    macos: 'macOS',
    windows: 'Windows',
    linux: 'Linux',
    android: 'Android',
    ios: 'iOS',
  }
  return map[p] ?? p
}
