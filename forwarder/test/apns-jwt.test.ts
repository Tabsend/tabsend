import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ApnsTokenSource, loadApnsPrivateKey, signApnsJwt } from '../src/apns-jwt'

/**
 * The ES256 provider token (PROTOCOL.md §9). Apple is the only party that can really
 * confirm the signature, so the next best thing is to verify it here with `node:crypto`
 * against the public half of the key — which catches the one mistake a hand-rolled JOSE
 * signer actually makes: emitting DER instead of raw r || s.
 */

/** A throwaway P-256 keypair in the same PKCS#8 PEM form Apple's .p8 arrives in. */
function makeKeyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

describe('APNs provider token', () => {
  it('produces a valid ES256 JWS that verifies against the public key', () => {
    const { privatePem, publicPem } = makeKeyPair()
    const jwt = signApnsJwt({
      privateKey: loadApnsPrivateKey(privatePem),
      keyId: 'ABCD123456',
      teamId: 'TEAM123456',
      issuedAtSeconds: 1_800_000_000,
    })

    const [header, payload, signature] = jwt.split('.')
    expect(header && payload && signature).toBeTruthy()
    expect(decodeSegment(header as string)).toEqual({ alg: 'ES256', kid: 'ABCD123456' })
    expect(decodeSegment(payload as string)).toEqual({ iss: 'TEAM123456', iat: 1_800_000_000 })

    // P-256 raw r || s is exactly 64 bytes. A DER signature would be ~70 and variable,
    // which is the failure Apple reports as an opaque 403.
    const raw = Buffer.from(signature as string, 'base64url')
    expect(raw).toHaveLength(64)

    const verified = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(publicPem), dsaEncoding: 'ieee-p1363' },
      raw,
    )
    expect(verified).toBe(true)
  })

  it('does not verify against a different key', () => {
    const signer = makeKeyPair()
    const stranger = makeKeyPair()
    const jwt = signApnsJwt({
      privateKey: loadApnsPrivateKey(signer.privatePem),
      keyId: 'ABCD123456',
      teamId: 'TEAM123456',
    })
    const [header, payload, signature] = jwt.split('.')

    const verified = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(stranger.publicPem), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature as string, 'base64url'),
    )
    expect(verified).toBe(false)
  })

  it('reuses one token for 45 minutes, then mints a fresh one', () => {
    const { privatePem } = makeKeyPair()
    let now = 1_800_000_000_000
    const source = new ApnsTokenSource(
      loadApnsPrivateKey(privatePem),
      'ABCD123456',
      'TEAM123456',
      () => now,
    )

    const first = source.current()
    now += 44 * 60 * 1000
    expect(source.current()).toBe(first)

    // Apple rejects a token older than an hour and a minter faster than every 20
    // minutes; 45 sits clear of both.
    now += 2 * 60 * 1000
    const second = source.current()
    expect(second).not.toBe(first)
    expect(decodeSegment(second.split('.')[1] as string).iat).toBe(Math.floor(now / 1000))
  })

  it('refuses a key that is not a PKCS#8 PEM, and says what to look for', () => {
    expect(() => loadApnsPrivateKey('this is not a key')).toThrow(/BEGIN PRIVATE KEY/)
  })
})
