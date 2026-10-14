import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreatePairingResponse } from '@tabsend/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app'
import { loadConfig } from '../src/config'
import { createDatabase, ensureRelayId, migrate } from '../src/db'
import { FakePushSender } from '../src/push'
import {
  certCoversHost,
  ensureSelfSignedCert,
  lanIPv4Candidates,
  spkiFingerprint,
} from '../src/tls'
import { http, register, startTestServer, type TestServer } from './helpers'

const dirs: string[] = []
function tempTlsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tabsend-tls-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('self-signed cert material (P-3)', () => {
  it('generates once, then reuses — same fingerprint across a second boot', async () => {
    const dir = tempTlsDir()
    const first = await ensureSelfSignedCert(dir)
    expect(existsSync(join(dir, 'key.pem'))).toBe(true)
    expect(existsSync(join(dir, 'cert.pem'))).toBe(true)

    // "Second boot": the pin every paired device carries must not change.
    const second = await ensureSelfSignedCert(dir)
    expect(second.certPem).toBe(first.certPem)
    expect(second.keyPem).toBe(first.keyPem)
    expect(spkiFingerprint(second.certPem)).toBe(spkiFingerprint(first.certPem))
  })

  it('fingerprint is base64url SHA-256 of the SPKI DER (43 chars, no padding)', async () => {
    const { certPem } = await ensureSelfSignedCert(tempTlsDir())
    const fp = spkiFingerprint(certPem)
    expect(fp).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes → 43 base64url chars
  })

  it('bakes extra SANs into the cert', async () => {
    const { certPem } = await ensureSelfSignedCert(tempTlsDir(), ['relay.lan', '10.0.0.7'])
    const san = new X509Certificate(certPem).subjectAltName ?? ''
    expect(san).toContain('DNS:localhost')
    expect(san).toContain('IP Address:127.0.0.1')
    expect(san).toContain('DNS:relay.lan')
    expect(san).toContain('IP Address:10.0.0.7')
  })
})

describe('LAN address ranking', () => {
  // Only the fields lanIPv4Candidates reads; the rest of NetworkInterfaceInfo is noise here.
  function iface(address: string, opts: { internal?: boolean; v6?: boolean } = {}) {
    return {
      address,
      netmask: '255.255.255.0',
      family: opts.v6 ? 'IPv6' : 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: opts.internal ?? false,
      cidr: `${address}/24`,
    } as unknown as import('node:os').NetworkInterfaceInfo
  }

  it('prefers a real NIC over the Docker bridges that always exist beside it', () => {
    // A typical Linux relay host: host networking exposes every bridge Docker ever created,
    // and the old "first non-internal IPv4" rule could hand a phone any of them.
    const ranked = lanIPv4Candidates({
      'br-9f2a1c': [iface('172.19.0.1')],
      docker0: [iface('172.17.0.1')],
      enp3s0: [iface('192.168.1.20')],
      lo: [iface('127.0.0.1', { internal: true })],
      tailscale0: [iface('100.64.0.7')],
      virbr0: [iface('192.168.122.1')],
    })

    expect(ranked[0]).toMatchObject({ address: '192.168.1.20', iface: 'enp3s0' })
    // Mesh VPN beats the bridges — reachable from somewhere, unlike docker0.
    expect(ranked[1]).toMatchObject({ address: '100.64.0.7' })
    expect(ranked.at(-1)?.iface).toMatch(/^(docker0|br-|virbr0)/)
    expect(ranked.map((c) => c.address)).not.toContain('127.0.0.1') // internal, skipped
  })

  it('keeps OS order within a rank, so the answer is stable across boots', () => {
    const ranked = lanIPv4Candidates({
      eth0: [iface('192.168.1.10')],
      eth1: [iface('192.168.1.11')],
    })
    expect(ranked.map((c) => c.address)).toEqual(['192.168.1.10', '192.168.1.11'])
  })

  it('does not mistake a hypervisor bridge (br0) for a Docker one (br-…)', () => {
    const ranked = lanIPv4Candidates({
      'br-9f2a1c': [iface('172.19.0.1')],
      br0: [iface('192.168.1.5')],
    })
    expect(ranked[0]).toMatchObject({ address: '192.168.1.5', iface: 'br0' })
  })

  it('ranks a self-assigned 169.254 address below a routable one', () => {
    const ranked = lanIPv4Candidates({
      eth0: [iface('169.254.7.7')],
      eth1: [iface('203.0.113.9')],
    })
    expect(ranked[0]).toMatchObject({ address: '203.0.113.9' })
  })

  it('ignores IPv6 (the pairing URL and cert SANs are IPv4 here)', () => {
    const ranked = lanIPv4Candidates({ eth0: [iface('fd7a:115c::1', { v6: true })] })
    expect(ranked).toEqual([])
  })
})

describe('cert coverage warning', () => {
  it('spots the address a reused cert does not cover', async () => {
    const { certPem } = await ensureSelfSignedCert(tempTlsDir(), ['10.0.0.7', 'relay.lan'])
    expect(certCoversHost(certPem, '10.0.0.7')).toBe(true)
    expect(certCoversHost(certPem, 'relay.lan')).toBe(true)
    expect(certCoversHost(certPem, '127.0.0.1')).toBe(true)
    // The machine moved to an address minted before it existed.
    expect(certCoversHost(certPem, '10.9.9.9')).toBe(false)
    expect(certCoversHost(certPem, 'elsewhere.lan')).toBe(false)
  })

  it('never warns about IPv6 literals, which it cannot compare reliably', async () => {
    const { certPem } = await ensureSelfSignedCert(tempTlsDir())
    expect(certCoversHost(certPem, 'fd7a:115c:a1e0::a039:622b')).toBe(true)
    expect(certCoversHost(certPem, '[fd7a:115c::1]')).toBe(true)
  })

  it('reports whether the cert was minted this boot or reused', async () => {
    const dir = tempTlsDir()
    expect((await ensureSelfSignedCert(dir)).generated).toBe(true)
    expect((await ensureSelfSignedCert(dir)).generated).toBe(false)
  })
})

describe('pairing payload fingerprint (P-3)', () => {
  let server: TestServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('carries certFingerprint when the relay serves a self-signed cert', async () => {
    server = await startTestServer({ certFingerprint: 'test-spki-pin' })
    const a = await register(server.baseUrl)
    const res = await http.post<CreatePairingResponse>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      a.token,
    )
    expect(res.status).toBe(201)
    expect(res.body.link).toContain('&fp=test-spki-pin')
  })

  it('omits certFingerprint on a plain-HTTP relay', async () => {
    server = await startTestServer()
    const a = await register(server.baseUrl)
    const res = await http.post<CreatePairingResponse>(
      server.baseUrl,
      '/v1/pairing',
      undefined,
      a.token,
    )
    expect(res.status).toBe(201)
    expect(res.body.link).not.toContain('&fp=')
  })
})

describe('https relay end to end (P-3)', () => {
  it('serves /v1/config over TLS, and the served cert matches the SPKI pin', async () => {
    const { keyPem, certPem } = await ensureSelfSignedCert(tempTlsDir())
    const fingerprint = spkiFingerprint(certPem)

    const db = createDatabase('sqlite::memory:')
    await migrate(db)
    const relayId = await ensureRelayId(db)
    const config = loadConfig({ DATABASE_URL: 'sqlite::memory:', TLS_SELF_SIGNED: '1' })
    config.rateLimit = { max: 0, windowMs: 600_000 }
    const app = await buildApp({
      db,
      config,
      relayId,
      https: { key: keyPem, cert: certPem },
      certFingerprint: fingerprint,
      push: new FakePushSender(),
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const { port } = app.server.address() as AddressInfo

    try {
      const result = await new Promise<{ status: number; body: string; peerSpkiPin: string }>(
        (resolve, reject) => {
          const req = https.request(
            {
              host: '127.0.0.1',
              port,
              path: '/v1/config',
              // Self-signed by design; the PIN below is the trust check.
              rejectUnauthorized: false,
            },
            (res) => {
              const socket = res.socket as import('node:tls').TLSSocket
              const peerDer = socket.getPeerCertificate().raw
              const spki = new X509Certificate(peerDer).publicKey.export({
                type: 'spki',
                format: 'der',
              })
              const peerSpkiPin = createHash('sha256').update(spki).digest('base64url')
              let body = ''
              res.on('data', (chunk) => {
                body += chunk
              })
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body, peerSpkiPin }))
            },
          )
          req.on('error', reject)
          req.end()
        },
      )

      expect(result.status).toBe(200)
      expect(JSON.parse(result.body).relayId).toBe(relayId)
      // The pin a client would compute from the LIVE handshake equals the one
      // the pairing payload advertises — the whole point of the scheme.
      expect(result.peerSpkiPin).toBe(fingerprint)
    } finally {
      await app.close()
      await db.destroy()
    }
  })
})
