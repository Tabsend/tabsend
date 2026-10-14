import type {
  Endpoint,
  EndpointId,
  GroupKeyRecord,
  HistoryRecord,
  IsoTimestamp,
} from '@tabsend/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { groupHistoryRow, makeEndpoint, makeGroupKey, sealedGroupBlob } from './fixtures'
import { changedRows, deliveryState, mergeTimeline, projectGroupRow } from './history'
import type { HistoryDelivery, HistoryEntry } from './model'

const NOW = Date.parse('2026-08-05T12:00:00.000Z')
const iso = (at: number): IsoTimestamp => new Date(at).toISOString() as IsoTimestamp

let key: GroupKeyRecord

beforeAll(async () => {
  key = await makeGroupKey('2026-08-01T00:00:00.000Z')
})

function endpoints(): Endpoint[] {
  return [
    makeEndpoint({ id: 'sender-1' as EndpointId, label: 'Chrome · Work' }),
    makeEndpoint({ id: 'target-1' as EndpointId, label: 'Pixel · Phone', kind: 'mobile' }),
  ]
}

function record(over: Partial<HistoryRecord['payload']> = {}): HistoryRecord {
  return {
    payload: {
      url: 'https://example.com/article',
      title: 'An Article',
      sentAt: iso(NOW - 60_000),
      ...over,
    },
    sourceLabelAtSend: 'Chrome · Work',
    targetLabelAtSend: 'Pixel · Phone',
  }
}

describe('what became of a transfer', () => {
  const delivery = (over: Partial<HistoryDelivery> = {}): HistoryDelivery => ({
    createdAt: iso(NOW - 60_000),
    expiresAt: iso(NOW + 60_000),
    deliveredAt: null,
    ackedAt: null,
    ...over,
  })

  it('is arrived once the target confirmed it', () => {
    expect(deliveryState(delivery({ ackedAt: iso(NOW - 1000) }), NOW)).toBe('arrived')
  })

  it('is still waiting while the relay is holding it', () => {
    expect(deliveryState(delivery({ deliveredAt: iso(NOW - 1000) }), NOW)).toBe('waiting')
  })

  it('is never-arrived once it expired unacked, which is a settled fact', () => {
    expect(deliveryState(delivery({ expiresAt: iso(NOW - 1) }), NOW)).toBe('never-arrived')
  })

  it('counts an ack even past expiry, because the ack is the proof', () => {
    const state = deliveryState(delivery({ expiresAt: iso(NOW - 1), ackedAt: iso(NOW - 2) }), NOW)
    expect(state).toBe('arrived')
  })

  it('does not treat a hand-over as an arrival [ADR-0008]', () => {
    expect(deliveryState(delivery({ deliveredAt: iso(NOW - 1000) }), NOW)).not.toBe('arrived')
  })
})

describe('projecting a group history row', () => {
  it('opens the blob when we hold the key it names', async () => {
    const row = groupHistoryRow({
      blob: await sealedGroupBlob(record(), key),
      ackedAt: iso(NOW - 30_000),
    })
    const entry = await projectGroupRow(row, [key], endpoints(), NOW)

    expect(entry.url).toBe('https://example.com/article')
    expect(entry.title).toBe('An Article')
    expect(entry.sourceLabelAtSend).toBe('Chrome · Work')
    expect(entry.targetLabelAtSend).toBe('Pixel · Phone')
    expect(entry.sentAt).toBe(record().payload.sentAt)
    expect(entry.delivery?.ackedAt).toBe(iso(NOW - 30_000))
  })

  it('keeps a row we hold no key for, as metadata only', async () => {
    // A transfer this console cannot read still happened, and the panel's job is
    // to say so rather than to hide it.
    const row = groupHistoryRow({ blob: await sealedGroupBlob(record(), key) })
    const entry = await projectGroupRow(row, [], endpoints(), NOW)

    expect(entry.url).toBeUndefined()
    expect(entry.title).toBeUndefined()
    expect(entry.delivery).toBeDefined()
    expect(entry.sentAt).toBe(row.createdAt) // the relay's own fact, honestly labelled
    expect(entry.sourceLabelAtSend).toBe('Chrome · Work') // from the live list
  })

  it('names an endpoint that left the group rather than rendering blank', async () => {
    const row = groupHistoryRow({ blob: await sealedGroupBlob(record(), key) })
    const entry = await projectGroupRow(row, [], [], NOW)
    expect(entry.targetLabelAtSend).toBe('Unknown device')
  })

  it('falls back to metadata when the blob will not open under the named key', async () => {
    const other = await makeGroupKey('2026-08-02T00:00:00.000Z')
    const blob = await sealedGroupBlob(record(), other)
    // Same id, wrong secret: the ring answers the lookup and the open still fails.
    const row = groupHistoryRow({ blob: { ...blob, keyId: key.keyId } })
    const entry = await projectGroupRow(row, [key], endpoints(), NOW)

    expect(entry.url).toBeUndefined()
    expect(entry.delivery).toBeDefined()
  })

  it('carries a batch through, so a multi-tab send still reads as one send', async () => {
    const row = groupHistoryRow({
      blob: await sealedGroupBlob(record({ batch: { id: 'batch-1', count: 3 } }), key),
    })
    const entry = await projectGroupRow(row, [key], endpoints(), NOW)
    expect(entry.batch).toEqual({ id: 'batch-1', count: 3 })
  })
})

describe('deciding what to write to the local cache', () => {
  const row = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    id: 'm1',
    sourceEndpointId: 'sender-1',
    targetEndpointId: 'target-1',
    url: 'https://example.com',
    sentAt: iso(NOW - 60_000),
    recordedAt: iso(NOW),
    sourceLabelAtSend: 'Chrome',
    targetLabelAtSend: 'Pixel',
    delivery: {
      createdAt: iso(NOW - 60_000),
      expiresAt: iso(NOW + 60_000),
      deliveredAt: null,
      ackedAt: null,
    },
    ...over,
  })

  it('writes a row it has never seen', () => {
    expect(changedRows([], [row()])).toHaveLength(1)
  })

  it('writes nothing when the relay repeats what we already hold', () => {
    expect(changedRows([row()], [row()])).toHaveLength(0)
  })

  it('writes a row whose delivery state moved', () => {
    const acked = row({
      delivery: { ...row().delivery!, ackedAt: iso(NOW) },
    })
    expect(changedRows([row()], [acked])).toHaveLength(1)
  })

  it('writes a row we can suddenly read, which is what a late key looks like', () => {
    const sealed = row({ url: undefined })
    expect(changedRows([sealed], [row()])).toHaveLength(1)
  })
})

describe('merging the two mechanisms into one timeline', () => {
  const copy: HistoryEntry = {
    id: 'copy-1',
    sourceEndpointId: 'sender-1',
    targetEndpointId: 'target-1',
    url: 'https://example.com/article',
    sentAt: iso(NOW - 60_000),
    recordedAt: iso(NOW),
    sourceLabelAtSend: 'Chrome · Work',
    targetLabelAtSend: 'Pixel · Phone',
  }
  const groupRow: HistoryEntry = {
    ...copy,
    id: 'send-1', // the real send's id; a copy is its own message with its own id
    delivery: {
      createdAt: iso(NOW - 60_000),
      expiresAt: iso(NOW + 60_000),
      deliveredAt: null,
      ackedAt: iso(NOW - 30_000),
    },
  }

  it('drops the ADR-0010 copy when group history covers the same send', () => {
    const merged = mergeTimeline([groupRow, copy])
    expect(merged.map((e) => e.id)).toEqual(['send-1'])
  })

  it('keeps a copy of a send group history does not cover', () => {
    // An older relay, or a send that aged out of the retention window: the copy
    // is then the only record of it this console has.
    const merged = mergeTimeline([copy])
    expect(merged.map((e) => e.id)).toEqual(['copy-1'])
  })

  it('keeps a copy whose send went somewhere else', () => {
    const elsewhere = { ...copy, id: 'copy-2', targetEndpointId: 'target-2' }
    expect(mergeTimeline([groupRow, elsewhere]).map((e) => e.id)).toEqual(['send-1', 'copy-2'])
  })

  it('never drops a group row', () => {
    const sealed = { ...groupRow, id: 'send-2', url: undefined }
    expect(mergeTimeline([groupRow, sealed])).toHaveLength(2)
  })
})
