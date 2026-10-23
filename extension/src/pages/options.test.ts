import { DEFAULT_CLIENT_SETTINGS } from '@tabsend/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceRow, DevicesView, RpcRequest, StateView } from '../lib/model'
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
    return answer(req)
  }),
}))
vi.mock('../lib/ext', () => ({
  ext: {
    tabs: { create: vi.fn(async () => undefined) },
    runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
  },
}))

const state: StateView = { registered: true, relayUrl: 'https://relay.example' }

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

function answer(req: RpcRequest): unknown {
  switch (req.type) {
    case 'getState':
      return { ok: true, state }
    case 'getSettings':
      return { ok: true, settings: DEFAULT_CLIENT_SETTINGS }
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
  requests.length = 0
})
afterEach(() => {
  uninstallFakePage()
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
