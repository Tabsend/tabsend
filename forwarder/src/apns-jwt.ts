import { createPrivateKey, type KeyObject, sign } from 'node:crypto'

/**
 * The ES256 JWT that authenticates the forwarder to APNs, signed with `node:crypto`
 * alone (PROTOCOL.md §9).
 *
 * Invariant: the signature is raw `r || s`, not DER. This is the single detail that
 * makes a hand-rolled JOSE signature either work or fail mysteriously, and it is handled
 * by `dsaEncoding: 'ieee-p1363'` rather than by unpacking DER by hand. No JWT dependency
 * enters the tree for sixty lines of well-specified format.
 *
 * Apple's rules, which set the caching policy below: a provider token older than one
 * hour is rejected, and a provider that mints them more often than every 20 minutes is
 * rejected too. 45 minutes sits clear of both edges.
 */

const REFRESH_INTERVAL_MS = 45 * 60 * 1000

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Sign one provider token. `issuedAtSeconds` is injectable so a test can pin it; nothing
 * in production passes it.
 */
export function signApnsJwt(params: {
  privateKey: KeyObject
  keyId: string
  teamId: string
  issuedAtSeconds?: number
}): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: params.keyId }))
  const iat = params.issuedAtSeconds ?? Math.floor(Date.now() / 1000)
  const payload = base64url(JSON.stringify({ iss: params.teamId, iat }))
  const signingInput = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: params.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${base64url(signature)}`
}

/** Parse a .p8 (PKCS#8 PEM). Throws with an actionable message on anything else. */
export function loadApnsPrivateKey(pem: string): KeyObject {
  try {
    return createPrivateKey(pem)
  } catch (cause) {
    throw new Error(
      'Could not read the Apple signing key. It must be the .p8 file Apple issued, in PKCS#8 PEM form, starting with "-----BEGIN PRIVATE KEY-----". A downloaded .p8 is already in that form, so the usual cause is a truncated copy and paste or a path pointing at the wrong file.',
      { cause },
    )
  }
}

/**
 * Holds one provider token and re-signs it when it ages out. Cheap enough that the wake
 * path can ask on every request.
 */
export class ApnsTokenSource {
  private cached: { token: string; mintedAt: number } | undefined

  constructor(
    private readonly privateKey: KeyObject,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  current(): string {
    const now = this.now()
    if (this.cached && now - this.cached.mintedAt < REFRESH_INTERVAL_MS) {
      return this.cached.token
    }
    const token = signApnsJwt({
      privateKey: this.privateKey,
      keyId: this.keyId,
      teamId: this.teamId,
      issuedAtSeconds: Math.floor(now / 1000),
    })
    this.cached = { token, mintedAt: now }
    return token
  }
}
