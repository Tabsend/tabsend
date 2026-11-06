import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { CreatePairingResponse, Endpoint, RegisterResponse } from '@tabsend/shared'
import { sleep, startRelay } from './relay'

/**
 * The other end of the Google Play screenshots (docs/STORE_LISTING.md, "Screenshots").
 *
 *   cd e2e && ../server/node_modules/.bin/tsx src/play-screenshots-relay.ts <out.json> [de]
 *
 * Boots a throwaway relay, joins two laptops over the API (the way browsers join), and
 * writes the link a phone pairs with to <out.json>. Once a phone has joined it sends it one
 * tab, then keeps collecting what the phone sends to the laptops, so "Sent to" and History
 * show delivered tabs. Runs until it is killed. Nothing is drawn: the phone is a real
 * emulator running the real app.
 */
const sodium = createRequire(import.meta.url)(
  'libsodium-wrappers',
) as typeof import('libsodium-wrappers')

const [outFile, lang = 'en'] = process.argv.slice(2)
if (!outFile) throw new Error('usage: play-screenshots-relay.ts <out.json> [de]')
const DE = lang === 'de'

interface Sender {
  endpointId: string
  token: string
  pubkey: string
  privkey: string
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

await sodium.ready
const b64 = sodium.base64_variants.ORIGINAL
const keyId = (k: string) => createHash('sha256').update(k).digest('base64url')

const relay = await startRelay()
process.on('SIGTERM', () => void relay.stop().then(() => process.exit(0)))
process.on('SIGINT', () => void relay.stop().then(() => process.exit(0)))

async function join(link: string, deviceName: string, browser: string): Promise<Sender> {
  const code = new URLSearchParams(new URL(link).hash.slice(1)).get('c')
  const kp = sodium.crypto_box_keypair()
  const pubkey = sodium.to_base64(kp.publicKey, b64)
  const privkey = sodium.to_base64(kp.privateKey, b64)
  const res = await api<RegisterResponse>('POST', `${relay.url}/v1/endpoints/register`, undefined, {
    label: `${browser === 'firefox' ? 'Firefox' : 'Chrome'} · ${deviceName}`,
    deviceName,
    kind: 'extension',
    browser,
    platform: 'windows',
    pushSubscription: { transport: 'none' },
    e2ePubkey: pubkey,
    pairingCode: code,
  })
  return { endpointId: String(res.endpointId), token: String(res.deviceToken), pubkey, privkey }
}
const mint = async (token: string) =>
  (await api<CreatePairingResponse>('POST', `${relay.url}/v1/pairing`, token)).link

const work = await join(relay.firstRunPairingLink, DE ? 'Arbeitslaptop' : 'Work laptop', 'chrome')
const home = await join(await mint(work.token), DE ? 'Laptop zu Hause' : 'Home laptop', 'firefox')
const phoneLink = await mint(work.token)
writeFileSync(outFile, JSON.stringify({ relay: relay.url, phoneLink }))
console.log('relay', relay.url)
console.log('phone link', phoneLink)

let greeted = false
for (;;) {
  const list = await api<Endpoint[]>('GET', `${relay.url}/v1/endpoints`, work.token).catch(
    () => [] as Endpoint[],
  )
  const phone = list.find((e) => e.kind === 'mobile')
  if (phone && !greeted) {
    greeted = true
    await sleep(3000)
    const payload = JSON.stringify({
      url: DE
        ? 'https://de.wikipedia.org/wiki/Sauerteig'
        : 'https://en.wikipedia.org/wiki/Sourdough',
      title: DE ? 'Sauerteig – Wikipedia' : 'Sourdough - Wikipedia',
      image:
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0a/Sourdough.jpg/960px-Sourdough.jpg',
      sentAt: new Date().toISOString(),
    })
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
    const ct = sodium.crypto_box_easy(
      sodium.from_string(payload),
      nonce,
      sodium.from_base64(phone.e2ePubkey, b64),
      sodium.from_base64(work.privkey, b64),
    )
    await api('POST', `${relay.url}/v1/messages`, work.token, {
      items: [
        {
          id: randomUUID(),
          targetEndpointId: String(phone.id),
          envelope: {
            alg: 'x25519-xsalsa20-poly1305/box',
            senderKeyId: keyId(work.pubkey),
            targetKeyId: keyId(phone.e2ePubkey),
            nonce: sodium.to_base64(nonce, b64),
            ciphertext: sodium.to_base64(ct, b64),
          },
        },
      ],
    }).catch((e) => console.log('greeting failed', String(e)))
    console.log('sent a tab to the phone')
  }
  // The laptops pick up what the phone sends them.
  for (const d of [work, home]) {
    const pending = await api<{ id: string }[]>(
      'GET',
      `${relay.url}/v1/messages?pending=1`,
      d.token,
    ).catch(() => [])
    for (const m of pending) {
      await api('POST', `${relay.url}/v1/messages/${m.id}/ack`, d.token).catch(() => undefined)
      console.log('collected a tab for', d.endpointId)
    }
  }
  await sleep(1000)
}
