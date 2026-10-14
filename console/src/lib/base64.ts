/**
 * Byte <-> base64 helpers, byte-identical to the extension's (extension/src/lib/
 * base64.ts) so the on-wire encoding and the keyId fingerprint match across every
 * package. Kept as a small self-contained copy rather than a shared dep — it's a
 * dozen lines and @tabsend/shared is intentionally types-only.
 */

/** Raw bytes → standard base64 (with `+` `/` and `=` padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/** Standard base64 → raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Standard base64 → base64url with padding stripped — the exact shape Node's
 * `createHash(...).digest('base64url')` produces, so a client-computed keyId
 * matches the relay's `keyIdFor()`.
 */
export function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
