import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EndpointId, IsoTimestamp, RegisterResponse, SendPayload } from '@tabsend/shared'
import sodium from 'libsodium-wrappers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ApiOptions,
  ackMessage,
  getPending,
  listEndpoints,
  mintPairing,
  register,
} from '../src/lib/api'
import { generateKeyPair, type KeyPairB64, keyId } from '../src/lib/crypto'
import type { ConsoleSession } from '../src/lib/model'
import { InMemoryHistoryStore } from '../src/lib/persist'
import { type ConsumeSources, consumePending } from '../src/lib/receive'

/**
 * Live end-to-end slice (NOT part of `pnpm test`). Boots the REAL chunk-2/4 relay
 * (server/src/server.ts via tsx) on an ephemeral port with a throwaway SQLite db —
 * never the owner's :8787 relay — then:
 *   1. an "extension" creates the group and a "phone" target joins it,
 *   2. this CONSOLE pairs in as a kind:'console' endpoint (real register),
 *   3. the extension seals a history COPY to the console (real crypto_box),
 *   4. the console runs its real consumption path (fetch → verify → open → record → ack),
 *   5. we assert the decrypted entry, that the console is a first-class group endpoint
 *      marked kind:'console' (so the extension excludes it from choosers), and that the
 *      ack deleted the server payload.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

interface Relay {
  url: string
  stop(): Promise<void>
}

function secretFromPairingLink(link: string): string {
  const secret = new URLSearchParams(new URL(link).hash.slice(1)).get('c')
  if (!secret) throw new Error('Relay returned a pairing link without a secret')
  return secret
}

async function startRelay(): Promise<Relay> {
  const dir = mkdtempSync(join(tmpdir(), 'tabsend-console-live-'))
  const port = await freePort()
  const serverDir = join(REPO_ROOT, 'server')
  const tsxBin = join(serverDir, 'node_modules', '.bin', 'tsx')
  const url = `http://127.0.0.1:${port}`

  const child: ChildProcess = spawn(tsxBin, ['src/server.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: `sqlite:${join(dir, 'live.db')}`,
      PUBLIC_RELAY_URL: url,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (c: Buffer) => process.stderr.write(`[relay] ${c}`))

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`relay exited early (${child.exitCode})`)
    try {
      await fetch(`${url}/v1/config`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  return {
    url,
    async stop() {
      child.kill('SIGTERM')
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          res()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(t)
          res()
        })
      })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') srv.close(() => res(addr.port))
      else rej(new Error('no port'))
    })
  })
}

let relay: Relay
let opts: ApiOptions
let extKp: KeyPairB64

beforeAll(async () => {
  await sodium.ready
  relay = await startRelay()
  opts = { relayUrl: relay.url }
  extKp = await generateKeyPair()
}, 40_000)

afterAll(async () => {
  await relay?.stop()
})

async function registerExtension(
  label: string,
  kp: KeyPairB64,
  pairingCode?: string,
): Promise<RegisterResponse> {
  return register(opts, {
    label,
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    pushSubscription: { transport: 'unifiedpush', endpoint: 'https://push.invalid/ext' },
    e2ePubkey: kp.publicKey,
    ...(pairingCode ? { pairingCode: pairingCode as never } : {}),
  })
}

describe('console live e2e', () => {
  it('pairs in, records a sealed history copy, and honours the contract', async () => {
    // 1. Extension creates the group.
    const ext = await registerExtension('Chrome · Work', extKp)

    // 2. A phone target joins (so historyOf points at a real endpoint).
    const phoneKp = await generateKeyPair()
    const phoneCode = secretFromPairingLink((await mintPairing(opts, ext.deviceToken)).link)
    const phone = await registerExtension('Pixel · Phone', phoneKp, phoneCode)

    // 3. This console pairs in as kind:'console'.
    const consoleKp = await generateKeyPair()
    const consoleCode = secretFromPairingLink((await mintPairing(opts, ext.deviceToken)).link)
    const consoleReg = await register(opts, {
      label: 'Web console',
      kind: 'console',
      browser: null,
      platform: 'macos',
      pushSubscription: { transport: 'unifiedpush', endpoint: 'https://push.invalid/console' },
      e2ePubkey: consoleKp.publicKey,
      pairingCode: consoleCode as never,
    })

    const session: ConsoleSession = {
      relayUrl: relay.url,
      endpointId: consoleReg.endpointId,
      groupId: consoleReg.groupId,
      deviceToken: consoleReg.deviceToken,
      label: 'Web console',
      publicKey: consoleKp.publicKey,
      privateKey: consoleKp.privateKey,
      keyId: await keyId(consoleKp.publicKey),
    }

    // The console renders the whole group list; the console endpoint is present and
    // marked kind:'console' — the exact handle the extension uses to exclude it from
    // send choosers (verified against the extension at extension/src/background/endpoints.ts).
    const listed = await listEndpoints(opts, consoleReg.deviceToken)
    const consoleRow = listed.find((e) => e.id === consoleReg.endpointId)
    expect(consoleRow?.kind).toBe('console')
    expect(listed.map((e) => e.id).sort()).toEqual(
      [ext.endpointId, phone.endpointId, consoleReg.endpointId].sort(),
    )

    // 4. The extension seals a history COPY to the console (real crypto_box on the wire).
    const payload: SendPayload = {
      url: 'https://example.com/read-later',
      title: 'Read me later',
      sentAt: new Date().toISOString() as IsoTimestamp,
      historyOf: { targetEndpointId: phone.endpointId as EndpointId },
    }
    await sealAndSend(ext.deviceToken, extKp, consoleReg.endpointId, consoleKp.publicKey, payload)

    // 5. The console consumes its pending copies through the real lib stack.
    const store = new InMemoryHistoryStore()
    const sources: ConsumeSources = {
      listEndpoints: () => listEndpoints(opts, session.deviceToken),
      getPending: () => getPending(opts, session.deviceToken),
      ack: (id) => ackMessage(opts, session.deviceToken, id).then(() => undefined),
    }
    const summary = await consumePending({ sources, session, store })

    expect(summary.recorded).toBe(1)
    expect(summary.acked).toBe(1)

    const entry = (await store.list())[0]!
    expect(entry.url).toBe('https://example.com/read-later')
    expect(entry.title).toBe('Read me later')
    expect(entry.sourceLabelAtSend).toBe('Chrome · Work')
    expect(entry.targetLabelAtSend).toBe('Pixel · Phone')

    // 6. The ack deleted the server payload — a re-pull yields nothing.
    expect(await getPending(opts, session.deviceToken)).toEqual([])
  })
})

/** Seal a payload to the console and POST it as the extension would a history copy. */
async function sealAndSend(
  senderToken: string,
  senderKp: KeyPairB64,
  consoleEndpointId: string,
  consolePubkey: string,
  payload: SendPayload,
): Promise<void> {
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES)
  const ciphertext = sodium.crypto_box_easy(
    sodium.from_string(JSON.stringify(payload)),
    nonce,
    sodium.from_base64(consolePubkey, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(senderKp.privateKey, sodium.base64_variants.ORIGINAL),
  )
  const res = await fetch(`${relay.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${senderToken}` },
    body: JSON.stringify({
      items: [
        {
          id: crypto.randomUUID(),
          targetEndpointId: consoleEndpointId,
          envelope: {
            alg: 'x25519-xsalsa20-poly1305/box',
            senderKeyId: await keyId(senderKp.publicKey),
            targetKeyId: await keyId(consolePubkey),
            nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
            ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
          },
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`)
}
