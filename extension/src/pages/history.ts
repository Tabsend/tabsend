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
  splitLatest,
} from '../lib/history'
import { t } from '../lib/i18n'
import { localizePage } from '../lib/i18n-dom'
import { pictureAddress, siteIconAddresses, siteLetter } from '../lib/link-preview'
import type { HistoryRow, ResendChoices } from '../lib/model'
import { findPagePicture, mayReadPage } from '../lib/page-picture'
import { isEmbeddedFavicon, isOpenableWebUrl } from '../lib/policy'
import {
  getHistory,
  getInbox,
  getPicturesAskClosed,
  getRegistration,
  getSettings,
  setPicturesAskClosed,
  setUnreadReceived,
} from '../lib/storage'
import { goneTargetCopy } from '../lib/strings'
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

localizePage()

const groupsEl = document.getElementById('groups') as HTMLDivElement
const emptyEl = document.getElementById('empty') as HTMLDivElement
/** Whether pictures are shown, read once per render (Settings, "Website images"). */
let imagesOn = true
/** Whether the browser lets this page read websites (the History card or Settings asked). */
let pageAccess = false

/**
 * Rows with no picture of their own look the page up once they come near the screen,
 * so opening a long History does not ask every site in it at once.
 */
const nearScreen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      nearScreen.unobserve(entry.target)
      waitingForScreen.get(entry.target)?.()
      waitingForScreen.delete(entry.target)
    }
  },
  { rootMargin: '300px' },
)
const waitingForScreen = new WeakMap<Element, () => void>()
const retentionEl = document.getElementById('retention') as HTMLParagraphElement

// Retention is stated here rather than buried in settings, and it names BOTH
// clocks, because they are genuinely different promises: the relay decides how
// far back the shared list goes, this browser decides how much of it survives
// the relay being unreachable.
retentionEl.textContent = t('history.retention', { max: HISTORY_MAX })

/**
 * Mail imagery per direction [ADR-0028 §9]: never a bare arrow.
 *
 * A paper plane for what this browser sent, a tray for what landed here, and a
 * neutral exchange when neither end is this browser. A plain up/down arrow was
 * rejected on owner review: it does not say what it means, and a lone arrow in a
 * row's left gutter reads as a control for reordering the list.
 */
const GLYPH_LABELS: Record<HistoryRow['direction'], () => string> = {
  sent: () => t('history.direction.sent'),
  received: () => t('history.direction.received'),
  other: () => t('history.direction.other'),
}

/** How each outcome reads. The relay's own routing facts, in plain words. */
const STATE_LABELS: Record<HistoryRow['state'], () => string> = {
  arrived: () => t('history.state.arrived'),
  waiting: () => t('history.state.waiting'),
  'never-arrived': () => t('history.state.neverArrived'),
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
  const label = GLYPH_LABELS[row.direction]()
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

/**
 * The picture slot: the plain letter tile until a picture has loaded over it, and the
 * tile for good when there is none or it fails, so a broken image never shows. The
 * site's icon stands in for the letter: an embedded favicon always (it asks nothing of
 * any site), and with Website images on, the site's icon from the web.
 */
function pictureSlot(row: HistoryRow, className: string): HTMLSpanElement {
  const slot = document.createElement('span')
  slot.className = `picture ${className}`
  slot.setAttribute('aria-hidden', 'true')
  const letter = document.createTextNode(siteLetter(row.url))
  slot.appendChild(letter)
  const icons = [
    ...(isEmbeddedFavicon(row.favicon) ? [row.favicon] : []),
    ...(imagesOn ? siteIconAddresses(row.url, row.favicon) : []),
  ]
  if (icons.length > 0) {
    const icon = document.createElement('img')
    icon.className = 'picture-icon hidden'
    icon.alt = ''
    icon.referrerPolicy = 'no-referrer'
    const queue = [...icons]
    icon.addEventListener('load', () => {
      // A 1x1 "no icon" answer would show as an empty tile.
      if (icon.naturalWidth < 8) return icon.dispatchEvent(new Event('error'))
      letter.remove()
      icon.classList.remove('hidden')
    })
    const tryNext = (): void => {
      const address = queue.shift()
      if (address) icon.src = address
      else icon.remove()
    }
    icon.addEventListener('error', tryNext)
    tryNext()
    slot.appendChild(icon)
  }
  const showPicture = (address: string): void => {
    const image = document.createElement('img')
    image.className = 'picture-image'
    image.alt = ''
    image.referrerPolicy = 'no-referrer'
    image.loading = 'lazy'
    image.addEventListener('error', () => image.remove())
    image.src = address
    slot.appendChild(image)
  }
  const source = imagesOn ? pictureAddress(row.image) : undefined
  const page = row.url
  if (source) {
    showPicture(source)
  } else if (imagesOn && pageAccess && page && mayReadPage(page)) {
    // The sender found no picture: look the page up from here (it was turned on).
    waitingForScreen.set(slot, () => {
      void findPagePicture(page).then((address) => {
        if (address) showPicture(address)
      })
    })
    nearScreen.observe(slot)
  }
  return slot
}

/**
 * The row's second line: who, and when. Only the third-party case spells out
 * both ends with an arrow — everywhere else the glyph already says which way it
 * went, and repeating it in words would cost a line per row [ADR-0028 §9].
 */
function subLine(row: HistoryRow, now: number): string {
  const url = row.url
  return t('history.row.sub', {
    hasHost: url ? 'yes' : 'no',
    host: url ? hostOf(url) : '',
    where: whereLine(row),
    ago: relativeTime(row.sentAt, now),
  })
}

/** "to Pixel 9", "from iPad" or "Pixel 9 → iPad": which device it went to or came from. */
function whereLine(row: HistoryRow): string {
  return t('history.where', {
    direction: row.direction,
    source: row.sourceLabel,
    target: row.targetLabel,
  })
}

function stateChip(row: HistoryRow): HTMLSpanElement | undefined {
  // A row this browser RECEIVED needs no verdict: it is here, which is the
  // whole of what "arrived" means. Everything else carries one, because a
  // transfer between two other devices can have failed just as quietly as one
  // of ours.
  if (row.direction === 'received') return undefined
  const chip = document.createElement('span')
  chip.className = `state ${row.state}`
  chip.textContent = STATE_LABELS[row.state]()
  return chip
}

/** The tab as it was sent, to send again. */
function resendPayload(row: HistoryRow, url: string): SendPayload {
  return {
    url,
    sentAt: row.sentAt as SendPayload['sentAt'],
    ...(row.title !== undefined ? { title: row.title } : {}),
    ...(row.favicon !== undefined ? { favicon: row.favicon } : {}),
    ...(row.image !== undefined ? { image: row.image } : {}),
  }
}

/**
 * Send it, and say on `label` what became of the click. The normal send path
 * reports its own outcome (banner + badge), so this only says what it did.
 */
function resend(
  row: HistoryRow,
  url: string,
  targetEndpointId: string,
  label: HTMLElement,
  controls: Array<HTMLButtonElement | HTMLSelectElement>,
): void {
  for (const c of controls) c.disabled = true
  label.textContent = t('history.sendAgain.sending')
  const insteadOf =
    targetEndpointId === row.targetEndpointId ? {} : { insteadOf: row.targetEndpointId }
  void rpc({ type: 'sendAgain', targetEndpointId, payload: resendPayload(row, url), ...insteadOf })
    .then((res) => {
      // Chrome can resolve sendMessage with no payload when the worker was
      // stopped before replying, so `res` itself may be missing. `moved: false`
      // is a device the background would not send to.
      const sent = res?.ok === true && !('moved' in res && res.moved === false)
      label.textContent = sent ? t('history.sendAgain.sent') : t('history.sendAgain.retry')
      for (const c of controls) c.disabled = sent
    })
    .catch(() => {
      label.textContent = t('history.sendAgain.retry')
      for (const c of controls) c.disabled = false
    })
}

/**
 * "Send again" on a tab that never arrived. Possible at all only because the
 * source kept a readable copy of what it sent, which is the point of sealing
 * history to a key the group holds.
 *
 * Offered on rows this browser SENT. Re-sending someone else's tab would put
 * this browser's name on it, which is a different claim from the one the row
 * makes.
 *
 * To the same device while it is still in the group. Once it has left (a browser
 * paired again leaves its old entry behind, PLANS P-31 item 4), the click opens
 * the choice a held tab whose device is gone shows (sketch A, owner 2026-11-09):
 * "Dia is no longer in your group. Send to: Dia 2 · Pixel 9", under the row.
 */
function sendAgainButton(row: HistoryRow, url: string, li: HTMLLIElement): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'again'
  btn.textContent = t('history.sendAgain.button')
  btn.addEventListener('click', () => {
    btn.disabled = true
    void rpc({ type: 'resendChoices', targetEndpointId: row.targetEndpointId })
      .catch(() => undefined)
      .then((res) => {
        const answer = res && res.ok && 'resend' in res ? res.resend : undefined
        if (answer?.gone) {
          btn.remove()
          li.append(goneDeviceChoice(row, url, answer))
          return
        }
        // Still in the group, or the worker did not answer: the device it was for.
        resend(row, url, row.targetEndpointId, btn, [btn])
      })
  })
  return btn
}

/** Up to this many devices get a button each; more get a menu (as for held tabs). */
const MAX_RESEND_BUTTONS = 3

/** The choice under a row whose device has left the group. */
function goneDeviceChoice(row: HistoryRow, url: string, answer: ResendChoices): HTMLElement {
  const box = document.createElement('div')
  box.className = 'again-gone'
  const line = document.createElement('div')
  line.textContent = goneTargetCopy.removedLine(row.targetLabel, answer.removedHere)
  box.append(line)
  if (answer.choices.length === 0) {
    const none = document.createElement('div')
    none.textContent = goneTargetCopy.noOtherDevice
    box.append(none)
    return box
  }
  const choices = document.createElement('div')
  choices.className = 'again-gone-choices'
  const status = document.createElement('span')
  status.className = 'again-gone-status'
  const controls: Array<HTMLButtonElement | HTMLSelectElement> = []
  const tabLabel = row.title?.trim() || hostOf(url)
  if (answer.choices.length <= MAX_RESEND_BUTTONS) {
    const lead = document.createElement('span')
    lead.textContent = goneTargetCopy.sendTo
    choices.append(lead)
    for (const choice of answer.choices) {
      const pick = document.createElement('button')
      pick.type = 'button'
      pick.className = 'linkish'
      pick.textContent = choice.label
      pick.setAttribute('aria-label', goneTargetCopy.sendToAria(tabLabel, choice.label))
      pick.addEventListener('click', () => resend(row, url, choice.id, status, controls))
      controls.push(pick)
      choices.append(pick)
    }
  } else {
    const select = document.createElement('select')
    select.setAttribute('aria-label', t('chooser.held.sendToMenuAria', { tab: tabLabel }))
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = goneTargetCopy.sendToMenu
    placeholder.disabled = true
    placeholder.selected = true
    select.append(placeholder)
    for (const choice of answer.choices) {
      const option = document.createElement('option')
      option.value = choice.id
      option.textContent = choice.label
      select.append(option)
    }
    select.addEventListener('change', () => {
      if (select.value) resend(row, url, select.value, status, controls)
    })
    controls.push(select)
    choices.append(select)
  }
  choices.append(status)
  box.append(choices)
  return box
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
      row.url === undefined ? t('history.row.waitingForKey') : t('history.row.cannotOpen')
  }
  const sub = document.createElement('span')
  sub.className = 'tab-sub'
  sub.textContent = subLine(row, now)
  text.append(title, sub)
  body.appendChild(text)
  if (url) body.appendChild(pictureSlot(row, 'thumb'))
  wrap.appendChild(body)

  const chip = stateChip(row)
  if (chip) wrap.appendChild(chip)
  if (row.direction === 'sent' && row.state === 'never-arrived' && url) {
    wrap.appendChild(sendAgainButton(row, url, li))
  }

  li.appendChild(wrap)
  return li
}

/** A Latest card's first line: which way it went, in words. */
function cardRoute(row: HistoryRow): string {
  if (row.direction === 'sent') return t('history.card.sent', { target: row.targetLabel })
  if (row.direction === 'received') return t('history.card.received', { source: row.sourceLabel })
  return t('history.card.other', { source: row.sourceLabel, target: row.targetLabel })
}

/** One of the Latest cards: the picture on top, then what it is and where it went. */
function renderCard(row: HistoryRow, now: number): HTMLButtonElement {
  const url = openableUrl(row) as string
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'card-tab'
  card.title = url
  card.addEventListener('click', () => openTab(url))

  const route = document.createElement('span')
  route.className = 'card-route'
  route.textContent = cardRoute(row)
  const title = document.createElement('span')
  title.className = 'card-title'
  title.textContent = row.title?.trim() || hostOf(url)
  const meta = document.createElement('span')
  meta.className = 'tab-sub'
  const parts = [hostOf(url), relativeTime(row.sentAt, now)]
  if (row.direction !== 'received') parts.push(STATE_LABELS[row.state]())
  meta.textContent = parts.join(' · ')

  const text = document.createElement('span')
  text.className = 'card-text'
  text.append(route, title, meta)
  card.append(pictureSlot(row, 'cover'), text)
  return card
}

function sectionHeading(label: string): HTMLHeadingElement {
  const heading = document.createElement('h2')
  heading.className = 'section-heading'
  heading.textContent = label
  return heading
}

/** The heading's own line: who the whole batch went to or came from, and when. */
function groupMeta(group: HistoryGroup, now: number): string {
  const first = group.rows[0]
  if (!first) return ''
  return t('history.group.meta', { where: whereLine(first), ago: relativeTime(first.sentAt, now) })
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
      chip.textContent = STATE_LABELS[state]()
      head.appendChild(chip)
    }

    const openable = group.rows.map(openableUrl).filter((u): u is string => u !== undefined)
    if (openable.length > 0) {
      const openAll = document.createElement('button')
      openAll.type = 'button'
      openAll.className = 'open-all'
      openAll.textContent = t('history.openAll')
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

/** Site access for reading pages' pictures: optional, asked for only from the card. */
const PAGE_ACCESS = { origins: ['https://*/*'] }

/**
 * The one-time "Show pictures for every link" card (owner, 2026-11-09: option A). Shown
 * while Website images is on, the browser has not granted page access, and the card has
 * not been answered. Either button closes it for good; Settings keeps the switch.
 */
async function showPicturesAsk(): Promise<void> {
  const card = document.getElementById('pictures-ask')
  if (!card) return
  const granted = await ext.permissions?.contains(PAGE_ACCESS).catch(() => false)
  const closed = await getPicturesAskClosed()
  card.classList.toggle('hidden', !imagesOn || Boolean(granted) || Boolean(closed))
}

document.getElementById('pictures-allow')?.addEventListener('click', () => {
  // Asked straight from the click: browsers allow the prompt only from a user gesture.
  void ext.permissions
    ?.request(PAGE_ACCESS)
    .catch(() => false)
    .then(async (granted) => {
      if (granted) {
        await setPicturesAskClosed()
        await render()
      } else await showPicturesAsk()
    })
})
for (const id of ['pictures-later', 'pictures-close']) {
  document.getElementById(id)?.addEventListener('click', () => {
    void setPicturesAskClosed().then(showPicturesAsk)
  })
}

async function render(): Promise<void> {
  const [cached, received, registration, settings] = await Promise.all([
    getHistory(),
    getInbox(),
    getRegistration(),
    getSettings(),
  ])
  imagesOn = settings.websiteImages
  pageAccess = Boolean(await ext.permissions?.contains(PAGE_ACCESS).catch(() => false))
  void showPicturesAsk()
  // The relay's list is authoritative, and the local received record fills its
  // gaps: rows whose group key this browser does not hold, and rows the relay
  // never had (an older relay, one serving no history, or one that is down).
  const rows = mergeHistory(
    cached,
    received,
    registration?.label ?? t('history.thisBrowser'),
    registration?.endpointId ?? '',
  )
  const now = Date.now()

  groupsEl.replaceChildren()
  emptyEl.classList.toggle('hidden', rows.length > 0)
  const { latest, earlier } = splitLatest(groupHistory(rows), (row) => Boolean(openableUrl(row)))
  if (latest.length > 0) {
    const cards = document.createElement('div')
    cards.className = latest.length === 1 ? 'latest single' : 'latest'
    for (const row of latest) cards.appendChild(renderCard(row, now))
    groupsEl.append(sectionHeading(t('history.latest')), cards)
    if (earlier.length > 0) groupsEl.appendChild(sectionHeading(t('history.earlier')))
  }
  for (const group of earlier) groupsEl.appendChild(renderGroup(group, now))
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
  if (area === 'local' && (changes.history || changes.inbox || changes.settings)) void render()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void render()
    refresh()
  }
})

void render()
refresh()
