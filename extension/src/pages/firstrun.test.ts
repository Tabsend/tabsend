import type { IsoTimestamp, NewDeviceNotice } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceRow, DevicesView, RpcRequest, StateView } from '../lib/model'
import { type FakePage, installFakePage, uninstallFakePage } from './test-dom'

/**
 * The manage screen at the end of first run (SECURITY_REVIEW L7, X13). It has
 * four ways to remove a device: the device list, the "new device" banner, the
 * first-look card, and the popup's "Remove it", which lands here as
 * `#remove=<id>`. Every one must ask first and then send `removeEndpoint`, the
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
vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { create: vi.fn(async () => undefined) },
    runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
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

  it('from the "new device" banner', async () => {
    await openPage()
    const [remove] = page.buttons('new-devices', 'Remove it')
    remove?.click()

    await vi.waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toEqual({ type: 'removeEndpoint', endpointId: 'ep-new' })
    expect(page.asked).toEqual(['Remove “Galaxy S24” from the group?'])
  })

  it('from the first-look card', async () => {
    await openPage()
    page.buttons('new-devices', 'Remove iPad')[0]?.click()

    await vi.waitFor(() => expect(removals()).toHaveLength(1))
    expect(removals()[0]).toEqual({ type: 'removeEndpoint', endpointId: 'ep-old' })
    expect(page.asked).toEqual(['Remove “iPad” from the group?'])
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
    page.buttons('new-devices', 'Remove it')[0]?.click()
    page.buttons('new-devices', 'Remove iPad')[0]?.click()

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
