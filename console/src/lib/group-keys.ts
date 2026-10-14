import {
  type Endpoint,
  type GroupKeyDelivery,
  type GroupKeyRecord,
  isAcceptableDeparted,
  isAcceptableKeyCreatedAt,
} from '@tabsend/shared'
import { base64ToBytes } from './base64'
import { groupKeyId, open } from './crypto'
import { mayMintGroupKey, mergeKeys } from './keyring'
import type { ConsoleSession } from './model'
import { buildSenderIndex } from './receive'

/**
 * Collecting the group history key [ADR-0028] — receive only.
 *
 * `GET /v1/group-keys` returns every copy some other endpoint sealed to this
 * console's published key. Each one is an ordinary `crypto_box` envelope, so it
 * gets the ordinary anti-injection rule a tab gets: the envelope's `senderKeyId`
 * has to fingerprint a CURRENT group endpoint's key before we open it. Without
 * that check the relay could hand us a key it made up, and then serve history
 * blobs sealed under it, which is exactly the link-injection ADR-0009 blocks for
 * tabs. The relay holds no key and cannot forge either half.
 *
 * The console never posts to this route. It does not mint (lib/keyring.ts) and
 * cannot seal (lib/crypto.ts), so the write direction has no implementation to
 * reach.
 *
 * Sources are injected so this is unit-testable with real crypto and no HTTP.
 * Fetch failures propagate to the caller, which is the only place that can tell
 * "this relay predates group history" (400/404) from "the relay is down".
 */
export interface GroupKeySources {
  listEndpoints(): Promise<Endpoint[]>
  getGroupKeys(): Promise<GroupKeyDelivery[]>
}

export interface GroupKeySyncDeps {
  sources: GroupKeySources
  session: ConsoleSession
  /** The ring as persisted. Merged and returned; the caller persists the result. */
  ring: readonly GroupKeyRecord[]
  /** An endpoint list already fetched this cycle, to save a second round trip. */
  endpoints?: Endpoint[]
}

export interface GroupKeySyncResult {
  ring: GroupKeyRecord[]
  /** Keys the ring did not already hold. */
  added: number
  /** Copies refused: unknown sender, failed authentication, or a bad record. */
  skipped: number
  /**
   * The group has no key here yet and this console will not create one. Lets the
   * panel say so plainly instead of showing a list of unreadable rows with no
   * explanation. It resolves itself as soon as a sending device delivers a copy.
   */
  awaitingFirstKey: boolean
}

/**
 * Pull every key copy addressed to this console and fold the good ones into the
 * ring. A single bad copy is skipped, never thrown: one forged or corrupt
 * delivery must not cost us the others in the same response.
 */
export async function syncGroupKeys(deps: GroupKeySyncDeps): Promise<GroupKeySyncResult> {
  const deliveries = await deps.sources.getGroupKeys()
  if (deliveries.length === 0) return done([...deps.ring], 0, 0)

  let endpoints = deps.endpoints ?? (await deps.sources.listEndpoints())
  let senders = await buildSenderIndex(endpoints)
  // A copy naming a sender we have not seen yet is the NORMAL case right after a
  // new device joins and immediately hands out the key. Refresh once so
  // verification never refuses a legitimate copy just because our list is stale.
  if (deliveries.some((d) => !senders.has(d.envelope.senderKeyId))) {
    try {
      endpoints = await deps.sources.listEndpoints()
      senders = await buildSenderIndex(endpoints)
    } catch {
      // keep the cached index; unknown senders are skipped and re-offered later
    }
  }

  const accepted: GroupKeyRecord[] = []
  let skipped = 0

  for (const delivery of deliveries) {
    const senderPubkey = senders.get(delivery.envelope.senderKeyId)
    if (!senderPubkey) {
      skipped += 1
      continue // not a current group member — refuse (blocks relay injection)
    }

    let record: GroupKeyRecord
    try {
      const json = await open(
        { nonce: delivery.envelope.nonce, ciphertext: delivery.envelope.ciphertext },
        senderPubkey,
        deps.session.privateKey,
      )
      record = JSON.parse(json) as GroupKeyRecord
    } catch {
      skipped += 1
      continue // forged, corrupt, or sealed to a key we have since replaced
    }

    if (!(await isSoundRecord(record))) {
      skipped += 1
      continue
    }
    accepted.push(record)
  }

  const ring = mergeKeys(deps.ring, accepted)
  return done(ring, ring.length - deps.ring.length, skipped)
}

function done(ring: GroupKeyRecord[], added: number, skipped: number): GroupKeySyncResult {
  // Where a sending client would now hold the first-key election [0028 §6]. The
  // console asks the same question and is always told no, so an empty ring is a
  // state it reports and waits out rather than one it resolves.
  return { ring, added, skipped, awaitingFirstKey: ring.length === 0 && !mayMintGroupKey() }
}

/**
 * A record is only usable if `keyId` really fingerprints `key`. The ring is
 * indexed by `keyId` and a blob names the key that sealed it, so a mismatched
 * pair would answer a lookup with the wrong secret: every blob under that id
 * would fail to open, and the console would report "sealed with a key this
 * console does not hold" about a key it is in fact holding.
 */
async function isSoundRecord(record: GroupKeyRecord): Promise<boolean> {
  if (typeof record?.key !== 'string' || record.key === '') return false
  if (typeof record.keyId !== 'string' || record.keyId === '') return false
  // One exact ISO shape, no more than a day ahead: the ring compares dates as
  // text, so a crafted one would stay "current" past every rotation (review
  // 2026-10-13; `shared/src/keyrecord.ts`).
  if (typeof record.createdAt !== 'string') return false
  if (!isAcceptableKeyCreatedAt(record.createdAt, Date.now())) return false
  // The console never rotates, so it never reads the list of devices a key replaces;
  // it refuses a malformed one all the same, so every client accepts the same records.
  if (!isAcceptableDeparted(record.departed)) return false
  try {
    if (base64ToBytes(record.key).length !== 32) return false
    return (await groupKeyId(record.key)) === record.keyId
  } catch {
    return false
  }
}
