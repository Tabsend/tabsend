import type { EncryptedEnvelope, PendingMessagesResponse, SendResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { keyIdFor } from '../src/ids'
import { assertProfile } from '../src/profile'
import {
  connectWs,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * Log hygiene, swept across every hot path at once [0033] (HOSTED_PLAN §4.5,
 * HOSTED_SECURITY_PLAN's control-plane gates: *logs and traces contain IDs and
 * aggregate sizes only, never tokens, pairing links, push URLs, ciphertext bodies,
 * decrypted URLs/titles, keys, or billing secrets*).
 *
 * TWO NARROWER TESTS ALREADY EXIST AND STAY WHERE THEY ARE: the provisioning audit
 * mirror asserts what its own lines DO carry and that a pairing link is not among them
 * (`provisioning.test.ts`), and the forwarder failure line asserts the wake token is
 * absent from it (`wake-forwarder.test.ts`). Both are positive assertions about one
 * line each. This file is the opposite shape and that is why it is separate: it drives
 * a hosted-shaped relay through every path that touches a secret and then looks for
 * that secret ANYWHERE in the captured output, including in Fastify's own request lines
 * and in lines a future edit adds without thinking about this rule.
 *
 * WHY IT KEEPS EARNING ITS PLACE. Every recent chunk added log lines: the provisioning
 * audit mirror [0031], the wake call-out [0032], the profile line [0033]. Each was
 * written carefully. The failure this guards is the NEXT one, added in a hurry, that
 * logs a whole request body or a whole endpoint row because that was the quickest way
 * to debug something.
 */

const PROVISIONING_TOKEN = 'test-provisioning-credential'
const WRONG_TOKEN = 'test-provisioning-credentiaL'
const WAKE_TOKEN = 'wake-token-that-must-never-be-logged'
const VAPID_PRIVATE_KEY = 'test-private-key'
const FORWARDER_URL = 'https://wake.test'
const PUSH_ENDPOINT = 'https://push.test/endpoint/subscription-secret-path'

/** Ciphertext and nonce a grep can find. Real ones are base64 noise; these are not. */
const CIPHERTEXT = Buffer.from('plaintext-tab-url-that-must-never-be-logged').toString('base64')
const NONCE = Buffer.from('nonce-that-must-never-log').toString('base64')

let server: TestServer

afterEach(async () => {
  await server?.close()
})

interface CreatedGroup {
  groupId: string
}
interface MintedPairing {
  link: string
  qrLink: string
  expiresAt: string
}

function envelope(targetPubkey: string): EncryptedEnvelope {
  return {
    alg: 'x25519-xsalsa20-poly1305/box',
    senderKeyId: 'sender-key-id',
    targetKeyId: keyIdFor(targetPubkey),
    nonce: NONCE,
    ciphertext: CIPHERTEXT,
  }
}

describe('logs carry ids and sizes, never secrets', () => {
  it('never writes a secret while a hosted relay is provisioned, paired, sent to and torn down', async () => {
    const logs: unknown[] = []
    const wakeCalls: string[] = []
    server = await startTestServer({
      // As close to the hosted posture as an in-process relay gets: groups exist only
      // because the provisioning API made them, an iPhone is on the wake path, and Web
      // Push has an identity, so every secret-bearing path below is reachable.
      groupCreation: 'provisioned',
      provisioningToken: PROVISIONING_TOKEN,
      vapidPublicKey: 'BPublicKeyBase64Url',
      wakeForwarderUrl: FORWARDER_URL,
      wakeFetch: async (_input, init) => {
        wakeCalls.push(String(new Headers(init?.headers).get('authorization')))
        // A failure, deliberately: the success path logs nothing, so the line most
        // likely to carry a token is the one written when a wake goes wrong.
        return new Response(null, { status: 500 })
      },
      rateLimit: { max: 100, windowMs: 600_000 },
      captureLogs: logs,
    })
    const base = server.baseUrl

    // 1. Provisioning: create a tenancy and mint its bootstrap link.
    const created = await http.post<CreatedGroup>(
      base,
      '/admin/provisioning/groups',
      undefined,
      PROVISIONING_TOKEN,
    )
    const groupId = created.body.groupId
    const minted = await http.post<MintedPairing>(
      base,
      `/admin/provisioning/groups/${groupId}/pairing`,
      undefined,
      PROVISIONING_TOKEN,
    )
    const bootstrapLink = minted.body.link
    const bootstrapCode = pairingCodeFromLink(bootstrapLink)

    // 2. Register: the path that CONSUMES a pairing code and MINTS a device token.
    const browser = await register(base, {
      pairingCode: bootstrapCode,
      e2ePubkey: 'browser-key',
      pushSubscription: {
        transport: 'webpush',
        endpoint: PUSH_ENDPOINT,
        keys: { p256dh: 'p256dh-secret', auth: 'auth-secret' },
      },
    })

    // 3. Device-to-device pairing, then a second register: the ordinary way in.
    const deviceLink = await http.post<{ link: string }>(
      base,
      '/v1/pairing',
      undefined,
      browser.token,
    )
    const deviceCode = pairingCodeFromLink(deviceLink.body.link)
    const phone = await register(base, {
      pairingCode: deviceCode,
      kind: 'mobile',
      platform: 'ios',
      e2ePubkey: 'phone-key',
      pushSubscription: { transport: 'forwarder', wakeToken: WAKE_TOKEN },
    })

    // 4. Send: ciphertext in, and a wake that fails and therefore logs.
    const sent = await http.post<SendResponse>(
      base,
      '/v1/messages',
      {
        items: [
          {
            id: 'log-hygiene-1',
            targetEndpointId: phone.endpointId,
            envelope: envelope(phone.e2ePubkey),
          },
        ],
      },
      browser.token,
    )
    expect(sent.body.accepted).toHaveLength(1)
    expect(wakeCalls).toEqual([`Bearer ${WAKE_TOKEN}`])

    // 5. Collect and ack: the envelope leaves the relay here, and ack erases it.
    const pending = await http.get<PendingMessagesResponse>(
      base,
      '/v1/messages?pending=1',
      phone.token,
    )
    expect(pending.body).toHaveLength(1)
    await http.post(base, `/v1/messages/${pending.body[0]?.id}/ack`, undefined, phone.token)

    // 6. A live WebSocket, whose hello frame carries a device token.
    const ws = await connectWs(server.wsUrl)
    ws.send({ type: 'hello', deviceToken: phone.token })
    ws.send({ type: 'ping' })
    await ws.next((m) => m.type === 'pong')
    ws.close()

    // 7. Refusals, because the error paths are where a secret usually escapes: a
    //    pairing code that is not one, and a credential that is nearly right.
    await http.post(base, '/v1/endpoints/register', {
      label: 'Impostor',
      kind: 'extension',
      browser: 'chrome',
      platform: 'macos',
      pushSubscription: { transport: 'none' },
      e2ePubkey: 'impostor-key',
      pairingCode: 'guessed-pairing-code-that-must-never-be-logged',
    })
    await http.post(base, '/admin/provisioning/groups', undefined, WRONG_TOKEN)

    // 8. The rest of the provisioning surface, ending in the destructive one.
    await http.get(base, `/admin/provisioning/groups/${groupId}/usage`, PROVISIONING_TOKEN)
    await http.patch(
      base,
      `/admin/provisioning/groups/${groupId}/caps`,
      { endpoints: 30 },
      PROVISIONING_TOKEN,
    )
    await http.post(
      base,
      `/admin/provisioning/groups/${groupId}/suspend`,
      undefined,
      PROVISIONING_TOKEN,
    )
    await http.get(base, '/admin/status')
    await http.del(base, `/admin/provisioning/groups/${groupId}`, PROVISIONING_TOKEN)

    // The relay wrote something on nearly every one of those, so an empty capture would
    // pass the sweep below for the wrong reason.
    expect(logs.length).toBeGreaterThan(10)

    const everything = JSON.stringify(logs)
    const forbidden: Array<[string, string]> = [
      ['the bootstrap pairing link', bootstrapLink],
      ['the bootstrap pairing code', bootstrapCode],
      ['the device-to-device pairing link', deviceLink.body.link],
      ['the device-to-device pairing code', deviceCode],
      ["the browser's device token", browser.token],
      ["the phone's device token", phone.token],
      ['the wake token', WAKE_TOKEN],
      ['the envelope ciphertext', CIPHERTEXT],
      ['the envelope nonce', NONCE],
      ['the VAPID private key', VAPID_PRIVATE_KEY],
      ['the provisioning credential', PROVISIONING_TOKEN],
      ['a credential a caller presented', WRONG_TOKEN],
      ['the push endpoint URL', PUSH_ENDPOINT],
      ['a push subscription key', 'p256dh-secret'],
      ['a pairing code somebody guessed', 'guessed-pairing-code-that-must-never-be-logged'],
    ]
    for (const [what, secret] of forbidden) {
      // Named in the assertion so a failure says WHICH secret escaped, not just that
      // one did — the difference between a five-minute fix and an afternoon.
      expect(`${what}: ${everything.includes(secret)}`).toBe(`${what}: false`)
    }
  })

  it('records the ids and sizes it is supposed to, so the sweep is not passing on silence', async () => {
    const logs: unknown[] = []
    server = await startTestServer({
      groupCreation: 'provisioned',
      provisioningToken: PROVISIONING_TOKEN,
      captureLogs: logs,
    })
    const created = await http.post<CreatedGroup>(
      server.baseUrl,
      '/admin/provisioning/groups',
      undefined,
      PROVISIONING_TOKEN,
    )
    const minted = await http.post<MintedPairing>(
      server.baseUrl,
      `/admin/provisioning/groups/${created.body.groupId}/pairing`,
      undefined,
      PROVISIONING_TOKEN,
    )

    const everything = JSON.stringify(logs)
    // The group id is an id, and the expiry is a time: both are exactly what the gate
    // asks for, and both prove the audit line was written rather than skipped.
    expect(everything).toContain(created.body.groupId)
    expect(everything).toContain(minted.body.expiresAt)
  })
})

describe('the boot log on a hosted relay', () => {
  it('has no first-run pairing link to print, because a hosted relay has no "the" group', async () => {
    // The one place the relay logs a live credential on purpose is ADR-0023's boot link
    // on a single-group relay, and [0029] already stops it under `provisioned`. Asserted
    // here rather than assumed, because it is the exception that would make every other
    // assertion in this file moot on a hosted deployment.
    server = await startTestServer({
      groupCreation: 'provisioned',
      provisioningToken: PROVISIONING_TOKEN,
    })
    expect(server.firstRunPairing).toBeNull()
  })

  it('refuses the hosted profile without echoing the credential it was given', () => {
    // The refusal prints configuration back at the operator, which is the whole point,
    // so it is worth proving it prints the NAMES and not the values.
    let message = ''
    try {
      assertProfile(
        loadConfig({
          TABSEND_PROFILE: 'hosted',
          PROVISIONING_TOKEN,
          PUSH_ALLOW_PRIVATE_ENDPOINTS: '1',
        }),
      )
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('PUSH_ALLOW_PRIVATE_ENDPOINTS')
    expect(message).not.toContain(PROVISIONING_TOKEN)
  })
})
