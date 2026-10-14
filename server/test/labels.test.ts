import type { Endpoint, ListEndpointsResponse } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, pairingCodeFromLink, register, startTestServer, type TestServer } from './helpers'

/**
 * Label de-duplication lives on the RELAY because the relay is the only party
 * that sees every endpoint in a group. Clients can't hold this invariant between
 * them: the extension de-duplicates locally, the console and the Android app
 * don't, and a browser that can't identify itself registers the same fallback
 * name as the last one that couldn't ("Chrome"). Two identical rows in the
 * chooser is the failure this prevents.
 */
let server: TestServer

beforeEach(async () => {
  server = await startTestServer()
})
afterEach(async () => {
  await server.close()
})

/** Register a first endpoint so it can mint links for later joiners. */
async function groupWith(label: string) {
  const { baseUrl } = server
  const first = await register(baseUrl, { label })
  return { first, baseUrl }
}

async function join(baseUrl: string, hostToken: string, label: string) {
  const pairing = await http.post<{ link: string }>(baseUrl, '/v1/pairing', undefined, hostToken)
  return register(baseUrl, { label, pairingCode: pairingCodeFromLink(pairing.body.link) })
}

async function labelsIn(baseUrl: string, token: string): Promise<string[]> {
  const res = await http.get<ListEndpointsResponse>(baseUrl, '/v1/endpoints', token)
  return res.body.map((e: Endpoint) => e.label).sort()
}

describe('label de-duplication within a group', () => {
  it('suffixes a joining endpoint whose label is already taken', async () => {
    const { first, baseUrl } = await groupWith('Chrome · MacBook')
    // Dia, unidentifiable, guesses the same name on the same machine.
    const second = await join(baseUrl, first.token, 'Chrome · MacBook')

    // The relay tells the joiner what it actually stored, so the new device shows
    // the same name everyone else sees.
    expect(second.label).toBe('Chrome 2 · MacBook')
    expect(await labelsIn(baseUrl, first.token)).toEqual(['Chrome 2 · MacBook', 'Chrome · MacBook'])
  })

  it('suffixes the BROWSER half, never the device half', async () => {
    const { first, baseUrl } = await groupWith('Chrome · MacBook')
    const second = await join(baseUrl, first.token, 'Chrome · MacBook')
    // "Chrome · MacBook 2" would claim a second machine that doesn't exist.
    expect(second.label).not.toContain('MacBook 2')
  })

  it('leaves the same browser name on a DIFFERENT device alone', async () => {
    const { first, baseUrl } = await groupWith('Chrome · MacBook')
    const second = await join(baseUrl, first.token, 'Chrome · Work PC')
    expect(second.label).toBe('Chrome · Work PC')
  })

  it('de-duplicates labels with no device half (a console, a phone)', async () => {
    const { first, baseUrl } = await groupWith('Web console')
    const second = await join(baseUrl, first.token, 'Web console')
    expect(second.label).toBe('Web console 2')
  })

  it('continues an existing counter instead of stacking suffixes', async () => {
    const { first, baseUrl } = await groupWith('Chrome · MacBook')
    const second = await join(baseUrl, first.token, 'Chrome · MacBook')
    const third = await join(baseUrl, first.token, 'Chrome · MacBook')
    expect([second.label, third.label]).toEqual(['Chrome 2 · MacBook', 'Chrome 3 · MacBook'])
  })

  it('de-duplicates a RENAME too, and reports the stored label back', async () => {
    const { first, baseUrl } = await groupWith('Chrome · MacBook')
    const second = await join(baseUrl, first.token, 'Firefox · MacBook')

    const res = await http.patch<Endpoint>(
      baseUrl,
      `/v1/endpoints/${second.endpointId}`,
      { label: 'Chrome · MacBook' },
      second.token,
    )

    expect(res.body.label).toBe('Chrome 2 · MacBook')
  })

  it('lets an endpoint keep its own name on rename (it is not its own duplicate)', async () => {
    const { first, baseUrl } = await groupWith('Chrome · MacBook')
    // Re-sending the same label — e.g. a device-name edit that leaves the browser
    // half alone — must not walk the counter up on every save.
    const res = await http.patch<Endpoint>(
      baseUrl,
      `/v1/endpoints/${first.endpointId}`,
      { label: 'Chrome · MacBook', deviceName: 'MacBook' },
      first.token,
    )
    expect(res.body.label).toBe('Chrome · MacBook')
  })
})
