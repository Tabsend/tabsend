import type { Endpoint, EndpointId, IsoTimestamp } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { batchHeading, projectRow, relativeTime } from '../lib/history'
import { setLocale } from '../lib/i18n'
import { unlocalizedWords } from '../lib/pseudo'
import { normalizeRelayUrl } from '../lib/relay-url'

/**
 * What the worker puts on the toolbar icon and in the right-click menus, in English and in the
 * pseudo-locale (en-XA). English must read as it always did; in en-XA every word must have come
 * out of the catalog (inside brackets), apart from the device names a person chose.
 */

// --- a browser that records what is set on it ---------------------------------------

const created: Array<{ id: string; title: string; parentId?: string }> = []
const badge = { text: '', title: '' }
vi.mock('../lib/ext', () => ({
  ext: {
    action: {},
    contextMenus: {
      removeAll: vi.fn(async () => undefined),
      create: (item: { id: string; title: string; parentId?: string }) => {
        created.push(item)
      },
    },
    storage: { onChanged: { addListener: vi.fn() } },
  },
}))
vi.mock('../lib/platform', () => ({ IS_FIREFOX: false }))

const settings = { contextMenusVisible: true, toolbarClickMode: 'popup' as 'popup' | 'quicksend' }
let endpoints: Endpoint[] = []
let registered = true
vi.mock('../lib/storage', () => ({
  getSettings: vi.fn(async () => settings),
  getCachedEndpoints: vi.fn(async () => endpoints),
}))
vi.mock('./endpoints', () => ({ targetEndpoints: vi.fn(async (list: Endpoint[]) => list) }))
vi.mock('./session', () => ({ currentSession: vi.fn(async () => (registered ? {} : undefined)) }))
vi.mock('./send', () => ({
  isSendableTab: vi.fn(),
  payloadsFromTabs: vi.fn(),
  sendToTarget: vi.fn(),
}))

import { ext } from '../lib/ext'
import { setUnreachableBadge, setUnreadBadge } from './badge'
import { rebuildMenus } from './menus'

function device(id: string, label: string): Endpoint {
  return {
    id: id as EndpointId,
    groupId: 'g' as Endpoint['groupId'],
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    label,
    e2ePubkey: 'k',
    presence: 'online',
    lastSeenAt: '2026-07-29T12:00:00.000Z' as IsoTimestamp,
    createdAt: '2026-07-29T00:00:00.000Z' as IsoTimestamp,
  }
}

const PIXEL = device('p', 'Pixel 9')
const IPAD = device('i', 'iPad')

async function titlesFor(list: Endpoint[], quicksend = false): Promise<string[]> {
  created.length = 0
  endpoints = list
  settings.toolbarClickMode = quicksend ? 'quicksend' : 'popup'
  await rebuildMenus()
  return created.map((item) => item.title)
}

beforeEach(() => {
  registered = true
  badge.text = ''
  badge.title = ''
  const action = ext.action as unknown as Record<string, (arg: never) => void>
  action.setBadgeText = (arg: { text: string }) => {
    badge.text = arg.text
  }
  action.setBadgeBackgroundColor = () => undefined
  action.setTitle = (arg: { title: string }) => {
    badge.title = arg.title
  }
})
afterEach(() => setLocale())

describe('right-click menus', () => {
  it('say what they always said, in English', async () => {
    expect(await titlesFor([])).toEqual(['Tabsend: add a device…'])
    expect(await titlesFor([PIXEL])).toEqual(['Send tab to Pixel 9', 'Send link to Pixel 9'])
    expect(await titlesFor([PIXEL, IPAD])).toEqual([
      'Send tab to',
      'Send link to',
      'Pixel 9',
      'Pixel 9',
      'iPad',
      'iPad',
    ])
    expect(await titlesFor([PIXEL], true)).toEqual([
      'Open Tabsend chooser…',
      'Send tab to Pixel 9',
      'Send link to Pixel 9',
    ])
  })

  it('have no words of their own in the pseudo-locale', async () => {
    setLocale('en-XA')
    const names = ['Pixel 9', 'iPad']
    for (const [list, quicksend] of [
      [[], false],
      [[PIXEL], true],
      [[PIXEL, IPAD], false],
    ] as const) {
      const titles = await titlesFor([...list], quicksend)
      expect(titles.length).toBeGreaterThan(0)
      for (const title of titles) expect(unlocalizedWords(title, names), title).toEqual([])
    }
  })
})

describe('the toolbar icon', () => {
  it('shows the unread count, and 9+ past nine', () => {
    setUnreadBadge(3)
    expect(badge.text).toBe('3')
    setUnreadBadge(12)
    expect(badge.text).toBe('9+')
  })

  it('has the manifest tooltip when idle, and bracketed words in the pseudo-locale', () => {
    setUnreachableBadge('')
    expect(badge.title).toBe('Tabsend — send this tab')
    setLocale('en-XA')
    setUnreachableBadge('')
    expect(unlocalizedWords(badge.title, [])).toEqual([])
    expect(badge.title).not.toBe('Tabsend — send this tab')
    setUnreadBadge(12)
    expect(unlocalizedWords(badge.text, [])).toEqual([])
  })
})

describe('History times and counts', () => {
  const now = Date.parse('2026-11-03T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  it('read as they always did', () => {
    expect(relativeTime(ago(20_000), now)).toBe('just now')
    expect(relativeTime(ago(3 * MIN), now)).toBe('3m ago')
    expect(relativeTime(ago(5 * HOUR), now)).toBe('5h ago')
    expect(relativeTime(ago(5 * DAY), now)).toBe('5d ago')
    expect(relativeTime(ago(65 * DAY), now)).toBe('2mo ago')
    expect(relativeTime(ago(800 * DAY), now)).toBe('2y ago')
    expect(relativeTime('not a time', now)).toBe('unknown')
  })

  it('come from the catalog in the pseudo-locale', () => {
    setLocale('en-XA')
    for (const ms of [20_000, 3 * MIN, 5 * HOUR, 5 * DAY, 65 * DAY, 800 * DAY]) {
      expect(unlocalizedWords(relativeTime(ago(ms), now), []), String(ms)).toEqual([])
    }
    expect(unlocalizedWords(relativeTime('not a time', now), [])).toEqual([])
  })
})

describe('History headings and stand-ins', () => {
  const rows = (n: number) => Array.from({ length: n }, () => ({}) as never)
  const whole = { batchId: 'b', sentCount: 3, rows: rows(3) }
  const partial = { batchId: 'b', sentCount: 3, rows: rows(2) }
  /** A transfer from a device that is not in the list, with nothing readable. */
  const fromStranger = () =>
    projectRow(
      {
        id: 'm',
        sourceEndpointId: 'gone',
        targetEndpointId: 'self',
        createdAt: '2026-11-03T10:00:00.000Z',
        expiresAt: '2026-11-04T10:00:00.000Z',
        ackedAt: null,
      } as never,
      undefined,
      'self',
      () => undefined,
      Date.parse('2026-11-03T12:00:00Z'),
    )

  it('read as they always did', () => {
    expect(batchHeading(whole)).toBe('3 tabs')
    expect(batchHeading(partial)).toBe('2 of 3 tabs')
    expect(fromStranger().sourceLabel).toBe('Unknown device')
  })

  it('come from the catalog in the pseudo-locale', () => {
    setLocale('en-XA')
    expect(unlocalizedWords(batchHeading(whole), [])).toEqual([])
    expect(unlocalizedWords(batchHeading(partial), [])).toEqual([])
    expect(unlocalizedWords(fromStranger().sourceLabel, [])).toEqual([])
  })
})

describe('errors that reach a person', () => {
  it('read as they always did', () => {
    expect(() => normalizeRelayUrl('')).toThrow('Enter the relay address.')
    expect(() => normalizeRelayUrl('ftp://relay.example')).toThrow(
      'The relay address must start with http:// or https://.',
    )
    expect(() => normalizeRelayUrl('https://me:pw@relay.example')).toThrow(
      'The relay address cannot include a username or password.',
    )
  })

  it('come from the catalog in the pseudo-locale', () => {
    setLocale('en-XA')
    for (const input of ['', 'ftp://relay.example', 'https://relay.example/?a=1', 'https://:@']) {
      let message = ''
      try {
        normalizeRelayUrl(input)
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message, input).not.toBe('')
      expect(unlocalizedWords(message, []), input).toEqual([])
    }
  })
})
