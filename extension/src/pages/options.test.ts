import { DEFAULT_CLIENT_SETTINGS } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ChooserRow,
  ChooserView,
  DeviceRow,
  DevicesView,
  RelayProbe,
  RpcRequest,
  StateView,
} from '../lib/model'
import { unlocalizedWords } from '../lib/pseudo'
import { type FakePage, installFakePage, uninstallFakePage } from './test-dom'

/**
 * The settings page's device list (SECURITY_REVIEW L7, X13). A Remove here must
 * reach the background as `removeEndpoint`, the request whose handler writes the
 * removal into this browser's watch (rpc.test.ts, identity.test.ts), and only
 * once the user has said yes. The page is imported for real, over a stand-in DOM
 * built from options.html.
 */

const requests: RpcRequest[] = []
vi.mock('./rpc-client', () => ({
  rpcOk: vi.fn(async (req: RpcRequest) => {
    requests.push(req)
    // What rpcOk throws for a failure the background worded is a UserFacingError. The class
    // is read now, because each test loads the page afresh.
    if (req.type === 'getState' && stateFails === 'worded') {
      const { UserFacingError } = await import('../lib/relay-errors')
      throw new UserFacingError('Boom')
    }
    return answer(req)
  }),
}))
/** The page's storage listeners, so a test can land a fresh device list in the cache. */
const storageListeners: ((changes: Record<string, unknown>, area: string) => void)[] = []
/** The browser's permission to reach the relay: held already, and the prompt's answer. */
const permission = { held: true, answer: true, asked: [] as string[][] }
vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { create: vi.fn(async () => undefined) },
    runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
    storage: {
      onChanged: {
        addListener: (l: (typeof storageListeners)[number]) => storageListeners.push(l),
      },
    },
    permissions: {
      contains: vi.fn(async () => permission.held),
      request: vi.fn(async (p: { origins: string[] }) => {
        permission.asked.push(p.origins)
        return permission.answer
      }),
    },
  },
}))

const state: StateView = { registered: true, relayUrl: 'https://relay.example' }
/** What probeRelay answers; unset keeps the bare `{ ok: true }` the older tests ran against. */
let probeAnswer: RelayProbe | undefined
/** Makes getState fail, to see the page's own error line: with a sentence the background chose, or not. */
let stateFails: false | 'worded' | 'unexpected' = false

function row(endpointId: string, label: string, isSelf = false): DeviceRow {
  return { endpointId, label, isSelf, online: true, presenceKnown: true, presenceLabel: 'online' }
}

const devices: DevicesView = {
  registered: true,
  selfEndpointId: 'ep-self',
  devices: [row('ep-self', 'Chrome · Mac', true), row('ep-phone', 'Pixel 8')],
  existingDeviceNames: [],
  newDevices: [],
  review: [],
  vanished: [],
}

/** What getSettings and getChooser answer; reset before each test. */
let settings = { ...DEFAULT_CLIENT_SETTINGS }
let chooser: Partial<ChooserView> = {}

function target(id: string, label: string): ChooserRow {
  return {
    endpoint: { id, label } as ChooserRow['endpoint'],
    isPrimary: false,
    isRecent: false,
    stale: false,
    presenceKnown: true,
  }
}

function answer(req: RpcRequest): unknown {
  switch (req.type) {
    case 'getState':
      if (stateFails === 'unexpected') {
        throw new TypeError("Cannot read properties of undefined (reading 'x')")
      }
      return { ok: true, state }
    case 'probeRelay':
      return probeAnswer ? { ok: true, probe: probeAnswer } : { ok: true }
    case 'getSettings':
      return { ok: true, settings }
    case 'getChooser':
      return {
        ok: true,
        chooser: {
          registered: true,
          targets: [],
          pending: [],
          held: [],
          primaryPinned: false,
          newDevices: [],
          review: [],
          vanished: [],
          ...chooser,
        },
      }
    case 'getDevices':
      return { ok: true, devices }
    default:
      return { ok: true }
  }
}

let page: FakePage

async function openPage(): Promise<void> {
  page = installFakePage('options.html')
  vi.resetModules()
  await import('./options')
  await vi.waitFor(() => expect(page.byId('device-list').children).toHaveLength(2))
  expect(page.byId('page-error').textContent).toBe('')
}

const removals = () => requests.filter((r) => r.type === 'removeEndpoint')

beforeEach(() => {
  settings = { ...DEFAULT_CLIENT_SETTINGS }
  chooser = {}
  probeAnswer = undefined
  stateFails = false
  requests.length = 0
  storageListeners.length = 0
  Object.assign(permission, { held: true, answer: true, asked: [] })
})
afterEach(() => {
  uninstallFakePage()
})

describe('Settings: a device that joins while the page is open', () => {
  afterEach(() => {
    devices.devices = devices.devices.slice(0, 2)
  })

  it('shows up without leaving the page, read from the cache', async () => {
    await openPage()
    devices.devices = [...devices.devices, row('ep-new', 'Galaxy S24')]
    requests.length = 0
    for (const listener of storageListeners) listener({ endpointsCacheAt: {} }, 'local')
    await vi.waitFor(() => expect(page.byId('device-list').children).toHaveLength(3))
    expect(page.byId('device-list').textContent).toContain('Galaxy S24')
    expect(requests).toEqual([{ type: 'getDevices', cached: true }])
  })

  it('ignores every other change in storage', async () => {
    await openPage()
    requests.length = 0
    for (const listener of storageListeners) listener({ history: {} }, 'local')
    expect(requests).toEqual([])
  })
})

describe('Settings: removing a device', () => {
  it('sends the removal that records it in the watch, once the user says yes (X13)', async () => {
    await openPage()
    const [remove] = page.buttons('device-list', 'Remove Pixel 8')
    page.confirmAnswer.value = true
    remove?.click()

    await vi.waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toEqual({ type: 'removeEndpoint', endpointId: 'ep-phone' })
    expect(page.asked).toEqual(['Remove “Pixel 8” from the group?'])
    // The list is read again, so the device's row reflects the relay's answer.
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.type === 'getDevices').length).toBeGreaterThan(1),
    )
  })

  it('sends nothing when the user says no', async () => {
    await openPage()
    page.confirmAnswer.value = false
    page.buttons('device-list', 'Remove Pixel 8')[0]?.click()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.asked).toHaveLength(1)
    expect(removals()).toEqual([])
  })

  it('offers no Remove on this browser itself', async () => {
    await openPage()
    expect(page.buttons('device-list', 'Remove Chrome · Mac')).toEqual([])
    expect(page.buttons('device-list', 'Remove')).toHaveLength(1)
  })
})

describe("Settings: the browser's permission to reach the relay (Chrome Web Store review)", () => {
  const probes = () => requests.filter((r) => r.type === 'probeRelay')

  it("asks for a new address's host before checking it", async () => {
    await openPage()
    page.byId('new-address').value = 'https://new-relay.example:8443'
    page.byId('relay-check').click()

    await vi.waitFor(() => expect(probes()).toHaveLength(1))
    expect(permission.asked).toEqual([['https://new-relay.example/*']])
  })

  it('checks nothing, and says why, when the user says no', async () => {
    permission.answer = false
    await openPage()
    page.byId('new-address').value = 'https://new-relay.example'
    page.byId('relay-check').click()

    await vi.waitFor(() => expect(page.byId('probe-note').textContent).toContain('choose Allow'))
    expect(probes()).toEqual([])
  })

  it('says so, and offers to ask again, when the paired relay has lost it', async () => {
    permission.held = false
    await openPage()
    await vi.waitFor(() =>
      expect(page.byId('relay-status').textContent).toContain('needs your permission'),
    )
    const [allow] = page.buttons('relay-access-actions', 'Allow access')
    allow?.click()
    await vi.waitFor(() => expect(permission.asked).toEqual([['https://relay.example/*']]))
  })

  it('shows nothing extra while the permission is held', async () => {
    await openPage()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.buttons('relay-access-actions', 'Allow access')).toEqual([])
    expect(page.byId('relay-status').textContent).not.toContain('permission')
  })
})

describe('Settings: "Send in one click"', () => {
  const sent = (type: RpcRequest['type']) => requests.filter((r) => r.type === type)

  it('starts off, with the device picker hidden and the current behaviour said', async () => {
    await openPage()
    expect(page.byId('one-click').checked).toBe(false)
    expect(page.byId('one-click-on').style.display).toBe('none')
    expect(page.byId('one-click-off').style.display).toBe('block')
  })

  it('turning it on saves quick-send mode and shows the picker', async () => {
    await openPage()
    const box = page.byId('one-click')
    box.checked = true
    box.dispatch('change')
    await vi.waitFor(() =>
      expect(sent('setSettings')).toEqual([
        { type: 'setSettings', settings: { toolbarClickMode: 'quicksend' } },
      ]),
    )
    expect(page.byId('one-click-on').style.display).toBe('block')
    expect(page.byId('one-click-off').style.display).toBe('none')
  })

  it('picking a device pins it; "the device I sent to last" unpins', async () => {
    settings = { ...settings, toolbarClickMode: 'quicksend' }
    chooser = {
      targets: [target('ep-phone', 'Pixel 8'), target('ep-ipad', 'iPad')],
      primaryTargetId: 'ep-phone',
    }
    await openPage()
    const select = page.byId('send-to')
    expect(select.children.map((o) => o.textContent)).toEqual([
      'The device I sent to last',
      'Pixel 8',
      'iPad',
    ])

    select.value = 'ep-ipad'
    select.dispatch('change')
    select.value = ''
    select.dispatch('change')
    await vi.waitFor(() =>
      expect(sent('setPrimary')).toEqual([
        { type: 'setPrimary', targetEndpointId: 'ep-ipad', pinned: true },
        { type: 'setPrimary', targetEndpointId: 'ep-phone', pinned: false },
      ]),
    )
  })
})

/**
 * Every sentence this page writes with the pseudo-locale on (en-XA): each one must come
 * through a catalog message, which wraps it in brackets. A sentence typed into the code
 * would show up as plain words; only what a person supplied (an address, a device name,
 * the relay's own error text) may stand outside the brackets.
 */
describe('Settings: all text written by the page comes from the catalog', () => {
  async function openPseudoPage(): Promise<void> {
    page = installFakePage('options.html')
    vi.resetModules()
    // The same module registry as the page, so the page sees the pseudo-locale.
    const { setLocale } = await import('../lib/i18n')
    setLocale('en-XA')
    await import('./options')
  }
  /** Waits for `id` to hold text, then returns the words in it that are not catalog text. */
  async function strays(id: string, allowed: string[] = []): Promise<string[]> {
    await vi.waitFor(() => expect(page.byId(id).textContent).not.toBe(''))
    return unlocalizedWords(page.byId(id).textContent, allowed)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    delete state.pendingSwitch
    delete state.relay
    delete state.removedNotice
    state.registered = true
    state.relayUrl = 'https://relay.example'
  })

  it('the relay line, its status and the Send to choices', async () => {
    const now = Date.now()
    state.relay = {
      relayUrl: state.relayUrl,
      reachable: true,
      since: new Date(now - 60_000).toISOString(),
      lastOkAt: new Date(now).toISOString(),
    }
    chooser = { targets: [target('ep-phone', 'Pixel 8')], primaryTargetId: 'ep-phone' }
    await openPseudoPage()
    expect(await strays('relay-status')).toEqual([])
    await vi.waitFor(() => expect(page.byId('send-to').children).toHaveLength(2))
    const options = page.byId('send-to').children.map((o) => o.textContent)
    expect(options[0]?.startsWith('[')).toBe(true)
    expect(options[1]).toBe('Pixel 8')

    // No other device: the one greyed-out choice is a message too.
    chooser = {}
    await openPseudoPage()
    await vi.waitFor(() => expect(page.byId('send-to').children).toHaveLength(1))
    expect(unlocalizedWords(page.byId('send-to').textContent, [])).toEqual([])
    expect(page.byId('send-to').textContent).not.toBe('')
  })

  it('the relay line when this browser is not set up, or was removed', async () => {
    state.registered = false
    state.relayUrl = ''
    await openPseudoPage()
    expect(await strays('current-relay')).toEqual([])
    state.removedNotice = true
    await openPseudoPage()
    expect(await strays('current-relay')).toEqual([])
    expect(page.byId('current-relay').textContent).toMatch(/^\[/)
  })

  it('an outage line, and the line when the permission is gone', async () => {
    const now = Date.now()
    state.relay = {
      relayUrl: state.relayUrl,
      reachable: false,
      since: new Date(now - 10 * 60_000).toISOString(),
      lastOkAt: new Date(now - 10 * 60_000).toISOString(),
    }
    await openPseudoPage()
    expect(await strays('relay-status', [state.relayUrl])).toEqual([])

    delete state.relay
    permission.held = false
    await openPseudoPage()
    await vi.waitFor(() => expect(page.buttons('relay-access-actions', '').length).toBe(0))
    expect(await strays('relay-status', [state.relayUrl])).toEqual([])
    const [allow] = page.byId('relay-access-actions').children
    expect(allow?.textContent).toMatch(/^\[/)
  })

  it('an unfinished move to another relay: the note, the reassurance and both buttons', async () => {
    state.pendingSwitch = { relayUrl: 'https://other.example' }
    await openPseudoPage()
    expect(await strays('pending-note', ['https://other.example'])).toEqual([])
    expect(await strays('pending-sub', [state.relayUrl])).toEqual([])
    const buttons = page.byId('pending-actions').children.map((b) => b.textContent)
    expect(buttons).toHaveLength(2)
    for (const label of buttons) expect(label).toMatch(/^\[.*\]$/)

    state.registered = false
    state.relayUrl = ''
    await openPseudoPage()
    expect(await strays('pending-sub')).toEqual([])
  })

  it('what the address check says, and the buttons it offers', async () => {
    const address = 'https://new-relay.example'
    const verdicts: RelayProbe[] = [
      { verdict: 'same', relayUrl: address, verified: true },
      { verdict: 'same', relayUrl: address, verified: false },
      { verdict: 'different', relayUrl: address },
      { verdict: 'unreachable', relayUrl: address },
    ]
    for (const verdict of verdicts) {
      probeAnswer = verdict
      await openPseudoPage()
      await vi.waitFor(() => expect(page.byId('current-relay').textContent).not.toBe(''))
      page.byId('new-address').value = address
      page.byId('relay-check').click()
      await vi.waitFor(() =>
        expect(requests.filter((r) => r.type === 'probeRelay')).not.toEqual([]),
      )
      await settle()
      const note = page.byId('probe-note').textContent
      expect(note, verdict.verdict).toMatch(/^\[/)
      expect(unlocalizedWords(note, [address]), verdict.verdict).toEqual([])
      for (const action of page.byId('probe-actions').children) {
        expect(action.textContent, verdict.verdict).toMatch(/^\[.*\]$/)
      }
      requests.length = 0
    }

    // The explanation the background chose for a relay that answered with an error is shown as it is.
    probeAnswer = { verdict: 'error', relayUrl: address, detail: 'The relay said no.' }
    await openPseudoPage()
    await vi.waitFor(() => expect(page.byId('current-relay').textContent).not.toBe(''))
    page.byId('new-address').value = address
    page.byId('relay-check').click()
    await vi.waitFor(() => expect(page.byId('probe-note').textContent).toBe('The relay said no.'))

    // Said no to the browser's permission prompt.
    permission.answer = false
    await openPseudoPage()
    await vi.waitFor(() => expect(page.byId('current-relay').textContent).not.toBe(''))
    page.byId('new-address').value = address
    page.byId('relay-check').click()
    expect(await strays('probe-note')).toEqual([])
  })

  it('"Saved" after a setting changes', async () => {
    await openPseudoPage()
    await vi.waitFor(() => expect(page.byId('current-relay').textContent).not.toBe(''))
    const box = page.byId('context-menus')
    box.checked = !box.checked
    box.dispatch('change')
    expect(await strays('saved')).toEqual([])
    expect(page.byId('saved').textContent).toMatch(/^\[.*✓.*\]$/)
  })

  it('the error line when the settings cannot be read', async () => {
    stateFails = 'worded'
    await openPseudoPage()
    // The words after the colon are a sentence the background chose, passed on as it is.
    expect(await strays('page-error', ['Boom'])).toEqual([])
    expect(page.byId('page-error').textContent).toContain('Boom')
    expect(page.byId('page-error').textContent).toMatch(/^\[/)
  })

  it('the error line when something nobody planned for went wrong: a plain sentence, no exception text', async () => {
    stateFails = 'unexpected'
    await openPseudoPage()
    expect(await strays('page-error')).toEqual([])
    expect(page.byId('page-error').textContent).not.toContain('Cannot read')
    expect(page.byId('page-error').textContent).toContain('Šöɱéţĥîñĝ ŵéñţ ŵŕöñĝ')
  })
})
