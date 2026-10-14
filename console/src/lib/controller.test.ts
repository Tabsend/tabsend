import type { Endpoint, EndpointId, GroupKeyRecord } from '@tabsend/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import type { FetchLike } from './api'
import { Controller } from './controller'
import { generateKeyPair, type KeyPairB64, keyId } from './crypto'
import {
  groupHistoryRow,
  makeEndpoint,
  makeGroupKey,
  sealedGroupBlob,
  sealedKeyDelivery,
} from './fixtures'
import type { ConsoleSession, HistoryEntry } from './model'
import { InMemoryHistoryStore } from './persist'
import { loadNewDeviceWatch, MemoryKv, saveSession } from './session'

/**
 * The controller's group-history wiring [ADR-0028], driven through a fake relay.
 *
 * Started through `init()`, because the order it does things in is part of what is
 * being checked: the local cache renders first, then the relay is asked. The live
 * path is torn down immediately after; it has nothing to do with this.
 */

const NOW = Date.parse('2026-08-05T12:00:00.000Z')

let consoleKp: KeyPairB64
let senderKp: KeyPairB64
let session: ConsoleSession
let groupKey: GroupKeyRecord

beforeAll(async () => {
  consoleKp = await generateKeyPair()
  senderKp = await generateKeyPair()
  session = {
    relayUrl: '',
    endpointId: 'console-1',
    groupId: 'group-1',
    deviceToken: 'tok',
    label: 'Web console',
    publicKey: consoleKp.publicKey,
    privateKey: consoleKp.privateKey,
    keyId: await keyId(consoleKp.publicKey),
  }
  groupKey = await makeGroupKey('2026-08-01T00:00:00.000Z')
})

function endpoints(): Endpoint[] {
  return [
    makeEndpoint({
      id: 'sender-1' as EndpointId,
      label: 'Chrome · Work',
      e2ePubkey: senderKp.publicKey,
    }),
    makeEndpoint({ id: 'target-1' as EndpointId, label: 'Pixel · Phone', kind: 'mobile' }),
    makeEndpoint({
      id: 'console-1' as EndpointId,
      label: 'Web console',
      kind: 'console',
      e2ePubkey: consoleKp.publicKey,
    }),
  ]
}

interface Relay {
  /** Route → JSON body, a status to fail with, or a function giving the body per call. */
  routes: Record<string, unknown | { status: number; code: string }>
  calls: string[]
}

function fakeRelay(routes: Relay['routes']): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const route = routes[url]
    const hit = typeof route === 'function' ? (route as () => unknown)() : route
    if (hit && typeof hit === 'object' && 'status' in hit && 'code' in hit) {
      const fail = hit as { status: number; code: string }
      return new Response(JSON.stringify({ error: { code: fail.code, message: fail.code } }), {
        status: fail.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(hit ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as FetchLike
  return { fetchImpl, calls }
}

/** Boot a console that is already paired, then stop its timers. */
async function startController(routes: Relay['routes'], store = new InMemoryHistoryStore()) {
  const { fetchImpl, calls } = fakeRelay({ '/v1/config': { vapidPublicKey: '' }, ...routes })
  const kv = new MemoryKv()
  saveSession(session, kv)
  const controller = new Controller({
    kv,
    store,
    fetchImpl,
    now: () => NOW,
    detectPlatform: () => 'macos',
  })
  await controller.init()
  controller.teardown() // no poll loop, no socket: this is about the fetch/merge path
  return { controller, calls, store }
}

async function modernRelayRoutes() {
  const delivery = await sealedKeyDelivery({
    sourceEndpointId: 'sender-1',
    record: groupKey,
    targetPubkeyB64: consoleKp.publicKey,
    senderPrivkeyB64: senderKp.privateKey,
    senderPubkeyB64: senderKp.publicKey,
  })
  const blob = await sealedGroupBlob(
    {
      payload: {
        url: 'https://example.com/article',
        title: 'An Article',
        sentAt: '2026-08-05T11:59:00.000Z' as never,
      },
      sourceLabelAtSend: 'Chrome · Work',
      targetLabelAtSend: 'Pixel · Phone',
    },
    groupKey,
  )
  const stranger = await makeGroupKey('2026-08-03T00:00:00.000Z')
  const unreadable = await sealedGroupBlob(
    {
      payload: { url: 'https://secret.example', sentAt: '2026-08-05T11:58:00.000Z' as never },
      sourceLabelAtSend: 'Chrome · Work',
      targetLabelAtSend: 'Pixel · Phone',
    },
    stranger,
  )
  return {
    '/v1/endpoints': endpoints(),
    '/v1/group-keys': [delivery],
    '/v1/messages?history=1': [
      groupHistoryRow({
        id: 'send-1' as never,
        blob,
        createdAt: '2026-08-05T11:59:00.000Z' as never,
        ackedAt: '2026-08-05T11:59:30.000Z' as never,
      }),
      // Sealed under a key this console never received, and expired unacked: the
      // two things a per-console copy could never have told anyone.
      groupHistoryRow({
        id: 'send-2' as never,
        blob: unreadable,
        createdAt: '2026-08-05T11:58:00.000Z' as never,
        expiresAt: '2026-08-04T00:00:00.000Z' as never,
      }),
    ],
    '/v1/messages?pending=1': [],
  }
}

describe('reading group history through the controller', () => {
  it('collects the key, reads the group, and keeps the row it cannot open', async () => {
    const { controller } = await startController(await modernRelayRoutes())

    expect(controller.groupHistory.get()).toBe('ready')
    expect(controller.keyring.get()).toHaveLength(1)

    const rows = controller.history.get()
    expect(rows.map((r) => r.id)).toEqual(['send-1', 'send-2'])
    expect(rows[0]!.url).toBe('https://example.com/article')
    expect(rows[0]!.delivery?.ackedAt).not.toBeNull()
    // The transfer this console holds no key for is still listed, without content.
    expect(rows[1]!.url).toBeUndefined()
    expect(rows[1]!.delivery).toBeDefined()
  })

  it('shows a transfer between two OTHER devices, which a copy could never do', async () => {
    const { controller } = await startController(await modernRelayRoutes())
    const row = controller.history.get()[0]!
    expect(row.sourceEndpointId).toBe('sender-1')
    expect(row.targetEndpointId).toBe('target-1')
    expect(row.targetEndpointId).not.toBe(session.endpointId)
  })
})

describe('a relay that predates group history', () => {
  const oldRelay = (): Relay['routes'] => ({
    '/v1/endpoints': endpoints(),
    // The refusals a pre-ADR-0028 relay actually gives.
    '/v1/group-keys': { status: 404, code: 'not_found' },
    '/v1/messages?history=1': { status: 400, code: 'invalid_request' },
    '/v1/messages?pending=1': [],
  })

  const copy: HistoryEntry = {
    id: 'copy-1',
    sourceEndpointId: 'sender-1',
    targetEndpointId: 'target-1',
    url: 'https://example.com/older',
    sentAt: '2026-08-04T09:00:00.000Z',
    recordedAt: '2026-08-04T09:00:01.000Z',
    sourceLabelAtSend: 'Chrome · Work',
    targetLabelAtSend: 'Pixel · Phone',
  }

  it('falls back to the ADR-0010 copies instead of breaking or erroring', async () => {
    const store = new InMemoryHistoryStore()
    await store.put(copy)
    const { controller } = await startController(oldRelay(), store)

    expect(controller.groupHistory.get()).toBe('unavailable')
    expect(controller.status.get().kind).not.toBe('error') // no banner: this is a state
    expect(controller.connection.get()).toBe('polling') // still connected, still polling
    expect(controller.history.get().map((e) => e.id)).toEqual(['copy-1'])
  })

  it('renders an empty list rather than looking broken when there is nothing at all', async () => {
    const { controller } = await startController(oldRelay())
    expect(controller.history.get()).toEqual([])
    expect(controller.status.get().kind).not.toBe('error')
  })

  it('stops asking for a while, so an old relay is not probed twice per poll forever', async () => {
    const { controller, calls } = await startController(oldRelay())
    await controller.refresh()

    expect(calls.filter((c) => c === '/v1/group-keys')).toHaveLength(1)
    // Never even reached: the key route's 404 already settled it for this relay.
    expect(calls.filter((c) => c === '/v1/messages?history=1')).toHaveLength(0)
    // The endpoint list is still fetched every time: devices are unaffected.
    expect(calls.filter((c) => c === '/v1/endpoints').length).toBeGreaterThan(1)
  })
})

describe('an outage', () => {
  it('is never mistaken for a relay without group history', async () => {
    const { controller } = await startController({
      '/v1/endpoints': endpoints(),
      '/v1/group-keys': { status: 503, code: 'internal' },
      '/v1/messages?history=1': { status: 503, code: 'internal' },
      '/v1/messages?pending=1': [],
    })

    // 'unknown', not 'unavailable': a blip must not switch the console into
    // fallback for the life of the tab.
    expect(controller.groupHistory.get()).toBe('unknown')
  })
})

describe('the new device joined notice (PLANS.md P-10)', () => {
  async function boot(routes: Relay['routes'], kv = new MemoryKv()) {
    const { fetchImpl } = fakeRelay(routes)
    saveSession(session, kv)
    const controller = new Controller({
      kv,
      store: new InMemoryHistoryStore(),
      fetchImpl,
      now: () => NOW,
      detectPlatform: () => 'macos',
    })
    await controller.init()
    controller.teardown()
    return { controller, kv }
  }

  it('takes the first list silently, then shows a device that appears later', async () => {
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const { controller } = await boot(routes)
    expect(controller.newDevices.get()).toEqual([])

    // Added straight into the relay's list, with no stream event: the fetch alone must catch it.
    const intruder = makeEndpoint({ id: 'x-1' as EndpointId, label: 'Firefox · Linux' })
    routes['/v1/endpoints'] = [...endpoints(), intruder]
    await controller.refresh()
    expect(controller.newDevices.get().map((n) => n.label)).toEqual(['Firefox · Linux'])
  })

  it('keeps the banner across a reload until answered, and forgets it on unpair', async () => {
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const first = await boot(routes)
    routes['/v1/endpoints'] = [...endpoints(), makeEndpoint({ id: 'x-1' as EndpointId })]
    await first.controller.refresh()

    const reloaded = await boot(routes, first.kv)
    expect(reloaded.controller.newDevices.get().map((n) => n.id)).toEqual(['x-1'])
    reloaded.controller.confirmNewDevice('x-1')
    expect(reloaded.controller.newDevices.get()).toEqual([])

    const again = await boot(routes, first.kv)
    expect(again.controller.newDevices.get()).toEqual([])
    again.controller.unpair()
    expect(again.kv.getItem('tabsend.console.newdevices.v1')).toBeNull()
  })

  it('refuses a list without this console: keeps the last list, announces nothing', async () => {
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const { controller } = await boot(routes)
    const intruder = makeEndpoint({ id: 'x-1' as EndpointId, label: 'Firefox · Linux' })
    routes['/v1/endpoints'] = [...endpoints().filter((e) => e.id !== 'console-1'), intruder]
    await controller.refresh()
    expect(controller.endpoints.get().map((e) => e.id)).not.toContain('x-1')
    expect(controller.newDevices.get()).toEqual([])
    expect(controller.connection.get()).not.toBe('offline')
  })

  it('asks once about the first list, keeps asking across a reload, and stops when answered (GH6)', async () => {
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const first = await boot(routes)
    expect(first.controller.review.get().map((n) => n.label)).toEqual([
      'Chrome · Work',
      'Pixel · Phone',
    ])
    expect(first.controller.newDevices.get()).toEqual([])

    const reloaded = await boot(routes, first.kv)
    expect(reloaded.controller.review.get()).toHaveLength(2)
    reloaded.controller.confirmReview()
    expect(reloaded.controller.review.get()).toEqual([])

    const again = await boot(routes, first.kv)
    expect(again.controller.review.get()).toEqual([])
    again.controller.unpair()
    expect(again.controller.review.get()).toEqual([])
  })

  it('keeps a device that joined and then disappeared on screen until dismissed (GH7)', async () => {
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const { controller, kv } = await boot(routes)
    routes['/v1/endpoints'] = [
      ...endpoints(),
      makeEndpoint({ id: 'x-1' as EndpointId, label: 'Firefox · Linux', e2ePubkey: 'pk-x1' }),
    ]
    await controller.refresh()
    expect(controller.newDevices.get().map((n) => n.id)).toEqual(['x-1'])

    routes['/v1/endpoints'] = endpoints()
    await controller.refresh()
    expect(controller.newDevices.get()).toEqual([])
    expect(controller.vanished.get().map((n) => n.label)).toEqual(['Firefox · Linux'])

    const reloaded = await boot(routes, kv)
    expect(reloaded.controller.vanished.get()).toHaveLength(1)
    reloaded.controller.dismissVanished('x-1')
    expect(reloaded.controller.vanished.get()).toEqual([])
    expect((await boot(routes, kv)).controller.vanished.get()).toEqual([])
  })

  it('stays quiet about a device this console removed itself (GH7)', async () => {
    const ex = makeEndpoint({ id: 'x-1' as EndpointId, label: 'Firefox · Linux' })
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const { controller } = await boot(routes)
    routes['/v1/endpoints'] = [...endpoints(), ex]
    await controller.refresh()
    routes['/v1/endpoints'] = endpoints()
    await controller.remove('x-1')
    expect(controller.vanished.get()).toEqual([])
  })

  it('writes its own removal into the watch, so a relay that keeps the device listed is caught (X13)', async () => {
    // "Remove" is only a request. The relay answers it and goes on listing the
    // device, and that device sends this console a key of its own.
    const exKp = await generateKeyPair()
    const ex = makeEndpoint({
      id: 'x-1' as EndpointId,
      label: 'Firefox · Linux',
      e2ePubkey: exKp.publicKey,
    })
    const planted = await makeGroupKey('2026-08-04T00:00:00.000Z')
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': [...endpoints(), ex],
    }
    const { controller, kv } = await boot(routes)
    expect(controller.newDevices.get()).toEqual([])

    await controller.remove('x-1')
    // The refresh that follows still shows it, so it is announced as a new device.
    expect(controller.newDevices.get().map((n) => n.id)).toEqual(['x-1'])
    expect(loadNewDeviceWatch(kv)?.removed).toEqual(['x-1'])
    expect(loadNewDeviceWatch(kv)?.rotateFor).toEqual(['x-1'])

    // The relay still lists it, and it hands this console a key.
    routes['/v1/group-keys'] = [
      await sealedKeyDelivery({
        sourceEndpointId: 'x-1',
        record: planted,
        targetPubkeyB64: consoleKp.publicKey,
        senderPrivkeyB64: exKp.privateKey,
        senderPubkeyB64: exKp.publicKey,
      }),
    ]
    await controller.refresh()
    expect(controller.keyring.get().map((k) => k.keyId)).not.toContain(planted.keyId)
  })

  it('counts "not found" on a removal as done, like the phones and the extension', async () => {
    const ex = makeEndpoint({ id: 'x-1' as EndpointId, label: 'Firefox · Linux' })
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': [...endpoints(), ex],
    }
    const { controller, kv } = await boot(routes)
    routes['/v1/endpoints/x-1'] = { status: 404, code: 'not_found' }
    await controller.remove('x-1')
    expect(loadNewDeviceWatch(kv)?.removed).toEqual(['x-1'])
  })

  it('watches the list the key sync re-fetches for an unknown sender', async () => {
    // A copy from a sender the console has not listed makes the key sync fetch the
    // list again. That fetch used to skip the watch, so a relay could trigger it
    // and slip a device past the notice.
    const intruderKp = await generateKeyPair()
    const intruder = makeEndpoint({
      id: 'x-1' as EndpointId,
      label: 'Firefox · Linux',
      e2ePubkey: intruderKp.publicKey,
    })
    const routes: Relay['routes'] = {
      '/v1/config': { vapidPublicKey: '' },
      '/v1/endpoints': endpoints(),
    }
    const { controller } = await boot(routes)
    let fetches = 0
    routes['/v1/endpoints'] = () => (++fetches === 1 ? endpoints() : [...endpoints(), intruder])
    routes['/v1/group-keys'] = [
      await sealedKeyDelivery({
        sourceEndpointId: 'x-1',
        record: groupKey,
        targetPubkeyB64: consoleKp.publicKey,
        senderPrivkeyB64: intruderKp.privateKey,
        senderPubkeyB64: intruderKp.publicKey,
      }),
    ]
    await controller.refresh()
    expect(fetches).toBe(2)
    expect(controller.newDevices.get().map((n) => n.id)).toEqual(['x-1'])
  })
})
