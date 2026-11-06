import { type Endpoint, endpointLabel, resolveBrowserName } from '@tabsend/shared'
import { type Controller, detectPlatform, type GroupHistoryStatus } from '../lib/controller'
import { t } from '../lib/i18n'
import type { DeviceRow, HistoryEntry } from '../lib/model'
import { effect, signal } from '../lib/store'
import { absoluteTime, isReadableTime, relativeTime } from '../lib/time'
import {
  batchHeading,
  connectionTitle,
  deliveryBadge,
  groupHistory,
  groupResetCopy,
  type HistoryGroup,
  hostOf,
  introCopy,
  projectLinks,
  resolveEntryLabel,
  sealedRowNote,
  sealedRowTitle,
  toDeviceRows,
} from '../lib/view'
import { el, replaceChildren, richNodes, svg } from './dom'
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

  replaceChildren(root, header, panel, renderFooter(), statusBar, modalHost)

  // --- header ---------------------------------------------------------------
  effect(() => {
    const session = controller.session.get()
    const conn = controller.connection.get()
    const brand = el('div', { class: 'brand' }, svg(LOGO), el('span', {}, t('app.brand')))
    const right = el('div', { class: 'header-right' })
    if (session) {
      right.append(
        connBadge(conn, session.relayUrl !== '' ? session.relayUrl : window.location.origin),
        el('span', { class: 'self-label', title: t('app.header.thisConsole') }, session.label),
      )
    } else {
      right.append(
        el('a', { class: 'home-link', href: 'https://tabsend.org' }, t('app.header.back')),
      )
    }
    replaceChildren(header, brand, right)
  })

  // --- main panel -----------------------------------------------------------
  effect(() => {
    const phase = controller.phase.get()
    if (phase === 'loading') {
      replaceChildren(panel, el('p', { class: 'muted center' }, t('app.loading')))
      return
    }
    if (phase === 'onboarding') {
      replaceChildren(panel, renderOnboarding(controller))
      return
    }
    replaceChildren(
      panel,
      renderNewDevices(controller),
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

function connBadge(conn: string, relayUrl: string): HTMLElement {
  const label =
    conn === 'live'
      ? t('connection.live.label')
      : conn === 'polling'
        ? t('connection.polling.label')
        : t('connection.offline.label')
  return el(
    'span',
    { class: `conn conn-${conn}`, title: connectionTitle(conn, relayUrl) },
    el('span', { class: 'dot' }),
    label,
  )
}

// --- onboarding --------------------------------------------------------------

function renderOnboarding(controller: Controller): HTMLElement {
  const input = el('input', {
    class: 'field',
    type: 'text',
    placeholder: t('onboarding.setupLink.placeholder'),
    autocomplete: 'off',
    spellcheck: false,
  }) as HTMLInputElement
  // Seed the name with the machine this console runs on, so two consoles in one
  // group aren't both "Web console". The browser half stays generic unless the
  // browser actually named itself: a console isn't a send target, so "which
  // browser" matters less here than "which machine". The relay de-duplicates
  // whatever we end up sending.
  const seed = (browser: string): string =>
    endpointLabel(browser, t('onboarding.name.deviceSeed', { platform: detectPlatform() }))
  const startName = seed(t('onboarding.name.default'))
  const name = el('input', {
    class: 'field',
    type: 'text',
    placeholder: t('onboarding.name.placeholder'),
    value: startName,
  }) as HTMLInputElement
  void resolveBrowserName().then((suggestion) => {
    // Only an identified browser is worth naming, and never over live typing.
    if (!suggestion.confident || name.value !== startName) return
    name.value = seed(t('onboarding.name.withBrowser', { browser: suggestion.value }))
  })

  // One sentence with a link in it: the translator moves the words and the link together.
  const newHere = richNodes(
    'onboarding.newHere',
    {},
    { link: (text) => el('a', { href: 'https://tabsend.org' }, text) },
  )

  const submit = (): void => {
    void controller.join(input.value, name.value)
  }
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') submit()
  })

  return el(
    'div',
    { class: 'onboarding' },
    el(
      'section',
      { class: 'intro' },
      el('h1', {}, introCopy.title),
      el('p', {}, introCopy.what),
      el('p', { class: 'muted' }, ...newHere),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, introCopy.pairTitle),
      el('p', { class: 'muted' }, introCopy.pairBody),
      el('label', { class: 'field-label' }, t('onboarding.setupLink.label')),
      input,
      el('label', { class: 'field-label' }, t('onboarding.name.label')),
      name,
      el('button', { class: 'btn primary', onClick: submit }, t('onboarding.submit')),
      el('p', { class: 'note' }, introCopy.privacy),
    ),
  )
}

/** Links to the project's own pages, under every screen. */
function renderFooter(): HTMLElement {
  const nav = el('nav', { class: 'app-footer', 'aria-label': t('app.footer.label') })
  projectLinks(window.location.hostname).forEach((link, i) => {
    if (i > 0) nav.append(el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'))
    nav.append(el('a', { href: link.href }, link.label))
  })
  return nav
}

// --- what the new-device watch asks this console to look at (PLANS.md P-10) ---

/**
 * Above the tabs, so it shows whichever tab is open. Top to bottom: a reset that
 * waits (P-18 item 12; danger-toned, with Stop and "It was me"), and one notice per
 * device that joined and then disappeared. A device that joins is told once by a phone or
 * a browser and is otherwise just in the list (P-23). The words match every other client.
 */
function renderNewDevices(controller: Controller): HTMLElement {
  const host = el('div', { class: 'new-devices' })
  // A time the relay sent that cannot be read says "recently", like the phones do.
  const when = (iso: string): string => {
    return isReadableTime(iso) ? relativeTime(iso) : t('time.recently')
  }
  effect(() => {
    const vanished = controller.vanished.get()
    const reset = controller.groupReset.get()
    const busy = controller.busy.get()
    const cards: HTMLElement[] = []
    if (reset) {
      cards.push(
        el(
          'div',
          { class: 'new-device group-reset', role: 'alert' },
          el('div', { class: 'new-device-title' }, groupResetCopy.title),
          el(
            'p',
            { class: 'new-device-body' },
            groupResetCopy.body(reset.requestedAt, reset.resetsAt),
          ),
          el(
            'div',
            { class: 'new-device-actions' },
            el(
              'button',
              {
                class: 'btn small danger',
                disabled: busy,
                onClick: () => void controller.stopGroupReset(),
              },
              groupResetCopy.stop,
            ),
            el(
              'button',
              { class: 'btn small', disabled: busy, onClick: () => controller.dismissGroupReset() },
              groupResetCopy.dismiss,
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
          el(
            'div',
            { class: 'new-device-title' },
            t('devices.vanished.title', { device: n.label }),
          ),
          el(
            'p',
            { class: 'new-device-body' },
            t('devices.vanished.body', { ago: when(n.createdAt) }),
          ),
          el(
            'div',
            { class: 'new-device-actions' },
            el(
              'button',
              { class: 'btn small', onClick: () => controller.dismissVanished(n.id) },
              t('common.dismiss'),
            ),
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
    tab('devices', t('app.tab.devices')),
    tab('history', t('app.tab.history')),
    tab('account', t('app.tab.account')),
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
    list.append(el('li', { class: 'muted' }, t('devices.empty')))
  }
  for (const row of rows) list.append(renderDeviceRow(row, dialog))

  return el(
    'section',
    { class: 'panel' },
    el(
      'div',
      { class: 'panel-head' },
      el('h2', {}, t('devices.title')),
      el(
        'button',
        { class: 'btn primary', onClick: () => void controller.addDevice() },
        t('devices.add'),
      ),
    ),
    el('p', { class: 'muted' }, t('devices.intro')),
    list,
  )
}

function renderDeviceRow(row: DeviceRow, dialog: { set(d: Dialog): void }): HTMLElement {
  const meta = el('div', { class: 'device-meta' })
  const tags: HTMLElement[] = []
  if (row.isSelf) tags.push(el('span', { class: 'tag tag-self' }, t('devices.tag.self')))
  if (row.isConsole && !row.isSelf)
    tags.push(el('span', { class: 'tag' }, t('devices.tag.console')))
  if (row.stale) tags.push(el('span', { class: 'tag tag-stale' }, t('devices.tag.inactive')))

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
      t('common.rename'),
    ),
    el(
      'button',
      {
        class: 'btn small danger',
        onClick: () => dialog.set({ kind: 'remove', endpoint: row.endpoint, isSelf: row.isSelf }),
      },
      t('common.remove'),
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
      ? t('devices.kind.browser')
      : endpoint.kind === 'mobile'
        ? t('devices.kind.phone')
        : endpoint.kind === 'console'
          ? t('devices.kind.console')
          : t('devices.kind.helper')
  const known = endpoint.platform !== 'unknown'
  return t('devices.detail', {
    kind,
    hasBrowser: endpoint.browser ? 'yes' : 'no',
    browser: endpoint.browser ? cap(endpoint.browser) : '',
    hasPlatform: known ? 'yes' : 'no',
    platform: known ? platformLabel(endpoint.platform) : '',
  })
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
      el('h2', {}, t('history.title')),
      entries.length > 0
        ? el(
            'button',
            {
              class: 'btn small',
              title: t('history.clear.hint'),
              onClick: () => void controller.clearHistory(),
            },
            t('history.clear'),
          )
        : null,
    ),
    el('p', { class: 'muted' }, historyIntro(status)),
    // Retention is stated on the surface, not buried in a config file: this list
    // is not permanent and a reader planning to come back for a link deserves to
    // know that before they need it.
    status === 'ready' ? el('p', { class: 'note muted' }, t('history.retention')) : null,
    // An old relay is a state, not a failure: the panel keeps working on the
    // copies it always ran on, and says which of the two it is showing.
    status === 'unavailable' ? el('p', { class: 'note warn' }, t('history.oldRelay')) : null,
    awaitingKey && status === 'ready'
      ? el('p', { class: 'note warn' }, t('history.awaitingKey'))
      : null,
    list,
  )
}

function historyIntro(status: GroupHistoryStatus): string {
  if (status === 'unavailable') return t('history.intro.copies')
  return t('history.intro.group')
}

function emptyHistoryText(status: GroupHistoryStatus): string {
  if (status === 'unavailable') return t('history.empty.copies')
  return t('history.empty.group')
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
      t('history.sent', { ago: relativeTime(first.sentAt) }),
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
      { class: 'mail-end', title: t('history.route.sentBy') },
      svg(PLANE),
      resolveEntryLabel(entry, 'source', endpoints),
    ),
    el('span', { class: 'arrow' }, ' → '),
    el(
      'span',
      { class: 'mail-end', title: t('history.route.sentTo') },
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
    : sealedRowTitle()

  const titleNode = href
    ? el(
        'a',
        { class: 'entry-title', href, target: '_blank', rel: 'noopener noreferrer' },
        titleText,
      )
    : el(
        'span',
        { class: `entry-title ${url ? '' : 'sealed'}`, title: url ? undefined : sealedRowNote() },
        titleText,
      )

  const badge = deliveryBadge(entry)
  const foot = el(
    'div',
    { class: 'entry-foot muted' },
    url ? el('span', { class: 'entry-host' }, hostOf(url)) : null,
    url ? el('span', { class: 'sep' }, '·') : null,
    el(
      'span',
      { title: absoluteTime(entry.sentAt) },
      t('history.sent', { ago: relativeTime(entry.sentAt) }),
    ),
    badge
      ? el('span', { class: `state state-${badge.state}`, title: badge.note }, badge.label)
      : null,
    url
      ? el('button', { class: 'btn tiny', onClick: (e) => void copy(url, e) }, t('common.copyLink'))
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
      btn.textContent = t('common.copied')
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
    session && session.relayUrl !== '' ? session.relayUrl : t('account.relay.sameOrigin')
  const push = controller.pushEnabled.get()
  const keys = controller.keyring.get().length

  const unpairBody = richNodes('account.unpair.body', {}, { em: (text) => el('em', {}, text) })

  return el(
    'section',
    { class: 'panel' },
    el('h2', {}, t('account.title')),

    el(
      'div',
      { class: 'kv' },
      kv(t('account.relay.label'), relayText),
      kv(t('account.group.label'), session?.groupId ?? '—'),
      kv(t('account.self.label'), session?.endpointId ?? '—'),
      kv(t('account.push.label'), push ? t('account.push.on') : t('account.push.off')),
      // A count, not the keys: it answers "why can this console not read that
      // row", which is the only question the number is good for. More than one is
      // normal, because a rotated key is kept so older history stays readable.
      kv(
        t('account.keys.label'),
        keys === 0 ? t('account.keys.none') : t('account.keys.held', { count: keys }),
      ),
    ),

    el('h3', {}, t('account.recovery.title')),
    el('p', { class: 'muted' }, t('account.recovery.body')),
    el('div', { class: 'note' }, t('account.recovery.warning')),

    el('h3', {}, t('account.unpair.title')),
    el('p', { class: 'muted' }, ...unpairBody),
    el(
      'button',
      { class: 'btn danger', onClick: () => dialog.set({ kind: 'unpair' }) },
      t('account.unpair.button'),
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
    el('h3', {}, t('dialog.rename.title')),
    el('label', { class: 'field-label' }, t('dialog.rename.label')),
    input,
    dialogButtons(close, el('button', { class: 'btn primary', onClick: save }, t('common.save'))),
  )
}

function renderRemoveDialog(
  controller: Controller,
  endpoint: Endpoint,
  isSelf: boolean,
  close: () => void,
): HTMLElement {
  const consequence = isSelf
    ? t('dialog.remove.self')
    : t('dialog.remove.other', { device: endpoint.label })
  return overlay(
    el('h3', {}, t('dialog.remove.title')),
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
        t('common.remove'),
      ),
    ),
  )
}

function renderUnpairDialog(controller: Controller, close: () => void): HTMLElement {
  return overlay(
    el('h3', {}, t('dialog.unpair.title')),
    el('p', { class: 'muted' }, t('dialog.unpair.body')),
    dialogButtons(
      close,
      el(
        'button',
        {
          class: 'btn danger',
          onClick: () => {
            void controller.unpair()
            close()
          },
        },
        t('dialog.unpair.confirm'),
      ),
    ),
  )
}

function dialogButtons(close: () => void, confirm: HTMLElement): HTMLElement {
  return el(
    'div',
    { class: 'dialog-actions' },
    el('button', { class: 'btn', onClick: close }, t('common.cancel')),
    confirm,
  )
}

// --- pairing modal ("add a device") -----------------------------------------

function renderPairingModal(controller: Controller): HTMLElement {
  const pairing = controller.pairing.get()
  if (!pairing) return el('div')
  const close = (): void => controller.dismissPairing()

  const qr = el('div', { class: 'qr' })
  qr.append(svg(qrSvg(pairing.qrLink, { cellSize: 5, label: t('pairing.qr.label') })))

  return overlay(
    el('h3', {}, t('pairing.title')),
    el('p', { class: 'muted' }, t('pairing.body')),
    qr,
    el(
      'div',
      { class: 'pair-actions' },
      el(
        'button',
        { class: 'btn small', onClick: (e) => void copy(pairing.link, e) },
        t('common.copyLink'),
      ),
    ),
    // A loopback link isn't an error — the mint succeeded — so this sits beside
    // the QR rather than replacing it: pairing a second client on this same
    // machine still works. Everything else scanning it would dead-end silently.
    ...(pairing.localOnly
      ? [el('p', { class: 'note warn' }, t('pairing.localOnly', { relayUrl: pairing.relayUrl }))]
      : pairing.routeNote
        ? [el('p', { class: 'note warn' }, pairing.routeNote)]
        : []),
    el(
      'p',
      { class: 'note muted' },
      t('pairing.expires', { when: absoluteTime(pairing.expiresAt) }),
    ),
    dialogButtons(close, el('button', { class: 'btn primary', onClick: close }, t('common.done'))),
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
