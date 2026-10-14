import { createHash, randomUUID } from 'node:crypto'
import type {
  CreatePairingResponse,
  EncryptedEnvelope,
  Endpoint,
  RegisterResponse,
  SendResponse,
} from '@tabsend/shared'
import sodium from 'libsodium-wrappers'

/**
 * Node-side sender for the push suite. Instead of a second browser, we register a
 * real group endpoint over the API and seal a payload with libsodium exactly as
 * the extension does (crypto_box, X25519 + XSalsa20-Poly1305), so the target's
 * sender verification + open path exercises the real crypto. The relay still sees
 * only ciphertext.
 */

/** Content fingerprint matching server ids.keyIdFor: base64url(sha256(utf8(pubkeyB64))). */
function keyIdFor(pubkeyB64: string): string {
  return createHash('sha256').update(pubkeyB64).digest('base64url')
}

async function api<T>(method: string, url: string, token?: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

export interface Sender {
  endpointId: string
  token: string
  pubkey: string
  privkey: string
}

/** Mint a complete pairing link from an already-paired endpoint's token. */
export async function mintPairingLink(relayUrl: string, token: string): Promise<string> {
  const res = await api<CreatePairingResponse>('POST', `${relayUrl}/v1/pairing`, token)
  return res.link
}

/** Register a node sender using the one-time secret inside a pairing link. */
export async function createSender(relayUrl: string, pairingLink: string): Promise<Sender> {
  const pairingCode = new URLSearchParams(new URL(pairingLink).hash.slice(1)).get('c')
  if (!pairingCode) throw new Error('Pairing link did not contain a secret.')
  await sodium.ready
  const kp = sodium.crypto_box_keypair()
  const pubkey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
  const privkey = sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL)

  const res = await api<RegisterResponse>('POST', `${relayUrl}/v1/endpoints/register`, undefined, {
    label: 'Node Sender',
    kind: 'extension',
    browser: 'chrome',
    platform: 'linux',
    pushSubscription: {
      transport: 'webpush',
      endpoint: 'https://push.invalid/sender',
      keys: { p256dh: 'x', auth: 'y' },
    },
    e2ePubkey: pubkey,
    pairingCode,
  })
  return {
    endpointId: res.endpointId as unknown as string,
    token: res.deviceToken as unknown as string,
    pubkey,
    privkey,
  }
}

/** Fetch a target endpoint's published public key. */
export async function targetPubkey(
  relayUrl: string,
  token: string,
  targetEndpointId: string,
): Promise<string> {
  const list = await api<Endpoint[]>('GET', `${relayUrl}/v1/endpoints`, token)
  const target = list.find((e) => e.id === (targetEndpointId as unknown as Endpoint['id']))
  if (!target) throw new Error(`target ${targetEndpointId} not in group`)
  return target.e2ePubkey
}

/** Seal a URL payload to the target and POST it. Returns the client message id. */
export async function sendSealed(
  relayUrl: string,
  sender: Sender,
  targetEndpointId: string,
  targetPubkeyB64: string,
  url: string,
): Promise<string> {
  await sodium.ready
  const payload = JSON.stringify({ url, sentAt: new Date().toISOString() })
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
  const ciphertext = sodium.crypto_box_easy(
    sodium.from_string(payload),
    nonce,
    sodium.from_base64(targetPubkeyB64, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(sender.privkey, sodium.base64_variants.ORIGINAL),
  )
  const envelope: EncryptedEnvelope = {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: keyIdFor(sender.pubkey),
    targetKeyId: keyIdFor(targetPubkeyB64),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  }

  const id = randomUUID()
  const res = await api<SendResponse>('POST', `${relayUrl}/v1/messages`, sender.token, {
    items: [{ id, targetEndpointId, envelope }],
  })
  if (!res.accepted.includes(id as unknown as SendResponse['accepted'][number])) {
    throw new Error(`send rejected: ${JSON.stringify(res.rejected)}`)
  }
  return id
}
