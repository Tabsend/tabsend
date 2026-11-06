import type { Endpoint, EndpointId, IsoTimestamp } from '@tabsend/shared'
import { Controller } from '../lib/controller'
import { makeEndpoint } from '../lib/fixtures'
import { t } from '../lib/i18n'
import type { ConsoleSession, HistoryEntry } from '../lib/model'
import { InMemoryHistoryStore } from '../lib/persist'
import { MemoryKv } from '../lib/session'
import { mountApp } from './app'
import { FakeElement, findAll, findButton, installFakeDom, outline } from './test-dom'

/**
 * Every screen the console can show, rendered into a stand-in page and read back as an
 * outline of the words on it. Test-only. One scene is one situation: a tab, a dialog, a
 * warning. Together they reach every sentence in `ui/app.ts`.
 *
 * The clock must be pinned by the caller (vi.setSystemTime) and the time zone set to
 * UTC, so the "5m ago" and the dates do not depend on when the test runs.
 */

export const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const ago = (ms: number): IsoTimestamp => new Date(NOW - ms).toISOString() as IsoTimestamp
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const SESSION: ConsoleSession = {
  relayUrl: 'https://relay.example.com',
  endpointId: 'console-1',
  groupId: 'group-abc',
  deviceToken: 'token',
  label: "Ben's web console",
  publicKey: 'pub',
  privateKey: 'priv',
  keyId: 'kid',
}

function devices(): Endpoint[] {
  const list = [
    makeEndpoint({
      id: 'console-1' as EndpointId,
      kind: 'console',
      browser: null,
      platform: 'macos',
      label: "Ben's web console",
      presence: 'online',
      lastSeenAt: ago(5_000),
    }),
    makeEndpoint({
      id: 'ext-1' as EndpointId,
      kind: 'extension',
      browser: 'chrome',
      platform: 'windows',
      label: 'Chrome · Work',
      presence: 'online',
      lastSeenAt: ago(10_000),
    }),
    makeEndpoint({
      id: 'phone-1' as EndpointId,
      kind: 'mobile',
      browser: null,
      platform: 'android',
      label: 'Pixel 9',
      presence: 'offline',
      lastSeenAt: ago(3 * HOUR + 5 * MIN),
    }),
    makeEndpoint({
      id: 'ext-2' as EndpointId,
      kind: 'extension',
      browser: 'firefox',
      platform: 'linux',
      label: 'Firefox · Old laptop',
      presence: 'offline',
      lastSeenAt: ago(41 * DAY),
    }),
    makeEndpoint({
      id: 'phone-2' as EndpointId,
      kind: 'mobile',
      browser: null,
      platform: 'ios',
      label: 'iPhone',
      presence: 'offline',
      lastSeenAt: ago(2 * MIN + 10_000),
    }),
    makeEndpoint({
      id: 'console-2' as EndpointId,
      kind: 'console',
      browser: null,
      platform: 'unknown',
      label: 'Kitchen console',
      presence: 'offline',
      lastSeenAt: ago(400 * DAY),
    }),
    makeEndpoint({
      id: 'ext-3' as EndpointId,
      kind: 'extension',
      browser: 'edge',
      platform: 'macos',
      label: 'Edge',
      presence: 'offline',
      lastSeenAt: ago(5 * DAY),
    }),
  ]
  // makeEndpoint turns a null browser into Chrome; the rows without a browser are real.
  for (const e of list)
    if (['console-1', 'phone-1', 'phone-2', 'console-2'].includes(e.id)) e.browser = null
  return list
}

const DATA_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function entry(over: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    sourceEndpointId: 'ext-1',
    targetEndpointId: 'phone-1',
    sentAt: ago(12 * MIN),
    recordedAt: ago(11 * MIN),
    sourceLabelAtSend: 'Chrome · Work',
    targetLabelAtSend: 'Pixel 9',
    ...over,
  }
}

function delivery(state: 'arrived' | 'waiting' | 'never') {
  return {
    createdAt: ago(12 * MIN),
    expiresAt: new Date(NOW + (state === 'never' ? -HOUR : 6 * DAY)).toISOString(),
    deliveredAt: state === 'waiting' ? null : ago(11 * MIN),
    ackedAt: state === 'arrived' ? ago(10 * MIN) : null,
  }
}

function history(): HistoryEntry[] {
  return [
    entry({
      id: 'h1',
      url: 'https://example.com/article',
      title: 'An Article',
      favicon: DATA_ICON,
      delivery: delivery('arrived'),
    }),
    entry({
      id: 'h2',
      url: 'https://news.example.org/story?id=2',
      title: '   ',
      sentAt: ago(2 * HOUR),
      delivery: delivery('waiting'),
    }),
    entry({
      id: 'h3',
      url: 'https://example.net/lost',
      title: 'Never opened',
      sentAt: ago(3 * DAY),
      delivery: delivery('never'),
    }),
    entry({ id: 'h4', sentAt: ago(5 * DAY), delivery: delivery('arrived') }), // sealed to a key we lack
    entry({
      id: 'h5',
      url: 'https://copy.example.com/',
      title: 'Older copy',
      sentAt: ago(400 * DAY),
    }),
    entry({
      id: 'h6',
      url: 'javascript:alert(1)',
      title: 'Not a web address',
      sentAt: ago(45 * DAY),
    }),
    // One send of three tabs, all here.
    entry({
      id: 'b1',
      url: 'https://one.example.com/',
      title: 'First of three',
      batch: { id: 'batch-a', count: 3 },
      delivery: delivery('arrived'),
    }),
    entry({
      id: 'b2',
      url: 'https://two.example.com/',
      title: 'Second of three',
      batch: { id: 'batch-a', count: 3 },
      delivery: delivery('arrived'),
    }),
    entry({
      id: 'b3',
      url: 'https://three.example.com/',
      title: 'Third of three',
      batch: { id: 'batch-a', count: 3 },
      delivery: delivery('waiting'),
    }),
    // A send of four tabs, two of them still here.
    entry({
      id: 'p1',
      url: 'https://p1.example.com/',
      title: 'Partial one',
      sentAt: ago(2 * DAY),
      sourceEndpointId: 'phone-1',
      targetEndpointId: 'ext-1',
      sourceLabelAtSend: 'Pixel 9',
      targetLabelAtSend: 'Chrome · Work',
      batch: { id: 'batch-b', count: 4 },
    }),
    entry({
      id: 'p2',
      url: 'https://p2.example.com/',
      title: 'Partial two',
      sentAt: ago(2 * DAY),
      sourceEndpointId: 'phone-1',
      targetEndpointId: 'ext-1',
      sourceLabelAtSend: 'Pixel 9',
      targetLabelAtSend: 'Chrome · Work',
      batch: { id: 'batch-b', count: 4 },
    }),
    // A device that is gone: its snapshot label shows.
    entry({
      id: 'g1',
      url: 'https://gone.example.com/',
      title: 'From a removed device',
      sentAt: ago(9 * DAY),
      sourceEndpointId: 'removed-1',
      sourceLabelAtSend: 'Old tablet',
      delivery: delivery('arrived'),
    }),
  ]
}

interface Scene {
  controller: Controller
  root: FakeElement
}

/** A console mounted on a stand-in page; the hostname decides which footer links show. */
function mount(hostname = 'relay.example.com'): Scene & { restore: () => void } {
  const restore = installFakeDom({ hostname, origin: `https://${hostname}` })
  const controller = new Controller({
    kv: new MemoryKv(),
    store: new InMemoryHistoryStore(),
    fetchImpl: (async () => new Response('{}')) as never,
    now: () => NOW,
    detectPlatform: () => 'macos',
  })
  const root = new FakeElement('div')
  mountApp(root as unknown as HTMLElement, controller)
  return { controller, root, restore }
}

/** A paired console with devices, on the tab given. */
function paired(
  tab: 'Devices' | 'History' | 'Account',
  setup: (c: Controller) => void = () => {},
  hostname?: string,
): Scene & { restore: () => void } {
  const scene = mount(hostname)
  const c = scene.controller
  c.session.set(SESSION)
  c.endpoints.set(devices())
  c.connection.set('live')
  c.phase.set('ready')
  setup(c)
  // Found by the words of the catalog in the language on screen, so the pseudo-locale works too.
  const label = {
    Devices: t('app.tab.devices'),
    History: t('app.tab.history'),
    Account: t('app.tab.account'),
  }
  if (tab !== 'Devices') findButton(scene.root, label[tab]).click()
  return scene
}

function dump(scene: Scene & { restore: () => void }): string {
  const text = outline(scene.root)
  scene.restore()
  return text
}

/** Open the first button with this label inside the row of `device`. */
function rowButton(root: FakeElement, device: string, label: string): FakeElement {
  const row = findAll(
    root,
    (e) => e.tagName === 'li' && e.textContent.includes(device) && e.className.includes('device'),
  )[0]
  if (!row) throw new Error(`No row for ${device}`)
  return findButton(row, label)
}

export async function collectScenes(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const add = (name: string, scene: Scene & { restore: () => void }) => {
    out[name] = dump(scene)
  }

  // --- before pairing ---
  add('loading', mount())
  {
    const s = mount()
    s.controller.phase.set('onboarding')
    add('onboarding', s)
  }
  {
    // The browser names itself a moment after the page opens, and the name box follows.
    const g = globalThis as { browser?: unknown }
    g.browser = { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } }
    const s = mount()
    s.controller.phase.set('onboarding')
    await new Promise((resolve) => setTimeout(resolve, 5))
    add('onboarding.browserNamed', s)
    delete g.browser
  }
  {
    const s = mount('app.tabsend.org')
    s.controller.phase.set('onboarding')
    s.controller.status.set({ kind: 'error', message: t('status.enterLink') })
    add('onboarding.hosted.error', s)
  }
  {
    const s = mount()
    s.controller.phase.set('onboarding')
    s.controller.status.set({ kind: 'info', message: t('status.pairing') })
    add('onboarding.pairing', s)
  }

  // --- devices ---
  add('devices', paired('Devices'))
  add(
    'devices.polling',
    paired('Devices', (c) => c.connection.set('polling')),
  )
  add(
    'devices.offline',
    paired('Devices', (c) => c.connection.set('offline')),
  )
  add(
    'devices.offline.homeNetwork',
    paired('Devices', (c) => {
      c.session.set({ ...SESSION, relayUrl: 'http://192.168.1.20:8787' })
      c.connection.set('offline')
    }),
  )
  add(
    'devices.sameOrigin',
    paired('Devices', (c) => c.session.set({ ...SESSION, relayUrl: '' })),
  )
  add(
    'devices.empty',
    paired('Devices', (c) => c.endpoints.set([])),
  )
  add(
    'devices.hosted',
    paired('Devices', () => {}, 'app.tabsend.org'),
  )
  add(
    'devices.busy',
    paired('Devices', (c) => c.busy.set(true)),
  )
  add(
    'devices.groupReset',
    paired('Devices', (c) =>
      c.groupReset.set({
        requestedAt: '2026-11-02T09:30:00.000Z' as IsoTimestamp,
        resetsAt: '2026-11-05T09:30:00.000Z' as IsoTimestamp,
      }),
    ),
  )
  add(
    'devices.vanished',
    paired('Devices', (c) =>
      c.vanished.set([
        { id: 'v1', label: 'Mystery laptop', createdAt: ago(5 * HOUR + 3 * MIN) },
        { id: 'v2', label: 'Broken clock', createdAt: 'not a time' as IsoTimestamp },
      ]),
    ),
  )
  add(
    'status.info',
    paired('Devices', (c) => c.status.set({ kind: 'info', message: t('status.removedSelf') })),
  )

  // --- dialogs ---
  {
    const s = paired('Devices')
    rowButton(s.root, 'Chrome · Work', t('common.rename')).click()
    add('dialog.rename', s)
  }
  {
    const s = paired('Devices')
    rowButton(s.root, 'Pixel 9', t('common.remove')).click()
    add('dialog.remove', s)
  }
  {
    const s = paired('Devices')
    rowButton(s.root, "Ben's web console", t('common.remove')).click()
    add('dialog.remove.self', s)
  }
  {
    const s = paired('Account')
    findButton(s.root, t('account.unpair.button')).click()
    add('dialog.unpair', s)
  }

  // --- add a device ---
  const base = {
    relayUrl: 'https://relay.example.com',
    link: 'https://relay.example.com/pair#c=ABCD',
    qrLink: 'tabsend://pair?c=ABCD',
    expiresAt: '2026-11-03T12:15:00.000Z',
    localOnly: false,
  }
  add(
    'pairing',
    paired('Devices', (c) => c.pairing.set(base)),
  )
  add(
    'pairing.localOnly',
    paired('Devices', (c) =>
      c.pairing.set({ ...base, relayUrl: 'http://localhost:8787', localOnly: true }),
    ),
  )
  add(
    'pairing.routeNote',
    paired('Devices', (c) =>
      c.pairing.set({
        ...base,
        routeNote: t('pairing.routeNote', {
          browserUrl: 'https://a.example',
          phoneUrl: 'https://b.example',
        }),
      }),
    ),
  )

  // --- history ---
  add(
    'history.unknown.empty',
    paired('History', (c) => c.groupHistory.set('unknown')),
  )
  add(
    'history.ready.empty',
    paired('History', (c) => c.groupHistory.set('ready')),
  )
  add(
    'history.unavailable.empty',
    paired('History', (c) => c.groupHistory.set('unavailable')),
  )
  add(
    'history.ready',
    paired('History', (c) => {
      c.groupHistory.set('ready')
      c.history.set(history())
    }),
  )
  add(
    'history.ready.awaitingKey',
    paired('History', (c) => {
      c.groupHistory.set('ready')
      c.awaitingGroupKey.set(true)
      c.history.set([entry({ id: 'h4', delivery: delivery('arrived') })])
    }),
  )
  add(
    'history.unavailable',
    paired('History', (c) => {
      c.groupHistory.set('unavailable')
      c.history.set([entry({ id: 'h5', url: 'https://copy.example.com/', title: 'Older copy' })])
    }),
  )

  // --- account ---
  add('account', paired('Account'))
  add(
    'account.keys',
    paired('Account', (c) => {
      c.keyring.set([{}, {}, {}] as never)
      c.pushEnabled.set(true)
    }),
  )
  add(
    'account.sameOrigin',
    paired('Account', (c) => c.session.set({ ...SESSION, relayUrl: '' })),
  )
  return out
}
