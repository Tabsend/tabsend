import { heartbeat } from '../lib/api'
import { getPushSubscription } from '../lib/storage'
import { currentSession } from './session'

/**
 * Presence heartbeat (INTERACTION_FLOWS §6 / spike §3b guidance). Runs on SW
 * boot and on the periodic alarm — well under PRESENCE_ONLINE_THRESHOLD_SECONDS
 * (90s) so a live endpoint never flaps offline.
 *
 * It also ROTATES the real Web Push subscription: once Chunk 4c has subscribed
 * and stored a real subscription, the heartbeat carries it to the relay,
 * replacing the register-time `{transport:'none'}` (ADR-0015). Until then it
 * heartbeats with no subscription (still refreshes presence — any
 * authenticated call does).
 *
 * Correctness never depends on this: a failed heartbeat is swallowed; the poll
 * alarm keeps presence fresh as a backstop and the queue holds every message.
 */
export async function heartbeatNow(): Promise<void> {
  const session = await currentSession()
  if (!session) return
  const { registration } = session

  // Send the stored real subscription if we have one; `null`/absent → omit, so
  // the relay keeps the last known subscription rather than clobbering it.
  const stored = await getPushSubscription()
  const push = stored ?? undefined

  try {
    await heartbeat(registration.relayUrl, registration.deviceToken, registration.endpointId, push)
  } catch {
    // Offline or relay down — presence will refresh on the next successful call.
  }
}
