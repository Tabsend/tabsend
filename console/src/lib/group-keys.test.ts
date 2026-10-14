import type { Endpoint, EndpointId, GroupKeyDelivery, GroupKeyRecord } from '@tabsend/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, groupKeyId, type KeyPairB64, keyId } from './crypto'
import { makeEndpoint, makeGroupKey, sealedKeyDelivery } from './fixtures'
import { type GroupKeySources, syncGroupKeys } from './group-keys'
import type { ConsoleSession } from './model'

let consoleKp: KeyPairB64
let senderKp: KeyPairB64
let session: ConsoleSession
let groupKey: GroupKeyRecord

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
  groupKey = await makeGroupKey('2026-08-05T10:00:00.000Z')
})

function group(): Endpoint[] {
  return [
    makeEndpoint({
      id: 'sender-1' as EndpointId,
      label: 'Chrome · Work',
      e2ePubkey: senderKp.publicKey,
    }),
    makeEndpoint({
      id: 'console-1' as EndpointId,
      label: 'Web console',
      kind: 'console',
      e2ePubkey: consoleKp.publicKey,
    }),
  ]
}

function sources(endpoints: Endpoint[], deliveries: GroupKeyDelivery[]): GroupKeySources {
  return {
    listEndpoints: async () => endpoints,
    getGroupKeys: async () => deliveries,
  }
}

function delivery(over: Partial<Parameters<typeof sealedKeyDelivery>[0]> = {}) {
  return sealedKeyDelivery({
    sourceEndpointId: 'sender-1',
    record: groupKey,
    targetPubkeyB64: consoleKp.publicKey,
    senderPrivkeyB64: senderKp.privateKey,
    senderPubkeyB64: senderKp.publicKey,
    ...over,
  })
}

describe('collecting the group history key', () => {
  it('opens a copy sealed by a group member and folds it into the ring', async () => {
    const result = await syncGroupKeys({
      sources: sources(group(), [await delivery()]),
      session,
      ring: [],
    })

    expect(result.added).toBe(1)
    expect(result.ring[0]!.keyId).toBe(groupKey.keyId)
    expect(result.ring[0]!.key).toBe(groupKey.key)
    expect(result.awaitingFirstKey).toBe(false)
  })

  it('refuses a copy whose sender is not a current group endpoint (relay injection)', async () => {
    // The relay could otherwise mint a key of its own and then serve history
    // blobs sealed under it, which is the link-injection ADR-0009 blocks for tabs.
    const result = await syncGroupKeys({
      sources: sources(group(), [await delivery({ senderKeyIdOverride: 'not-a-member' })]),
      session,
      ring: [],
    })

    expect(result.ring).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('drops a copy that fails authentication', async () => {
    const impostor = await generateKeyPair()
    const result = await syncGroupKeys({
      // Claims to be sender-1 (a real keyId) but is authenticated by someone else.
      sources: sources(group(), [await delivery({ senderPrivkeyB64: impostor.privateKey })]),
      session,
      ring: [],
    })

    expect(result.ring).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('drops a record whose keyId does not fingerprint its key', async () => {
    // Indexing that would answer a blob's lookup with the wrong secret, and the
    // console would report a key it holds as one it does not.
    const lying = { ...groupKey, keyId: 'someone-elses-fingerprint' } as GroupKeyRecord
    const result = await syncGroupKeys({
      sources: sources(group(), [await delivery({ record: lying })]),
      session,
      ring: [],
    })

    expect(result.ring).toHaveLength(0)
    expect(result.skipped).toBe(1)
  })

  it('is idempotent, because the relay never consumes a copy on read', async () => {
    const copies = [await delivery(), await delivery()]
    const first = await syncGroupKeys({ sources: sources(group(), copies), session, ring: [] })
    const second = await syncGroupKeys({
      sources: sources(group(), copies),
      session,
      ring: first.ring,
    })

    expect(first.ring).toHaveLength(1)
    expect(second.added).toBe(0)
    expect(second.ring).toHaveLength(1)
  })

  it('keeps a rotated-away key alongside the new one, so old history stays readable', async () => {
    const older = await makeGroupKey('2026-07-01T00:00:00.000Z')
    const result = await syncGroupKeys({
      sources: sources(group(), [await delivery(), await delivery({ record: older })]),
      session,
      ring: [],
    })

    expect(result.ring.map((k) => k.keyId)).toEqual([groupKey.keyId, older.keyId])
  })

  it('refreshes the endpoint list once when a copy names a sender it has not seen', async () => {
    // The normal case right after a device joins and immediately hands out the key.
    let calls = 0
    const stale: Endpoint[] = [
      makeEndpoint({ id: 'console-1' as EndpointId, e2ePubkey: consoleKp.publicKey }),
    ]
    const result = await syncGroupKeys({
      sources: {
        listEndpoints: async () => {
          calls += 1
          return group()
        },
        getGroupKeys: async () => [await delivery()],
      },
      session,
      ring: [],
      endpoints: stale,
    })

    expect(calls).toBe(1)
    expect(result.added).toBe(1)
  })

  it('reports an empty ring as waiting, never as something to fix by minting', async () => {
    const result = await syncGroupKeys({ sources: sources(group(), []), session, ring: [] })

    expect(result.ring).toHaveLength(0)
    expect(result.awaitingFirstKey).toBe(true)
  })
})

describe('the date on a received key (review 2026-10-13)', () => {
  for (const createdAt of [
    'Wed, 31 Dec 9999 00:00:00 GMT',
    '9999-12-31T23:59:59.999Z',
    '2026-08-05T10:00:00Z',
  ]) {
    it(`refuses ${createdAt}: it could stay current past every rotation`, async () => {
      const record = { ...groupKey, createdAt } as GroupKeyRecord
      const result = await syncGroupKeys({
        sources: sources(group(), [await delivery({ record })]),
        session,
        ring: [],
      })
      expect(result.added).toBe(0)
      expect(result.skipped).toBe(1)
    })
  }
})

describe('the key itself (review 2026-10-13)', () => {
  it('refuses a key that is not 32 bytes, even when its keyId matches', async () => {
    const key = 'AAAA'
    const record = { key, keyId: await groupKeyId(key), createdAt: groupKey.createdAt }
    const result = await syncGroupKeys({
      sources: sources(group(), [await delivery({ record: record as GroupKeyRecord })]),
      session,
      ring: [],
    })
    expect(result.added).toBe(0)
  })
})
