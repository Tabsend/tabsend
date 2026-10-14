import type { GroupKeyRecord } from '@tabsend/shared'

/**
 * The group history keyring [ADR-0028], console side.
 *
 * A device holds a SET of group keys, not one. That single decision collapses
 * three problems into the same code path:
 *
 *  - **Rotation.** Removing a device mints a new key. History written before it
 *    stays readable, because the old key is still in the ring.
 *  - **A generation race.** A group upgrading from before ADR-0028 has no key,
 *    and two devices could mint one at the same moment. Both end up in every
 *    ring, everyone converges on the same newest one, and the blobs written
 *    under the loser stay readable instead of becoming garbage.
 *  - **Arriving late.** A console paired today collects whatever it missed and
 *    can read the whole retention window, including transfers made before it
 *    existed. That is the case this console could never serve before.
 *
 * The convergence rule is total and deterministic, so devices agree without
 * talking to each other: newest `createdAt` wins, and `keyId` breaks a tie.
 * `keyId` is a hash, so the tiebreak is arbitrary but identical everywhere.
 *
 * This is a faithful port of extension/src/lib/keyring.ts, which is the
 * canonical version, minus the halves a console has no business running (see
 * `mayMintGroupKey` below and the note at the end of the file).
 */

/** Newest first, deterministic. Storage order, so a reload reads the same ring. */
export function sortKeys(ring: readonly GroupKeyRecord[]): GroupKeyRecord[] {
  return [...ring].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.keyId < b.keyId ? 1 : -1
  })
}

/** The key a stored blob names. A miss means we hold no key for that transfer. */
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
 * May THIS console mint a group key? Always no.
 *
 * The canonical rule (`shouldMintFirstKey` in the extension) elects the lowest
 * endpoint id in the group to mint the first key, so an upgrading group does not
 * fragment its first day of history across N keys. Run here, that election would
 * hand the group's key authority to whichever browser tab happened to have the
 * console open — a surface that cannot send a tab, is excluded from every
 * chooser, and may have been opened once and abandoned. A key minted there and
 * never delivered onward would split the group's history for no gain.
 *
 * So the console reads keys and never writes one, in either direction: it does
 * not mint, and it does not deliver copies to other endpoints. It is a reader.
 * If no sending device is around to mint, the group simply has no history yet,
 * which is the honest outcome rather than one this console invents.
 *
 * Kept as a named function rather than an absence so the sync path can state the
 * refusal at the point where the canonical logic would have acted, and so a test
 * can hold it to it.
 */
export function mayMintGroupKey(): boolean {
  return false
}

// There is deliberately no `pendingKeyDeliveries` / `deliveryId` here either.
// Handing the current key to a new endpoint is the other half of minting, and a
// console that never seals (lib/crypto.ts) has nothing to hand over.
