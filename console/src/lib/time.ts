import type { Endpoint } from '@tabsend/shared'

/**
 * Time + staleness helpers. The "inactive > 30d" horizon mirrors the extension's
 * policy (extension/src/lib/policy.ts, ADR-0004 / Chunk-4b): the relay NEVER
 * auto-deletes an endpoint; one offline longer than this is rendered "inactive"
 * (derived from `lastSeenAt`, no wire field), and removal stays a user action
 * (DELETE /v1/endpoints/:id — the devices panel). Kept as a local copy because
 * cross-importing another package's non-exported source is not allowed.
 */
export const STALE_ENDPOINT_THRESHOLD_DAYS = 30
export const STALE_ENDPOINT_THRESHOLD_MS = STALE_ENDPOINT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000

/** True when an OFFLINE endpoint's last-seen is older than the stale horizon. */
export function isStaleEndpoint(endpoint: Endpoint, now: number = Date.now()): boolean {
  if (endpoint.presence === 'online') return false
  const lastSeen = Date.parse(endpoint.lastSeenAt)
  if (Number.isNaN(lastSeen)) return false
  return now - lastSeen > STALE_ENDPOINT_THRESHOLD_MS
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * Compact, calm relative time ("just now", "3m ago", "2h ago", "5d ago"). Used for
 * "last seen" on offline rows and "sent" on history entries. Honest and quiet —
 * no false precision, no "online" implied by a fresh timestamp (presence is a
 * separate, server-derived signal).
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'unknown'
  const delta = now - then
  if (delta < 0) return 'just now'
  if (delta < MIN) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`
  const days = Math.floor(delta / DAY)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

/** Absolute, locale-formatted timestamp for the row's title/hover (full precision). */
export function absoluteTime(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return iso
  return then.toLocaleString()
}
