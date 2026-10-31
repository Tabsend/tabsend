import type { IsoTimestamp, NewDeviceNotice } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceRow, DevicesView, RpcRequest, StateView } from '../lib/model'
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
/** The browser's permission prompt: what it was asked for, and the user's answer. */
const permission = { asked: [] as string[][], answer: true }
vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { create: vi.fn(async () => undefined) },
    runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
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

function answer(req: RpcRequest): unknown {
  switch (req.type) {
    case 'getState':
      return { ok: true, state }
    case 'getDevices':
      return { ok: true, devices }
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

describe('first run, manage screen: a device that joined (P-23)', () => {
  it('is just in the list: no card, no tag, nothing to answer', async () => {
    await openPage()
    expect(page.byId('new-devices').textContent).toBe('')
    expect(page.byId('device-list').textContent).toContain('Galaxy S24')
    expect(page.buttons('device-list', "It's mine: Galaxy S24")).toEqual([])
  })
})
