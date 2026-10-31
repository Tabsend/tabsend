import type { Endpoint } from '@tabsend/shared'
import type { SendResult } from './model'

/**
 * A device a send from this browser could not reach because the relay no longer
 * has it (PLANS.md P-20): Tabsend was removed or reinstalled there, or the device
 * was removed from the group. Remembered so the popup can say so, and the toolbar
 * icon can keep a "!", until it is fixed or dismissed. A send failure on its own
 * flashed for 2.5 seconds and left nothing behind.
 *
 * Device-local; never sent anywhere.
 */
export interface UnreachableDevice {
  endpointId: string
  /** The name it had when the send failed. It is usually no longer listed. */
  label: string
  /** ISO: when the send failed. A device paired after this may be its return. */
  failedAt: string
}

/**
 * Whether this send result says the target itself is gone from the group, as
 * opposed to the relay being down or busy. Only these deserve a standing notice:
 * every other failure either clears itself or is about the relay, not the device.
 */
export function isUnreachableResult(result: SendResult): boolean {
  const failure = result.failure
  if (!failure) return false
  if (failure.kind === 'no-target') return true
  return (
    failure.kind === 'relay-rejected' &&
    (failure.reason === 'unknown_target' || failure.reason === 'not_in_group')
  )
}

/** Record one device, replacing any older entry for it. Newest last. */
export function addUnreachable(
  list: readonly UnreachableDevice[],
  entry: UnreachableDevice,
): UnreachableDevice[] {
  return [...list.filter((d) => d.endpointId !== entry.endpointId), entry]
}

export function withoutUnreachable(
  list: readonly UnreachableDevice[],
  endpointId: string,
): UnreachableDevice[] {
  return list.filter((d) => d.endpointId !== endpointId)
}

/**
 * Drop the entries a fresh device list has answered:
 *  - the device is listed again, so the relay has it after all; or
 *  - a device with the same name joined after the failure, which is what pairing
 *    it again looks like (a reinstalled app gets a new id, not the old one).
 *
 * Only ever called with a list fetched from the relay, never the cache: a stale
 * cache can still list a device the relay has already forgotten.
 */
export function pruneUnreachable(
  list: readonly UnreachableDevice[],
  fresh: readonly Endpoint[],
): UnreachableDevice[] {
  return list.filter((d) => {
    if (fresh.some((e) => e.id === d.endpointId)) return false
    const failed = Date.parse(d.failedAt)
    return !fresh.some((e) => e.label === d.label && Date.parse(e.createdAt) > failed)
  })
}
