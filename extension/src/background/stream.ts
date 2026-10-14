import type { ServerStreamEvent } from '@tabsend/shared'
import { fetchEndpoints } from './endpoints'
import { rebuildMenus } from './menus'
import { deliverPushed } from './receive'

/**
 * Service-worker side of the WS fast path. The offscreen doc forwards every
 * server event here; the SW owns all delivery + UI refresh. One deliver code
 * path (deliverPushed → the same loop as polling) means a message arriving by
 * WS and by poll can never double-open a tab.
 */

// Live popups hold a port so presence/ack/endpoint changes refresh them while open.
const chooserPorts = new Set<chrome.runtime.Port>()

export function registerChooserPort(port: chrome.runtime.Port): void {
  chooserPorts.add(port)
  port.onDisconnect.addListener(() => chooserPorts.delete(port))
}

/** Tell every open popup to re-render (fresh presence + drained pending row). */
export function notifyChooser(): void {
  for (const port of [...chooserPorts]) {
    try {
      port.postMessage({ type: 'refresh' })
    } catch {
      chooserPorts.delete(port)
    }
  }
}

export async function handleStreamEvent(event: ServerStreamEvent): Promise<void> {
  switch (event.type) {
    case 'message':
      // Envelope in hand → sub-second open through the shared idempotent path.
      await deliverPushed([event.message])
      notifyChooser()
      break
    case 'acked':
      // A target acked one of our sends → the ⏳ pending row drains live [ADR-0010].
      notifyChooser()
      break
    case 'presence':
    case 'endpoint_added':
    case 'endpoint_removed':
    case 'endpoint_updated':
      // Group/presence changed → refresh cache, context menus, and any open popup.
      try {
        await fetchEndpoints()
      } catch {
        // offline — the cache stands; the next poll refreshes it
      }
      await rebuildMenus()
      notifyChooser()
      break
    case 'pong':
      break
  }
}
