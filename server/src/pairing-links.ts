import { PAIRING_LINK, type PairingCodeValue } from '@tabsend/shared'
import type { Config } from './config'

export interface PairingLinks {
  /** Copy/paste default: browser-safe on a self-signed dual-listener relay. */
  browserLink: string
  /** QR/deep-link default: pinned HTTPS for native apps. */
  nativeLink: string
}

/**
 * Build both presentations of one pairing credential. Each carries the other
 * route in its fragment, so pasting the "wrong" presentation into a client is
 * recoverable. A hosted relay collapses to the same ordinary HTTPS link twice.
 */
export function pairingLinks(
  config: Config,
  code: PairingCodeValue,
  certFingerprint?: string,
): PairingLinks {
  const browserRelayUrl = config.publicBrowserRelayUrl
  const nativeRelayUrl = config.publicRelayUrl
  return {
    browserLink: PAIRING_LINK({
      relayUrl: browserRelayUrl,
      code,
      ...(certFingerprint ? { certFingerprint } : {}),
      ...(nativeRelayUrl !== browserRelayUrl ? { nativeRelayUrl } : {}),
    }),
    nativeLink: PAIRING_LINK({
      relayUrl: nativeRelayUrl,
      code,
      ...(certFingerprint ? { certFingerprint } : {}),
      ...(browserRelayUrl !== nativeRelayUrl ? { browserRelayUrl } : {}),
    }),
  }
}
