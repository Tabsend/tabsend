import type { IsoTimestamp, NewDeviceNotice } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceRow, DevicesView, RpcRequest, StateView } from '../lib/model'
import { unlocalizedWords } from '../lib/pseudo'
import { type FakePage, installFakePage, uninstallFakePage } from './test-dom'

/**
 * The manage screen at the end of first run (SECURITY_REVIEW L7, X13). It has
 * two ways to remove a device: a row of the device list, and the popup's
 * "Remove it", which lands here as `#remove=<id>`. Every one must ask first and then send `removeEndpoint`, the
 * request whose handler writes the removal into this browser's watch. The page
 * is imported for real, over a stand-in DOM built from firstrun.html.
 */

const requests: RpcRequest[] = []
vi.mock('./rpc-client', () => ({
  rpcOk: vi.fn(async (req: RpcRequest) => {
    requests.push(req)
    return answer(req)
  }),
}))
/** The page's storage listeners, so a test can land a fresh device list in the cache. */
const storageListeners: ((changes: Record<string, unknown>, area: string) => void)[] = []
/** The browser's permission prompt: what it was asked for, and the user's answer. */
const permission = { asked: [] as string[][], answer: true }
/** What the browser says about the toolbar icon: pinned or not, nothing, or an error. */
const toolbar = {
  settings: undefined as { isOnToolbar: boolean } | undefined,
  throws: false,
}
vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { create: vi.fn(async () => undefined) },
    runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
    action: {
      getUserSettings: vi.fn(async () => {
        if (toolbar.throws) throw new Error('not supported')
        return toolbar.settings
      }),
    },
    storage: {
      onChanged: {
        addListener: (l: (typeof storageListeners)[number]) => storageListeners.push(l),
      },
    },
    permissions: {
      request: vi.fn(async (p: { origins: string[] }) => {
        permission.asked.push(p.origins)
        return permission.answer
      }),
    },
  },
}))

const state: StateView = {
  registered: true,
  relayUrl: 'https://relay.example',
  selfLabel: 'Chrome · Mac',
  browserName: 'Chrome',
  deviceName: 'Mac',
}

function row(endpointId: string, label: string, isSelf = false): DeviceRow {
  return { endpointId, label, isSelf, online: true, presenceKnown: true, presenceLabel: 'online' }
}
function notice(id: string, label: string): NewDeviceNotice {
  return { id, label, createdAt: '2026-10-20T00:00:00.000Z' as IsoTimestamp }
}

let devices: DevicesView
/** What setDevice answers; unset keeps the bare `{ ok: true }` the older tests ran against. */
let deviceChosen: StateView | undefined

function answer(req: RpcRequest): unknown {
  switch (req.type) {
    case 'getState':
      return { ok: true, state }
    case 'getDevices':
      return { ok: true, devices }
    case 'setDevice':
      return deviceChosen ? { ok: true, state: deviceChosen } : { ok: true }
    default:
      return { ok: true }
  }
}

let page: FakePage

async function openPage(hash = ''): Promise<void> {
  page = installFakePage('firstrun.html', { hash })
  vi.resetModules()
  await import('./firstrun')
  await vi.waitFor(() => expect(document.body.dataset.ready).toBe('1'))
  expect(page.byId('screen-manage').classList.contains('hidden')).toBe(false)
  expect(page.byId('error').classList.contains('visible')).toBe(false)
}

const removals = () => requests.filter((r) => r.type === 'removeEndpoint')

beforeEach(() => {
  requests.length = 0
  storageListeners.length = 0
  deviceChosen = undefined
  toolbar.settings = undefined
  toolbar.throws = false
  devices = {
    registered: true,
    selfEndpointId: 'ep-self',
    devices: [
      row('ep-self', 'Chrome · Mac', true),
      row('ep-phone', 'Pixel 8'),
      row('ep-new', 'Galaxy S24'),
      row('ep-old', 'iPad'),
    ],
    existingDeviceNames: [],
    newDevices: [notice('ep-new', 'Galaxy S24')],
    review: [notice('ep-old', 'iPad')],
    vanished: [],
  }
})
afterEach(() => {
  uninstallFakePage()
})

describe('first run, manage screen: every Remove records the removal (X13)', () => {
  it('from the device list', async () => {
    await openPage()
    page.buttons('device-list', 'Remove Pixel 8')[0]?.click()

    await vi.waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toEqual({ type: 'removeEndpoint', endpointId: 'ep-phone' })
    expect(page.asked).toEqual(['Remove “Pixel 8” from the group?'])
  })

  it('from the row of a device that just joined', async () => {
    await openPage()
    page.buttons('device-list', 'Remove Galaxy S24')[0]?.click()

    await vi.waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toEqual({ type: 'removeEndpoint', endpointId: 'ep-new' })
    expect(page.asked).toEqual(['Remove “Galaxy S24” from the group?'])
  })

  it('from the popup, handed over as #remove=<id>, asked once', async () => {
    await openPage('#remove=ep-new')

    await vi.waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toEqual({ type: 'removeEndpoint', endpointId: 'ep-new' })
    expect(page.asked).toEqual(['Remove “Galaxy S24” from the group?'])
    // Dropped, so a reload does not ask again.
    expect(page.location.hash).toBe('')
  })

  it('never for this browser itself, or a device not in the list, even when asked by address', async () => {
    for (const hash of ['#remove=ep-self', '#remove=ep-stranger']) {
      await openPage(hash)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(page.asked).toEqual([])
      expect(page.location.hash).toBe('')
    }
    expect(removals()).toEqual([])
  })

  it('sends nothing from any of them when the user says no', async () => {
    await openPage()
    page.confirmAnswer.value = false
    page.buttons('device-list', 'Remove Pixel 8')[0]?.click()
    page.buttons('device-list', 'Remove Galaxy S24')[0]?.click()
    page.buttons('device-list', 'Remove iPad')[0]?.click()

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(page.asked).toEqual([
      'Remove “Pixel 8” from the group?',
      'Remove “Galaxy S24” from the group?',
      'Remove “iPad” from the group?',
    ])
    expect(removals()).toEqual([])
  })

  it('sends nothing from the popup hand-over when the user says no', async () => {
    page = installFakePage('firstrun.html', { hash: '#remove=ep-new' })
    page.confirmAnswer.value = false
    vi.resetModules()
    await import('./firstrun')
    await vi.waitFor(() => expect(page.asked).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(removals()).toEqual([])
  })
})

describe('first run, pair screen: the hosted-service offer', () => {
  async function openPairScreen(): Promise<void> {
    page = installFakePage('firstrun.html')
    vi.resetModules()
    await import('./firstrun')
    await vi.waitFor(() => expect(document.body.dataset.ready).toBe('1'))
  }
  const offerShown = () => page.byId('hosted-offer').classList.contains('visible')

  afterEach(() => {
    state.registered = true
    delete state.pendingSwitch
  })

  it('is shown to a browser that is not paired yet', async () => {
    state.registered = false
    await openPairScreen()
    expect(page.byId('screen-name').classList.contains('hidden')).toBe(false)
    expect(offerShown()).toBe(true)
  })

  it('is not shown to a browser moving to another relay', async () => {
    state.pendingSwitch = { relayUrl: 'https://other.example' }
    await openPairScreen()
    expect(page.byId('screen-name').classList.contains('hidden')).toBe(false)
    expect(offerShown()).toBe(false)
  })

  it('is not shown to a paired browser', async () => {
    await openPairScreen()
    expect(offerShown()).toBe(false)
  })
})

describe('first run, pair screen: the relay permission (Chrome Web Store review)', () => {
  const link = 'http://192.168.1.20:8080/pair#c=ABCD-1234'

  async function pairWith(answer: boolean): Promise<void> {
    state.registered = false
    permission.asked.length = 0
    permission.answer = answer
    page = installFakePage('firstrun.html')
    vi.resetModules()
    await import('./firstrun')
    await vi.waitFor(() => expect(document.body.dataset.ready).toBe('1'))
    page.byId('browser-name').value = 'Chrome'
    page.byId('pairing-link-input').value = link
    page.byId('join').click()
  }
  const joins = () => requests.filter((r) => r.type === 'joinGroup')

  afterEach(() => {
    state.registered = true
    permission.answer = true
  })

  it("asks for the relay's host, any port, before joining", async () => {
    await pairWith(true)
    await vi.waitFor(() => expect(joins()).toHaveLength(1))
    expect(permission.asked).toEqual([['http://192.168.1.20/*']])
  })

  it('does not join, and says why, when the user says no', async () => {
    await pairWith(false)
    await vi.waitFor(() => expect(page.byId('error').classList.contains('visible')).toBe(true))
    expect(page.byId('error').textContent).toContain('choose Allow')
    expect(joins()).toEqual([])
    expect(page.byId('join').disabled).toBe(false)
  })
})

describe('first run, manage screen: the tip to pin Tabsend', () => {
  const tipShown = () => page.byId('pin-note').classList.contains('visible')

  it('is shown while Tabsend is not on the toolbar', async () => {
    toolbar.settings = { isOnToolbar: false }
    await openPage()
    await vi.waitFor(() => expect(tipShown()).toBe(true))
  })

  it('is left out once the icon is pinned', async () => {
    toolbar.settings = { isOnToolbar: true }
    await openPage()
    // Let the browser's answer land before looking.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tipShown()).toBe(false)
  })

  it('is shown when the browser cannot say', async () => {
    toolbar.settings = undefined
    await openPage()
    await vi.waitFor(() => expect(tipShown()).toBe(true))

    toolbar.throws = true
    await openPage()
    await vi.waitFor(() => expect(tipShown()).toBe(true))
  })
})

describe('first run, manage screen: a device that joined (P-23)', () => {
  it('shows up while the screen is open, read from the cache', async () => {
    await openPage()
    const before = page.byId('device-list').children.length
    devices = {
      ...devices,
      devices: [...devices.devices, row('ep-joined', 'Pixel 9')],
    }
    requests.length = 0
    for (const listener of storageListeners) listener({ endpointsCacheAt: {} }, 'local')
    await vi.waitFor(() => expect(page.byId('device-list').children).toHaveLength(before + 1))
    expect(requests).toEqual([{ type: 'getDevices', cached: true }])
  })

  it('is just in the list: no card, no tag, nothing to answer', async () => {
    await openPage()
    expect(page.byId('new-devices').textContent).toBe('')
    expect(page.byId('device-list').textContent).toContain('Galaxy S24')
    expect(page.buttons('device-list', "It's mine: Galaxy S24")).toEqual([])
  })
})

/**
 * Every sentence this page writes with the pseudo-locale on (en-XA): each one must come
 * through a catalog message, which wraps it in brackets. A sentence typed into the code
 * would show up as plain words; only what a person supplied (a name, an address, the
 * background's own error text) may stand outside the brackets.
 */
describe('first run: all text written by the page comes from the catalog', () => {
  async function openPseudoPage(): Promise<void> {
    page = installFakePage('firstrun.html')
    vi.resetModules()
    // The same module registry as the page, so the page sees the pseudo-locale.
    const { setLocale } = await import('../lib/i18n')
    setLocale('en-XA')
    await import('./firstrun')
    await vi.waitFor(() => expect(document.body.dataset.ready).toBe('1'))
  }
  /** The words in `id`'s text that are not catalog text; fails if there is no text at all. */
  function strays(id: string, allowed: string[] = []): string[] {
    const text = page.byId(id).textContent
    expect(text, `#${id} is empty`).not.toBe('')
    expect(text, `#${id} is not a catalog message`).toMatch(/\[/)
    return unlocalizedWords(text, allowed)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    state.registered = true
    delete state.pendingSwitch
    delete state.removedNotice
    delete state.registeredAt
    state.browserName = 'Chrome'
  })

  it('what the pair screen says when this browser was removed from its group', async () => {
    state.registered = false
    state.removedNotice = true
    await openPseudoPage()
    expect(strays('error')).toEqual([])
  })

  it('each mistake on the pair screen and the device screen', async () => {
    state.registered = false
    await openPseudoPage()
    // The browser's own name is filled in as soon as it is known; wait, then empty it.
    await settle()
    page.byId('browser-name').value = ''
    page.byId('join').click()
    await vi.waitFor(() => expect(page.byId('error').textContent).not.toBe(''))
    expect(strays('error')).toEqual([])

    page.byId('browser-name').value = 'Chrome'
    page.byId('pairing-link-input').value = 'not a link'
    page.byId('join').click()
    await settle()
    expect(strays('error')).toEqual([])

    page.byId('pairing-link-input').value = 'http://192.168.1.20:8080/pair#c=ABCD-1234'
    page.byId('join').click()
    await vi.waitFor(() =>
      expect(page.byId('screen-device').classList.contains('hidden')).toBe(false),
    )
    page.byId('device-new').value = ''
    page.byId('device-confirm').click()
    await settle()
    expect(strays('error')).toEqual([])
  })

  it('the manage screen: who you are, and the note when a name was already taken', async () => {
    state.registered = false
    await openPseudoPage()
    await settle()
    page.byId('browser-name').value = 'Chrome'
    page.byId('pairing-link-input').value = 'http://192.168.1.20:8080/pair#c=ABCD-1234'
    state.registered = true
    deviceChosen = { ...state, browserName: 'Chrome 2' }
    page.byId('join').click()
    await vi.waitFor(() =>
      expect(page.byId('screen-device').classList.contains('hidden')).toBe(false),
    )
    page.byId('device-new').value = 'Mac'
    page.byId('device-confirm').click()
    await vi.waitFor(() =>
      expect(page.byId('screen-manage').classList.contains('hidden')).toBe(false),
    )
    expect(strays('self-label-line', ['Chrome', 'Mac'])).toEqual([])
    expect(strays('rename-note', ['Chrome', 'Mac'])).toEqual([])
    expect(page.byId('rename-note').textContent).toContain('Chrome 2')
  })

  it('the solo-group note on the manage screen', async () => {
    state.registeredAt = '2026-01-01T00:00:00.000Z'
    devices = { ...devices, devices: [row('ep-self', 'Chrome · Mac', true)] }
    await openPseudoPage()
    await vi.waitFor(() => expect(page.byId('solo-body').textContent).not.toBe(''))
    expect(strays('solo-body', [state.relayUrl])).toEqual([])
  })

  it('an unfinished move to another relay, from settings', async () => {
    state.pendingSwitch = {
      relayUrl: 'https://other.example',
      pairingLink: 'https://x.example/pair#c=AB',
    }
    await openPseudoPage()
    expect(strays('switch-target', ['https://other.example'])).toEqual([])
    expect(strays('switch-cost', [state.relayUrl])).toEqual([])
    expect(strays('switch-keep', [state.relayUrl])).toEqual([])
    expect(strays('switch-link-note')).toEqual([])

    // Nothing to keep: no pairing left to fall back on.
    state.registered = false
    await openPseudoPage()
    expect(strays('switch-target', ['https://other.example'])).toEqual([])
    expect(page.byId('switch-cost').textContent).toBe('')
  })
})
