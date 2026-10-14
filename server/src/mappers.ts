import type {
  BrowserFamily,
  Endpoint,
  EndpointId,
  EndpointKind,
  GroupId,
  IsoTimestamp,
  Message,
  MessageId,
  Platform,
  PresenceStatus,
  PushSubscription,
} from '@tabsend/shared'
import { PRESENCE_ONLINE_THRESHOLD_SECONDS } from '@tabsend/shared'
import type { EndpointRow, MessageRow } from './db/schema'

/**
 * Presence = lastSeenAt within the threshold OR a live fast-path socket.
 * lastSeenAt is refreshed by heartbeat, ANY authenticated call, or a WS
 * hello/ping (see context.authenticate + the stream route).
 */
export function derivePresence(lastSeenAt: string, now: Date, liveSocket: boolean): PresenceStatus {
  if (liveSocket) return 'online'
  const ageMs = now.getTime() - Date.parse(lastSeenAt)
  return ageMs <= PRESENCE_ONLINE_THRESHOLD_SECONDS * 1000 ? 'online' : 'offline'
}

/**
 * Endpoint row → the peer-facing Endpoint. CRITICAL: never projects
 * `push_subscription` (server-held wake secret) or `device_token_hash`.
 */
export function toEndpoint(row: EndpointRow, now: Date, liveSocket: boolean): Endpoint {
  const endpoint: Endpoint = {
    id: row.id as EndpointId,
    groupId: row.group_id as GroupId,
    kind: row.kind as EndpointKind,
    browser: (row.browser as BrowserFamily | null) ?? null,
    platform: row.platform as Platform,
    label: row.label,
    e2ePubkey: row.e2e_pubkey,
    presence: derivePresence(row.last_seen_at, now, liveSocket),
    lastSeenAt: row.last_seen_at as IsoTimestamp,
    createdAt: row.created_at as IsoTimestamp,
  }
  // ADDITIVE (5-ext): only project the grouping hint when set — a null column
  // (pre-existing rows) stays absent on the wire, matching the optional field.
  if (row.device_name) endpoint.deviceName = row.device_name
  return endpoint
}

/** Message row → the wire Message (parses the stored envelope JSON). */
export function toMessage(row: MessageRow): Message {
  if (row.envelope === null) {
    throw new Error(`message ${row.id} has no envelope (acked/deleted)`)
  }
  return {
    id: row.id as MessageId,
    groupId: row.group_id as GroupId,
    sourceEndpointId: row.source_endpoint_id as EndpointId,
    targetEndpointId: row.target_endpoint_id as EndpointId,
    envelope: JSON.parse(row.envelope),
    createdAt: row.created_at as IsoTimestamp,
    expiresAt: row.expires_at as IsoTimestamp,
    deliveredAt: (row.delivered_at as IsoTimestamp | null) ?? null,
    ackedAt: (row.acked_at as IsoTimestamp | null) ?? null,
  }
}

/** Read a stored endpoint's push subscription (server-side only). */
export function parsePushSubscription(row: EndpointRow): PushSubscription {
  return JSON.parse(row.push_subscription)
}
