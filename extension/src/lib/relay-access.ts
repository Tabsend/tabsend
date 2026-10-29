import { ext } from './ext'

/**
 * Permission to reach the user's relay (Chrome Web Store review, 2026-10-28).
 *
 * The extension used to ask for every website at install, because a relay can be
 * at any address. That made Chrome warn "Read and change all your data on all
 * websites" and put the item into in-depth review. Now the hosted relay is the
 * only host in the manifest, and any other relay is asked for once, by origin,
 * when the user pairs with it or moves to it. The "Sent to" banner uses
 * `activeTab` instead, which the send's own click grants.
 *
 * Requests go to the relay from the service worker, and the relay sends no CORS
 * headers, so without this grant every call fails as if the relay were down.
 */

/** The match pattern for `relayUrl`'s host. Patterns carry no port, so any port is covered. */
export function relayAccessPattern(relayUrl: string): string {
  const url = new URL(relayUrl)
  return `${url.protocol}//${url.hostname}/*`
}

/** True when this browser may call `relayUrl`. Never throws: an unknown answers false. */
export async function hasRelayAccess(relayUrl: string): Promise<boolean> {
  try {
    return await ext.permissions.contains({ origins: [relayAccessPattern(relayUrl)] })
  } catch {
    return false
  }
}

/**
 * Ask for `relayUrl`'s host. It must be the FIRST await in a click handler:
 * the browser accepts the request only during the click, and Firefox drops the
 * click after any earlier await. A host already granted answers true with no
 * prompt, so callers just ask. Resolves false when the user says no.
 */
export async function requestRelayAccess(relayUrl: string): Promise<boolean> {
  try {
    return await ext.permissions.request({ origins: [relayAccessPattern(relayUrl)] })
  } catch {
    return false
  }
}
