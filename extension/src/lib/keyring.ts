import type { Endpoint, GroupKeyRecord } from '@tabsend/shared'

/**
 * The group history keyring [ADR-0028].
 *
 * A device holds a SET of group keys, not one. That single decision collapses
 * three problems into the same code path:
 *
 *  - **Rotation.** A device leaving the group mints a new key (the next sync
 *    after the new-device watch sees it go; see `groupkeys.ts`). History written
 *    before it stays readable, because the old key is still in the ring.
 *  - **A generation race.** A group upgrading from before ADR-0028 has no key,
 *    and two devices could mint one at the same moment. Both end up in every
 *    ring, everyone converges on the same `current` one, and the blobs written
 *    under the loser stay readable instead of becoming garbage.
 *  - **Arriving late.** A device that has been off for a month collects whatever
 *    it missed and can read the whole window.
 *
 * The convergence rule is total and deterministic, so devices agree without
 * talking to each other: newest `createdAt` wins, and `keyId` breaks a tie.
 * `keyId` is a hash, so the tiebreak is arbitrary but identical everywhere.
 */

/** Newest first, deterministic. The head is what new sends are sealed under. */
export function sortKeys(ring: readonly GroupKeyRecord[]): GroupKeyRecord[] {
  return [...ring].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.keyId < b.keyId ? 1 : -1
  })
}

/** The key to seal NEW history under, or undefined while the group has none. */
export function currentKey(ring: readonly GroupKeyRecord[]): GroupKeyRecord | undefined {
  return sortKeys(ring)[0]
}

/** The key a stored blob names, for reading history sealed under an older one. */
export function keyById(
  ring: readonly GroupKeyRecord[],
  keyId: string,
): GroupKeyRecord | undefined {
  return ring.find((k) => k.keyId === keyId)
}

/**
 * Fold newly-received keys into the ring, deduped by `keyId`. Never drops a key:
 * an old one is what makes old history readable, and they are 32 bytes each.
 */
export function mergeKeys(
  ring: readonly GroupKeyRecord[],
  incoming: readonly GroupKeyRecord[],
): GroupKeyRecord[] {
  const byId = new Map(ring.map((k) => [k.keyId, k]))
  for (const key of incoming) {
    if (!byId.has(key.keyId)) byId.set(key.keyId, key)
  }
  return sortKeys([...byId.values()])
}

/**
 * Should THIS device mint the group's first key?
 *
 * Only when the ring is empty, and only for the endpoint with the lowest id
 * among the group's current members that can mint. A console never mints, so it
 * stands outside the election: counting it let a console with the lowest id
 * leave the group with no key at all. Any device minting whenever it noticed a
 * missing key would have every device in an upgrading group mint a different one
 * at once — survivable (see the race note above) but it would fragment the first
 * day of history across N keys for no reason. Lowest-id is an election that
 * needs no coordination, from a list every device already fetches.
 *
 * If that device never comes online the group simply has no history yet, and the
 * election moves to the next id the moment it leaves the group.
 */
export function shouldMintFirstKey(
  ring: readonly GroupKeyRecord[],
  endpoints: readonly Endpoint[],
  selfEndpointId: string,
): boolean {
  if (ring.length > 0) return false
  if (!endpoints.some((e) => e.id === selfEndpointId)) return false
  const ids = endpoints.filter((e) => e.kind !== 'console').map((e) => e.id as string)
  return ids.every((id) => selfEndpointId <= id)
}

/** One copy of the current key that still needs handing to a group member. */
export interface PendingKeyDelivery {
  /** Deterministic, so a replay dedupes server-side instead of piling up rows. */
  id: string
  targetEndpointId: string
  targetPubkey: string
}

/**
 * Which group members still need the current key.
 *
 * Excludes this device, consoles included on purpose (a console reads history
 * like anything else — it is excluded from CHOOSERS, not from the group), and
 * anything already delivered. `delivered` is a local record of
 * `keyId:endpointId` pairs, which is enough because both halves are stable: a
 * device that re-pairs gets a new endpoint id and so reappears here.
 */
export function pendingKeyDeliveries(
  ring: readonly GroupKeyRecord[],
  endpoints: readonly Endpoint[],
  selfEndpointId: string,
  delivered: readonly string[],
): PendingKeyDelivery[] {
  const key = currentKey(ring)
  if (!key) return []
  const done = new Set(delivered)
  // Never to a device the key itself names as gone: a key minted after a departure
  // exists to keep that device out, and a relay that lists it again (or shows this
  // device a list from before) must not get it handed over (X14).
  const gone = new Set(key.departed)
  return endpoints
    .filter((e) => (e.id as string) !== selfEndpointId && !gone.has(e.id as string))
    .map((e) => ({
      id: deliveryId(key.keyId, e.id as string),
      targetEndpointId: e.id as string,
      targetPubkey: e.e2ePubkey,
    }))
    .filter((d) => !done.has(d.id))
}

/** The stable id for one (key, recipient) pair. */
export function deliveryId(keyId: string, endpointId: string): string {
  return `gk-${keyId}-${endpointId}`
}

/**
 * Mint the record for a rotation. Separate from generation so the caller cannot
 * accidentally date a new key earlier than the one it replaces — which would
 * make `currentKey` keep choosing the old one and silently un-rotate the group.
 * `departed` is the debt it pays (`rotationDeparted` in the shared watch).
 */
export function rotatedKey(
  ring: readonly GroupKeyRecord[],
  key: string,
  keyId: string,
  now: Date,
  departed: readonly string[] = [],
): GroupKeyRecord {
  const newest = currentKey(ring)
  const nowIso = now.toISOString()
  const createdAt = newest && newest.createdAt >= nowIso ? bumpIso(newest.createdAt) : nowIso
  const record: GroupKeyRecord = { key, keyId, createdAt: createdAt as GroupKeyRecord['createdAt'] }
  // The devices this key replaces, named so a device that owes a rotation for them
  // can tell this key from one that merely arrived later (X14). The first key of a
  // group replaces nothing and names nobody.
  if (departed.length > 0) record.departed = [...departed]
  return record
}

/** One millisecond past an ISO instant, so a rotation always sorts newer. */
function bumpIso(iso: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? new Date().toISOString() : new Date(at + 1).toISOString()
}
