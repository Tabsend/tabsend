import { ext } from '../lib/ext'
import { getRegistration } from '../lib/storage'

/**
 * Offscreen-document lifecycle (the WS fast path lives inside it —
 * src/offscreen/index.ts). The MV3 service worker can't keep a socket alive
 * across idle-termination; an offscreen document can. Creating it is best-effort:
 * if the API is missing or the doc already exists, we quietly skip — the socket
 * is latency-only, so push + poll still deliver.
 *
 * The doc can't read ext.storage (offscreen docs get almost no ext.* APIs),
 * so the SW feeds it the relay/token config over runtime messaging: the doc asks
 * with `need-config` at startup, and `pushConfigToOffscreen` broadcasts a fresh
 * config whenever registration changes.
 *
 * NOTE on `reasons`: Chrome offers no dedicated "hold a network connection"
 * offscreen reason. BLOBS is the conventional choice for a persistent-connection
 * offscreen doc; the justification states the real purpose. (Flagged in the
 * chunk-4 report as a known approximation.)
 */
const OFFSCREEN_URL = 'offscreen.html'

export interface WsConfig {
  relayUrl: string
  deviceToken: string
}

/** The offscreen doc's control request (its only way to reach our storage). */
export function isNeedConfig(message: unknown): message is { __tabsendWsCtl: 'need-config' } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { __tabsendWsCtl?: string }).__tabsendWsCtl === 'need-config'
  )
}

export async function currentWsConfig(): Promise<WsConfig | null> {
  const reg = await getRegistration()
  return reg ? { relayUrl: reg.relayUrl, deviceToken: reg.deviceToken } : null
}

/** Broadcast a fresh config to the offscreen doc (after register/join/relay edit). */
export async function pushConfigToOffscreen(): Promise<void> {
  const config = await currentWsConfig()
  if (!config) return
  await ext.runtime.sendMessage({ __tabsendWsConfig: true, config }).catch(() => undefined)
}

export async function ensureOffscreen(): Promise<void> {
  const api = ext.offscreen
  if (!api) return // Push/offscreen API absent (older Chrome, Firefox) — poll path stands
  try {
    if (await api.hasDocument?.()) return
    await api.createDocument({
      url: OFFSCREEN_URL,
      reasons: [ext.offscreen.Reason.BLOBS],
      justification:
        'Hold the Tabsend delivery WebSocket (/v1/stream) for sub-second foreground tab delivery.',
    })
  } catch {
    // A concurrent creation may be in flight, or the API is unavailable — either
    // way the WS is an optimization; the poll/push path is the correctness path.
  }
}
