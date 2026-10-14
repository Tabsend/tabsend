import type { ServerStreamEvent } from '@tabsend/shared'
import { ext } from '../lib/ext'
import { createWsClient, type WsClientConfig } from '../lib/ws'

/**
 * Offscreen-document WebSocket host — the CHROME foreground fast path (ADR-0001,
 * PRD §6.1). The MV3 service worker can't hold a long-lived socket across
 * idle-termination, so this invisible document does. The socket lifecycle lives
 * in the shared `createWsClient`; this file only wires it to Chrome's offscreen
 * environment: forward every event to the SW (which owns all delivery) and get
 * the relay/token config over runtime messaging (offscreen docs can't read
 * storage — verified empirically; the SW pushes config on registration change).
 *
 * On Firefox there is no offscreen document; the event page runs the same
 * `createWsClient` directly (src/background/fxwake.ts).
 */

function forwardToWorker(event: ServerStreamEvent): void {
  ext.runtime.sendMessage({ __tabsendWs: true, event }).catch(() => {
    // SW asleep/among reloads — it will pull pending on its next boot anyway.
  })
}

const client = createWsClient({ onEvent: forwardToWorker })

// The SW pushes a fresh config whenever registration changes.
ext.runtime.onMessage.addListener((message: unknown) => {
  const m = message as { __tabsendWsConfig?: boolean; config?: WsClientConfig | null }
  if (m && typeof m === 'object' && m.__tabsendWsConfig) client.applyConfig(m.config)
})

// ...and the doc pulls it once at startup.
async function start(): Promise<void> {
  try {
    const res = (await ext.runtime.sendMessage({ __tabsendWsCtl: 'need-config' })) as {
      config?: WsClientConfig | null
    } | null
    client.applyConfig(res?.config)
  } catch {
    // SW mid-reload — it re-pushes config after boot/registration anyway.
  }
}

void start()
