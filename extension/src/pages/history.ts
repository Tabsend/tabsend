import type { SendPayload } from '@tabsend/shared'
import { ext } from '../lib/ext'
import {
  batchHeading,
  groupHistory,
  groupState,
  HISTORY_MAX,
  type HistoryGroup,
  hostOf,
  mergeHistory,
  relativeTime,
} from '../lib/history'
import type { HistoryRow } from '../lib/model'
import { isEmbeddedFavicon, isOpenableWebUrl } from '../lib/policy'
import { getHistory, getInbox, getRegistration, setUnreadReceived } from '../lib/storage'
import { rpc } from './rpc-client'

/**
 * The group history page [ADR-0028 §8], which P-7's received-tabs page grew into.
 *
 * One timeline, newest first, sent and received together, and transfers between
 * two OTHER devices as well: the relay keeps one blob per send that every paired
 * device can read, so "where did that tab go" is answerable from whichever
 * browser you happen to be sitting at.
 *
 * It reads `ext.storage.local` DIRECTLY rather than going through the RPC to the
 * service worker. That is deliberate. A page and its worker can be different
 * builds (an unpacked directory rebuilt under a running browser keeps serving the
 * cached worker script — dogfood 2026-08-05), and a list has no reason to inherit
 * that failure mode. The RPCs below are for ACTIONS only, and each one is
 * best-effort on top of a page that has already rendered.
 */

const groupsEl = document.getElementById('groups') as HTMLDivElement
const emptyEl = document.getElementById('empty') as HTMLDivElement
const retentionEl = document.getElementById('retention') as HTMLParagraphElement

// Retention is stated here rather than buried in settings, and it names BOTH
// clocks, because they are genuinely different promises: the relay decides how
// far back the shared list goes, this browser decides how much of it survives
// the relay being unreachable.
retentionEl.textContent =
  `Every tab your devices send each other, newest first. Your relay decides how far ` +
  `back the list goes. The newest ${HISTORY_MAX} are kept on this browser, so the page still works offline.`

/**
 * Mail imagery per direction [ADR-0028 §9]: never a bare arrow.
 *
 * A paper plane for what this browser sent, a tray for what landed here, and a
 * neutral exchange when neither end is this browser. A plain up/down arrow was
 * rejected on owner review: it does not say what it means, and a lone arrow in a
 * row's left gutter reads as a control for reordering the list.
 */
const GLYPH_LABELS: Record<HistoryRow['direction'], string> = {
  sent: 'Sent from this browser',
  received: 'Received on this browser',
  other: 'Between two of your other devices',
}

/** How each outcome reads. The relay's own routing facts, in plain words. */
const STATE_LABELS: Record<HistoryRow['state'], string> = {
  arrived: 'Arrived',
  waiting: 'Waiting',
  'never-arrived': 'Never arrived',
}

/** Open a tab from history. Nothing is focused: a click means "get it back". */
function openTab(url: string): void {
  void ext.tabs.create({ url, active: false })
}

/** True when this row still holds a link this page is willing to navigate to. */
function openableUrl(row: HistoryRow): string | undefined {
  // Re-checked at RENDER time, not just at receipt: this page turns a stored
  // string back into a navigation, and the check that makes that safe belongs
  // next to the click.
  return isOpenableWebUrl(row.url) ? row.url : undefined
}

function directionGlyph(row: HistoryRow): HTMLSpanElement {
  const label = GLYPH_LABELS[row.direction]
  const span = document.createElement('span')
  span.className = 'dir'
  span.title = label
  span.setAttribute('role', 'img')
  span.setAttribute('aria-label', label)
  const template = document.getElementById(`glyph-${row.direction}`)
  if (template instanceof HTMLTemplateElement) {
    span.appendChild(template.content.cloneNode(true))
  }
  return span
}

function faviconFor(row: HistoryRow): HTMLElement {
  if (!isEmbeddedFavicon(row.favicon)) return faviconSlot()
  const img = document.createElement('img')
  img.className = 'favicon'
  img.src = row.favicon
  img.alt = ''
  // Plenty of favicons 404, are blocked, or are an extension-internal URL this
  // page can't load. A broken-image glyph would read as part of a failure, so
  // fall back to the empty slot and keep the titles aligned (same treatment as
  // the send-feedback banner).
  img.addEventListener('error', () => img.replaceWith(faviconSlot()))
  return img
}

function faviconSlot(): HTMLSpanElement {
  const slot = document.createElement('span')
  slot.className = 'favicon-slot'
  return slot
}

/**
 * The row's second line: who, and when. Only the third-party case spells out
 * both ends with an arrow — everywhere else the glyph already says which way it
 * went, and repeating it in words would cost a line per row [ADR-0028 §9].
 */
function subLine(row: HistoryRow, now: number): string {
  const url = row.url
  const where =
    row.direction === 'sent'
      ? `to ${row.targetLabel}`
      : row.direction === 'received'
        ? `from ${row.sourceLabel}`
        : `${row.sourceLabel} → ${row.targetLabel}`
  const parts = url ? [hostOf(url), where] : [where]
  parts.push(relativeTime(row.sentAt, now))
  return parts.join(' · ')
}

function stateChip(row: HistoryRow): HTMLSpanElement | undefined {
  // A row this browser RECEIVED needs no verdict: it is here, which is the
  // whole of what "arrived" means. Everything else carries one, because a
  // transfer between two other devices can have failed just as quietly as one
  // of ours.
  if (row.direction === 'received') return undefined
  const chip = document.createElement('span')
  chip.className = `state ${row.state}`
  chip.textContent = STATE_LABELS[row.state]
  return chip
}

/**
 * "Send again" on a tab that never arrived. Possible at all only because the
 * source kept a readable copy of what it sent, which is the point of sealing
 * history to a key the group holds.
 *
 * Offered on rows this browser SENT. Re-sending someone else's tab would put
 * this browser's name on it, which is a different claim from the one the row
 * makes.
 */
function sendAgainButton(row: HistoryRow, url: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'again'
  btn.textContent = 'Send again'
  btn.addEventListener('click', () => {
    btn.disabled = true
    btn.textContent = 'Sending'
    const payload: SendPayload = {
      url,
      sentAt: row.sentAt as SendPayload['sentAt'],
      ...(row.title !== undefined ? { title: row.title } : {}),
      ...(row.favicon !== undefined ? { favicon: row.favicon } : {}),
    }
    // The normal send path reports its own outcome (banner + badge), so this
    // button only has to say what it did with the click.
    void rpc({ type: 'sendAgain', targetEndpointId: row.targetEndpointId, payload })
      .then((res) => {
        // Chrome can resolve sendMessage with no payload when the worker was
        // stopped before replying, so `res` itself may be missing.
        const sent = res?.ok === true
        btn.textContent = sent ? 'Sent again' : 'Try again'
        btn.disabled = sent
      })
      .catch(() => {
        btn.textContent = 'Try again'
        btn.disabled = false
      })
  })
  return btn
}

function renderRow(row: HistoryRow, now: number): HTMLLIElement {
  const li = document.createElement('li')
  const wrap = document.createElement('div')
  wrap.className = 'row'
  wrap.appendChild(directionGlyph(row))

  const url = openableUrl(row)
  // A row with a link is a button that reopens it; one without is inert text.
  const body = document.createElement(url ? 'button' : 'div')
  body.className = 'tab'
  if (body instanceof HTMLButtonElement) {
    body.type = 'button'
    const target = url as string
    body.addEventListener('click', () => openTab(target))
    // The whole URL on hover: the row truncates, and "which link is this
    // exactly" is the question this page exists to answer.
    body.title = target
  }
  body.appendChild(faviconFor(row))

  const text = document.createElement('span')
  text.className = 'tab-text'
  const title = document.createElement('span')
  title.className = 'tab-title'
  if (url) {
    // A tab sent without a title is normal (some pages have none); the host is a
    // better handle than an empty line.
    title.textContent = row.title?.trim() || hostOf(url)
  } else {
    // No readable content: either we hold no key for this row's blob yet, or the
    // link is one this page will not navigate to. Say which, quietly.
    title.classList.add('unreadable')
    title.textContent =
      row.url === undefined
        ? 'Waiting for the key that opens this one'
        : 'This link cannot be opened here'
  }
  const sub = document.createElement('span')
  sub.className = 'tab-sub'
  sub.textContent = subLine(row, now)
  text.append(title, sub)
  body.appendChild(text)
  wrap.appendChild(body)

  const chip = stateChip(row)
  if (chip) wrap.appendChild(chip)
  if (row.direction === 'sent' && row.state === 'never-arrived' && url) {
    wrap.appendChild(sendAgainButton(row, url))
  }

  li.appendChild(wrap)
  return li
}

/** The heading's own line: who the whole batch went to or came from, and when. */
function groupMeta(group: HistoryGroup, now: number): string {
  const first = group.rows[0]
  if (!first) return ''
  const where =
    first.direction === 'sent'
      ? `to ${first.targetLabel}`
      : first.direction === 'received'
        ? `from ${first.sourceLabel}`
        : `${first.sourceLabel} → ${first.targetLabel}`
  return `${where} · ${relativeTime(first.sentAt, now)}`
}

function renderGroup(group: HistoryGroup, now: number): HTMLDivElement {
  const box = document.createElement('div')
  box.className = 'group'
  const state = groupState(group)
  if (state === 'never-arrived') box.classList.add('never-arrived')

  // Only a multi-tab send gets a heading. A single send with a "1 tabs" header
  // would be noise, and the row already names its ends and its age.
  if (group.batchId !== undefined) {
    const head = document.createElement('div')
    head.className = 'group-head'

    const count = document.createElement('span')
    count.className = 'group-count'
    count.textContent = batchHeading(group)

    const meta = document.createElement('span')
    meta.className = 'group-meta'
    meta.textContent = groupMeta(group, now)

    head.append(count, meta)

    // The heading carries the WORST state in the block. "3 tabs · arrived" over
    // a batch where one expired unacked is exactly the lie this page removes.
    const first = group.rows[0]
    if (first && first.direction !== 'received') {
      const chip = document.createElement('span')
      chip.className = `state ${state}`
      chip.textContent = STATE_LABELS[state]
      head.appendChild(chip)
    }

    const openable = group.rows.map(openableUrl).filter((u): u is string => u !== undefined)
    if (openable.length > 0) {
      const openAll = document.createElement('button')
      openAll.type = 'button'
      openAll.className = 'open-all'
      openAll.textContent = 'Open all'
      openAll.addEventListener('click', () => {
        for (const url of openable) openTab(url)
      })
      head.appendChild(openAll)
    }

    box.appendChild(head)
  }

  const list = document.createElement('ul')
  for (const row of group.rows) list.appendChild(renderRow(row, now))
  box.appendChild(list)
  return box
}

async function render(): Promise<void> {
  const [cached, received, registration] = await Promise.all([
    getHistory(),
    getInbox(),
    getRegistration(),
  ])
  // The relay's list is authoritative, and the local received record fills its
  // gaps: rows whose group key this browser does not hold, and rows the relay
  // never had (an older relay, one serving no history, or one that is down).
  const rows = mergeHistory(
    cached,
    received,
    registration?.label ?? 'This browser',
    registration?.endpointId ?? '',
  )
  const now = Date.now()

  groupsEl.replaceChildren()
  emptyEl.classList.toggle('hidden', rows.length > 0)
  for (const group of groupHistory(rows)) groupsEl.appendChild(renderGroup(group, now))
  markSeenIfVisible()
}

/**
 * Looking at this page IS the ack for the badge/pop-up indicator [P-7
 * addendum] — there is no separate "mark as read" control. Written straight
 * to storage, same as `render` reads it: the background worker's badge
 * repaints itself reactively off the `unreadReceived` change (badge.ts
 * `registerUnreadBadgeSync`), so this page never has to reach the SW
 * directly. Guarded on visibility so a new arrival landing while this page
 * sits in a background tab isn't silently marked seen before anyone looked.
 */
function markSeenIfVisible(): void {
  if (document.visibilityState === 'visible') void setUnreadReceived(0)
}

/**
 * Ask the worker to pull a fresh list. Never awaited by the render above: an
 * asleep worker, a stale build, or a relay that predates ADR-0028 must all leave
 * a page that still shows what it has.
 */
function refresh(): void {
  void rpc({ type: 'refreshHistory' }).catch(() => undefined)
}

// Repaint when either source changes while this page is open, and when it is
// returned to after being left in a background tab. Both matter: this is a page
// people leave open, and a list that silently goes stale is worse than no list.
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.history || changes.inbox)) void render()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void render()
    refresh()
  }
})

void render()
refresh()
