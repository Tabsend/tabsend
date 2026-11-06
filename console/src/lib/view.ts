import { type Endpoint, isHomeNetworkRelay } from '@tabsend/shared'
import { type DeliveryState, deliveryState } from './history'
import { getLocale, t } from './i18n'
import type { ConsoleSession, DeviceRow, HistoryEntry } from './model'
import { isStaleEndpoint, relativeTime } from './time'

/**
 * Pure view projections shared by the UI and the tests. No DOM here.
 */

/**
 * "October 27", in this browser's time zone and the language of the text on screen. An
 * unreadable time is shown as sent.
 */
export function monthDayLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(getLocale(), { month: 'long', day: 'numeric' })
}

/**
 * "3:05 PM", in this browser's time zone and the language of the text on screen. ICU's
 * narrow space before AM/PM made plain.
 */
export function clockLine(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d
    .toLocaleTimeString(getLocale(), { hour: 'numeric', minute: '2-digit' })
    .replace(/\s/g, ' ')
}

/**
 * The reset that waits (PLANS.md P-18 item 12). Word for word the same as the
 * extension, Android and iOS (a test holds the console's and the extension's English to
 * it). The console has no background, so the card is all. The words are read when asked
 * for, never at load, so they follow the language chosen.
 */
export const groupResetCopy = {
  get title(): string {
    return t('devices.reset.title')
  },
  body: (requestedAt: string, resetsAt: string): string =>
    t('devices.reset.body', {
      requestedDate: monthDayLine(requestedAt),
      resetsDate: monthDayLine(resetsAt),
      resetsTime: clockLine(resetsAt),
    }),
  get stop(): string {
    return t('devices.reset.stop')
  },
  get dismiss(): string {
    return t('devices.reset.dismiss')
  },
  get stopped(): string {
    return t('devices.reset.stopped')
  },
  get stopFailedOffline(): string {
    return t('devices.reset.stopFailedOffline')
  },
}

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
  if (conn === 'live') return t('connection.live.title')
  if (conn === 'polling') return t('connection.polling.title')
  if (isHomeNetworkRelay(relayUrl)) return t('connection.offline.titleHomeNetwork', { relayUrl })
  return t('connection.offline.title', { relayUrl })
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
          ? t('devices.lastSeen.online')
          : t('devices.lastSeen.ago', { ago: relativeTime(endpoint.lastSeenAt, now) }),
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
    return {
      state,
      label: t('history.state.arrived'),
      note: t('history.state.arrivedNote'),
    }
  }
  if (state === 'never-arrived') {
    return {
      state,
      label: t('history.state.neverArrived'),
      note: t('history.state.neverArrivedNote'),
    }
  }
  return {
    state,
    label: t('history.state.waiting'),
    note: t('history.state.waitingNote'),
  }
}

/**
 * What a row says instead of a title when the blob is sealed under a key this
 * console does not hold. The transfer is still true and still listed; only its
 * content is missing, and the row says which of the two it is.
 */
export function sealedRowTitle(): string {
  return t('history.sealed.title')
}
export function sealedRowNote(): string {
  return t('history.sealed.note')
}

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
  return arrived === sent
    ? t('history.batch.heading', { count: sent })
    : t('history.batch.partial', { here: arrived, count: sent })
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
  get title(): string {
    return t('onboarding.title')
  },
  get what(): string {
    return t('onboarding.what')
  },
  get pairTitle(): string {
    return t('onboarding.pair.title')
  },
  get pairBody(): string {
    return t('onboarding.pair.body')
  },
  get privacy(): string {
    return t('onboarding.privacy')
  },
}

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
  const links: ProjectLink[] = [{ label: t('app.footer.site'), href: 'https://tabsend.org' }]
  if (hostname === HOSTED_HOST) {
    links.push(
      { label: t('app.footer.privacy'), href: 'https://tabsend.org/privacy' },
      { label: t('app.footer.terms'), href: 'https://tabsend.org/terms' },
    )
  }
  links.push({ label: t('app.footer.support'), href: 'https://tabsend.org/support' })
  return links
}
