import { createHash, randomBytes } from 'node:crypto'

/**
 * Wake tokens: minting, hashing, and the one shape allowed in a log line.
 *
 * Invariant: the forwarder holds a wake token only for the length of one request. It is
 * minted, returned to the app, and never written to disk or to a log — the store keeps
 * `hashWakeToken(token)` and nothing else (PROTOCOL.md §5, §8).
 */

/** 32 random bytes, base64url. Same size and shape as the relay's device token. */
export const WAKE_TOKEN_LENGTH = 43

/**
 * Mint a wake token. 32 bytes of CSPRNG output, so guessing one is not a threat model
 * and the stored hash needs no salt or slow KDF (PROTOCOL.md §5).
 */
export function newWakeToken(): string {
  return randomBytes(32).toString('base64url')
}

/** What the store keys on. Never reversible to the token. */
export function hashWakeToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/**
 * The ONLY token-derived value permitted in a log line: the first 8 characters of the
 * hash. Enough to correlate two lines about one device, useless for reconstructing the
 * token (PROTOCOL.md §8).
 */
export function tokenRef(tokenHash: string): string {
  return tokenHash.slice(0, 8)
}

/**
 * Cheap syntactic check, run before the store is touched. It refuses garbage without a
 * database read, which is what makes a wake cheap to refuse, and it leaks nothing about
 * which tokens exist: every 43-character base64url string passes, live or not.
 */
export function isWellFormedWakeToken(token: string): boolean {
  return token.length === WAKE_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(token)
}
