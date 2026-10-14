import {
  type Endpoint,
  type EndpointId,
  endpointsKnownTo,
  type GroupKeyDelivery,
  type GroupKeyRecord,
  type GroupKeyRequest,
  type IsoTimestamp,
  isAcceptableDeparted,
  isAcceptableKeyCreatedAt,
  listIncludesSelf,
  rotationDeparted,
  rotationDue,
  vouchedDeparted,
} from '@tabsend/shared'
import { getGroupKeys as fetchGroupKeys, isHistoryUnsupported, postGroupKeys } from '../lib/api'
import { base64ToBytes } from '../lib/base64'
import { generateGroupKey, groupKeyId, keyId, open, seal } from '../lib/crypto'
import {
  currentKey,
  mergeKeys,
  pendingKeyDeliveries,
  rotatedKey,
  shouldMintFirstKey,
} from '../lib/keyring'
import {
  clearHistoryUnsupportedAt,
  getCachedEndpoints,
  getDeliveredKeys,
  getGroupKeys,
  getHistoryUnsupportedAt,
  setDeliveredKeys,
  setGroupKeys,
  setHistoryUnsupportedAt,
} from '../lib/storage'
import { fetchEndpoints } from './endpoints'
import { currentDeviceWatch, markRotationDone } from './newdevices'
import { currentSession } from './session'

/**
 * Keeping this device's group history keyring current [ADR-0028 §4-§6].
 *
 * Three things happen on a wake, in this order, and all three are BEST-EFFORT by
 * contract: nothing here may fail, slow, or block a send or a delivery. History
 * is a record of what the product does; it is not the product.
 *
 *  1. **Collect.** Fetch every copy sealed to this endpoint and fold it into the
 *     ring. A copy is not consumed on read, so re-fetching costs nothing and a
 *     device that dies before persisting gets another chance.
 *  2. **Mint, if elected.** A group that predates the ADR has no key at all.
 *     Exactly one device (lowest endpoint id) mints the first one, so an
 *     upgrading group does not fragment its first day of history across N keys.
 *     **Or rotate, if owed.** A device left the list since the current key was
 *     made (the new-device watch records it), so whatever left may hold that
 *     key. Mint a replacement unless another device already has [ADR-0028 §7].
 *  3. **Hand out.** Seal the current key to every other member that has not had
 *     it yet. This is the ONLY way a key ever travels: to a published X25519 key,
 *     never in a pairing link.
 *
 * The cost of all this being best-effort is the one ADR-0028 names: a freshly
 * paired device has no history until some other device next wakes. Receiving
 * tabs is unaffected and works immediately.
 */

/**
 * How long to leave a relay alone after it turns out to predate ADR-0028.
 *
 * The realistic upgrade order is that a browser extension updates itself and a
 * self-hosted relay is updated by hand some time later, so an old relay is a
 * normal state to be in, not a failure. Backing off keeps that from becoming one
 * doomed POST per 30-second poll, while still picking the relay up within an
 * hour of its being upgraded, with no action from anyone.
 */
export const UNSUPPORTED_BACKOFF_MS = 60 * 60 * 1000

/**
 * A sync already in flight, shared by anything asking in the same moment. A cold
 * boot and a popup open land within a few hundred ms of each other and would
 * otherwise both mint, both post, and race on the same stored ring.
 */
let inFlight: Promise<GroupKeyRecord[]> | null = null

/**
 * Bring the keyring up to date and return it. Never throws; on any failure the
 * ring is whatever was already stored, which is the right answer — an old key
 * still opens old history.
 */
export function syncGroupKeys(): Promise<GroupKeyRecord[]> {
  if (inFlight) return inFlight
  const run = doSync()
  inFlight = run
  const clear = (): void => {
    if (inFlight === run) inFlight = null
  }
  run.then(clear, clear)
  return run
}

/** True while a relay that refused ADR-0028's routes is still inside its backoff. */
export async function historyBackedOff(now: number = Date.now()): Promise<boolean> {
  const at = await getHistoryUnsupportedAt()
  return at !== undefined && now - at < UNSUPPORTED_BACKOFF_MS
}

/**
 * Record that this relay predates ADR-0028 (or has stopped answering its routes).
 * Deliberately silent: no banner, no badge, nothing the user has to dismiss.
 * Group history is the only thing affected, and its absence explains itself on
 * the screen that would have shown it.
 */
export async function markHistoryUnsupported(): Promise<void> {
  await setHistoryUnsupportedAt(Date.now())
}

async function doSync(): Promise<GroupKeyRecord[]> {
  const stored = await getGroupKeys()
  try {
    const session = await currentSession()
    if (!session) return stored
    // Read the backoff stamp once: it decides both whether to try at all and
    // whether there is anything to clear afterwards. Clearing unconditionally
    // would be a storage write on every 30-second wake, forever, to remove a key
    // that is almost never there.
    const unsupportedAt = await getHistoryUnsupportedAt()
    const backedOff =
      unsupportedAt !== undefined && Date.now() - unsupportedAt < UNSUPPORTED_BACKOFF_MS
    const { registration, identity } = session

    // The endpoint list is both the anti-injection check below and the list of
    // people to hand the key to, so a stale one is worth one round trip. Every
    // caller of this has just refreshed it, so the fetch is the empty-cache case.
    let endpoints = await getCachedEndpoints()
    if (endpoints.length === 0) {
      endpoints = await fetchEndpoints().catch(() => [])
    }
    // Only a list the new-device watch has judged may decide who is trusted and
    // who gets the key, and the watch ignores a list without this device.
    // `recordEndpoints` no longer caches one, so this only catches a cache left
    // by an older build.
    if (!listIncludesSelf(endpoints, registration.endpointId)) return stored

    let ring = stored
    // A relay that will not answer the key routes (down, backed off, or lying) must
    // not stop an owed rotation: the phones mint anyway, and a relay that fails these
    // routes after a removal would otherwise keep the removed device on the key. The
    // new key is minted locally and handed out on the first wake the routes answer.
    let deliveries: GroupKeyDelivery[] = []
    let routesAnswer = false
    if (!backedOff) {
      try {
        deliveries = await fetchGroupKeys(registration.relayUrl, registration.deviceToken)
        routesAnswer = true
        if (unsupportedAt !== undefined) await clearHistoryUnsupportedAt()
      } catch (err) {
        if (isHistoryUnsupported(err)) await markHistoryUnsupported()
      }
    }

    // Trust and hand out only to devices the new-device watch has accepted, by id
    // AND key: the cached list may predate the watch's latest view.
    const watch = await currentDeviceWatch()
    endpoints = endpointsKnownTo(watch, endpoints)

    const collected = await openDeliveries(deliveries, endpoints, identity.privateKey)
    if (collected.length > 0) {
      ring = mergeKeys(ring, collected)
      await setGroupKeys(ring)
    }

    if (shouldMintFirstKey(ring, endpoints, registration.endpointId)) {
      const key = await generateGroupKey()
      ring = mergeKeys(ring, [rotatedKey(ring, key, await groupKeyId(key), new Date())])
      await setGroupKeys(ring)
    }

    // After collecting, so a rotation another device already made is seen and
    // not repeated; before handing out, so the new key goes to everyone left.
    // The debt is settled either way once the ring holds a key.
    const owedAt = watch?.rotateOwedAt
    if (owedAt !== undefined && ring.length > 0) {
      const newest = currentKey(ring)
      // Stand down only for a key that is newer AND names the devices owed for:
      // one that merely arrived later may be held by the device that left (X14).
      if (rotationDue(watch, newest?.createdAt, newest?.departed)) {
        const key = await generateGroupKey()
        const departed = rotationDeparted(watch)
        ring = mergeKeys(ring, [rotatedKey(ring, key, await groupKeyId(key), new Date(), departed)])
        await setGroupKeys(ring)
      }
      await markRotationDone(owedAt)
    }

    if (routesAnswer) await deliverPending(ring, endpoints, session.registration, identity)
    return ring
  } catch {
    // Anything at all: a relay outage, a corrupt stored ring, a browser refusing
    // storage. History waits for the next wake; sending and receiving do not.
    return stored
  }
}

/**
 * Open every copy addressed to us, dropping anything we cannot vouch for.
 *
 * `senderKeyId` must fingerprint a CURRENT group endpoint — the same rule a tab
 * gets in receive.ts, and for the same reason. Without it the relay could inject
 * a key of its own choosing and then read every history blob written under it,
 * which would hand it exactly the plaintext ADR-0028 exists to keep from it.
 */
async function openDeliveries(
  deliveries: readonly GroupKeyDelivery[],
  endpoints: readonly Endpoint[],
  privateKey: string,
): Promise<GroupKeyRecord[]> {
  if (deliveries.length === 0) return []
  const senders = new Map<string, Endpoint>()
  await Promise.all(
    endpoints.map(async (e) => {
      senders.set(await keyId(e.e2ePubkey), e)
    }),
  )

  const records: GroupKeyRecord[] = []
  for (const delivery of deliveries) {
    const sender = senders.get(delivery.envelope.senderKeyId)
    if (!sender) continue
    try {
      const json = await open(
        { nonce: delivery.envelope.nonce, ciphertext: delivery.envelope.ciphertext },
        sender.e2ePubkey,
        privateKey,
      )
      const record = await validRecord(JSON.parse(json), sender.id)
      if (record) records.push(record)
    } catch {
      // Forged, corrupt, or sealed to a key we have since replaced. Drop it.
    }
  }
  return records
}

/**
 * A record is only usable if its `keyId` really fingerprints its `key`, its key
 * is a real 32-byte secretbox key, and its `createdAt` is one exact ISO shape no
 * more than a day ahead (`isAcceptableKeyCreatedAt`: the ring compares dates as
 * text, and a crafted date would otherwise stay "current" past every rotation).
 *
 * `departed` (the devices the key replaces) must be a short list of distinct ids,
 * and loses the sender's own id: a device cannot vouch that it has left.
 *
 * Everything downstream looks keys up BY id — `keyById` when reading a blob,
 * `deliveryId` when handing one on — so a mismatched pair would poison the ring
 * quietly: blobs sealed under it would name an id nothing can open, and the
 * failure would surface days later as unreadable history. Checking costs one
 * hash on a path that runs a handful of times in a group's lifetime.
 */
async function validRecord(
  parsed: unknown,
  senderEndpointId: string,
): Promise<GroupKeyRecord | undefined> {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { key, keyId: id, createdAt, departed } = parsed as Record<string, unknown>
  if (typeof key !== 'string' || typeof id !== 'string' || typeof createdAt !== 'string') {
    return undefined
  }
  if (!isAcceptableKeyCreatedAt(createdAt, Date.now())) return undefined
  if (!isAcceptableDeparted(departed)) return undefined
  if (!isGroupKeyLength(key)) return undefined
  if ((await groupKeyId(key)) !== id) return undefined
  const record: GroupKeyRecord = { key, keyId: id, createdAt: createdAt as IsoTimestamp }
  // What the key claims to replace, minus the device that sent this copy: a device
  // cannot vouch that it has left (X14).
  const named = vouchedDeparted(departed as string[] | null | undefined, senderEndpointId)
  if (named) record.departed = named
  return record
}

function isGroupKeyLength(keyB64: string): boolean {
  try {
    return base64ToBytes(keyB64).length === 32
  } catch {
    return false
  }
}

/**
 * Seal the current key to everyone who still needs it and post the copies.
 *
 * One POST for the whole batch, mirroring `POST /v1/messages`: per-item outcomes
 * are independent, so one member with a rotated key cannot cost the others their
 * copy. Only ACCEPTED ids are remembered, so a refusal is retried on a later
 * wake rather than being marked done and forgotten.
 */
async function deliverPending(
  ring: readonly GroupKeyRecord[],
  endpoints: readonly Endpoint[],
  registration: { relayUrl: string; deviceToken: string; endpointId: string },
  identity: { keyId: string; privateKey: string },
): Promise<void> {
  // Only the CURRENT key is handed on. An older one is still held by whoever was
  // in the group when it was current, and a device that arrived after it was
  // replaced has no history under it to read.
  const record = currentKey(ring)
  const delivered = await getDeliveredKeys()
  const pending = pendingKeyDeliveries(ring, endpoints, registration.endpointId, delivered)
  if (!record || pending.length === 0) return

  const plaintext = JSON.stringify(record)
  const items: GroupKeyRequest['items'] = []
  for (const target of pending) {
    try {
      const box = await seal(plaintext, target.targetPubkey, identity.privateKey)
      items.push({
        id: target.id,
        targetEndpointId: target.targetEndpointId as EndpointId,
        envelope: {
          alg: 'x25519-xsalsa20-poly1305/box',
          senderKeyId: identity.keyId,
          targetKeyId: await keyId(target.targetPubkey),
          nonce: box.nonce,
          ciphertext: box.ciphertext,
        },
      })
    } catch {
      // One member's published key is unusable; the rest still get theirs.
    }
  }
  if (items.length === 0) return

  try {
    const res = await postGroupKeys(registration.relayUrl, registration.deviceToken, { items })
    if (res.accepted.length > 0) {
      await setDeliveredKeys([...new Set([...delivered, ...res.accepted])])
    }
  } catch (err) {
    if (isHistoryUnsupported(err)) await markHistoryUnsupported()
    // Otherwise the relay is down or busy — the next wake tries again.
  }
}
