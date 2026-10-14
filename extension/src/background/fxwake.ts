import { ext } from '../lib/ext'
import { getRegistration } from '../lib/storage'
import { createWsClient } from '../lib/ws'
import { pollPending } from './receive'
import { handleStreamEvent } from './stream'

/**
 * Firefox wake strategy (transport spike §3b). Firefox has NO Push API for
 * extensions and NO offscreen documents, so the EVENT PAGE itself:
 *  1. holds the delivery WebSocket (1–2 ms while alive) via the shared client,
 *     handling events IN-PROCESS (no runtime round-trip like Chrome's offscreen);
 *  2. reconnects + drains on the ≥1-min alarm (the hard ceiling: Firefox suspends
 *     the event page after ~30–40 s regardless of socket/timer activity);
 *  3. wakes on USER-ACTIVITY events (tab/window focus/update) — each re-runs this
 *     top-level script, reconnects the socket, and drains the queue, so a
 *     delivered tab lands the moment the user touches Firefox.
 * Correctness is unchanged: the durable queue holds everything; this is latency.
 */

const client = createWsClient({
  onEvent: (event) => {
    void handleStreamEvent(event)
  },
})

/** Point the WS at the current registration (boot + after register/join), or drop
 *  it when there's no registration (after a relay switch clears it). */
export async function refreshFirefoxWs(): Promise<void> {
  const reg = await getRegistration()
  client.applyConfig(reg ? { relayUrl: reg.relayUrl, deviceToken: reg.deviceToken } : null)
}

/** Reconnect the socket if it's down (the poll alarm already drains the queue). */
export function firefoxReconnect(): void {
  client.connectNow()
}

/** Reconnect AND drain — the user-activity path (a delivered tab should land now). */
export function firefoxWake(): void {
  client.connectNow()
  void pollPending()
}

/**
 * Register the Firefox wake listeners. MUST run synchronously at top-level event-
 * page eval so Firefox re-delivers these events to a suspended page (waking it).
 */
export function startFirefoxWake(): void {
  const onActivity = (): void => firefoxWake()
  ext.tabs?.onActivated?.addListener(onActivity)
  ext.tabs?.onUpdated?.addListener((_tabId, info) => {
    if (info.status === 'complete') onActivity()
  })
  ext.windows?.onFocusChanged?.addListener((windowId) => {
    if (windowId !== ext.windows.WINDOW_ID_NONE) onActivity()
  })
  // Bring the socket up on this eval (boot or a wake). Config load is async.
  void refreshFirefoxWs()
}
