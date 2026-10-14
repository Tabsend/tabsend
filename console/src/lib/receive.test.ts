import type { EndpointId, IsoTimestamp, Message, SendPayload } from '@tabsend/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, type KeyPairB64, keyId } from './crypto'
import { makeEndpoint, sealedMessage } from './fixtures'
import type { ConsoleSession } from './model'
import { InMemoryHistoryStore } from './persist'
import { type ConsumeSources, consumePending, projectEntry } from './receive'

let consoleKp: KeyPairB64
let senderKp: KeyPairB64
let session: ConsoleSession

beforeAll(async () => {
  consoleKp = await generateKeyPair()
  senderKp = await generateKeyPair()
  session = {
    relayUrl: '',
    endpointId: 'console-1',
    groupId: 'group-1',
    deviceToken: 'tok',
    label: 'Web console',
    publicKey: consoleKp.publicKey,
    privateKey: consoleKp.privateKey,
    keyId: await keyId(consoleKp.publicKey),
  }
})

function group() {
  return [
    makeEndpoint({
      id: 'sender-1' as EndpointId,
      label: 'Chrome · Work',
      e2ePubkey: senderKp.publicKey,
    }),
    makeEndpoint({ id: 'target-1' as EndpointId, label: 'Pixel · Phone', kind: 'mobile' }),
    makeEndpoint({
      id: 'console-1' as EndpointId,
      label: 'Web console',
      kind: 'console',
      e2ePubkey: consoleKp.publicKey,
    }),
  ]
}

function sources(
  endpoints: ReturnType<typeof group>,
  pending: Message[],
  acked: string[],
): ConsumeSources {
  return {
    listEndpoints: async () => endpoints,
    getPending: async () => pending,
    ack: async (id) => {
      acked.push(id)
    },
  }
}

const payload: SendPayload = {
  url: 'https://example.com/article',
  title: 'An Article',
  sentAt: new Date().toISOString() as IsoTimestamp,
  historyOf: { targetEndpointId: 'target-1' as EndpointId },
}

describe('consumePending — history recording', () => {
  it('records a decrypted copy, acks it, and stores the right fields', async () => {
    const store = new InMemoryHistoryStore()
    const endpoints = group()
    const msg = await sealedMessage({
      id: 'm1',
      sourceEndpointId: 'sender-1',
      targetPubkeyB64: consoleKp.publicKey,
      senderPrivkeyB64: senderKp.privateKey,
      senderPubkeyB64: senderKp.publicKey,
      payload,
    })
    const acked: string[] = []

    const summary = await consumePending({
      sources: sources(endpoints, [msg], acked),
      session,
      store,
    })

    expect(summary.recorded).toBe(1)
    expect(summary.acked).toBe(1)
    expect(acked).toEqual(['m1'])

    const entry = (await store.list())[0]!
    expect(entry.url).toBe('https://example.com/article')
    expect(entry.title).toBe('An Article')
    expect(entry.sourceEndpointId).toBe('sender-1')
    expect(entry.targetEndpointId).toBe('target-1')
    expect(entry.sourceLabelAtSend).toBe('Chrome · Work')
    expect(entry.targetLabelAtSend).toBe('Pixel · Phone')
  })

  it('is idempotent — a re-pull of an already-recorded copy re-acks but does not duplicate', async () => {
    const store = new InMemoryHistoryStore()
    const endpoints = group()
    const msg = await sealedMessage({
      id: 'm2',
      sourceEndpointId: 'sender-1',
      targetPubkeyB64: consoleKp.publicKey,
      senderPrivkeyB64: senderKp.privateKey,
      senderPubkeyB64: senderKp.publicKey,
      payload,
    })
    const acked: string[] = []
    await consumePending({ sources: sources(endpoints, [msg], acked), session, store })
    const second = await consumePending({
      sources: sources(endpoints, [msg], acked),
      session,
      store,
    })

    expect(second.recorded).toBe(0)
    expect(second.acked).toBe(1) // re-acked to clear the server copy
    expect((await store.list()).length).toBe(1)
  })

  it('refuses an unknown sender (blocks relay injection) — not recorded, not acked', async () => {
    const store = new InMemoryHistoryStore()
    const endpoints = group()
    const msg = await sealedMessage({
      id: 'm3',
      sourceEndpointId: 'sender-1',
      targetPubkeyB64: consoleKp.publicKey,
      senderPrivkeyB64: senderKp.privateKey,
      senderPubkeyB64: senderKp.publicKey,
      payload,
      senderKeyIdOverride: 'not-a-known-key',
    })
    const acked: string[] = []
    const summary = await consumePending({
      sources: sources(endpoints, [msg], acked),
      session,
      store,
    })

    expect(summary.recorded).toBe(0)
    expect(acked).toEqual([]) // left queued, never acked
    expect((await store.list()).length).toBe(0)
  })

  it('drops a forged copy that fails authentication', async () => {
    const store = new InMemoryHistoryStore()
    const endpoints = group()
    const impostor = await generateKeyPair()
    // Claim to be sender-1 (valid keyId) but authenticate with the impostor's key.
    const msg = await sealedMessage({
      id: 'm4',
      sourceEndpointId: 'sender-1',
      targetPubkeyB64: consoleKp.publicKey,
      senderPrivkeyB64: impostor.privateKey,
      senderPubkeyB64: senderKp.publicKey, // keyId points at the real sender → passes index lookup
      payload,
    })
    const acked: string[] = []
    const summary = await consumePending({
      sources: sources(endpoints, [msg], acked),
      session,
      store,
    })

    expect(summary.recorded).toBe(0)
    expect((await store.list()).length).toBe(0)
  })

  it('does nothing on an empty pending list', async () => {
    const store = new InMemoryHistoryStore()
    const summary = await consumePending({ sources: sources(group(), [], []), session, store })
    expect(summary).toMatchObject({ recorded: 0, acked: 0 })
  })
})

describe('projectEntry', () => {
  it('falls back to the console itself when historyOf is absent', () => {
    const endpoints = group()
    const direct: SendPayload = {
      url: 'https://x.test',
      sentAt: new Date().toISOString() as IsoTimestamp,
    }
    const msg = {
      id: 'd1',
      sourceEndpointId: 'sender-1',
      targetEndpointId: 'console-1',
    } as unknown as Message
    const entry = projectEntry(msg, direct, endpoints, session, Date.now())
    expect(entry.targetEndpointId).toBe('console-1')
    expect(entry.targetLabelAtSend).toBe('Web console')
  })
})
