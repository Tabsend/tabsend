import { createHash } from 'node:crypto'
import sodium from 'libsodium-wrappers'
import { describe, expect, it } from 'vitest'
import { generateKeyPair, keyId, open, ready } from './crypto'

describe('console crypto', () => {
  it('generates distinct X25519 keypairs', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    expect(a.publicKey).not.toBe(b.publicKey)
    expect(a.privateKey).not.toBe(b.privateKey)
  })

  it('keyId matches the relay convention: base64url(sha256(utf8(pubkey)))', async () => {
    const { publicKey } = await generateKeyPair()
    const expected = createHash('sha256').update(publicKey).digest('base64url')
    expect(await keyId(publicKey)).toBe(expected)
  })

  it('opens a crypto_box sealed to it by a sender (round-trip)', async () => {
    await ready()
    const sender = await generateKeyPair()
    const console = await generateKeyPair()
    const message = JSON.stringify({ url: 'https://example.com', hi: 'there' })

    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
    const ciphertext = sodium.crypto_box_easy(
      sodium.from_string(message),
      nonce,
      sodium.from_base64(console.publicKey, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(sender.privateKey, sodium.base64_variants.ORIGINAL),
    )

    const plaintext = await open(
      {
        nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
        ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
      },
      sender.publicKey,
      console.privateKey,
    )
    expect(plaintext).toBe(message)
  })

  it('throws when the sender key is wrong (forgery / injection)', async () => {
    await ready()
    const sender = await generateKeyPair()
    const impostor = await generateKeyPair()
    const console = await generateKeyPair()

    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
    const ciphertext = sodium.crypto_box_easy(
      sodium.from_string('secret'),
      nonce,
      sodium.from_base64(console.publicKey, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(sender.privateKey, sodium.base64_variants.ORIGINAL),
    )

    await expect(
      open(
        {
          nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
          ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
        },
        impostor.publicKey, // verifying against the wrong sender key
        console.privateKey,
      ),
    ).rejects.toThrow()
  })
})
