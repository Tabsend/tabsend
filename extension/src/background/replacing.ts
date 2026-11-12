import { appNameOf, findReplacedSelf } from '@tabsend/shared'
import type { ReplaceOffer } from '../lib/model'
import { fetchEndpoints } from './endpoints'
import { removeEndpoint, renameEndpoint } from './identity'
import { currentDeviceWatch } from './newdevices'
import { currentSession } from './session'

/**
 * "Is this browser replacing Dia?" (PLANS.md P-31 item 2). Asked on the setup page
 * only, right after this browser finished pairing, about THIS browser. The match is
 * `findReplacedSelf` (`shared/src/replacing.ts`), on a fresh list from the relay.
 *
 * Never answers, confirms or accepts any device (SECURITY_REVIEW.md L1): "Replace"
 * is the ordinary removal (watch record, owed rotation) and then a rename of this
 * browser. Nothing else.
 */
export async function replaceOffer(): Promise<ReplaceOffer | null> {
  const session = await currentSession()
  if (!session) return null
  const selfId = session.registration.endpointId
  const list = await fetchEndpoints()
  const watch = await currentDeviceWatch()
  const removed = watch?.selfId === selfId ? (watch.removed ?? []) : []
  const old = findReplacedSelf(selfId, list, removed, Date.now())
  if (!old) return null
  return {
    endpointId: old.id,
    label: old.label,
    appName: appNameOf(old.label),
    lastSeenAt: old.lastSeenAt,
  }
}

/**
 * "Replace Dia": only if the same entry is still the match on a list read now (the
 * page may have sat open), remove it, and only once that worked, take its name.
 * Returns whether it did anything.
 */
export async function replaceSelf(endpointId: string): Promise<boolean> {
  const offer = await replaceOffer()
  if (!offer || offer.endpointId !== endpointId) return false
  const session = await currentSession()
  if (!session) return false
  await removeEndpoint(offer.endpointId)
  await renameEndpoint(session.registration.endpointId, offer.label)
  return true
}
