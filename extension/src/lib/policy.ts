import { type Endpoint, PRESENCE_ONLINE_THRESHOLD_SECONDS } from '@tabsend/shared'

/**
 * Client-side reliability/UX policy constants that aren't wire contract.
 *
 * Presence itself is server-derived (PRESENCE_ONLINE_THRESHOLD_SECONDS in
 * @tabsend/shared) — the dots read straight off `Endpoint.presence`. Staleness
 * is a *separate, longer* horizon and, per ADR-0004's "pruned by last-seen"
 * follow-up, is resolved conservatively (Chunk 4b decision):
 *
 *   The relay NEVER auto-deletes an endpoint. An endpoint offline for longer
 *   than STALE_ENDPOINT_THRESHOLD is *marked* stale in the client's list
 *   rendering (derived from `lastSeenAt`, no new wire field), so a reinstalled/
 *   abandoned profile visibly ages out — but actual removal stays a user action
 *   (DELETE /v1/endpoints/:id, surfaced in the Chunk-5 devices UI). This avoids
 *   the relay silently dropping an endpoint whose owner is simply on vacation.
 */
export const STALE_ENDPOINT_THRESHOLD_DAYS = 30
export const STALE_ENDPOINT_THRESHOLD_MS = STALE_ENDPOINT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000

/**
 * How long a cached presence verdict is still worth showing as fact.
 *
 * The relay calls an endpoint online when its last heartbeat is inside
 * PRESENCE_ONLINE_THRESHOLD_SECONDS, so a snapshot of that verdict can only
 * outlive the same window — past it, "online" may already be false and we have
 * no way to know. The dots therefore go to an explicit UNKNOWN state rather than
 * keeping their last colour, which during a relay outage had the popup drawing a
 * confident green dot beside a banner saying the relay hadn't answered in two
 * hours (dogfood 2026-08-05).
 *
 * Deliberately the same horizon as the relay's, not a longer "close enough" one:
 * the whole point is that we stop claiming what we cannot check.
 */
export const PRESENCE_TRUST_MS = PRESENCE_ONLINE_THRESHOLD_SECONDS * 1000

/**
 * Is the presence in a snapshot taken at `fetchedAt` still claimable?
 *
 * `undefined` means we never recorded when the list was taken (a cache written
 * by an older build) — unknown, not fresh.
 */
export function isPresenceFresh(fetchedAt: number | undefined, now: number = Date.now()): boolean {
  if (fetchedAt === undefined) return false
  return now - fetchedAt <= PRESENCE_TRUST_MS
}

/** True when an OFFLINE endpoint's last-seen is older than the stale horizon. */
export function isStaleEndpoint(endpoint: Endpoint, now: number = Date.now()): boolean {
  if (endpoint.presence === 'online') return false
  const lastSeen = Date.parse(endpoint.lastSeenAt)
  if (Number.isNaN(lastSeen)) return false
  return now - lastSeen > STALE_ENDPOINT_THRESHOLD_MS
}

/**
 * How long after registering a solo group is simply "not finished pairing yet"
 * rather than a symptom. Someone who has just created a group is ON their way to
 * the pairing link; telling them their group looks wrong would be noise.
 */
export const SOLO_GROUP_GRACE_MS = 10 * 60 * 1000

/**
 * Received payloads are authenticated, but the sender is still another device
 * in the group and therefore an input boundary. Browser tab APIs may hand
 * non-web schemes to privileged handlers, so delivery is deliberately limited
 * to ordinary web links.
 */
export function isOpenableWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * A favicon the history page may show: an embedded `data:image/` URL only, never
 * an address to fetch. History rows come from blobs any key holder can write, so
 * a remote favicon is a tracking pixel a planted row fires whenever History is
 * opened, and even an honest one tells that site what another device sent. The
 * console has always held this line; the extension page did not (review
 * 2026-10-13).
 */
export function isEmbeddedFavicon(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\//i.test(value)
}

/**
 * Should the manage screen say "this browser is alone in its group"?
 *
 * Being alone is normal for ten minutes after creating a group, and alarming
 * afterwards: it means the browsers that used to be here are on a different
 * relay address or in a different group (dogfood 2026-07-29 — Arc turned up
 * solo mid-migration to the LAN relay, and the screen said nothing at all).
 *
 * - `deviceCount` 0 means we never got a list (relay unreachable, empty cache),
 *   NOT an empty group — warning there would fire on every offline open.
 * - A registration with no `registeredAt` predates the field, so it is old by
 *   definition: warn.
 */
export function shouldWarnSoloGroup(args: {
  deviceCount: number
  /** ISO — when this install registered. Absent on pre-existing registrations. */
  registeredAt?: string
  /** True when THIS page just created the group (no reload in between). */
  justRegistered?: boolean
  now?: number
}): boolean {
  if (args.justRegistered) return false
  if (args.deviceCount !== 1) return false
  if (!args.registeredAt) return true
  const at = Date.parse(args.registeredAt)
  if (Number.isNaN(at)) return true
  return (args.now ?? Date.now()) - at > SOLO_GROUP_GRACE_MS
}
