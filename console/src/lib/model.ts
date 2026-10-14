import type {
  BrowserFamily,
  Endpoint,
  EndpointKind,
  IsoTimestamp,
  Platform,
  PresenceStatus,
} from '@tabsend/shared'

/**
 * Console-local shapes. None of this is on the wire (the wire is @tabsend/shared) —
 * it's the console's own storage + view model.
 */

/** What this console got back from register (join), plus the keys it holds locally. */
export interface ConsoleSession {
  relayUrl: string
  endpointId: string
  groupId: string
  deviceToken: string
  label: string
  /** X25519 keypair (base64). The private key never leaves this browser. */
  publicKey: string
  privateKey: string
  /** keyId(publicKey) — cached so we don't recompute the fingerprint each pull. */
  keyId: string
}

/**
 * What the relay knows about one transfer without being able to read it [ADR-0028]:
 * the routing row's own timestamps. This is what lets the console say "that tab
 * never arrived" as a fact rather than an inference, on transfers it was never
 * an end of and was never sent a copy of.
 *
 * Absent on an ADR-0010 copy, where the console genuinely has no idea: a copy is
 * evidence that a send was made, and nothing more.
 */
export interface HistoryDelivery {
  /** When the relay accepted the send. "Sent" has only ever meant this [ADR-0008]. */
  createdAt: string
  /** Past this instant with no ack, the tab never arrived and never will. */
  expiresAt: string
  /** Set once the relay handed it to the target. */
  deliveredAt: string | null
  /** Set once the target confirmed it. */
  ackedAt: string | null
}

/**
 * One row of the history panel. Two things produce these, and they merge into one
 * timeline (lib/history.ts `mergeTimeline`):
 *
 *  - **Group history [ADR-0028]** — a row of `GET /v1/messages?history=1`,
 *    covering EVERY transfer in the group, with `delivery` filled in. Content is
 *    present when we hold the key the blob names, absent when we do not.
 *  - **A per-console copy [ADR-0010]** — a message an older sender sealed to this
 *    console. Always has content, never has `delivery`.
 *
 * Persisted keyed by `id` (a message id either way, so the two can never
 * collide), which also serves as the idempotency/seen set.
 */
export interface HistoryEntry {
  /** The message id: the real send's for a group row, the copy's for a copy. */
  id: string
  sourceEndpointId: string
  /** The REAL send's target — "Chrome · Work → Pixel · Phone". */
  targetEndpointId: string
  /**
   * The link. ABSENT on a metadata-only row: group history whose blob is sealed
   * under a key this console does not hold. The row still renders, because a
   * transfer it cannot read is still a true record that the transfer happened.
   */
  url?: string
  title?: string
  favicon?: string
  /**
   * Sender-stamped send time when we could read the content — honest, no server
   * clock involved. On a metadata-only row it falls back to the relay's
   * `createdAt`, which is when the relay accepted the send.
   */
  sentAt: string
  /** When THIS console last wrote the row into its local cache. */
  recordedAt: string
  /** Label snapshots, so a row still renders after a rename or a removal. */
  sourceLabelAtSend: string
  targetLabelAtSend: string
  /**
   * Set when the send was a multi-tab selection (SendPayload.batch): the id every
   * tab of that send shares, and how many tabs the sender put in it. The history
   * list groups by the id so one send reads as one send. `count` is the sender's
   * number, which can exceed the rows we hold, so the group header says "2 of 3"
   * rather than pretending.
   */
  batch?: { id: string; count: number }
  /** Relay-known delivery facts [ADR-0028]. Absent on an ADR-0010 copy. */
  delivery?: HistoryDelivery
}

/** A device row in the management panel — an endpoint plus computed adornments. */
export interface DeviceRow {
  endpoint: Endpoint
  /** This console's own endpoint (highlighted, not removable-without-warning). */
  isSelf: boolean
  /** kind === 'console' — shown, but marked "console" and never a send target. */
  isConsole: boolean
  /** Offline past the 30-day stale horizon (time.ts) — likely abandoned/reinstalled. */
  stale: boolean
  /**
   * False once the relay stops answering: the list on screen is then whatever
   * the last successful refresh returned, and its `presence` ages with it.
   */
  presenceKnown: boolean
  presence: PresenceStatus
  lastSeenLabel: string
}

/** The console's live connection to the relay's fast path. */
export type ConnectionMode = 'live' | 'polling' | 'offline'

/** Re-exports so UI code imports view enums from one place. */
export type { BrowserFamily, EndpointKind, IsoTimestamp, Platform, PresenceStatus }
