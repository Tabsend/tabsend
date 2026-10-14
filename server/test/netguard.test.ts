import type { AddressInfo } from 'node:net'
import websocketPlugin from '@fastify/websocket'
import Fastify from 'fastify'
import type { Kysely } from 'kysely'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { createDatabase, type Database, ensureRelayId, migrate } from '../src/db'
import { isPrivateAddress } from '../src/netguard'
import { FakePushSender } from '../src/push'

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', 'IPv4 loopback'],
    ['127.1.2.3', 'anywhere in 127/8'],
    ['10.0.0.1', 'RFC1918 10/8'],
    ['192.168.1.30', 'RFC1918 192.168/16'],
    ['172.16.0.1', 'RFC1918 172.16/12 lower bound'],
    ['172.31.255.254', 'RFC1918 172.16/12 upper bound'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'CGNAT/VPN lower bound'],
    ['100.127.255.254', 'CGNAT/VPN upper bound'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fe80::1%eth0', 'IPv6 link-local with a zone index'],
    ['fd00::1', 'IPv6 unique-local'],
    ['fc00::abcd', 'IPv6 unique-local low prefix'],
    ['::ffff:192.168.1.5', 'IPv4-mapped IPv6, as Node reports dual-stack peers'],
    ['::FFFF:10.0.0.9', 'IPv4-mapped, uppercase'],
  ])('allows %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['203.0.113.7', 'public documentation range'],
    ['172.15.0.1', 'just BELOW the 172.16/12 block'],
    ['172.32.0.1', 'just ABOVE the 172.16/12 block'],
    ['100.63.255.255', 'just below the CGNAT block'],
    ['100.128.0.1', 'just above the CGNAT block'],
    ['192.169.1.1', 'near-miss on 192.168'],
    ['11.0.0.1', 'near-miss on 10/8'],
    ['2606:4700::1111', 'public IPv6'],
    ['fe00::1', 'below the link-local block'],
    ['fec0::1', 'site-local — deprecated, not treated as private'],
    ['::ffff:8.8.8.8', 'IPv4-mapped PUBLIC address must not slip through'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })

  it.each<[string | undefined, string]>([
    [undefined, 'an unknown peer'],
    ['', 'an empty string'],
    ['not-an-address', 'garbage'],
    ['999.1.1.1', 'out-of-range octet'],
    ['10.0.0', 'too few octets'],
    ['010.0.0.1', 'zero-padded octet, which some parsers read as octal'],
  ])('refuses %s (%s) rather than guessing', (address) => {
    expect(isPrivateAddress(address)).toBe(false)
  })
})

/** A relay whose cleartext guard is on, driven via inject so the peer can be faked. */
async function guardedApp(db: Kysely<Database>) {
  const config = loadConfig({ DATABASE_URL: 'sqlite::memory:' })
  config.rateLimit = { max: 0, windowMs: 600_000 }
  // Mirrors the cleartext listener behind a proxy: request.ip would come from the
  // X-Forwarded-For header, which is exactly what the guard must NOT trust.
  config.trustProxy = true
  return buildApp({
    db,
    config,
    relayId: await ensureRelayId(db),
    push: new FakePushSender(),
    restrictToPrivateClients: true,
  })
}

describe('cleartext listener guard', () => {
  it('serves a private client', async () => {
    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const app = await guardedApp(db)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config',
      remoteAddress: '192.168.1.40',
    })
    expect(res.statusCode).toBe(200)
    await app.close()
    await db.destroy()
  })

  it('refuses a public client with 403', async () => {
    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const app = await guardedApp(db)
    const res = await app.inject({ method: 'GET', url: '/v1/config', remoteAddress: '203.0.113.7' })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden')
    await app.close()
    await db.destroy()
  })

  it('cannot be walked through with a forged X-Forwarded-For', async () => {
    // The whole point of reading the socket address instead of request.ip. If the
    // guard trusted the header, this request would be served.
    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const app = await guardedApp(db)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/config',
      remoteAddress: '203.0.113.7',
      headers: { 'x-forwarded-for': '192.168.1.5' },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
    await db.destroy()
  })

  it('guards unauthenticated write routes too, not just reads', async () => {
    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const app = await guardedApp(db)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/endpoints/register',
      remoteAddress: '8.8.8.8',
      payload: { label: 'x', kind: 'extension', e2ePubkey: 'pk' },
    })
    expect(res.statusCode).toBe(403)
    await app.close()
    await db.destroy()
  })

  it('is absent by default, so the https listener stays open to the world', async () => {
    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const config = loadConfig({ DATABASE_URL: 'sqlite::memory:' })
    config.rateLimit = { max: 0, windowMs: 600_000 }
    const app = await buildApp({
      db,
      config,
      relayId: await ensureRelayId(db),
      push: new FakePushSender(),
    })
    const res = await app.inject({ method: 'GET', url: '/v1/config', remoteAddress: '203.0.113.7' })
    expect(res.statusCode).toBe(200)
    await app.close()
    await db.destroy()
  })
})

describe('the guard covers the WebSocket upgrade, not just REST', () => {
  // The guard is an onRequest hook, and the WS fast path is the one route that could
  // plausibly bypass Fastify's normal request lifecycle. If it did, a refused client
  // could still open a live socket — a hole that REST-only tests would never show.
  // `inject` cannot drive a real upgrade, so this asserts the framework guarantee the
  // guard depends on, using a hook that refuses by URL instead of by address (a real
  // socket always has a private peer in tests).
  it('a 403 from onRequest prevents the socket from opening', async () => {
    const app = Fastify()
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/blocked')) {
        await reply.code(403).send({ error: { code: 'forbidden', message: 'no' } })
      }
    })
    await app.register(websocketPlugin)
    app.get('/blocked', { websocket: true }, (socket) => socket.send('{"type":"leaked"}'))
    app.get('/allowed', { websocket: true }, (socket) => socket.send('{"type":"ok"}'))
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo

    // Resolves only once the socket has fully CLOSED, not merely when the outcome is
    // known: http.Server.close() waits on open connections, so leaving the accepted
    // socket dangling would hang teardown rather than fail the assertion.
    const attempt = (path: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
        let outcome = 'timeout'
        ws.addEventListener('message', () => {
          outcome = 'opened'
          ws.close()
        })
        ws.addEventListener('error', () => {
          outcome = 'refused'
        })
        ws.addEventListener('close', () => resolve(outcome))
        setTimeout(() => {
          ws.close()
          resolve(outcome)
        }, 4000)
      })

    expect(await attempt('/allowed')).toBe('opened')
    expect(await attempt('/blocked')).toBe('refused')

    // A refused upgrade leaves a socket that Fastify's close() waits on indefinitely,
    // so cap teardown — the assertions above are the point, not the shutdown.
    app.server.closeAllConnections()
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 1000))])
  })
})

describe('HTTP_ALLOW_PUBLIC config', () => {
  it('defaults to off (the guard is on)', () => {
    expect(loadConfig({ DATABASE_URL: 'sqlite::memory:' }).httpAllowPublic).toBe(false)
  })

  it('accepts 1 and true', () => {
    const base = { DATABASE_URL: 'sqlite::memory:' }
    expect(loadConfig({ ...base, HTTP_ALLOW_PUBLIC: '1' }).httpAllowPublic).toBe(true)
    expect(loadConfig({ ...base, HTTP_ALLOW_PUBLIC: 'true' }).httpAllowPublic).toBe(true)
  })

  it('ignores other values rather than half-enabling', () => {
    const base = { DATABASE_URL: 'sqlite::memory:' }
    expect(loadConfig({ ...base, HTTP_ALLOW_PUBLIC: 'yes' }).httpAllowPublic).toBe(false)
    expect(loadConfig({ ...base, HTTP_ALLOW_PUBLIC: '0' }).httpAllowPublic).toBe(false)
  })
})
