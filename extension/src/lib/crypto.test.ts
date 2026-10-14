import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  generateGroupKey,
  generateKeyPair,
  groupKeyId,
  keyId,
  open,
  openGroup,
  seal,
  sealGroup,
} from './crypto'

describe('crypto (libsodium crypto_box)', () => {
  it('round-trips a payload sealed to a target', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const payload = JSON.stringify({ url: 'https://example.com', title: 'Example' })

    const box = await seal(payload, bob.publicKey, alice.privateKey)
    expect(box.nonce).not.toBe('')
    expect(box.ciphertext).not.toBe(payload)

    const opened = await open(box, alice.publicKey, bob.privateKey)
    expect(opened).toBe(payload)
  })

  it('uses a fresh nonce per message', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const a = await seal('x', bob.publicKey, alice.privateKey)
    const b = await seal('x', bob.publicKey, alice.privateKey)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('rejects a message from the wrong sender (authentication)', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const mallory = await generateKeyPair()
    const box = await seal('payload', bob.publicKey, mallory.privateKey)
    // Bob believes the sender is Alice — opening must fail.
    await expect(open(box, alice.publicKey, bob.privateKey)).rejects.toThrow()
  })

  it('rejects tampered ciphertext', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const box = await seal('payload', bob.publicKey, alice.privateKey)
    const bytes = Buffer.from(box.ciphertext, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    const tampered = { ...box, ciphertext: bytes.toString('base64') }
    await expect(open(tampered, alice.publicKey, bob.privateKey)).rejects.toThrow()
  })

  it('computes keyId exactly like the server (base64url(sha256(utf8(pubkey))))', async () => {
    const kp = await generateKeyPair()
    // The server's convention, verbatim (server/src/ids.ts keyIdFor).
    const serverKeyId = createHash('sha256').update(kp.publicKey).digest('base64url')
    expect(await keyId(kp.publicKey)).toBe(serverKeyId)
  })
})

describe('group history key (libsodium crypto_secretbox) [0028]', () => {
  it('round-trips a record under the group key', async () => {
    const key = await generateGroupKey()
    const blob = await sealGroup('{"url":"https://example.com/"}', key)
    expect(await openGroup(blob, key)).toBe('{"url":"https://example.com/"}')
  })

  it('is unreadable to a device holding a different key', async () => {
    const ours = await generateGroupKey()
    const theirs = await generateGroupKey()
    const blob = await sealGroup('secret', ours)
    // The relay holds neither. This is what "the relay never sees a URL" rests on.
    await expect(openGroup(blob, theirs)).rejects.toThrow()
  })

  it('rejects tampered ciphertext, so a blob cannot be rewritten in place', async () => {
    const key = await generateGroupKey()
    const blob = await sealGroup('payload', key)
    const bytes = Buffer.from(blob.ciphertext, 'base64')
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    await expect(
      openGroup({ ...blob, ciphertext: bytes.toString('base64') }, key),
    ).rejects.toThrow()
  })

  it('uses a fresh nonce per blob, so identical records do not look identical', async () => {
    const key = await generateGroupKey()
    const one = await sealGroup('same', key)
    const two = await sealGroup('same', key)
    expect(one.nonce).not.toBe(two.nonce)
    expect(one.ciphertext).not.toBe(two.ciphertext)
  })

  it('fingerprints a key without revealing it', async () => {
    const key = await generateGroupKey()
    const id = await groupKeyId(key)
    expect(id).toBe(createHash('sha256').update(key).digest('base64url'))
    expect(id).not.toContain(key)
    // Stable, so two devices name the same key the same way.
    expect(await groupKeyId(key)).toBe(id)
  })

  it('generates a distinct key each time', async () => {
    expect(await generateGroupKey()).not.toBe(await generateGroupKey())
  })
})
