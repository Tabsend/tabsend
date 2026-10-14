import type { CreatePairingResponse } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import {
  connectWs,
  envelopeFor,
  http,
  pairingCodeFromLink,
  register,
  startTestServer,
  type TestServer,
} from './helpers'

/**
 * Dual-listen: one relay serving https (for phones, which pin the cert) AND plain
 * http (for browser extensions, which cannot pin anything) on a second port.
 *
 * The whole risk of that shape is shared state. Two Fastify instances mean two of
 * everything unless boot passes one in, and the WS hub is the one that fails
 * SILENTLY: a browser sending on the http listener would not wake a phone's socket
 * on the https listener, and delivery would quietly fall back to polling instead of
 * erroring. So these tests assert across the listener boundary in both directions.
 */

let server: TestServer

beforeEach(async () => {
  server = await startTestServer({ secondListener: true })
})
afterEach(async () => {
  await server.close()
})

function second(): { baseUrl: string; wsUrl: string } {
  if (!server.second) throw new Error('second listener not started')
  return server.second
}

async function mintPairing(baseUrl: string, token: string): Promise<string> {
  const res = await http.post<CreatePairingResponse>(baseUrl, '/v1/pairing', undefined, token)
  return pairingCodeFromLink(res.body.link)
}

async function connectAuthed(wsUrl: string, token: string) {
  const ws = await connectWs(wsUrl)
  ws.send({ type: 'hello', deviceToken: token })
  ws.send({ type: 'ping' })
  await ws.next((m) => m.type === 'pong')
  return ws
}

describe('dual listeners on one relay', () => {
  it('shares the process connection cap across both listeners', async () => {
    await server.close()
    server = await startTestServer({ secondListener: true, streamMaxConnections: 1 })
    const first = await connectWs(server.wsUrl)
    const secondSocket = await connectWs(second().wsUrl)
    const { code } = await secondSocket.closed
    expect(code).toBe(1013)
    first.close()
  })

  it('wakes a socket held on the OTHER listener (shared hub)', async () => {
    // The real scenario: phone streaming over https, browser sending over http.
    const phone = await register(server.baseUrl)
    const code = await mintPairing(server.baseUrl, phone.token)
    const browser = await register(second().baseUrl, { pairingCode: code })

    const phoneWs = await connectAuthed(server.wsUrl, phone.token)

    await http.post(
      second().baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'dual-1',
            targetEndpointId: phone.endpointId,
            envelope: envelopeFor(phone.e2ePubkey),
          },
        ],
      },
      browser.token,
    )

    const event = await phoneWs.next((m) => m.type === 'message')
    expect(event.type).toBe('message')
    phoneWs.close()
  })

  it('wakes a socket in the reverse direction too', async () => {
    const browser = await register(second().baseUrl)
    const code = await mintPairing(second().baseUrl, browser.token)
    const phone = await register(server.baseUrl, { pairingCode: code })

    const browserWs = await connectAuthed(second().wsUrl, browser.token)

    await http.post(
      server.baseUrl,
      '/v1/messages',
      {
        items: [
          {
            id: 'dual-2',
            targetEndpointId: browser.endpointId,
            envelope: envelopeFor(browser.e2ePubkey),
          },
        ],
      },
      phone.token,
    )

    const event = await browserWs.next((m) => m.type === 'message')
    expect(event.type).toBe('message')
    browserWs.close()
  })

  it('honours a token minted on one listener at the other', async () => {
    // Both listeners are the same relay, so identity must not be per-socket.
    const a = await register(server.baseUrl)
    const res = await http.get(second().baseUrl, '/v1/endpoints', a.token)
    expect(res.status).toBe(200)
  })

  it('carries the cert pin in a pairing minted on the cleartext listener', async () => {
    // The browser extension lives on the cleartext listener and is usually the side
    // that mints the QR the PHONE scans. That payload points at the https address, so
    // it must also carry the pin — without it the phone falls back to CA validation
    // of a self-signed cert and cannot connect at all.
    const pinned = await startTestServer({ secondListener: true, certFingerprint: 'test-pin-abc' })
    try {
      const ext = await register(pinned.second?.baseUrl ?? '')
      const res = await http.post<CreatePairingResponse>(
        pinned.second?.baseUrl ?? '',
        '/v1/pairing',
        undefined,
        ext.token,
      )
      expect(res.body.link).toContain('&fp=test-pin-abc')
    } finally {
      await pinned.close()
    }
  })

  it('reports the same relayId on both listeners', async () => {
    // A differing relayId would make clients treat one relay as two, defeating the
    // in-place "change relay address" path (P-4/ADR-0020).
    const a = await http.get<{ relayId: string }>(server.baseUrl, '/v1/config')
    const b = await http.get<{ relayId: string }>(second().baseUrl, '/v1/config')
    expect(a.body.relayId).toBe(b.body.relayId)
    expect(a.body.relayId).toBeTruthy()
  })
})

describe('HTTP_PORT config', () => {
  const base = { DATABASE_URL: 'sqlite::memory:', TLS_SELF_SIGNED: '1' }

  it('is off unless set', () => {
    expect(loadConfig(base).httpPort).toBeUndefined()
  })

  it('is ignored without TLS, where the main listener is already cleartext', () => {
    expect(
      loadConfig({ DATABASE_URL: base.DATABASE_URL, HTTP_PORT: '8786' }).httpPort,
    ).toBeUndefined()
  })

  it('parses alongside self-signed TLS', () => {
    const config = loadConfig({
      ...base,
      PORT: '8787',
      HTTP_PORT: '8786',
      PUBLIC_RELAY_URL: 'https://192.168.1.20:8787',
    })
    expect(config.httpPort).toBe(8786)
    expect(config.publicBrowserRelayUrl).toBe('http://192.168.1.20:8786')
  })

  it('allows an explicit browser route for custom proxying', () => {
    const config = loadConfig({
      ...base,
      HTTP_PORT: '9080',
      PUBLIC_RELAY_URL: 'https://phone.example:9443/base',
      PUBLIC_BROWSER_RELAY_URL: 'http://browser.example:9080/base',
    })
    expect(config.publicBrowserRelayUrl).toBe('http://browser.example:9080/base')
  })

  it('refuses to collide with the https port', () => {
    expect(() => loadConfig({ ...base, PORT: '8787', HTTP_PORT: '8787' })).toThrow(/must differ/)
  })
})
