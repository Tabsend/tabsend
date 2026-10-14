import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { freePort } from './relay'

export interface ProxyHandle {
  /** Base URL profile B uses as its relay. */
  url: string
  /**
   * While true, POST /v1/messages/:id/ack returns 503 — the message stays
   * pending on the relay, so re-polls genuinely re-hand the same row. This is
   * how the rig exercises the client's seen-set (no-dupes) for real.
   */
  failAcks: boolean
  ackAttempts: number
  stop(): Promise<void>
}

const ACK_RE = /^\/v1\/messages\/[^/]+\/ack$/

/**
 * A tiny fault-injection proxy in front of the relay. Everything passes through
 * verbatim except acks while `failAcks` is set. Lets the rig hold a delivered
 * message in the "opened but not yet acked" window across polls and browser
 * restarts — the exact window where a duplicate tab could happen.
 */
export async function startAckProxy(relayUrl: string): Promise<ProxyHandle> {
  const port = await freePort()

  const handle: ProxyHandle = {
    url: `http://127.0.0.1:${port}`,
    failAcks: false,
    ackAttempts: 0,
    stop: async () => {},
  }

  const server: Server = createServer((req, res) => {
    void forward(req, res)
  })

  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '/'
    if (req.method === 'POST' && ACK_RE.test(path)) {
      handle.ackAttempts += 1
      if (handle.failAcks) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'internal', message: 'e2e: ack blocked' } }))
        return
      }
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    try {
      const upstream = await fetch(`${relayUrl}${path}`, {
        method: req.method,
        headers: {
          ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: body.length > 0 ? body : undefined,
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': 'application/json' })
      res.end(text)
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'internal', message: 'e2e proxy: relay down' } }))
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve)
  })

  handle.stop = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })

  return handle
}

/** A one-page static server: the "real" web page profile A sends to profile B. */
export async function startTargetSite(): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort()
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Tabsend e2e target</title><h1>The tab that travels</h1>')
  })
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${port}/travel.html`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
