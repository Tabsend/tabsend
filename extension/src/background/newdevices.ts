import {
  announcesNewDevices,
  confirmNewDevice,
  confirmReview,
  dismissVanished,
  type Endpoint,
  ListWithoutSelfError,
  listIncludesSelf,
  type NewDeviceNotice,
  type NewDeviceWatch,
  removeDevice,
  rotationDone,
  settleNotices,
  watchDevices,
} from '@tabsend/shared'
import { ext } from '../lib/ext'
import { currentKey } from '../lib/keyring'
import { IS_FIREFOX } from '../lib/platform'
import {
  clearPairingVouch,
  getCachedEndpoints,
  getGroupKeys,
  getNewDeviceWatch,
  getPairingVouch,
  setCachedEndpoints,
  setNewDeviceWatch,
} from '../lib/storage'
import { newDeviceCopy } from '../lib/strings'
import { currentSession } from './session'

export { ListWithoutSelfError }

/**
 * The "new device joined" notice (PLANS.md P-10) on the extension.
 *
 * Every device list this browser fetches goes through `recordEndpoints`, which
 * runs the shared rule (`watchDevices`) against what this browser saw last and
 * only then writes the cache. The `endpoint_added` stream event is never read here:
 * it only makes a fetch happen sooner, and a relay that wanted to hide a device
 * would not send it.
 *
 * The alert is posted once per newly seen device. The banner (chooser and
 * manage screen) reads `newDeviceNotices` and stays until the user answers.
 */

const NOTIFICATION_ID_PREFIX = 'tabsend-device-'

/**
 * Read-compare-write runs one at a time. The poll alarm, a stream event and an
 * open popup can all fetch in the same second; two passes reading the same old
 * record would both announce the same device.
 */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * Judge a list just taken from the relay, then store it. The watch is written
 * FIRST and the cache only after it, so the key sync (which reads the cache) never
 * acts on a list the watch has not seen; if the watch cannot be stored, this
 * throws and callers keep the last good list. A list without this device is
 * refused outright (`ListWithoutSelfError`) for the same reason.
 */
export async function recordEndpoints(list: Endpoint[], selfEndpointId: string): Promise<void> {
  if (!listIncludesSelf(list, selfEndpointId)) throw new ListWithoutSelfError()
  const told = await serial(async () => {
    const current = currentKey(await getGroupKeys())?.createdAt
    const prev = await getNewDeviceWatch()
    // With no record yet, the list a build from before the notice cached is the
    // baseline, so what appeared after it is announced (GH6). Read before the
    // cache is overwritten below.
    const seed = prev ? undefined : await getCachedEndpoints()
    // The devices the pairing link vouched for are not reported (P-23). Read only
    // while this pairing has no record; spent once its first record is stored.
    const mine = prev?.selfId === selfEndpointId ? prev : undefined
    const vouch = mine ? undefined : await getPairingVouch()
    const vouched = vouch?.endpointId === selfEndpointId ? vouch.tags : undefined
    const result = watchDevices(
      prev,
      list,
      selfEndpointId,
      new Date().toISOString(),
      current,
      seed,
      vouched,
    )
    // Told once, as information, and nothing waits for an answer (P-23): the record
    // keeps no pending notice. On a fresh pairing, the devices the link did not
    // vouch for are told the same way.
    if (result.watch) await setNewDeviceWatch(settleNotices(result.watch))
    if (vouched && result.watch?.selfId === selfEndpointId) await clearPairingVouch()
    await setCachedEndpoints(list)
    const firstList = mine ? [] : (result.watch?.review ?? [])
    if (!announcesNewDevices(mine, list, selfEndpointId, Date.now())) return null
    if (result.joined.length > 0) return { kind: 'joined' as const, devices: result.joined }
    if (firstList.length > 0) return { kind: 'firstList' as const, devices: firstList }
    return null
  })
  if (told) await notifyNewDevices(told.kind, told.devices)
}

/** The joined devices this browser has not answered yet, oldest first. */
export async function newDeviceNotices(): Promise<NewDeviceNotice[]> {
  const session = await currentSession()
  const watch = await getNewDeviceWatch()
  if (!session || !watch || watch.selfId !== session.registration.endpointId) return []
  return watch.unconfirmed
}

/** The first look: the other devices in the first list, waiting for one answer (GH6). */
export async function reviewNotices(): Promise<NewDeviceNotice[]> {
  const session = await currentSession()
  const watch = await getNewDeviceWatch()
  if (!session || !watch || watch.selfId !== session.registration.endpointId) return []
  return watch.review ?? []
}

/** Announced as new, never answered, then gone from the list (GH7). */
export async function vanishedNotices(): Promise<NewDeviceNotice[]> {
  const session = await currentSession()
  const watch = await getNewDeviceWatch()
  if (!session || !watch || watch.selfId !== session.registration.endpointId) return []
  return watch.vanished ?? []
}

/** "All of these are mine". Only this browser's card goes; each device answers for itself. */
export function confirmReviewAnswer(): Promise<void> {
  return serial(async () => {
    const watch = await getNewDeviceWatch()
    if (watch) await setNewDeviceWatch(confirmReview(watch))
  })
}

/** Dismiss one "joined, then disappeared" notice on this browser. */
export function dismissVanishedNotice(endpointId: string): Promise<void> {
  return serial(async () => {
    const watch = await getNewDeviceWatch()
    if (watch) await setNewDeviceWatch(dismissVanished(watch, endpointId))
  })
}

/** The watch as stored now, for the key sync's owed-rotation check. */
export function currentDeviceWatch(): Promise<NewDeviceWatch | undefined> {
  return serial(() => getNewDeviceWatch())
}

/** Clear the owed rotation that was read, through the same queue as every other write. */
export function markRotationDone(owedAt: string): Promise<void> {
  return serial(async () => {
    const watch = await getNewDeviceWatch()
    if (watch) await setNewDeviceWatch(rotationDone(watch, owedAt))
  })
}

/**
 * This browser removed `endpointId` and the relay accepted the request: write it
 * into the watch NOW. "Remove" is only a request, and a relay that answers it and
 * keeps listing the device would otherwise trigger no departure and no rotation
 * (X13). The device leaves the watch's known list, a rotation is owed at once, and
 * the key sync leaves it out for good. Through the same queue as every other write.
 */
export function recordRemovedEndpoint(selfEndpointId: string, endpointId: string): Promise<void> {
  return serial(async () => {
    const watch = await getNewDeviceWatch()
    if (!watch || watch.selfId !== selfEndpointId) return
    const current = currentKey(await getGroupKeys())?.createdAt
    await setNewDeviceWatch(removeDevice(watch, endpointId, new Date().toISOString(), current))
  })
}

/** "Yes, it's mine". Only this browser's banner goes; each device answers for itself. */
export function confirmNewDeviceNotice(endpointId: string): Promise<void> {
  return serial(async () => {
    const watch = await getNewDeviceWatch()
    if (watch) await setNewDeviceWatch(confirmNewDevice(watch, endpointId))
  })
}

/**
 * Deliberately NOT gated on `notifyOnReceive`: that switch is about arrivals,
 * and this is a security notice. The browser's own notification permission
 * still applies. Information only (P-23): it goes away on its own, and the
 * device is simply in the list.
 */
async function notifyNewDevices(
  kind: 'joined' | 'firstList',
  devices: NewDeviceNotice[],
): Promise<void> {
  try {
    if (!ext.notifications?.create) return
    const { title, message } =
      kind === 'joined'
        ? newDeviceCopy.alert(devices, Date.now())
        : newDeviceCopy.firstListAlert(devices)
    await ext.notifications.create(`${NOTIFICATION_ID_PREFIX}${Date.now()}`, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icons/tabsend-128.png'),
      title,
      message,
    })
  } catch {
    // No notifications API or permission: the device is still in the list.
  }
}

/** A click opens the manage screen, where the device list and its Remove buttons are. */
export async function handleNewDeviceNotificationClick(notificationId: string): Promise<boolean> {
  if (!notificationId.startsWith(NOTIFICATION_ID_PREFIX)) return false
  void Promise.resolve()
    .then(() => ext.notifications.clear(notificationId))
    .catch(() => {})
  try {
    await ext.tabs.create({ url: ext.runtime.getURL('firstrun.html') })
  } catch {
    // nothing to fall back to
  }
  return true
}
