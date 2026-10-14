/**
 * What a group-key record's `createdAt` must look like before a client accepts
 * it (ADR-0028 §6, amended 2026-10-13).
 *
 * The keyring picks the current key by comparing `createdAt` AS TEXT, so the
 * text has to be one exact shape. Before this check a copy dated
 * `"Wed, 31 Dec 9999 00:00:00 GMT"` (which `Date.parse` accepts, and which sorts
 * above every ISO date because `W` > `2`) or `"9999-12-31T23:59:59.999Z"` (one
 * millisecond later is `"+010000-…"`, which sorts LOWER) would have stayed the
 * current key for good, and no rotation could ever have replaced it. Android and
 * iOS did not look at the field at all, so a value the browsers refused split the
 * group in two.
 *
 * Accepted: exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, a real instant, and no more than
 * a day ahead of this device's clock. The day is slack for a wrong clock on the
 * device that minted it; anything further ahead could only pin a key.
 *
 * Mirrored by Android (`logic/Keyring.kt`) and iOS (`Keyring.swift`); all three
 * run `shared/vectors/group-key-records.json`.
 */

export const KEY_CREATED_AT_MAX_AHEAD_MS = 24 * 60 * 60 * 1000

const CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isAcceptableKeyCreatedAt(createdAt: string, nowMs: number): boolean {
  if (!CANONICAL.test(createdAt)) return false
  const at = Date.parse(createdAt)
  if (Number.isNaN(at)) return false
  // Round-trips exactly, so "2026-02-30T…" (which Date.parse rolls forward) is refused.
  if (new Date(at).toISOString() !== createdAt) return false
  return at <= nowMs + KEY_CREATED_AT_MAX_AHEAD_MS
}

/**
 * The most ids a key record names, and a new-device watch tracks as owed. A key
 * copy has to fit the relay's 4096-byte envelope cap (`server/src/routes/group-keys.ts`),
 * and a relay that makes ids appear and disappear must not be able to grow the
 * record until the cap refuses the copy, which would stop the rotation reaching
 * anyone. Measured: 32 UUIDs make a 1408-byte record and a 2117-byte envelope; 32
 * ids of 64 characters make 3313 bytes. `groupkeys.test.ts` fails if the worst case
 * ever stops fitting.
 */
export const MAX_DEPARTED = 32
export const MAX_DEPARTED_ID_LENGTH = 64

/**
 * Whether a record's `departed` field may enter the ring: absent (or `null`), or
 * a list of at most `MAX_DEPARTED` distinct, non-empty strings of at most
 * `MAX_DEPARTED_ID_LENGTH` characters. Anything else refuses the whole record,
 * the way a bad date does: a key whose claim cannot be read is not one to act on.
 *
 * Mirrored by Android (`logic/Keyring.kt`) and iOS (`Keyring.swift`); all three
 * run the `departed` cases in `shared/vectors/group-key-records.json`.
 */
export function isAcceptableDeparted(departed: unknown): boolean {
  if (departed === undefined || departed === null) return true
  if (!Array.isArray(departed) || departed.length > MAX_DEPARTED) return false
  const seen = new Set<string>()
  for (const id of departed) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_DEPARTED_ID_LENGTH) return false
    if (seen.has(id)) return false
    seen.add(id)
  }
  return true
}

/**
 * The `departed` list a receiver may rely on: the record's, minus the device that
 * sent the copy. A device cannot vouch that IT has left. Without this, a device
 * about to be removed could mint a key naming itself, and a relay that held the
 * copies back until after the removal would let everyone stand down on a key that
 * device holds (the "lagging" variant of X14). Returns undefined for a record that
 * names nobody, so a stored record never carries an empty claim.
 */
export function vouchedDeparted(
  departed: readonly string[] | undefined | null,
  senderEndpointId: string,
): string[] | undefined {
  const named = (departed ?? []).filter((id) => id !== senderEndpointId)
  return named.length > 0 ? named : undefined
}
