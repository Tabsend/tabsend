import type { Endpoint } from '@tabsend/shared'
import { ext } from '../lib/ext'
import type { SendResult } from '../lib/model'
import {
  getUnreachableDevices,
  setUnreachableDevices,
  UNREACHABLE_DEVICES_KEY,
} from '../lib/storage'
import { unreachableCopy } from '../lib/strings'
import {
  addUnreachable,
  isUnreachableResult,
  pruneUnreachable,
  type UnreachableDevice,
  withoutUnreachable,
} from '../lib/unreachable'
import { setUnreachableBadge } from './badge'

/**
 * Devices a send could not reach (PLANS.md P-20), kept until they are answered:
 * paired again, listed again, sent to successfully, or dismissed in the popup.
 * Storage is the record; the badge follows it through `registerUnreachableBadgeSync`.
 */

/** After every send: remember a device the relay no longer has, forget one that worked. */
export async function noteSendOutcome(targetEndpointId: string, result: SendResult): Promise<void> {
  const list = await getUnreachableDevices()
  if (isUnreachableResult(result)) {
    await setUnreachableDevices(
      addUnreachable(list, {
        endpointId: targetEndpointId,
        label: result.targetLabel ?? 'A device',
        failedAt: new Date().toISOString(),
      }),
    )
  } else if (result.ok && !result.failure && list.some((d) => d.endpointId === targetEndpointId)) {
    await setUnreachableDevices(withoutUnreachable(list, targetEndpointId))
  }
}

/** Measure the record against a list just fetched from the relay. */
export async function pruneUnreachableWith(fresh: readonly Endpoint[]): Promise<void> {
  const list = await getUnreachableDevices()
  if (list.length === 0) return
  const kept = pruneUnreachable(list, fresh)
  if (kept.length !== list.length) await setUnreachableDevices(kept)
}

export async function dismissUnreachable(endpointId: string): Promise<void> {
  await setUnreachableDevices(withoutUnreachable(await getUnreachableDevices(), endpointId))
}

export function unreachableTooltip(list: readonly UnreachableDevice[]): string {
  return list.length === 0 ? '' : unreachableCopy.tooltip(list.map((d) => d.label))
}

/** Prime the badge from storage: a fresh service worker starts knowing nothing. */
export async function primeUnreachableBadge(): Promise<void> {
  setUnreachableBadge(unreachableTooltip(await getUnreachableDevices()))
}

/** Follow every writer of the record, as `registerUnreadBadgeSync` does for the count. */
export function registerUnreachableBadgeSync(): void {
  ext.storage.onChanged.addListener((changes, area) => {
    const change = changes[UNREACHABLE_DEVICES_KEY]
    if (area === 'local' && change) {
      setUnreachableBadge(
        unreachableTooltip((change.newValue as UnreachableDevice[] | undefined) ?? []),
      )
    }
  })
}
