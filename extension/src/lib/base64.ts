/**
 * Byte <-> base64 helpers. We keep a single, explicit implementation so the
 * on-wire encoding is identical on the sender and the receiver (and matches the
 * server's keyId convention, which base64url-encodes a SHA-256 digest).
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
 * `createHash(...).digest('base64url')` produces, so client-computed keyIds
 * match the relay's `keyIdFor()`.
 */
export function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * base64url (no padding) → raw bytes. Used to turn the relay's VAPID public key
 * into the `applicationServerKey` BufferSource that pushManager.subscribe wants.
 */
export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return base64ToBytes(b64 + pad)
}
