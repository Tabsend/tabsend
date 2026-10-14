import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * Device tokens at rest [2026-10-02, SECURITY_REVIEW G15].
 *
 * The provider's device token is the one thing in the store that is worth stealing,
 * though not for what it can do at Apple or Google: without this service's credentials
 * it rings nothing there. It is worth stealing for what it can do HERE. Registration
 * replaces whatever row holds the same device token (PROTOCOL.md §3.1), so anyone holding
 * a list of them could kill every phone's real wake token and mint new ones that ring
 * every phone. A copy of the database, or of a backup of it, used to be that list.
 *
 * So the store keeps two columns where it kept one, both under a key that is held OUTSIDE
 * the database file (`DEVICE_TOKEN_KEY`, PROTOCOL.md §10):
 *
 * - `device_token_mac`, an HMAC-SHA256 of the token. Deterministic, which is what lets it
 *   carry the UNIQUE constraint the replacement rule depends on, and useless to anyone
 *   without the key: it cannot be reversed, and without the key a guess cannot be checked.
 * - `device_token_enc`, the token itself under AES-256-GCM with a fresh random nonce, so
 *   the forwarder can still hand Apple or Google the exact string it must present.
 *   The MAC is the ciphertext's associated data, which ties each ciphertext to its own
 *   index entry.
 *
 * Both keys, and a key-check value the store keeps to recognise its own key at boot, are
 * derived from the one operator secret with HKDF and distinct labels, so none of the three
 * says anything about the others.
 *
 * What this does not do: protect against someone who has the key as well as the file.
 * That person has the forwarder's environment, which also holds the Apple and Google
 * credentials, and can do far worse than this with those.
 */

/** The operator secret's length: 32 random bytes. */
export const DEVICE_TOKEN_KEY_BYTES = 32

const NONCE_BYTES = 12
const TAG_BYTES = 16

const INFO_SEAL = 'tabsend-forwarder device token seal v1'
const INFO_INDEX = 'tabsend-forwarder device token index v1'
const INFO_CHECK = 'tabsend-forwarder device token key check v1'

/** The generate command, named in every error that asks for a key. Runnable as is. */
export const DEVICE_TOKEN_KEY_HINT =
  'Generate one with `openssl rand -base64 32` and keep it where your other secrets live, not beside the database file or in its backups.'

function derive(masterKey: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, DEVICE_TOKEN_KEY_BYTES))
}

/**
 * Read the operator secret: base64 (standard or URL-safe), decoding to exactly 32 bytes.
 * Throws with the fix, and never echoes the value it was given.
 */
export function parseDeviceTokenKey(raw: string, source: string): Buffer {
  const text = raw.trim()
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    throw new Error(`${source} must be 32 random bytes written as base64. ${DEVICE_TOKEN_KEY_HINT}`)
  }
  const key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (key.length !== DEVICE_TOKEN_KEY_BYTES) {
    throw new Error(
      `${source} must decode to exactly ${DEVICE_TOKEN_KEY_BYTES} bytes; it decodes to ${key.length}. ${DEVICE_TOKEN_KEY_HINT}`,
    )
  }
  if (looksChosen(key)) {
    throw new Error(
      `${source} does not look random: it decodes to readable text, or to a few byte values repeated. Anyone holding a copy of the database could try guesses against a key like that. ${DEVICE_TOKEN_KEY_HINT}`,
    )
  }
  return key
}

/**
 * A key somebody typed rather than generated: every byte printable (a passphrase run
 * through base64), or very few distinct bytes (zeros, a repeated pattern). Thirty-two
 * random bytes are all printable about once in 10^14 tries and show fewer than sixteen
 * distinct values far less often, so a real key is never refused.
 */
function looksChosen(key: Buffer): boolean {
  const printable = key.every((byte) => byte >= 0x20 && byte <= 0x7e)
  return printable || new Set(key).size < 16
}

/**
 * The key, at boot: inline from `DEVICE_TOKEN_KEY` (already validated by `loadConfig`),
 * or read from the file `DEVICE_TOKEN_KEY_PATH` names.
 */
export function loadDeviceTokenKey(source: {
  deviceTokenKey?: string
  deviceTokenKeyPath?: string
}): Buffer {
  if (source.deviceTokenKey) return parseDeviceTokenKey(source.deviceTokenKey, 'DEVICE_TOKEN_KEY')
  if (source.deviceTokenKeyPath) {
    return parseDeviceTokenKey(
      readFileSync(source.deviceTokenKeyPath, 'utf8'),
      'The file DEVICE_TOKEN_KEY_PATH names',
    )
  }
  throw new Error(`DEVICE_TOKEN_KEY is required. ${DEVICE_TOKEN_KEY_HINT}`)
}

export class DeviceTokenBox {
  private readonly sealKey: Buffer
  private readonly indexKey: Buffer
  /** Base64url. Stored in the database; reveals nothing about the other two keys. */
  readonly keyCheck: string

  constructor(masterKey: Buffer) {
    if (masterKey.length !== DEVICE_TOKEN_KEY_BYTES) {
      throw new Error(`The device token key must be ${DEVICE_TOKEN_KEY_BYTES} bytes.`)
    }
    this.sealKey = derive(masterKey, INFO_SEAL)
    this.indexKey = derive(masterKey, INFO_INDEX)
    this.keyCheck = derive(masterKey, INFO_CHECK).toString('base64url')
  }

  /** The keyed hash that carries UNIQUE, so one device holds one live wake token. */
  index(deviceToken: string): string {
    return createHmac('sha256', this.indexKey).update(deviceToken, 'utf8').digest('base64url')
  }

  /** Encrypt a device token for storage, bound to its index entry. */
  seal(deviceToken: string, index: string): string {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.sealKey, nonce)
    cipher.setAAD(Buffer.from(index, 'utf8'))
    const body = Buffer.concat([cipher.update(deviceToken, 'utf8'), cipher.final()])
    return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url')
  }

  /** Decrypt a stored device token. Throws if it was not sealed under this key and index. */
  open(sealed: string, index: string): string {
    const raw = Buffer.from(sealed, 'base64url')
    if (raw.length < NONCE_BYTES + TAG_BYTES) {
      throw new Error('A stored device token is too short to have been sealed by this forwarder.')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.sealKey, raw.subarray(0, NONCE_BYTES))
    decipher.setAAD(Buffer.from(index, 'utf8'))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }

  /** Whether a stored key check was written under this key. */
  matches(storedKeyCheck: string): boolean {
    const a = Buffer.from(storedKeyCheck, 'utf8')
    const b = Buffer.from(this.keyCheck, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }
}
