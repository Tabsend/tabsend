import type { IsoTimestamp } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../lib/i18n'
import type { ChooserRow, ChooserView, RpcRequest, SendResult, StateView } from '../lib/model'
import { unlocalizedWords } from '../lib/pseudo'
import { renderDeviceList } from './device-list'
import { FakeElement, type FakePage, installFakePage, uninstallFakePage } from './test-dom'

/**
 * The toolbar popup, imported for real over a stand-in DOM built from chooser.html. Two
 * things are proved here. In English every sentence reads exactly as it did before it moved
 * into the catalog. In the pseudo-locale (en-XA) every word on the page is inside a catalog
 * message, so nothing is left in the code: only names a person typed (device names, tab
 * titles) show as plain words.
 */

const requests: RpcRequest[] = []
const answers = {
  chooser: undefined as ChooserView | undefined,
  selection: 1,
  send: undefined as SendResult | undefined,
  mint: undefined as unknown,
}
vi.mock('./rpc-client', () => ({
  rpcOk: vi.fn(async (req: RpcRequest) => {
    requests.push(req)
    switch (req.type) {
      case 'getState':
        return { ok: true, state }
      case 'getChooser':
        return { ok: true, chooser: answers.chooser }
      case 'getSelection':
        return { ok: true, selection: { count: answers.selection } }
      case 'sendTo':
        return { ok: true, send: answers.send }
      case 'mintPairing': {
        // A string stands for a failure the background worded: what rpcOk throws is a
        // UserFacingError. The class is read now, because each test loads the page afresh.
        if (typeof answers.mint === 'string') {
          const { UserFacingError } = await import('../lib/relay-errors')
          throw new UserFacingError(answers.mint)
        }
        // An error object is an exception nobody planned for.
        if (answers.mint instanceof Error) throw answers.mint
        return { ok: true, pairing: answers.mint }
      }
      default:
        return { ok: true }
    }
  }),
}))
vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { create: vi.fn(async () => undefined) },
    runtime: {
      getURL: (path: string) => `chrome-extension://id/${path}`,
      openOptionsPage: vi.fn(async () => undefined),
      connect: () => ({
        onMessage: { addListener: () => undefined },
        onDisconnect: { addListener: () => undefined },
      }),
    },
    permissions: { contains: vi.fn(async () => true) },
  },
}))

const state: StateView = {
  registered: true,
  relayUrl: 'https://relay.example',
  selfLabel: 'Chrome · Mac',
}

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const ago = (minutes: number): IsoTimestamp =>
  new Date(NOW - minutes * 60_000).toISOString() as IsoTimestamp

function target(
  id: string,
  label: string,
  kind: 'mobile' | 'browser' | 'console',
  extra: Partial<ChooserRow> & { presence?: 'online' | 'offline'; lastSeenMinutes?: number } = {},
): ChooserRow {
  const { presence, lastSeenMinutes, ...flags } = extra
  return {
    endpoint: {
      id,
      label,
      kind,
      presence: presence ?? 'offline',
      lastSeenAt: ago(lastSeenMinutes ?? 5),
    },
    isPrimary: false,
    isRecent: false,
    stale: false,
    presenceKnown: true,
    ...flags,
  } as unknown as ChooserRow
}

function view(): ChooserView {
  return {
    registered: true,
    targets: [
      target('ep-phone', 'Pixel 9', 'mobile', { presence: 'online', isPrimary: true }),
      target('ep-arc', 'Arc', 'browser'),
      target('ep-old', 'Old iPad', 'browser', { stale: true, lastSeenMinutes: 60 * 24 * 40 }),
      target('ep-pc', 'Home PC', 'console', { presenceKnown: false, lastSeenMinutes: 180 }),
      target('ep-lost', 'Ghost', 'browser', { unreachable: true }),
    ],
    pending: [{ targetEndpointId: 'ep-phone', count: 2 }],
    held: [
      {
        id: 'h1',
        targetEndpointId: 'ep-arc',
        title: 'Quarterly numbers',
        url: 'https://example.org/q',
        createdAt: ago(10),
      },
      {
        id: 'h2',
        targetEndpointId: 'ep-gone',
        targetLabel: 'S24',
        targetGone: true,
        title: 'Receipt',
        url: 'https://example.org/r',
        createdAt: ago(20),
        choices: ['ep-phone', 'ep-arc'],
      },
      {
        id: 'h3',
        targetEndpointId: 'ep-gone',
        targetLabel: 'S24',
        targetGone: true,
        url: 'https://shop.example.net/cart',
        createdAt: ago(30),
        choices: ['ep-phone', 'ep-arc', 'ep-old', 'ep-pc'],
      },
    ],
    primaryPinned: false,
    newDevices: [],
    review: [],
    vanished: [{ id: 'ep-van', label: 'Lost laptop', createdAt: ago(90) }],
    unreachable: [{ endpointId: 'ep-lost', label: 'Ghost', failedAt: ago(15) }],
    groupReset: {
      requestedAt: '2026-10-27T10:00:00.000Z' as IsoTimestamp,
      resetsAt: '2026-11-10T15:05:00.000Z' as IsoTimestamp,
    },
  }
}

// The stand-in DOM answers `querySelectorAll`; the popup also asks for one element.
const proto = FakeElement.prototype as unknown as {
  querySelector?: (selector: string) => FakeElement | null
}
proto.querySelector = function (this: FakeElement, selector: string) {
  return this.querySelectorAll(selector)[0] ?? null
}

let page: FakePage

/** `locale` is chosen on the page's own copy of the catalog, which a reset of the modules renews. */
async function openPopup(locale?: string): Promise<void> {
  page = installFakePage('chooser.html')
  ;(globalThis.window as unknown as { close: () => void }).close = () => undefined
  vi.resetModules()
  if (locale) (await import('../lib/i18n')).setLocale(locale)
  await import('./chooser')
  await vi.waitFor(() => expect(page.byId('targets').children.length).toBeGreaterThan(0))
}

const buttonsIn = (id: string): FakeElement[] =>
  page
    .byId(id)
    .descendants()
    .filter((e) => e.tagName === 'button')
const titleOf = (el: FakeElement): string | undefined => (el as unknown as { title?: string }).title
const sub = (button: FakeElement): string =>
  button
    .descendants()
    .find((e) => e.classList.contains('row-sub'))
    ?.textContent.replace(/\s+/g, ' ') ?? ''

/** Every piece of text and every spoken or hover name under `ids`, as one string. */
function everythingShown(ids: string[]): string {
  const parts: string[] = []
  for (const id of ids) {
    const root = page.byId(id)
    for (const el of [root, ...root.descendants()]) {
      // Text leaf by leaf, so two neighbours do not run together into one word.
      if (el.children.length === 0 && el.textContent) parts.push(el.textContent)
      for (const name of ['aria-label', 'placeholder']) {
        const value = el.getAttribute(name)
        if (value) parts.push(value)
      }
      const title = titleOf(el)
      if (title) parts.push(title)
    }
  }
  return parts.join(' ')
}

const SHOWN = [
  'status',
  'relay-down',
  'multi',
  'new-devices',
  'confirm',
  'targets',
  'pending',
  'held',
  'pairing-note',
  'pairing-local-only',
  'copy-note',
  'pairing-link',
  'pairing-qr',
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
  vi.setSystemTime(NOW)
  requests.length = 0
  answers.chooser = view()
  answers.selection = 1
  answers.send = undefined
  answers.mint = undefined
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  uninstallFakePage()
  setLocale()
})

describe('the popup in English', () => {
  it('reads every device row as it always did', async () => {
    await openPopup()
    const rows = buttonsIn('targets')
    expect(rows.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Send to Pixel 9, main, online',
      'Send to Arc, offline, last seen 5m ago',
      'Send to Old iPad, offline, last seen 40d ago',
      'Send to Home PC, status unknown, last seen 3h ago',
      'Send to Ghost, offline, last seen 5m ago',
    ])
    expect(rows.map(sub)).toEqual([
      'Phone · online',
      'Browser · offline · seen 5m ago',
      'Browser · inactive',
      'Computer · status unknown · seen 3h ago',
      'Browser · not connected',
    ])
    expect(rows[0]?.textContent).toContain('Main')
  })

  it('keeps the status as its own element, which a send swaps for "sending…"', async () => {
    await openPopup()
    answers.send = { ok: true, queued: false, offline: false, targetLabel: 'Arc' }
    const arc = buttonsIn('targets')[1] as FakeElement
    const status = arc.descendants().find((e) => e.classList.contains('last-seen'))
    expect(status?.textContent).toBe('offline · seen 5m ago')
    arc.click()
    expect(status?.textContent).toBe('sending…')
    await vi.waitFor(() => expect(page.byId('confirm').classList.contains('visible')).toBe(true))
  })

  it('says how many tabs a click sends', async () => {
    answers.selection = 3
    await openPopup()
    expect(buttonsIn('targets')[0]?.getAttribute('aria-label')).toBe(
      'Send 3 tabs to Pixel 9, main, online',
    )
  })

  it('names the waiting tabs and the way out of each wait', async () => {
    await openPopup()
    expect(page.byId('pending').textContent).toBe('⏳ 2 waiting for Pixel 9')
    const held = page.byId('held')
    expect(held.descendants().find((e) => e.classList.contains('held-heading'))?.textContent).toBe(
      '3 tabs waiting on this browser',
    )
    const stop = buttonsIn('held').filter((b) => b.classList.contains('held-cancel'))
    expect(stop.map(titleOf)).toEqual(Array(3).fill('Stop waiting to send this tab'))
    expect(stop.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Stop waiting to send Quarterly numbers',
      'Stop waiting to send Receipt',
      'Stop waiting to send shop.example.net',
    ])
    expect(
      held
        .descendants()
        .filter((e) => e.classList.contains('held-to'))
        .map((e) => e.textContent),
    ).toEqual(['→ Arc'])
  })

  it('gives a held tab whose device left a button per device, or a menu past three', async () => {
    await openPopup()
    const labels = buttonsIn('held')
      .filter((b) => b.classList.contains('linkish'))
      .map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['Send Receipt to Pixel 9', 'Send Receipt to Arc'])
    const menu = page
      .byId('held')
      .descendants()
      .find((e) => e.tagName === 'select')
    expect(menu?.getAttribute('aria-label')).toBe('Send to… shop.example.net')
  })

  it('shows the pairing steps in the box', async () => {
    answers.mint = {
      relayUrl: 'https://relay.example',
      link: 'https://relay.example/pair#c=ABC',
      expiresAt: ago(-10),
      localOnly: false,
    }
    await openPopup()
    page.byId('pair-header').click()
    expect(page.byId('pairing-note').textContent).toBe('Getting a setup link…')
    await vi.waitFor(() => expect(page.byId('pairing-qr').children.length).toBe(1))
    expect(page.byId('pairing-qr').children[0]?.getAttribute('aria-label')).toBe('Pairing QR code')
  })

  it('offers a way to try again when the link could not be made', async () => {
    answers.mint = 'Relay unavailable.'
    await openPopup()
    page.byId('pair-header').click()
    await vi.waitFor(() => expect(buttonsIn('pairing-note')).toHaveLength(1))
    expect(page.byId('pairing-note').textContent).toBe('Relay unavailable.Try again')
  })

  it('never shows the text of an exception it did not expect', async () => {
    answers.mint = new Error('Unexpected token < in JSON at position 0')
    await openPopup()
    page.byId('pair-header').click()
    await vi.waitFor(() => expect(buttonsIn('pairing-note')).toHaveLength(1))
    expect(page.byId('pairing-note').textContent).toBe('Something went wrong. Try again.Try again')
  })
})

describe('the popup in the pseudo-locale', () => {
  const NAMES = [
    'Pixel',
    'Arc',
    'Old',
    'iPad',
    'Home',
    'PC',
    'Ghost',
    'S24',
    'https',
    'org',
    'q',
    'r',
    'cart',
    'Lost',
    'laptop',
    'Quarterly',
    'numbers',
    'Receipt',
    'shop',
    'example',
    'net',
    'Chrome',
    'Mac',
    'Relay',
    'unavailable',
  ]

  it('has no word of its own outside the catalog', async () => {
    answers.selection = 2
    answers.mint = {
      relayUrl: 'http://localhost:8787',
      link: 'http://localhost:8787/pair#c=ABC',
      qrLink: 'tabsend://pair?c=ABC',
      expiresAt: ago(-10),
      localOnly: true,
      routeNote: undefined,
    }
    await openPopup('en-XA')

    page.byId('pair-header').click()
    await vi.waitFor(() => expect(page.byId('pairing-qr').children.length).toBe(1))

    expect(unlocalizedWords(everythingShown(SHOWN), NAMES)).toEqual([])
    // The page really is in the pseudo-locale, not just free of words.
    expect(buttonsIn('targets')[0]?.getAttribute('aria-label')).toMatch(/^\[/)
    expect(sub(buttonsIn('targets')[0] as FakeElement)).toMatch(/^\[.*\]$/)
  })

  it('has no word of its own in a failed send or a copy that failed', async () => {
    answers.mint = 'Relay unavailable.'
    answers.send = {
      ok: false,
      queued: false,
      offline: false,
      targetLabel: 'Arc',
      failure: { kind: 'relay-unauthorized' },
    } as SendResult
    await openPopup('en-XA')
    buttonsIn('targets')[1]?.click()
    await vi.waitFor(() => expect(page.byId('status').classList.contains('error')).toBe(true))
    page.byId('pair-header').click()
    await vi.waitFor(() => expect(buttonsIn('pairing-note')).toHaveLength(1))

    expect(unlocalizedWords(everythingShown(SHOWN), NAMES)).toEqual([])
  })

  it('has no word of its own in the shared device list', () => {
    setLocale('en-XA')
    const list = installFakePage('chooser.html').byId('targets')
    renderDeviceList(
      list as unknown as HTMLElement,
      [
        {
          endpointId: 'a',
          label: 'Pixel 8',
          isSelf: true,
          online: true,
          presenceKnown: true,
          presenceLabel: '[online]',
        },
        {
          endpointId: 'b',
          label: 'Pixel 9',
          isSelf: false,
          online: false,
          presenceKnown: true,
          presenceLabel: '[last seen 2h ago]',
        },
      ],
      { rename: () => undefined, remove: () => undefined },
    )
    const shown = [list.textContent, ...list.descendants().map((e) => e.getAttribute('aria-label'))]
    expect(unlocalizedWords(shown.join(' '), ['Pixel'])).toEqual([])
    expect(list.descendants().filter((e) => e.getAttribute('aria-label'))).toHaveLength(3)
  })
})
