import type { Endpoint, HistoryEntry, HistoryRecord, SendPayload } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import {
  batchHeading,
  deriveState,
  directionOf,
  groupHistory,
  groupState,
  HISTORY_MAX,
  hostOf,
  labelIndex,
  mergeHistory,
  projectItem,
  projectRow,
  recordItem,
} from './history'
import type { HistoryRow, InboxItem } from './model'

const NOW = Date.parse('2026-08-05T12:00:00.000Z')

function payload(url: string, extra: Partial<SendPayload> = {}): SendPayload {
  return {
    url,
    sentAt: '2026-08-05T10:00:00.000Z',
    ...extra,
  } as SendPayload
}

function item(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    url: `https://example.com/${id}`,
    sourceLabel: 'Chrome · Work',
    sentAt: '2026-08-05T10:00:00.000Z',
    receivedAt: 1000,
    ...extra,
  }
}

function entry(id: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    sourceEndpointId: 'self',
    targetEndpointId: 'phone',
    createdAt: '2026-08-05T10:00:00.000Z',
    expiresAt: '2026-08-12T10:00:00.000Z',
    deliveredAt: null,
    ackedAt: null,
    blob: { alg: 'xsalsa20-poly1305/secretbox', keyId: 'k1', nonce: 'n', ciphertext: 'c' },
    ...extra,
  } as HistoryEntry
}

function record(extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    payload: payload('https://example.com/a', { title: 'Roadmap' }),
    sourceLabelAtSend: 'Chrome · Work',
    targetLabelAtSend: 'Pixel · Phone',
    ...extra,
  } as HistoryRecord
}

function row(id: string, extra: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id,
    direction: 'sent',
    state: 'arrived',
    sourceEndpointId: 'self',
    targetEndpointId: 'phone',
    sourceLabel: 'Chrome · Work',
    targetLabel: 'Pixel · Phone',
    sentAt: '2026-08-05T10:00:00.000Z',
    sortAt: '2026-08-05T10:00:00.000Z',
    url: `https://example.com/${id}`,
    ...extra,
  }
}

/** Record a whole batch the way the deliver loop does: one item at a time, in order. */
function recordAll(start: InboxItem[], items: InboxItem[]): InboxItem[] {
  return items.reduce((acc, i) => recordItem(acc, i), start)
}

describe('projectItem', () => {
  it('snapshots the sender label rather than an endpoint id', () => {
    const result = projectItem('m1', payload('https://a.test/'), 'Firefox · Laptop', 5)
    expect(result.sourceLabel).toBe('Firefox · Laptop')
    expect(result.receivedAt).toBe(5)
    expect(result.sentAt).toBe('2026-08-05T10:00:00.000Z')
  })

  it('omits optional fields the payload did not carry', () => {
    const result = projectItem('m1', payload('https://a.test/'), 'Chrome', 5)
    expect('title' in result).toBe(false)
    expect('favicon' in result).toBe(false)
    expect('batch' in result).toBe(false)
  })

  it('carries title, favicon and batch through when present', () => {
    const result = projectItem(
      'm1',
      payload('https://a.test/', {
        title: 'Roadmap',
        favicon: 'https://a.test/i.png',
        batch: { id: 'b1', count: 3 },
      }),
      'Chrome',
      5,
    )
    expect(result.title).toBe('Roadmap')
    expect(result.favicon).toBe('https://a.test/i.png')
    expect(result.batch).toEqual({ id: 'b1', count: 3 })
  })
})

describe('recordItem', () => {
  it('puts the newest arrival first', () => {
    const list = recordAll([], [item('a'), item('b')])
    expect(list.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('is idempotent on the message id', () => {
    const once = recordItem([], item('a'))
    const twice = recordItem(once, item('a'))
    expect(twice).toBe(once)
  })

  it('keeps the ORIGINAL arrival time on a re-delivery', () => {
    const first = [item('a', { receivedAt: 42 })]
    const again = recordItem(first, item('a', { receivedAt: 9999 }))
    expect(again[0]?.receivedAt).toBe(42)
  })

  it('drops the oldest past the cap', () => {
    const many = Array.from({ length: HISTORY_MAX + 10 }, (_, n) => item(`m${n}`))
    const list = recordAll([], many)
    expect(list).toHaveLength(HISTORY_MAX)
    expect(list[0]?.id).toBe(`m${HISTORY_MAX + 9}`)
    expect(list.some((i) => i.id === 'm0')).toBe(false)
  })
})

describe('deriveState', () => {
  it('calls an acked message arrived, even long past its expiry', () => {
    const state = deriveState(
      { ackedAt: '2026-08-05T10:00:01.000Z', expiresAt: '2026-08-05T10:00:00.000Z' },
      NOW,
    )
    expect(state).toBe('arrived')
  })

  it('is waiting while the relay still holds it for a sleeping target', () => {
    expect(deriveState({ ackedAt: null, expiresAt: '2026-08-12T10:00:00.000Z' }, NOW)).toBe(
      'waiting',
    )
  })

  it('is never-arrived once the TTL runs out with nobody acking', () => {
    // The failure ADR-0028 exists to make visible: every surface said "Sent",
    // because the relay did accept it.
    expect(deriveState({ ackedAt: null, expiresAt: '2026-08-05T11:59:59.000Z' }, NOW)).toBe(
      'never-arrived',
    )
  })
})

describe('directionOf', () => {
  it('names the two ends this browser is part of', () => {
    expect(directionOf('self', 'phone', 'self')).toBe('sent')
    expect(directionOf('phone', 'self', 'self')).toBe('received')
  })

  it('marks a transfer between two OTHER devices, which has no preposition', () => {
    expect(directionOf('desk', 'phone', 'self')).toBe('other')
  })
})

describe('projectRow', () => {
  const noLabels = () => undefined

  it('prefers the labels snapshotted at send over the live list', () => {
    const live = labelIndex([
      { id: 'self', label: 'Renamed since', e2ePubkey: 'p' },
      { id: 'phone', label: 'Also renamed', e2ePubkey: 'p' },
    ] as Endpoint[])
    const result = projectRow(entry('m1'), record(), 'self', live, NOW)
    expect(result.sourceLabel).toBe('Chrome · Work')
    expect(result.targetLabel).toBe('Pixel · Phone')
  })

  it('falls back to the live endpoint list for a row it cannot read', () => {
    const live = labelIndex([{ id: 'phone', label: 'Pixel · Phone', e2ePubkey: 'p' }] as Endpoint[])
    const result = projectRow(entry('m1'), undefined, 'self', live, NOW)
    expect(result.targetLabel).toBe('Pixel · Phone')
    // Nothing to look the source up in, and printing a UUID at somebody is worse
    // than admitting we do not know.
    expect(result.sourceLabel).toBe('Unknown device')
  })

  it('keeps an unreadable row as metadata, because it is still a true record', () => {
    const result = projectRow(entry('m1'), undefined, 'self', noLabels, NOW)
    expect(result.id).toBe('m1')
    expect(result.direction).toBe('sent')
    expect(result.url).toBeUndefined()
    // The relay's clock is all that is left to date it by.
    expect(result.sentAt).toBe('2026-08-05T10:00:00.000Z')
  })

  it('carries the payload through when the blob opened', () => {
    const result = projectRow(entry('m1'), record(), 'self', noLabels, NOW)
    expect(result.url).toBe('https://example.com/a')
    expect(result.title).toBe('Roadmap')
    expect('favicon' in result).toBe(false)
  })

  it('orders by the RELAY clock, never the sender stamp', () => {
    // A device with a skewed clock must not reorder the list on every screen.
    const skewed = record({
      payload: payload('https://a.test/', {
        sentAt: '2020-01-01T00:00:00.000Z' as SendPayload['sentAt'],
      }),
    })
    const result = projectRow(entry('m1'), skewed, 'self', noLabels, NOW)
    expect(result.sentAt).toBe('2020-01-01T00:00:00.000Z')
    expect(result.sortAt).toBe('2026-08-05T10:00:00.000Z')
  })
})

describe('mergeHistory', () => {
  it('fills an unreadable row from the copy this browser decrypted itself', () => {
    // The target of a tab always knows what it was, key or no key.
    const metadataOnly = row('m1', { direction: 'received', url: undefined, title: undefined })
    const merged = mergeHistory([metadataOnly], [item('m1', { title: 'Roadmap' })], 'Me', 'self')
    expect(merged[0]?.url).toBe('https://example.com/m1')
    expect(merged[0]?.title).toBe('Roadmap')
  })

  it('leaves a row the relay could already read alone', () => {
    const merged = mergeHistory(
      [row('m1', { title: 'From the blob' })],
      [item('m1', { title: 'From the inbox' })],
      'Me',
      'self',
    )
    expect(merged[0]?.title).toBe('From the blob')
  })

  it('carries a received tab the relay has no history for at all', () => {
    // An older relay, one with HISTORY_RETENTION_DAYS=0, or one that is down.
    const merged = mergeHistory([], [item('m9')], 'Me', 'self')
    expect(merged).toHaveLength(1)
    expect(merged[0]?.direction).toBe('received')
    expect(merged[0]?.state).toBe('arrived')
    expect(merged[0]?.targetLabel).toBe('Me')
    expect(merged[0]?.targetEndpointId).toBe('self')
  })

  it('puts the newest first and caps what this browser keeps', () => {
    const rows = Array.from({ length: HISTORY_MAX + 5 }, (_, n) =>
      row(`m${n}`, { sortAt: `2026-08-${String(n + 1).padStart(2, '0')}T00:00:00.000Z` }),
    )
    const merged = mergeHistory(rows, [], 'Me', 'self')
    expect(merged).toHaveLength(HISTORY_MAX)
    expect(merged[0]?.id).toBe(`m${HISTORY_MAX + 4}`)
  })

  it('breaks a same-instant tie deterministically', () => {
    const one = mergeHistory([row('aaa'), row('bbb')], [], 'Me', 'self')
    const other = mergeHistory([row('bbb'), row('aaa')], [], 'Me', 'self')
    expect(one.map((r) => r.id)).toEqual(other.map((r) => r.id))
  })
})

describe('groupHistory', () => {
  it('passes single sends through as groups of one', () => {
    const groups = groupHistory([row('a'), row('b')])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.batchId).toBeUndefined()
  })

  it('restores the order the sender picked the tabs in', () => {
    const batch = { id: 'b1', count: 3 }
    // Stored newest-first, so the last tab of the batch leads the raw list...
    const list = [row('three', { batch }), row('two', { batch }), row('one', { batch })]
    expect(groupHistory(list)[0]?.rows.map((r) => r.id)).toEqual(['one', 'two', 'three'])
  })

  it('groups a batch split by a later single send between its tabs', () => {
    const batch = { id: 'b1', count: 2 }
    const list = [row('two', { batch }), row('single'), row('one', { batch })]
    const groups = groupHistory(list)
    expect(groups).toHaveLength(2)
    // The group holds the position of its FIRST row in the newest-first list.
    expect(groups[0]?.batchId).toBe('b1')
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(['one', 'two'])
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(['single'])
  })

  it('keeps the same batch sent to two devices as two sends', () => {
    // The payloads carry one batch id, but three tabs to each of two devices is
    // two sends; merging them would claim "3 tabs" over six rows.
    const batch = { id: 'b1', count: 2 }
    const list = [
      row('a', { batch, targetEndpointId: 'phone' }),
      row('b', { batch, targetEndpointId: 'desk' }),
    ]
    expect(groupHistory(list)).toHaveLength(2)
  })

  it('trusts the largest count any tab of the batch carries', () => {
    const list = [
      row('a', { batch: { id: 'b', count: 2 } }),
      row('c', { batch: { id: 'b', count: 5 } }),
    ]
    expect(groupHistory(list)[0]?.sentCount).toBe(5)
  })
})

describe('batchHeading', () => {
  it('says the plain count when every tab is here', () => {
    expect(batchHeading({ batchId: 'b', sentCount: 3, rows: [row('a'), row('b'), row('c')] })).toBe(
      '3 tabs',
    )
  })

  it('admits the gap when the cap or the relay ate one', () => {
    expect(batchHeading({ batchId: 'b', sentCount: 3, rows: [row('a'), row('b')] })).toBe(
      '2 of 3 tabs',
    )
  })

  it('never claims fewer tabs than it is showing', () => {
    expect(batchHeading({ batchId: 'b', sentCount: 1, rows: [row('a'), row('b')] })).toBe('2 tabs')
  })
})

describe('groupState', () => {
  it('lets the worst outcome speak for the block', () => {
    // "3 tabs · arrived" over a batch where one expired unacked is exactly the
    // lie this page removes.
    const rows = [row('a'), row('b', { state: 'never-arrived' }), row('c', { state: 'waiting' })]
    expect(groupState({ batchId: 'b', rows })).toBe('never-arrived')
  })

  it('prefers waiting to arrived', () => {
    expect(groupState({ batchId: 'b', rows: [row('a'), row('b', { state: 'waiting' })] })).toBe(
      'waiting',
    )
  })

  it('is arrived only when every tab of the batch got there', () => {
    expect(groupState({ batchId: 'b', rows: [row('a'), row('b')] })).toBe('arrived')
  })
})

describe('hostOf', () => {
  it('reduces a URL to its host', () => {
    expect(hostOf('https://example.com/deep/path?q=1')).toBe('example.com')
  })

  it('hands back anything it cannot parse rather than throwing', () => {
    expect(hostOf('not a url')).toBe('not a url')
  })
})
