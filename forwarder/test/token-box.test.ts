import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeviceTokenBox, loadDeviceTokenKey, parseDeviceTokenKey } from '../src/token-box'
import { fakeFcmToken, TEST_DEVICE_TOKEN_KEY, TEST_DEVICE_TOKEN_KEY_B64 } from './helpers'

/**
 * The key and the box that keep device tokens unreadable in a copy of the database
 * [2026-10-02, SECURITY_REVIEW G15].
 */
describe('the device-token key', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabsend-forwarder-key-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the key from the file DEVICE_TOKEN_KEY_PATH names, as openssl writes it', () => {
    const path = join(dir, 'device-token.key')
    writeFileSync(path, `${TEST_DEVICE_TOKEN_KEY_B64}\n`)
    expect(loadDeviceTokenKey({ deviceTokenKeyPath: path }).equals(TEST_DEVICE_TOKEN_KEY)).toBe(
      true,
    )
    expect(
      loadDeviceTokenKey({ deviceTokenKey: TEST_DEVICE_TOKEN_KEY_B64 }).equals(
        TEST_DEVICE_TOKEN_KEY,
      ),
    ).toBe(true)
  })

  it('names a missing key file without saying anything about a key', () => {
    expect(() => loadDeviceTokenKey({ deviceTokenKeyPath: join(dir, 'absent.key') })).toThrow(
      /ENOENT/,
    )
  })

  /**
   * Found by the 2026-10-02 verification pass: any 32 bytes were taken, including a
   * passphrase run through base64, and the key check in the database lets whoever holds a
   * copy test guesses against it.
   */
  it('refuses a key somebody typed rather than generated, and never a random one', () => {
    const typed = Buffer.from('correct horse battery staple!!!!').toString('base64')
    expect(() => parseDeviceTokenKey(typed, 'DEVICE_TOKEN_KEY')).toThrow(/does not look random/)
    expect(() =>
      parseDeviceTokenKey(Buffer.alloc(32).toString('base64'), 'DEVICE_TOKEN_KEY'),
    ).toThrow(/does not look random/)
    for (let i = 0; i < 200; i++) {
      const random = crypto.getRandomValues(new Uint8Array(32))
      expect(() =>
        parseDeviceTokenKey(Buffer.from(random).toString('base64'), 'DEVICE_TOKEN_KEY'),
      ).not.toThrow()
    }
  })
})

describe('DeviceTokenBox', () => {
  it('opens what it sealed, and nothing sealed under another index or key', () => {
    const box = new DeviceTokenBox(TEST_DEVICE_TOKEN_KEY)
    const token = fakeFcmToken()
    const index = box.index(token)
    const sealed = box.seal(token, index)

    expect(box.open(sealed, index)).toBe(token)
    // A fresh nonce each time, so two seals of one token never match.
    expect(box.seal(token, index)).not.toBe(sealed)
    // The index is the associated data: a ciphertext moved to another row will not open.
    expect(() => box.open(sealed, box.index(fakeFcmToken()))).toThrow()
    const other = new DeviceTokenBox(Buffer.from(crypto.getRandomValues(new Uint8Array(32))))
    expect(() => other.open(sealed, index)).toThrow()
    // The index is stable for one key and differs between keys.
    expect(box.index(token)).toBe(index)
    expect(other.index(token)).not.toBe(index)
    expect(box.matches(box.keyCheck)).toBe(true)
    expect(box.matches(other.keyCheck)).toBe(false)
  })
})
