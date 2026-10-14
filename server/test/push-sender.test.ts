import type { IncomingMessage, ServerResponse } from 'node:http'
import { Agent, createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls'
import { generate } from 'selfsigned'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { RequestDetails } from 'web-push'
import webpush from 'web-push'
import {
  isDeadSubscriptionError,
  PushServiceError,
  sendPushRequest,
  WebPushSender,
} from '../src/push'

/**
 * How the relay sends a Web Push wake [2026-10-01 follow-up review, R12].
 *
 * A push endpoint is client-supplied, so on a hosted relay any tenant can point one at a
 * server of its own. web-push's sender read the ENTIRE reply into one string with no
 * limit, and its timeout only measured silence: a reply past V8's longest string (about
 * 512 MB) threw inside a stream handler, where nothing could catch it, and the relay
 * process ended for every tenant on it; a reply dripping a byte at a time held a wake
 * open indefinitely. These drive the replacement against a real local HTTPS server.
 */

let tls: { key: string; cert: string }
const insecure = new Agent({ rejectUnauthorized: false })
const servers: Server[] = []

beforeAll(async () => {
  const pems = await generate([{ name: 'commonName', value: '127.0.0.1' }], {
    algorithm: 'sha256',
    keySize: 2048,
  })
  tls = { key: pems.private, cert: pems.cert }
})
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections()
          s.close(() => resolve())
        }),
    ),
  )
})
afterAll(() => insecure.destroy())

async function pushService(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(tls, handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}/push/abc`
}

function details(endpoint: string): RequestDetails {
  return { method: 'POST', headers: { TTL: '60', 'Content-Length': '0' }, body: null, endpoint }
}

describe('sending a Web Push wake', () => {
  it('settles on the status line, and stops reading a reply that will not end', async () => {
    let written = 0
    let ended: () => void = () => {}
    const serverDone = new Promise<void>((resolve) => {
      ended = resolve
    })
    const endpoint = await pushService((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/octet-stream' })
      const chunk = Buffer.alloc(256 * 1024, 0x61)
      const pump = () => {
        // Up to 256 MB, with backpressure, unless the reader goes away first.
        while (written < 256 * 1024 * 1024) {
          written += chunk.length
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end()
      }
      res.on('close', ended)
      pump()
    })

    await sendPushRequest(details(endpoint), { agent: insecure, maxResponseBytes: 64 * 1024 })
    await serverDone
    // The relay stopped reading long before the end: what was written is what the
    // socket buffers took, not the 256 MB on offer.
    expect(written).toBeLessThan(32 * 1024 * 1024)
  })

  it('rejects with the status, so a 404 or 410 still reads as a dead subscription', async () => {
    const endpoint = await pushService((_req, res) => {
      res.writeHead(410).end('gone')
    })
    const sending = sendPushRequest(details(endpoint), { agent: insecure })
    await expect(sending).rejects.toBeInstanceOf(PushServiceError)
    const err = await sending.catch((e: unknown) => e)
    expect(isDeadSubscriptionError(err)).toBe(true)
  })

  it('treats any other refusal as transient', async () => {
    const endpoint = await pushService((_req, res) => {
      res.writeHead(503).end()
    })
    const err = await sendPushRequest(details(endpoint), { agent: insecure }).catch((e) => e)
    expect(err).toBeInstanceOf(PushServiceError)
    expect(isDeadSubscriptionError(err)).toBe(false)
  })

  it('gives up at the deadline when nothing comes back', async () => {
    const endpoint = await pushService(() => {
      // Accept the request and never answer it.
    })
    const started = Date.now()
    await expect(
      sendPushRequest(details(endpoint), { agent: insecure, deadlineMs: 300 }),
    ).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('settles as soon as the status line arrives, without waiting for the body', async () => {
    let hold: ServerResponse | undefined
    const endpoint = await pushService((_req, res) => {
      res.writeHead(201)
      res.write('partial')
      hold = res // never ended while the assertion runs
    })
    const started = Date.now()
    await sendPushRequest(details(endpoint), { agent: insecure, deadlineMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(hold?.writableEnded).toBe(false)
  })

  it('does not hang on a reply that switches protocols', async () => {
    // Node hands a `101` with `Connection: upgrade` to an 'upgrade' listener nobody
    // registered, destroys the socket and takes the deadline with it. The wake must
    // still settle rather than wait for ever.
    const raw: TlsServer = createTlsServer(tls, (socket) => {
      socket.once('data', () => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: upgrade\r\n\r\n',
        )
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', () => resolve()))
    try {
      const port = (raw.address() as AddressInfo).port
      const started = Date.now()
      await expect(
        sendPushRequest(details(`https://127.0.0.1:${port}/push/abc`), {
          agent: insecure,
          deadlineMs: 10_000,
        }),
      ).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()))
    }
  })
})

describe('what the Web Push sender hands to the network', () => {
  const vapid = (() => {
    const keys = webpush.generateVAPIDKeys()
    return {
      subject: 'mailto:test@tabsend.test',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    }
  })()
  const subscription = {
    transport: 'webpush' as const,
    endpoint: 'https://push.example.com/send/abc?x=1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  }

  it('sends an empty, high-urgency wake signed with the relay key, through the egress guard', async () => {
    const sent: Array<{ details: RequestDetails; agent?: Agent }> = []
    const sender = new WebPushSender(vapid, false, async (d, options) => {
      sent.push({ details: d, agent: options?.agent })
    })
    await sender.wake(subscription)

    expect(sent).toHaveLength(1)
    const { details: d, agent } = sent[0]!
    expect(d.endpoint).toBe(subscription.endpoint)
    expect(d.method).toBe('POST')
    expect(d.body).toBeNull()
    expect(String(d.headers.TTL)).toBe('60')
    expect(d.headers.Urgency).toBe('high')
    expect(String(d.headers.Authorization)).toMatch(/^vapid t=.+, k=.+/)
    // The public-only agent is what makes the connection refuse private addresses.
    expect(agent).toBeDefined()
  })

  it('leaves the agent off only where private destinations were explicitly allowed', async () => {
    const sent: Array<{ agent?: Agent }> = []
    const sender = new WebPushSender(vapid, true, async (_d, options) => {
      sent.push({ agent: options?.agent })
    })
    await sender.wake(subscription)
    expect(sent[0]?.agent).toBeUndefined()
  })
})
