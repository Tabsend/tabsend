/**
 * The page a browser opens after the Tabsend extension is uninstalled [PLANS P-31 item 1].
 *
 * The extension hands the browser this address with `runtime.setUninstallURL`. The leave
 * token rides in the fragment (`#t=...`), never the query, so it never reaches the
 * relay's request log; the page's own script reads it and posts it to
 * `POST /v1/endpoints/leave`.
 */

/** Chrome refuses an uninstall address longer than this (characters). */
export const UNINSTALL_URL_MAX = 1023;

/** Most characters a goodbye note may hold. The relay refuses longer ones. */
export const GOODBYE_NOTE_MAX = 2000;

/**
 * The goodbye page on `relayUrl` with `leaveToken` in its fragment, or null when there
 * is none to set: a relay address that is not http(s), an empty token, or an address
 * past the browser's limit. Null means "set no uninstall page", never a cut-down one.
 */
export function goodbyeUrl(relayUrl: string, leaveToken: string): string | null {
  if (!leaveToken) return null;
  // Parsed by hand: this package runs where `URL` may not be declared (no DOM, no Node).
  const m = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)/i.exec(relayUrl.trim());
  if (!m) return null;
  const [, scheme, host, rawPath] = m as unknown as [string, string, string, string];
  // A relay may live under a path (`https://host/tabsend`); keep it, drop any query or
  // fragment the stored address carried.
  const path = rawPath.replace(/\/+$/, '');
  const url = `${scheme.toLowerCase()}://${host}${path}/goodbye#t=${encodeURIComponent(leaveToken)}`;
  return url.length <= UNINSTALL_URL_MAX ? url : null;
}
