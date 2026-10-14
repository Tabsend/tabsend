import { deviceNameFromLabel, type Endpoint } from '@tabsend/shared'
import { getOutbox, listEndpoints } from '../lib/api'
import type { ChooserView, DeviceRow, DevicesView, HeldTab } from '../lib/model'
import { heldTabsOnly } from '../lib/outbound'
import { isPresenceFresh, isStaleEndpoint } from '../lib/policy'
import { getCachedEndpoints, getCachedEndpointsAt, getOutbound, getPrefs } from '../lib/storage'
import { agoLine } from '../lib/strings'
import { relayHealth } from './health'
import { newDeviceNotices, recordEndpoints, reviewNotices, vanishedNotices } from './newdevices'
import { orderTargets } from './prefs'
import { currentSession } from './session'

/**
 * A fetch already in flight, shared by anything asking in the same moment.
 *
 * Opening the popup sets off three independent callers within a few hundred ms:
 * the service worker's own wake-up bootstrap, the chooser view build, and then
 * the send's target lookup when a row is clicked. Each used to issue its own
 * `GET /v1/endpoints`, so the click paid for a round trip whose answer the
 * chooser had just received. They now share one request.
 *
 * Deliberately tiny: this coalesces concurrent callers, it is NOT a cache with a
 * lifetime. `getCachedEndpoints` is the cache, and it is allowed to be stale;
 * this must never be, because a send seals to the key it returns.
 */
let inFlight: Promise<Endpoint[]> | null = null

/**
 * Fetch the group's endpoint list from the relay and refresh the local cache.
 * Throws on network/relay failure (callers that must tolerate offline fall back
 * to `getCachedEndpoints`).
 */
export function fetchEndpoints(): Promise<Endpoint[]> {
  if (inFlight) return inFlight
  const run = (async () => {
    const session = await currentSession()
    if (!session) return []
    const list = await listEndpoints(
      session.registration.relayUrl,
      session.registration.deviceToken,
    )
    await recordEndpoints(list, session.registration.endpointId)
    return list
  })()
  // Cleared the moment it settles, success or failure — a rejected request must
  // not be handed to the next caller, and the next caller is often a retry.
  inFlight = run
  const clear = (): void => {
    if (inFlight === run) inFlight = null
  }
  run.then(clear, clear)
  return run
}

/** True for endpoints that may be shown as send targets (self + console excluded). */
function isSelectableTarget(endpoint: Endpoint, selfEndpointId: string): boolean {
  return endpoint.id !== selfEndpointId && endpoint.kind !== 'console'
}

/** The list of endpoints this install may send to, ordered per SourcePrefs. */
export async function targetEndpoints(endpoints: Endpoint[]): Promise<Endpoint[]> {
  const session = await currentSession()
  if (!session) return []
  const prefs = await getPrefs()
  const selectable = endpoints.filter((e) => isSelectableTarget(e, session.registration.endpointId))
  return orderTargets(selectable, prefs)
}

/**
 * Build the chooser view model. Uses fresh endpoints when reachable, else the
 * cache, so the popup still renders (and can send) while briefly offline.
 *
 * `cached` skips the network entirely and builds from the last-known list. That
 * is what the popup asks for FIRST: every millisecond between the toolbar click
 * and the first row on screen is a millisecond of "Loading…", and the cache is
 * kept fresh by every fetch, poll and delivery. The networked build follows and
 * re-renders in place. (The Android share sheet paints from its own
 * `Store.cachedEndpoints` for exactly this reason, where the cost is even more
 * visible — the sharing app stays frozen until the sheet draws.)
 */
export async function buildChooserView(opts: { cached?: boolean } = {}): Promise<ChooserView> {
  const session = await currentSession()
  if (!session)
    return {
      registered: false,
      targets: [],
      pending: [],
      held: [],
      primaryPinned: false,
      newDevices: [],
      review: [],
      vanished: [],
    }

  // Independent reads, so the popup waits on the slowest rather than the sum.
  // The outbox call used to run only AFTER the endpoint fetch had resolved,
  // which put two full round trips in front of the first row.
  const [endpoints, outbox, prefs, outbound, health] = await Promise.all([
    opts.cached ? getCachedEndpoints() : fetchEndpoints().catch(() => getCachedEndpoints()),
    opts.cached
      ? Promise.resolve([])
      : getOutbox(session.registration.relayUrl, session.registration.deviceToken).catch(
          // relay unreachable — the ⏳ row is then empty and the held list carries it
          () => [],
        ),
    getPrefs(),
    getOutbound(),
    relayHealth(),
  ])

  const ordered = await targetEndpoints(endpoints)
  const recent = new Set(prefs.recentTargetIds)

  // The ⏳ pending row's SOURCE OF TRUTH is the server outbox (sent-but-unacked)
  // [ADR-0010, paying chunk-3's debt]; the local outbound queue only ADDS sends
  // not yet accepted by the relay (source offline). Both read as "waiting for
  // <target>" from the user's side. Live drain arrives via the WS `acked` event.
  const pendingCounts = new Map<string, number>()
  const bump = (targetEndpointId: string): void => {
    pendingCounts.set(targetEndpointId, (pendingCounts.get(targetEndpointId) ?? 0) + 1)
  }
  for (const row of outbox) bump(row.targetEndpointId)

  // Tabs still on THIS browser. Kept out of the ⏳ count above: that row means
  // "the relay has it, the target is asleep", which is a promise we can't make
  // about something the relay has never seen. Console history copies never
  // appear — they aren't tabs the user sent anywhere — and that exclusion runs
  // through `heldTabsOnly` so this list and the counts in the give-up
  // announcements cannot come to disagree about what a "tab" is.
  const held: HeldTab[] = heldTabsOnly(outbound).map((item) => {
    const row: HeldTab = {
      id: item.id,
      targetEndpointId: item.targetEndpointId,
      createdAt: item.createdAt,
    }
    if (item.title) row.title = item.title
    if (item.url) row.url = item.url
    return row
  })

  const now = Date.now()
  // Read AFTER the fetch above, never alongside it: a successful fetch restamps
  // the cache, and reading the stamp in the same batch would race it and report
  // the age of the list we just replaced.
  //
  // A failed fetch leaves the stamp where the last successful one put it, so an
  // outage ages the dots out on its own — no separate "is the relay down"
  // branch, and no window where the popup shows a live-looking dot it can't
  // vouch for.
  const presenceKnown = isPresenceFresh(await getCachedEndpointsAt(), now)
  // After the fetch for the same reason: a fetch that spots a device must show
  // its banner in the render it feeds, not one render later.
  const newDevices = await newDeviceNotices()
  const review = await reviewNotices()
  const vanished = await vanishedNotices()
  const view: ChooserView = {
    registered: true,
    targets: ordered.map((endpoint) => ({
      endpoint,
      isPrimary: endpoint.id === prefs.primaryTargetId,
      isRecent: recent.has(endpoint.id),
      stale: isStaleEndpoint(endpoint, now),
      presenceKnown,
    })),
    pending: [...pendingCounts].map(([targetEndpointId, count]) => ({ targetEndpointId, count })),
    held,
    primaryPinned: prefs.primaryPinned,
    newDevices,
    review,
    vanished,
  }
  if (prefs.primaryTargetId) view.primaryTargetId = prefs.primaryTargetId
  // Read alongside the fetch above rather than after it. On the networked build
  // that fetch votes on reachability via the transport handler, so the verdict a
  // cached-first render shows can lag by one pass — the networked render landing
  // moments later carries the current one.
  if (health) view.relay = health
  return view
}

const relativeLastSeen = agoLine

function presenceLabel(endpoint: Endpoint, now: number, presenceKnown: boolean): string {
  // "Last seen" survives an unknown presence — it is a statement about the past
  // and stays true as the snapshot ages. Only "online" is a claim about NOW.
  if (!presenceKnown) return `last seen ${relativeLastSeen(endpoint.lastSeenAt, now)}`
  if (endpoint.presence === 'online') return 'online'
  if (isStaleEndpoint(endpoint, now)) return 'inactive'
  return `last seen ${relativeLastSeen(endpoint.lastSeenAt, now)}`
}

/**
 * The manage-devices view (dogfood pass-2 #4): EVERY endpoint in the group,
 * including self, with presence and the device tie — plus the distinct existing
 * device names that power the join "which device is this?" select (pass-2 #1).
 * Uses fresh endpoints when reachable, else the cache, so it still renders offline.
 */
export async function buildDevicesView(): Promise<DevicesView> {
  const session = await currentSession()
  if (!session) {
    return {
      registered: false,
      devices: [],
      existingDeviceNames: [],
      newDevices: [],
      review: [],
      vanished: [],
    }
  }

  let endpoints: Endpoint[]
  try {
    endpoints = await fetchEndpoints()
  } catch {
    endpoints = await getCachedEndpoints()
  }

  const selfId = session.registration.endpointId
  const now = Date.now()
  const presenceKnown = isPresenceFresh(await getCachedEndpointsAt(), now)
  const devices: DeviceRow[] = endpoints.map((endpoint) => {
    const row: DeviceRow = {
      endpointId: endpoint.id,
      label: endpoint.label,
      isSelf: endpoint.id === selfId,
      online: presenceKnown && endpoint.presence === 'online',
      presenceKnown,
      presenceLabel: presenceLabel(endpoint, now, presenceKnown),
    }
    if (endpoint.deviceName) row.deviceName = endpoint.deviceName
    return row
  })

  // Distinct device names on OTHER endpoints — the select options for a joining
  // browser ("this browser is on my <existing device>"). Endpoints registered
  // before the deviceName field existed fall back to parsing it out of their
  // label, so pre-existing devices still show up as suggestions.
  const existingDeviceNames = [
    ...new Set(
      endpoints
        .filter((e) => e.id !== selfId)
        .map((e) => e.deviceName ?? deviceNameFromLabel(e.label))
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort((a, b) => a.localeCompare(b))

  return {
    registered: true,
    selfEndpointId: selfId,
    devices,
    existingDeviceNames,
    newDevices: await newDeviceNotices(),
    review: await reviewNotices(),
    vanished: await vanishedNotices(),
  }
}
