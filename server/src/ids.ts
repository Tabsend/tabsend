import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** Opaque server-minted id (group, endpoint). */
export function newId(): string {
  return randomUUID()
}

/** The per-endpoint credential returned once at register/join. */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

/** We store only a hash of the device token, never the token itself. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/**
 * Content fingerprint of an endpoint's e2ePubkey, used to detect a STALE key
 * after a re-pair (EncryptedEnvelope.targetKeyId must match this to be accepted).
 *
 * NOTE: this is a plain SHA-256 over the pubkey STRING — a routing/staleness
 * fingerprint, NOT E2E crypto. The relay still performs no sealing/opening. The
 * convention (keyId = base64url(sha256(utf8(e2ePubkey)))) is a Chunk 2 lock the
 * extension (Chunk 3) must mirror when it fills EncryptedEnvelope.targetKeyId.
 */
export function keyIdFor(e2ePubkey: string): string {
  return createHash('sha256').update(e2ePubkey).digest('base64url')
}

// Unambiguous alphabet: no 0/O, 1/I/L — safe to read aloud and type. [types.ts §9]
const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
/** Pairing codes are 8 chars (within the contract's 6–8 range). */
export const PAIRING_CODE_LENGTH = 8

/** A short, unambiguous, cryptographically-random pairing code. */
export function newPairingCode(length = PAIRING_CODE_LENGTH): string {
  const bytes = randomBytes(length)
  let out = ''
  for (const byte of bytes) {
    out += PAIRING_ALPHABET.charAt(byte % PAIRING_ALPHABET.length)
  }
  return out
}
