import type { GroupResetState } from '@tabsend/shared'
import { getGroupState, isGroupStateUnsupported, stopGroupReset } from '../lib/api'
import { ext } from '../lib/ext'
import type { GroupResetRecord } from '../lib/model'
import { IS_FIREFOX } from '../lib/platform'
import { getGroupResetRecord, setGroupResetRecord } from '../lib/storage'
import { groupResetCopy } from '../lib/strings'
import { currentSession } from './session'

/**
 * The reset that waits (PLANS.md P-18 item 12) on the extension.
 *
 * A hosted customer who lost every device can ask the account page to replace the
 * group with an empty one, 72 hours later. While it waits, every paired device shows
 * it and can stop it: that is the safeguard against someone who got into the
 * customer's email. A popup may not be opened once in those 72 hours, so the
 * BACKGROUND reads it, on every poll, on the `group_updated` stream event and with
 * every popup or manage-screen build, and raises a system notification once per
 * request (keyed by `requestedAt`, persisted). The card is drawn by the pages from
 * `groupResetNotice`.
 *
 * An older relay answers `GET /v1/group` 404, which reads as "no reset", quietly.
 */

const NOTIFICATION_ID_PREFIX = 'tabsend-reset-'

/** Read-compare-write runs one at a time, so overlapping reads cannot both alert. */
let queue: Promise<unknown> = Promise.resolve()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** A read already in flight, shared by everyone asking in the same moment. */
let inFlight: Promise<GroupResetState | null> | null = null

/**
 * Ask the relay whether a reset is waiting, store the answer, and raise the system
 * notification the first time a request is seen. Throws when the relay could not be
 * asked (offline, 5xx); the stored answer then stands. Coalesced: the poll alarm, a
 * stream event and an opening popup often ask in the same second.
 */
export function refreshGroupReset(): Promise<GroupResetState | null> {
  if (inFlight) return inFlight
  const run = doRefresh()
  inFlight = run
  const clear = (): void => {
    if (inFlight === run) inFlight = null
  }
  run.then(clear, clear)
  return run
}

async function doRefresh(): Promise<GroupResetState | null> {
  const session = await currentSession()
  if (!session) return null
  const { relayUrl, deviceToken, endpointId } = session.registration
  const reset = await readGroupReset(relayUrl, deviceToken)
  const announce = await serial(async () => {
    const stored = await getGroupResetRecord()
    const prev = stored?.selfId === endpointId ? stored : undefined
    const next: GroupResetRecord = { ...prev, selfId: endpointId, reset }
    const fresh =
      reset !== null &&
      prev?.notifiedFor !== reset.requestedAt &&
      prev?.dismissedFor !== reset.requestedAt
    if (fresh) next.notifiedFor = reset.requestedAt
    await setGroupResetRecord(next)
    return fresh ? reset : null
  })
  if (announce) await notifyGroupReset(announce)
  return reset
}

/** The relay's answer; an older relay without the route (404) has no reset waiting. */
async function readGroupReset(relayUrl: string, token: string): Promise<GroupResetState | null> {
  try {
    return (await getGroupState(relayUrl, token)).reset ?? null
  } catch (err) {
    if (isGroupStateUnsupported(err)) return null
    throw err
  }
}

/** The waiting reset to show a card for: none when there is none, or it was answered here. */
export async function groupResetNotice(): Promise<GroupResetState | undefined> {
  const session = await currentSession()
  if (!session) return undefined
  const record = await getGroupResetRecord()
  if (!record || record.selfId !== session.registration.endpointId) return undefined
  const { reset } = record
  if (!reset || record.dismissedFor === reset.requestedAt) return undefined
  return reset
}

/**
 * "Stop the reset". Throws user copy when the relay did not take it, so the card
 * stays and says why. On success the stored state is cleared at once (the relay's
 * `group_updated` follows, and changes nothing) and the notification goes.
 */
export async function stopPendingGroupReset(): Promise<void> {
  const session = await currentSession()
  if (!session) throw new Error(groupResetCopy.stopFailedOffline)
  const { relayUrl, deviceToken, endpointId } = session.registration
  try {
    await stopGroupReset(relayUrl, deviceToken)
  } catch (err) {
    if (err instanceof TypeError || (err instanceof Error && err.name === 'TimeoutError')) {
      throw new Error(groupResetCopy.stopFailedOffline)
    }
    throw new Error(groupResetCopy.stopFailed(err instanceof Error ? err.message : String(err)))
  }
  const was = await serial(async () => {
    const stored = await getGroupResetRecord()
    const prev = stored?.selfId === endpointId ? stored : undefined
    await setGroupResetRecord({ ...prev, selfId: endpointId, reset: null })
    return prev?.reset ?? null
  })
  if (was) clearNotification(was.requestedAt)
}

/** "It was me": hide the card for this request only, on this browser. A new request shows again. */
export function dismissGroupReset(requestedAt: string): Promise<void> {
  return serial(async () => {
    const session = await currentSession()
    if (!session) return
    const endpointId = session.registration.endpointId
    const stored = await getGroupResetRecord()
    const prev = stored?.selfId === endpointId ? stored : undefined
    await setGroupResetRecord({
      ...prev,
      selfId: endpointId,
      reset: prev?.reset ?? null,
      dismissedFor: requestedAt,
    })
    clearNotification(requestedAt)
  })
}

function clearNotification(requestedAt: string): void {
  void Promise.resolve()
    .then(() => ext.notifications?.clear?.(`${NOTIFICATION_ID_PREFIX}${requestedAt}`))
    .catch(() => {})
}

/**
 * Not gated on `notifyOnReceive`, like the new-device alert: this is a security
 * notice, not an arrival. The card covers a browser with notifications blocked.
 */
async function notifyGroupReset(reset: GroupResetState): Promise<void> {
  try {
    if (!ext.notifications?.create) return
    await ext.notifications.create(`${NOTIFICATION_ID_PREFIX}${reset.requestedAt}`, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icons/tabsend-128.png'),
      title: groupResetCopy.alertTitle,
      message: groupResetCopy.alertMessage(reset.requestedAt),
      // Chrome keeps it on screen until dismissed. Firefox rejects the option outright.
      ...(IS_FIREFOX ? {} : { requireInteraction: true }),
    })
  } catch {
    // No notifications API or permission: the card still shows.
  }
}

/** A click opens the manage screen, where the card and its Stop button are. */
export async function handleGroupResetNotificationClick(notificationId: string): Promise<boolean> {
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
