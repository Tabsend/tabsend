import { type Endpoint, HOME_NETWORK_HINT, isHomeNetworkRelay } from '@tabsend/shared'
import { type DeliveryState, deliveryState } from './history'
import type { ConsoleSession, DeviceRow, HistoryEntry } from './model'
import { isStaleEndpoint, relativeTime } from './time'

/**
 * Pure view projections shared by the UI and the tests. No DOM here.
 */

/** "October 27", in this browser's time zone. An unreadable time is shown as sent. */
export function monthDayLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

/** "3:05 PM", in this browser's time zone. ICU's narrow space before AM/PM made plain. */
export function clockLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ')
}

/**
 * The reset that waits (PLANS.md P-18 item 12). Word for word the same as the
 * extension, Android and iOS. The console has no background, so the card is all.
 */
export const groupResetCopy = {
  title: 'Someone asked to remove all your devices',
  body: (requestedAt: string, resetsAt: string): string =>
    `From your account page on ${monthDayLine(requestedAt)}. On ${monthDayLine(resetsAt)} at ${clockLine(resetsAt)}, every device is removed, this one too. If it wasn't you, stop it now, then change your email password.`,
  stop: 'Stop the reset',
  dismiss: 'It was me',
  stopped: 'Reset stopped. Nothing was removed.',
  stopFailedOffline: "Couldn't reach your relay, so the reset is still waiting. Try again.",
  stopFailed: (reason: string): string => {
    const r = reason.trim().replace(/[.!]?$/, '.')
    return `Couldn't stop the reset: ${r} The reset is still waiting. Try again.`
  },
} as const

/**
 * The hover text on the header's connection badge. The console has no outage
 * line of its own; "Offline" and this text are what it says when the relay does
 * not answer. A relay on a home-network address gets the same extra sentence as
 * the relay-down line on the extension and the phones (PLANS.md P-15 item 4),
 * because away from home that address cannot answer.
 *
 * `relayUrl` is the address actually in use: the session's, or this page's own
 * origin when the console is served by the relay.
 */
export function connectionTitle(conn: string, relayUrl: string): string {
  if (conn === 'live') return 'Real-time updates over the WebSocket fast path'
  if (conn === 'polling')
    return 'Live updates are off. Refreshing every 20 seconds, so nothing is lost.'
  const line = `Not connected to the relay at ${relayUrl}.`
  return isHomeNetworkRelay(relayUrl) ? `${line} ${HOME_NETWORK_HINT}` : line
}

/** Build the device-management rows: presence, stale marking, self/console flags. */
export function toDeviceRows(
  endpoints: Endpoint[],
  session: ConsoleSession | null,
  now: number = Date.now(),
  presenceKnown = true,
): DeviceRow[] {
  const selfId = session?.endpointId
  return endpoints.map((endpoint) => {
    const stale = isStaleEndpoint(endpoint, now)
    return {
      endpoint,
      isSelf: endpoint.id === selfId,
      isConsole: endpoint.kind === 'console',
      stale,
      presenceKnown,
      presence: endpoint.presence,
      // "Last seen" is a statement about the past and survives an unreachable
      // relay; "online now" is a claim about this instant and does not.
      lastSeenLabel:
        presenceKnown && endpoint.presence === 'online'
          ? 'online now'
          : `last seen ${relativeTime(endpoint.lastSeenAt, now)}`,
    }
  })
}

/**
 * Resolve the label to show for a history entry's source/target. Prefers the LIVE
 * label (so a rename is reflected), falls back to the snapshot captured at record
 * time (so an entry whose endpoint was later removed still reads sensibly).
 */
export function resolveEntryLabel(
  entry: HistoryEntry,
  side: 'source' | 'target',
  endpoints: Endpoint[],
): string {
  const id = side === 'source' ? entry.sourceEndpointId : entry.targetEndpointId
  const snapshot = side === 'source' ? entry.sourceLabelAtSend : entry.targetLabelAtSend
  const live = endpoints.find((e) => e.id === id)
  return live?.label ?? snapshot
}

/**
 * The delivery state of one row, worded for the panel [ADR-0028].
 *
 * Null when the row has no delivery facts at all: an ADR-0010 copy proves a send
 * was made and says nothing about whether it landed. Showing "waiting" there
 * would be inventing a fact, so the badge is simply absent.
 */
export interface DeliveryBadge {
  state: DeliveryState
  /** Short enough to sit in a row's footer beside the host and the time. */
  label: string
  /** The hover/title line, which is where the reasoning belongs. */
  note: string
}

export function deliveryBadge(entry: HistoryEntry, now: number = Date.now()): DeliveryBadge | null {
  if (!entry.delivery) return null
  const state = deliveryState(entry.delivery, now)
  if (state === 'arrived') {
    return { state, label: 'Arrived', note: 'The target confirmed this tab.' }
  }
  if (state === 'never-arrived') {
    return {
      state,
      label: 'Never arrived',
      note: 'The target never confirmed this tab, and the relay has stopped holding it.',
    }
  }
  return {
    state,
    label: 'Waiting',
    note: 'The relay is holding this tab until the target picks it up.',
  }
}

/**
 * What a row says instead of a title when the blob is sealed under a key this
 * console does not hold. The transfer is still true and still listed; only its
 * content is missing, and the row says which of the two it is.
 */
export const SEALED_ROW_TITLE = 'Sealed to a key this console does not hold'
export const SEALED_ROW_NOTE =
  'This console can see that the transfer happened, not what was sent. The key reaches it from another paired device.'

/**
 * One rendered block of the history list: either a single send, or every row of
 * one multi-tab send.
 */
export interface HistoryGroup {
  /** The batch id, when this block is a multi-tab send. Absent for a single send. */
  batchId?: string
  /** How many tabs the SENDER put in the batch (may exceed `entries.length`). */
  sentCount?: number
  entries: HistoryEntry[]
}

/**
 * Group the history list so one multi-tab send reads as one send instead of N
 * unrelated rows. Grouping is by batch id across the WHOLE list, not just
 * adjacent rows: copies of one batch can be recorded by separate pulls, so a
 * later single send can land between two of them in the sorted list.
 *
 * A group takes the position of its FIRST entry, so the list stays in whatever
 * order it was given. Entries without a batch pass through as groups of one.
 */
export function groupHistory(entries: HistoryEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  const byBatch = new Map<string, HistoryGroup>()
  for (const entry of entries) {
    const batch = entry.batch
    if (!batch) {
      groups.push({ entries: [entry] })
      continue
    }
    const existing = byBatch.get(batch.id)
    if (existing) {
      existing.entries.push(entry)
      // Trust the largest count seen: every copy carries it, and a truncated one
      // would understate what the sender actually sent.
      existing.sentCount = Math.max(existing.sentCount ?? 0, batch.count)
      continue
    }
    const group: HistoryGroup = { batchId: batch.id, sentCount: batch.count, entries: [entry] }
    byBatch.set(batch.id, group)
    groups.push(group)
  }
  return groups
}

/**
 * The heading for a batch block: "3 tabs" when the whole send is here, "2 of 3
 * tabs" when it is not. A gap is a real outcome and the header names it rather
 * than quietly showing a shorter list. Group history [ADR-0028] closes most of
 * the gaps that used to appear here, because it carries every send rather than
 * the copies one sender chose to seal this console, but it does not close all of
 * them: a row can have aged past the relay's retention window while its siblings
 * are still inside it.
 */
export function batchHeading(group: HistoryGroup): string {
  const arrived = group.entries.length
  const sent = Math.max(group.sentCount ?? arrived, arrived)
  return arrived === sent ? `${sent} tabs` : `${arrived} of ${sent} tabs`
}

/** A safe hostname for a URL (for the history row's secondary line). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The front page's words. A visitor who opens app.tabsend.org (a store reviewer, a
 * person who followed a pairing link) has never seen this product, so the page says
 * what Tabsend is and what this page is for before it asks for a pairing link. The
 * word "console" stays, because the device lists on every client call it that;
 * the intro explains it instead.
 */
export const introCopy = {
  title: 'Tabsend web console',
  what: "Tabsend sends a web page from one of your devices to another, such as from your computer to your phone. The console is a web page that lists your devices and shows what you sent. It can't send tabs itself. Use the Tabsend browser extension or phone app for that.",
  newHere: 'New to Tabsend?',
  newHereLink: 'Learn more at tabsend.org',
  pairTitle: 'Pair this console',
  pairBody:
    'Open Tabsend on a device you already use, choose Add a device, and paste its setup link here.',
  privacy:
    'Tabsend encrypts what you send on your devices. The server holds no key to read it, and the console never opens tabs.',
} as const

export interface ProjectLink {
  label: string
  href: string
}

/** The address of the Tabsend-run service. Its policies cover only this address. */
export const HOSTED_HOST = 'app.tabsend.org'

/**
 * Footer links to the project's own pages, which live on tabsend.org. Privacy and
 * Terms describe the hosted service, so they appear only on its address: a console
 * served by someone's own relay has a different operator, and pointing its visitors
 * at our policy would say something untrue.
 */
export function projectLinks(hostname: string): ProjectLink[] {
  const links: ProjectLink[] = [{ label: 'tabsend.org', href: 'https://tabsend.org' }]
  if (hostname === HOSTED_HOST) {
    links.push(
      { label: 'Privacy', href: 'https://tabsend.org/privacy' },
      { label: 'Terms', href: 'https://tabsend.org/terms' },
    )
  }
  links.push({ label: 'Support', href: 'https://tabsend.org/support' })
  return links
}
