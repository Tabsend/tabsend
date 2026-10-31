import type { EndpointId, IsoTimestamp } from '@tabsend/shared'
import { HOME_NETWORK_HINT } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import { makeEndpoint } from './fixtures'
import type { ConsoleSession, HistoryEntry } from './model'
import { STALE_ENDPOINT_THRESHOLD_MS } from './time'
import {
  batchHeading,
  clockLine,
  connectionTitle,
  deliveryBadge,
  groupHistory,
  groupResetCopy,
  HOSTED_HOST,
  hostOf,
  introCopy,
  monthDayLine,
  projectLinks,
  resolveEntryLabel,
  toDeviceRows,
} from './view'

const NOW = Date.parse('2026-07-18T12:00:00.000Z')

const session = {
  endpointId: 'console-1',
  label: 'Web console',
} as ConsoleSession

describe('toDeviceRows', () => {
  it('flags self, console, and stale rows and labels presence', () => {
    const endpoints = [
      makeEndpoint({ id: 'console-1' as EndpointId, kind: 'console', presence: 'online' }),
      makeEndpoint({ id: 'ext-1' as EndpointId, kind: 'extension', presence: 'online' }),
      makeEndpoint({
        id: 'old-1' as EndpointId,
        kind: 'extension',
        presence: 'offline',
        lastSeenAt: new Date(
          NOW - STALE_ENDPOINT_THRESHOLD_MS - 1000,
        ).toISOString() as IsoTimestamp,
      }),
    ]
    const rows = toDeviceRows(endpoints, session, NOW)

    expect(rows[0]!).toMatchObject({ isSelf: true, isConsole: true })
    expect(rows[0]!.lastSeenLabel).toBe('online now')
    expect(rows[1]!).toMatchObject({ isSelf: false, isConsole: false, stale: false })
    expect(rows[2]!.stale).toBe(true)
    expect(rows[2]!.lastSeenLabel).toContain('last seen')
  })
})

describe('resolveEntryLabel', () => {
  const entry: HistoryEntry = {
    id: 'e1',
    sourceEndpointId: 'sender-1',
    targetEndpointId: 'target-1',
    url: 'https://example.com',
    sentAt: new Date(NOW).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    sourceLabelAtSend: 'Old Source Name',
    targetLabelAtSend: 'Old Target Name',
  }

  it('prefers the live label when the endpoint still exists (reflects a rename)', () => {
    const endpoints = [makeEndpoint({ id: 'sender-1' as EndpointId, label: 'Renamed Source' })]
    expect(resolveEntryLabel(entry, 'source', endpoints)).toBe('Renamed Source')
  })

  it('falls back to the snapshot when the endpoint was removed', () => {
    expect(resolveEntryLabel(entry, 'target', [])).toBe('Old Target Name')
  })
})

describe('groupHistory', () => {
  const make = (id: string, batch?: { id: string; count: number }): HistoryEntry => ({
    id,
    sourceEndpointId: 'sender-1',
    targetEndpointId: 'target-1',
    url: `https://example.com/${id}`,
    sentAt: new Date(NOW).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    sourceLabelAtSend: 'Chrome',
    targetLabelAtSend: 'Pixel',
    ...(batch ? { batch } : {}),
  })

  it('passes single sends through as groups of one', () => {
    const groups = groupHistory([make('a'), make('b')])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.batchId).toBeUndefined()
    expect(groups[0]!.entries).toHaveLength(1)
  })

  it('collects a batch into one group at the position of its first entry', () => {
    const batch = { id: 'batch-1', count: 3 }
    const groups = groupHistory([
      make('a', batch),
      make('single'),
      make('b', batch),
      make('c', batch),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.batchId).toBe('batch-1')
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['a', 'b', 'c'])
    expect(groups[1]!.entries[0]!.id).toBe('single')
  })

  it('keeps separate batches separate', () => {
    const groups = groupHistory([
      make('a', { id: 'batch-1', count: 2 }),
      make('b', { id: 'batch-2', count: 2 }),
    ])
    expect(groups.map((g) => g.batchId)).toEqual(['batch-1', 'batch-2'])
  })
})

describe('batchHeading', () => {
  const entry = (id: string): HistoryEntry => ({
    id,
    sourceEndpointId: 's',
    targetEndpointId: 't',
    url: 'https://example.com',
    sentAt: new Date(NOW).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    sourceLabelAtSend: 'Chrome',
    targetLabelAtSend: 'Pixel',
  })

  it('names the count when every copy arrived', () => {
    expect(
      batchHeading({ batchId: 'b', sentCount: 3, entries: [1, 2, 3].map(String).map(entry) }),
    ).toBe('3 tabs')
  })

  it('says how many are missing when copies were dropped', () => {
    expect(batchHeading({ batchId: 'b', sentCount: 3, entries: [entry('a'), entry('b')] })).toBe(
      '2 of 3 tabs',
    )
  })

  it('never claims fewer tabs than it holds', () => {
    expect(batchHeading({ batchId: 'b', sentCount: 1, entries: [entry('a'), entry('b')] })).toBe(
      '2 tabs',
    )
  })
})

describe('deliveryBadge', () => {
  const entry = (delivery?: HistoryEntry['delivery']): HistoryEntry => ({
    id: 'e1',
    sourceEndpointId: 's',
    targetEndpointId: 't',
    url: 'https://example.com',
    sentAt: new Date(NOW).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    sourceLabelAtSend: 'Chrome',
    targetLabelAtSend: 'Pixel',
    ...(delivery ? { delivery } : {}),
  })

  it('names the three states the relay can settle', () => {
    const base = {
      createdAt: new Date(NOW - 1000).toISOString(),
      expiresAt: new Date(NOW + 1000).toISOString(),
      deliveredAt: null,
      ackedAt: null,
    }
    expect(deliveryBadge(entry(base), NOW)?.label).toBe('Waiting')
    expect(deliveryBadge(entry({ ...base, ackedAt: base.createdAt }), NOW)?.label).toBe('Arrived')
    expect(deliveryBadge(entry({ ...base, expiresAt: base.createdAt }), NOW)?.label).toBe(
      'Never arrived',
    )
  })

  it('says nothing at all about an ADR-0010 copy, which carries no delivery facts', () => {
    // A copy proves a send was made. Rendering "waiting" there would be inventing
    // a fact the console does not have.
    expect(deliveryBadge(entry(), NOW)).toBeNull()
  })
})

describe('hostOf', () => {
  it('returns the host of a URL', () => {
    expect(hostOf('https://news.example.com/path?q=1')).toBe('news.example.com')
  })
  it('returns the input for a non-URL', () => {
    expect(hostOf('not a url')).toBe('not a url')
  })
})

// P-15 item 4: the console's only outage signal is the Offline badge, so its hover
// text carries the same home-network line as the other clients' relay-down notice.
describe('connectionTitle', () => {
  it('names the relay it cannot reach', () => {
    expect(connectionTitle('offline', 'https://app.tabsend.org')).toBe(
      'Not connected to the relay at https://app.tabsend.org.',
    )
  })

  it('says why a home-network relay is out of reach, and what to do', () => {
    const title = connectionTitle('offline', 'http://192.168.1.20:8786')
    expect(title).toContain('http://192.168.1.20:8786')
    expect(title.endsWith(HOME_NETWORK_HINT)).toBe(true)
    expect(title).not.toContain('—')
  })

  it('adds nothing for a Tailscale or same-machine relay, or while connected', () => {
    expect(connectionTitle('offline', 'http://100.101.102.103:8787')).not.toContain(
      HOME_NETWORK_HINT,
    )
    expect(connectionTitle('offline', 'http://localhost:5173')).not.toContain(HOME_NETWORK_HINT)
    expect(connectionTitle('live', 'http://192.168.1.20:8786')).not.toContain(HOME_NETWORK_HINT)
    expect(connectionTitle('polling', 'http://192.168.1.20:8786')).not.toContain(HOME_NETWORK_HINT)
  })
})

describe('the reset that waits copy (PLANS.md P-18 item 12)', () => {
  it('names the day and the local time, word for word as on the other clients', () => {
    const requestedAt = '2026-10-27T12:00:00.000Z'
    const resetsAt = '2026-10-30T12:00:00.000Z'
    // Noon UTC is the same calendar day in every time zone from UTC-11 to UTC+11.
    expect(monthDayLine(requestedAt)).toBe('October 27')
    expect(clockLine(resetsAt)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/)
    expect(groupResetCopy.body(requestedAt, resetsAt)).toBe(
      `From your account page on October 27. On October 30 at ${clockLine(resetsAt)}, every device is removed, this one too. If it wasn't you, stop it now, then change your email password.`,
    )
    expect(groupResetCopy.body(requestedAt, resetsAt)).not.toContain('—')
  })
})

describe('the front page copy', () => {
  it('says what Tabsend is and what the console cannot do, in plain words', () => {
    expect(introCopy.what).toContain('sends a web page from one of your devices to another')
    expect(introCopy.what).toContain("can't send tabs itself")
    for (const text of Object.values(introCopy)) expect(text).not.toContain('—')
  })

  it('never uses the words a visitor would have to look up', () => {
    const all = Object.values(introCopy).join(' ')
    expect(all).not.toMatch(/relay|group history|end-to-end/i)
  })
})

describe('projectLinks', () => {
  it('links the hosted service to the site, its policies and support', () => {
    expect(projectLinks(HOSTED_HOST)).toEqual([
      { label: 'tabsend.org', href: 'https://tabsend.org' },
      { label: 'Privacy', href: 'https://tabsend.org/privacy' },
      { label: 'Terms', href: 'https://tabsend.org/terms' },
      { label: 'Support', href: 'https://tabsend.org/support' },
    ])
  })

  it('leaves out the policies on a relay somebody else runs', () => {
    for (const host of [
      'localhost',
      '192.168.1.20',
      'relay.example.com',
      'app.tabsend.org.evil.test',
    ]) {
      expect(projectLinks(host).map((l) => l.label)).toEqual(['tabsend.org', 'Support'])
    }
  })
})
