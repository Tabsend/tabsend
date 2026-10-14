import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GroupSealed, HistoryRecord } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { groupKeyId, openGroup, sealGroup } from './crypto'

/**
 * Cross-client vector for the ADR-0028 group seal.
 *
 * Four clients each implement `crypto_secretbox` separately — libsodium here and
 * in the console, hand-written XSalsa20-Poly1305 on Android and iOS. A per-client
 * round-trip test only proves a client agrees with ITSELF, which is exactly the
 * bug that would ship: everything green, and a tab sealed on a phone unreadable
 * in a browser. This pins the construction to fixed bytes instead.
 *
 * The file is the one iOS generated and tests against, read from its home rather
 * than copied, so the two can never drift apart unnoticed. Android keeps its own
 * copy under `app/src/test/resources/`, matching how `interop-vector.json`
 * already works — gradle cannot reach outside its module.
 */
const VECTOR_PATH = resolve(
  import.meta.dirname,
  '../../../ios/TabsendKit/Tests/TabsendKitTests/Resources/group-history-vector.json',
)

interface Vector {
  key: string
  keyId: string
  nonce: string
  plaintext: string
  record: HistoryRecord
  blob: GroupSealed
}

const vector = JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as Vector

describe('group history seal, cross-client vector [0028]', () => {
  it('fingerprints the key exactly as every other client does', async () => {
    expect(await groupKeyId(vector.key)).toBe(vector.keyId)
  })

  it('opens a blob the vector fixes, byte for byte', async () => {
    const plaintext = await openGroup(vector.blob, vector.key)
    expect(plaintext).toBe(vector.plaintext)
    expect(JSON.parse(plaintext)).toEqual(vector.record)
  })

  it('seals blobs another client can open', async () => {
    // Opening the fixed blob above is the real compatibility proof: authentication
    // fails on ANY divergence in the construction, so a client that opens it
    // agrees byte for byte. This direction just confirms the seal is not
    // write-only, and that each blob gets a fresh nonce.
    const sealed = await sealGroup(vector.plaintext, vector.key)
    const again = await sealGroup(vector.plaintext, vector.key)
    expect(sealed.nonce).not.toBe(again.nonce)
    expect(sealed.ciphertext).not.toBe(again.ciphertext)
    const blob: GroupSealed = {
      alg: 'xsalsa20-poly1305/secretbox',
      keyId: vector.keyId,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
    }
    expect(await openGroup(blob, vector.key)).toBe(vector.plaintext)
  })

  it('refuses the vector blob under any other key', async () => {
    const wrong = 'A'.repeat(43).concat('=')
    await expect(openGroup(vector.blob, wrong)).rejects.toThrow()
  })
})
