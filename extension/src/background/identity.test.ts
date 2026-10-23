import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Registration lifecycle. Two paths give up a pairing and they are not the same
 * thing: `resetRegistration` is an outright unpair (drop every RELAY-SCOPED key,
 * KEEP the device keypair + settings, remember the old URL, best-effort DELETE
 * our endpoint on the old relay and proceed with the local wipe even if that
 * fails), while a relay MOVE gives nothing up until the new relay has accepted
 * this browser. See the switchToRelay block for why.
 */

// In-memory ext.storage.local shared by storage.ts and identity.ts (same module).
const store = new Map<string, unknown>()
vi.mock('../lib/ext', () => ({
  ext: {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v)
        },
        remove: async (keys: string[]) => {
          for (const k of keys) store.delete(k)
        },
      },
    },
  },
}))

// Stub the relay API so no fetch happens; capture the best-effort delete call.
const deleteEndpoint = vi.fn(async (..._args: unknown[]) => {})
/** The group's other endpoints, as `setDeviceName` sees them when de-duplicating. */
const listEndpoints = vi.fn(async (..._args: unknown[]) => [] as { id: string; label: string }[])
vi.mock('../lib/api', () => ({
  // Same shape as the real one so `err.status === 401` checks work in tests.
  ApiClientError: class ApiClientError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  deleteEndpoint: (...args: unknown[]) => deleteEndpoint(...args),
  listEndpoints: (...args: unknown[]) => listEndpoints(...args),
  // Registration handshakes on /v1/config first; a compatible relay is the
  // default so these tests stay about registration, not version skew.
  getConfig: vi.fn(async () => ({ vapidPublicKey: '', protocol: 3, minClientProtocol: 3 })),
  probeEndpoints: vi.fn(async () => []),
  register: vi.fn(),
  updateEndpoint: vi.fn(),
}))

// The watch is covered in newdevices.test.ts; here only that a removal reaches it.
const recordRemovedEndpoint = vi.fn(async (..._args: unknown[]) => {})
vi.mock('./newdevices', () => ({
  recordRemovedEndpoint: (...args: unknown[]) => recordRemovedEndpoint(...args),
}))

import type { DeviceToken, EndpointId, GroupId } from '@tabsend/shared'
import {
  ApiClientError,
  getConfig as getConfigApi,
  probeEndpoints as probeEndpointsApi,
  register as registerApi,
  updateEndpoint as updateEndpointApi,
} from '../lib/api'
import {
  cancelSwitch,
  changeRelayUrl,
  createGroup,
  getState,
  handleAuthRejection,
  handleRemoval,
  joinGroup,
  probeOnboarding,
  probeRelay,
  removeEndpoint,
  resetRegistration,
  setDeviceName,
  switchToRelay,
} from './identity'

const registration = {
  endpointId: 'ep-self',
  groupId: 'g1',
  deviceToken: 'dt-123',
  relayUrl: 'http://localhost:8787',
  label: 'Dia · MacBook',
  browserName: 'Dia',
  deviceName: 'MacBook',
  kind: 'extension',
  browser: 'chrome',
  platform: 'macos',
}

beforeEach(() => {
  store.clear()
  deleteEndpoint.mockClear()
  deleteEndpoint.mockResolvedValue(undefined)
  recordRemovedEndpoint.mockClear()
  listEndpoints.mockClear()
  listEndpoints.mockResolvedValue([])
  // Default relay behaviour: store the label as sent and echo it back, the way a
  // relay with nothing to de-duplicate does.
  ;(updateEndpointApi as ReturnType<typeof vi.fn>).mockReset()
  ;(updateEndpointApi as ReturnType<typeof vi.fn>).mockImplementation(
    (_relayUrl: string, _token: string, id: string, body: { label: string }) =>
      Promise.resolve({ id, label: body.label }),
  )
})

/**
 * The device step is the last moment before a name goes live, and the first at
 * which the group is readable — so it's where a duplicate gets fixed without
 * asking the user anything. Matters most for browsers we can't identify (Dia,
 * Comet): they all fall back to the SAME placeholder name.
 */
describe('setDeviceName de-duplicates against the group', () => {
  const asPatch = () => (updateEndpointApi as ReturnType<typeof vi.fn>).mock.calls[0]?.[3]

  it('keeps the typed name when nothing collides', async () => {
    store.set('registration', { ...registration, browserName: 'Dia', deviceName: '' })
    listEndpoints.mockResolvedValue([{ id: 'ep-2', label: 'Firefox · MacBook' }])

    await setDeviceName('MacBook')

    expect(asPatch()).toEqual({ label: 'Dia · MacBook', deviceName: 'MacBook' })
  })

  it('counts up when the same name is already on this device', async () => {
    store.set('registration', { ...registration, browserName: 'Chrome', deviceName: '' })
    listEndpoints.mockResolvedValue([{ id: 'ep-2', label: 'Chrome · MacBook' }])

    const state = await setDeviceName('MacBook')

    expect(asPatch()).toEqual({ label: 'Chrome 2 · MacBook', deviceName: 'MacBook' })
    // The page reads the corrected name back off the state to explain itself.
    expect(state.browserName).toBe('Chrome 2')
  })

  it('ignores a same-name endpoint on ANOTHER device', async () => {
    store.set('registration', { ...registration, browserName: 'Chrome', deviceName: '' })
    listEndpoints.mockResolvedValue([{ id: 'ep-2', label: 'Chrome · Work PC' }])

    await setDeviceName('MacBook')

    expect(asPatch()).toEqual({ label: 'Chrome · MacBook', deviceName: 'MacBook' })
  })

  it('adopts the label the RELAY stored, which its own dedupe may have changed', async () => {
    // The relay sees every client; we see the ones we could list. When the two
    // disagree, this browser must show what the others see, not what it asked for.
    store.set('registration', { ...registration, browserName: 'Chrome', deviceName: '' })
    listEndpoints.mockResolvedValue([])
    ;(updateEndpointApi as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'ep-1',
      label: 'Chrome 3 · MacBook',
    })

    const state = await setDeviceName('MacBook')

    expect(asPatch()).toEqual({ label: 'Chrome · MacBook', deviceName: 'MacBook' })
    expect(state.browserName).toBe('Chrome 3')
    expect(state.selfLabel).toBe('Chrome 3 · MacBook')
  })

  it('proceeds with the typed name when the group is unreadable (offline)', async () => {
    store.set('registration', { ...registration, browserName: 'Chrome', deviceName: '' })
    listEndpoints.mockRejectedValue(new Error('offline'))

    await expect(setDeviceName('MacBook')).resolves.toBeTruthy()
    expect(asPatch()).toEqual({ label: 'Chrome · MacBook', deviceName: 'MacBook' })
  })
})

/**
 * "Remove" is only a request to the relay. Once the relay says yes the watch is told
 * at once (X13), so a relay that keeps the device listed cannot keep it on the key.
 */
describe('removeEndpoint', () => {
  it('writes the removal into the watch once the relay has accepted it', async () => {
    store.set('registration', registration)
    await removeEndpoint('ep-other')
    expect(deleteEndpoint).toHaveBeenCalledWith('http://localhost:8787', 'dt-123', 'ep-other')
    expect(recordRemovedEndpoint).toHaveBeenCalledWith('ep-self', 'ep-other')
  })

  it('counts "not found" as removed, like the phones do', async () => {
    store.set('registration', registration)
    deleteEndpoint.mockRejectedValueOnce(new ApiClientError(404, 'not_found', 'No such device'))
    await removeEndpoint('ep-other')
    expect(recordRemovedEndpoint).toHaveBeenCalledWith('ep-self', 'ep-other')
  })

  it('records nothing when the relay refuses, because nothing was removed', async () => {
    store.set('registration', registration)
    deleteEndpoint.mockRejectedValueOnce(new Error('refused'))
    await expect(removeEndpoint('ep-other')).rejects.toThrow('refused')
    expect(recordRemovedEndpoint).not.toHaveBeenCalled()
  })
})

describe('resetRegistration', () => {
  it('wipes relay-scoped state, keeps identity + settings, remembers the old relay', async () => {
    store.set('identity', { publicKey: 'pk', privateKey: 'sk', keyId: 'kid' })
    store.set('registration', registration)
    store.set('prefs', { primaryTargetId: 'ep-2', primaryPinned: true, recentTargetIds: ['ep-2'] })
    store.set('endpointsCache', [{ id: 'ep-2' }])
    store.set('pushSubscription', { endpoint: 'https://push/1' })
    store.set('pushVapidKey', 'vapid-key')
    store.set('outbound', [{ id: 'o1' }])
    store.set('pendingUndo', { id: 'u1' })
    store.set('settings', { toolbarClickMode: 'quicksend' })
    store.set('seen', [{ id: 'm1', ts: 1 }])

    await resetRegistration()

    // Best-effort removal of our own endpoint on the OLD relay.
    expect(deleteEndpoint).toHaveBeenCalledWith('http://localhost:8787', 'dt-123', 'ep-self')

    // Every relay-scoped key is gone.
    for (const key of [
      'registration',
      'prefs',
      'endpointsCache',
      'pushSubscription',
      'pushVapidKey',
      'outbound',
      'pendingUndo',
    ]) {
      expect(store.has(key), `${key} should be cleared`).toBe(false)
    }

    // Kept: the device keypair and device-local settings; seen is harmless.
    expect(store.get('identity')).toEqual({ publicKey: 'pk', privateKey: 'sk', keyId: 'kid' })
    expect(store.get('settings')).toEqual({ toolbarClickMode: 'quicksend' })
    expect(store.has('seen')).toBe(true)

    // Remembered so onboarding pre-fills it.
    expect(store.get('lastRelayUrl')).toBe('http://localhost:8787')
  })

  it('still wipes locally when the old relay refuses the delete', async () => {
    deleteEndpoint.mockRejectedValueOnce(new Error('unreachable'))
    store.set('registration', registration)

    await expect(resetRegistration()).resolves.toBeUndefined()
    expect(store.has('registration')).toBe(false)
    expect(store.get('lastRelayUrl')).toBe('http://localhost:8787')
  })

  it('no-ops when there is no registration', async () => {
    await resetRegistration()
    expect(deleteEndpoint).not.toHaveBeenCalled()
    expect(store.has('lastRelayUrl')).toBe(false)
  })
})

/**
 * Unregistered, the relay field is EMPTY — no localhost default, and no silent
 * refill with the relay just left. The previous URL rides along separately so
 * first run can offer it as a click (dogfood 2026-07-29).
 */
describe('getState unregistered', () => {
  it('carries the last relay URL as a suggestion, not as the value', async () => {
    store.set('lastRelayUrl', 'https://relay.example.com')
    expect(await getState()).toEqual({
      registered: false,
      relayUrl: '',
      previousRelayUrl: 'https://relay.example.com',
    })
  })

  it('has no relay URL at all on a fresh install', async () => {
    expect(await getState()).toEqual({ registered: false, relayUrl: '' })
  })
})

/**
 * Removed-from-group detection: the relay rejects our device token (401)
 * because another device deleted our endpoint. The endpoint is already gone
 * server-side, so unlike resetRegistration this must NOT call the relay —
 * just wipe local state, remember why, and make the install re-onboardable.
 */
describe('handleRemoval', () => {
  it('wipes the registration and flags why, without calling the relay', async () => {
    store.set('identity', { publicKey: 'pk', privateKey: 'sk', keyId: 'kid' })
    store.set('registration', registration)

    await handleRemoval()

    expect(deleteEndpoint).not.toHaveBeenCalled()
    expect(store.has('registration')).toBe(false)
    expect(store.get('lastRelayUrl')).toBe('http://localhost:8787')
    expect(store.get('removedNotice')).toBe(true)
    // Kept, same as resetRegistration.
    expect(store.get('identity')).toEqual({ publicKey: 'pk', privateKey: 'sk', keyId: 'kid' })
  })

  it('no-ops when there is no registration', async () => {
    await handleRemoval()
    expect(store.has('removedNotice')).toBe(false)
    expect(store.has('lastRelayUrl')).toBe(false)
  })

  it('surfaces through getState so onboarding can explain the removal', async () => {
    store.set('registration', registration)
    await handleRemoval()
    expect(await getState()).toEqual({
      registered: false,
      relayUrl: '',
      previousRelayUrl: 'http://localhost:8787',
      removedNotice: true,
    })
  })

  it('clears once the browser joins or creates a new group', async () => {
    store.set('registration', registration)
    await handleRemoval()
    expect(store.get('removedNotice')).toBe(true)

    vi.mocked(registerApi).mockResolvedValueOnce({
      endpointId: 'ep-new' as EndpointId,
      groupId: 'g2' as GroupId,
      deviceToken: 'dt-new' as DeviceToken,
    })
    await createGroup('http://localhost:8787', 'Dia', 'MacBook')

    expect(store.has('removedNotice')).toBe(false)
  })
})

describe('a fresh pairing', () => {
  it("drops tabs still held from an earlier one, sealed for another group's devices (L4)", async () => {
    // No registration, yet a queue: a send that failed just after an unpair.
    store.set('outbound', [
      { id: 'old', targetEndpointId: 'old-phone', createdAt: '2026-10-01T00:00:00.000Z' },
    ])
    vi.mocked(registerApi).mockResolvedValueOnce({
      endpointId: 'ep-new' as EndpointId,
      groupId: 'g2' as GroupId,
      deviceToken: 'dt-new' as DeviceToken,
    })

    await createGroup('http://localhost:8787', 'Dia', 'MacBook')

    expect(store.get('outbound')).toEqual([])
  })
})

describe('protocol handshake', () => {
  it('names a v1 relay as stale before bootstrap pairing attempts registration', async () => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 1,
      minClientProtocol: 1,
    })
    vi.mocked(registerApi).mockClear()

    await expect(createGroup('http://localhost:8787', 'Dia', 'MacBook')).rejects.toThrow(
      /Update the relay/,
    )
    expect(registerApi).not.toHaveBeenCalled()
  })

  it('reports version skew as skew, not as an unreachable relay', async () => {
    // The regression: an incompatible relay answers fine, but the failure used
    // to reach the user as "couldn't reach the relay" — sending them to check a
    // healthy server (dogfood 2026-07-26).
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 7,
      minClientProtocol: 7,
    })

    await expect(createGroup('http://localhost:8787', 'Dia', 'MacBook')).rejects.toThrow(
      /too old for that relay/,
    )
    await expect(createGroup('http://localhost:8787', 'Dia', 'MacBook')).rejects.not.toThrow(
      /reach the relay/,
    )
  })

  it('never registers against a relay it cannot talk to', async () => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 7,
      minClientProtocol: 7,
    })
    vi.mocked(registerApi).mockClear()

    await expect(createGroup('http://localhost:8787', 'Dia', 'MacBook')).rejects.toThrow()

    expect(registerApi).not.toHaveBeenCalled()
  })
})

/**
 * P-4: a mere ADDRESS change (DHCP lease, LAN → tunnel, domain move of the SAME
 * relay) must not cost a re-pair. changeRelayUrl verifies the candidate first —
 * config reachable, relayId match when both sides have one, device token
 * recognised — and only then rewrites registration.relayUrl. Every refusal must
 * leave storage exactly as it was.
 */
describe('changeRelayUrl', () => {
  const withId = { ...registration, relayId: 'relay-aaa' }
  const config = (relayId?: string) => ({
    vapidPublicKey: '',
    protocol: 1,
    minClientProtocol: 1,
    ...(relayId ? { relayId } : {}),
  })

  beforeEach(() => {
    vi.mocked(getConfigApi).mockClear()
    vi.mocked(probeEndpointsApi).mockClear()
    vi.mocked(probeEndpointsApi).mockResolvedValue([])
  })

  it('updates only the relay URL when relayId matches and the token is recognised', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-aaa'))

    const res = await changeRelayUrl('https://tunnel.example:8443/')

    expect(res).toEqual({ relayUrl: 'https://tunnel.example:8443', verified: true })
    expect(store.get('registration')).toEqual({
      ...withId,
      relayUrl: 'https://tunnel.example:8443',
    })
    // The proof call went to the NEW address with the existing token.
    expect(probeEndpointsApi).toHaveBeenCalledWith('https://tunnel.example:8443', 'dt-123')
  })

  it('refuses a different relay (relayId mismatch) and leaves storage untouched', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-bbb'))

    await expect(changeRelayUrl('https://other.example')).rejects.toThrow(/different relay/)
    expect(store.get('registration')).toEqual(withId)
    // Never even sends the token to a relay that is provably not ours.
    expect(probeEndpointsApi).not.toHaveBeenCalled()
  })

  it('refuses when the token is not recognised (401) and leaves storage untouched', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-aaa'))
    vi.mocked(probeEndpointsApi).mockRejectedValueOnce(
      new ApiClientError(401, 'unauthorized', 'Unknown device token.'),
    )

    await expect(changeRelayUrl('https://other.example')).rejects.toThrow(
      /stopped recognising this browser/,
    )
    expect(store.get('registration')).toEqual(withId)
  })

  it('fails distinctly when the new address is unreachable, touching nothing', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(changeRelayUrl('https://nowhere.example')).rejects.toThrow(/Couldn't reach/)
    expect(store.get('registration')).toEqual(withId)
    expect(probeEndpointsApi).not.toHaveBeenCalled()
  })

  it('still works with verified:false when the old relay had no relayId, and backfills it', async () => {
    store.set('registration', registration) // pre-relayId registration
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-new'))

    const res = await changeRelayUrl('https://tunnel.example')

    expect(res).toEqual({ relayUrl: 'https://tunnel.example', verified: false })
    expect(store.get('registration')).toEqual({
      ...registration,
      relayUrl: 'https://tunnel.example',
      relayId: 'relay-new',
    })
  })

  it('reports verified:false when the NEW relay has no relayId either', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config())

    const res = await changeRelayUrl('https://tunnel.example')

    expect(res.verified).toBe(false)
    // Keeps the stored id — absence on one probe is not evidence against it.
    expect(store.get('registration')).toEqual({ ...withId, relayUrl: 'https://tunnel.example' })
  })

  it('refuses when not registered', async () => {
    await expect(changeRelayUrl('https://tunnel.example')).rejects.toThrow(/not registered/)
  })
})

/**
 * The probe is what lets the UI stop asking the user to classify their own
 * situation: it answers "is this my relay at a new address, or a different relay?"
 * BEFORE anything is committed. Two invariants matter more than the verdicts —
 * it never writes storage, and it never sends the device token to a relay it can
 * already prove is not ours.
 */
describe('probeRelay', () => {
  const withId = { ...registration, relayId: 'relay-aaa' }
  const config = (relayId?: string) => ({
    vapidPublicKey: '',
    protocol: 3,
    minClientProtocol: 3,
    ...(relayId ? { relayId } : {}),
  })

  beforeEach(() => {
    vi.mocked(getConfigApi).mockClear()
    vi.mocked(probeEndpointsApi).mockClear()
    vi.mocked(probeEndpointsApi).mockResolvedValue([])
  })

  it('reports "same" for our own relay at a new address, without touching storage', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-aaa'))

    expect(await probeRelay('https://tunnel.example:8443/')).toEqual({
      verdict: 'same',
      relayUrl: 'https://tunnel.example:8443',
      verified: true,
    })
    expect(store.get('registration')).toEqual(withId)
  })

  it('reports "same" with verified:false when either side predates relayId', async () => {
    store.set('registration', registration)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-new'))

    expect(await probeRelay('https://tunnel.example')).toMatchObject({
      verdict: 'same',
      verified: false,
    })
    // Still nothing written — the backfill belongs to the commit, not the check.
    expect(store.get('registration')).toEqual(registration)
  })

  it('reports "different" on a relayId mismatch without offering up the token', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config('relay-bbb'))

    expect(await probeRelay('https://minipc.example:8786')).toEqual({
      verdict: 'different',
      relayUrl: 'https://minipc.example:8786',
    })
    expect(probeEndpointsApi).not.toHaveBeenCalled()
  })

  it('reports "different" when the relay rejects our token (a fresh relay elsewhere)', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce(config())
    vi.mocked(probeEndpointsApi).mockRejectedValueOnce(
      new ApiClientError(401, 'unauthorized', 'Unknown device token.'),
    )

    expect(await probeRelay('https://minipc.example:8786')).toEqual({
      verdict: 'different',
      relayUrl: 'https://minipc.example:8786',
    })
  })

  it('reports "unreachable" when nothing answers', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    expect(await probeRelay('https://nowhere.example')).toEqual({
      verdict: 'unreachable',
      relayUrl: 'https://nowhere.example',
    })
  })

  it('reports "error" for a relay that answers but speaks another protocol', async () => {
    store.set('registration', withId)
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 99,
      minClientProtocol: 99,
    })

    const res = await probeRelay('https://future.example')
    expect(res.verdict).toBe('error')
    expect(res).toHaveProperty('detail', expect.stringMatching(/too old for that relay/))
  })

  it('refuses when not registered', async () => {
    await expect(probeRelay('https://tunnel.example')).rejects.toThrow(/not registered/)
  })
})

/**
 * Choosing a different relay is an INTENTION, not a departure. The old pairing
 * has to survive it, because the screens that follow can be abandoned: a user
 * who opens setup, finds it wants a pairing link they no longer have, and closes
 * the tab used to be left on no relay at all with no route back (dogfood
 * 2026-08-05). Everything below pins that: nothing is given up until the new
 * relay has granted a registration, and cancelling is a complete undo.
 */
describe('switchToRelay', () => {
  /** Make the next register() call succeed with a distinct set of ids. */
  const relayAccepts = (): void => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 3,
      minClientProtocol: 3,
    })
    vi.mocked(registerApi).mockResolvedValueOnce({
      endpointId: 'ep-new' as EndpointId,
      groupId: 'g-new' as GroupId,
      deviceToken: 'dt-new' as DeviceToken,
    })
  }

  it('records the destination and leaves the current pairing alone', async () => {
    store.set('registration', registration)

    await switchToRelay('https://minipc.example:8786/')

    expect(store.get('pendingRelayUrl')).toBe('https://minipc.example:8786')
    // The point of the whole change: still paired, still able to send.
    expect(store.get('registration')).toEqual(registration)
    expect(deleteEndpoint).not.toHaveBeenCalled()
    expect(store.has('lastRelayUrl')).toBe(false)
  })

  it('carries the pasted pairing link so onboarding can re-fill it', async () => {
    store.set('registration', registration)

    await switchToRelay('https://minipc.example:8786', 'https://minipc.example:8786/pair#c=ABC123')

    expect((await getState()).pendingSwitch).toEqual({
      relayUrl: 'https://minipc.example:8786',
      pairingLink: 'https://minipc.example:8786/pair#c=ABC123',
    })
  })

  it('drops a link from an earlier move when the new one carries none', async () => {
    store.set('registration', registration)
    store.set('pendingPairingLink', 'https://old.example/pair#c=OLD999')

    await switchToRelay('https://minipc.example:8786')

    // Pre-filling old credentials for a relay the user is no longer heading to
    // would fail in a way that reads as the new relay being broken.
    expect(store.has('pendingPairingLink')).toBe(false)
  })

  it('surfaces the move alongside the live registration', async () => {
    store.set('registration', registration)
    await switchToRelay('https://minipc.example:8786')

    const state = await getState()

    expect(state.registered).toBe(true)
    expect(state.relayUrl).toBe('http://localhost:8787')
    expect(state.pendingSwitch).toEqual({ relayUrl: 'https://minipc.example:8786' })
  })

  it('hides a move that names the relay already in use', async () => {
    store.set('registration', registration)
    await switchToRelay('http://localhost:8787')

    // Nothing to continue: offering to "finish" this would send the user off to
    // re-pair with the relay they are happily on.
    expect((await getState()).pendingSwitch).toBeUndefined()
  })

  it('gives up the old registration only once the new relay accepts', async () => {
    store.set('registration', registration)
    await switchToRelay('https://minipc.example:8786')
    relayAccepts()

    await createGroup('https://minipc.example:8786', 'Chrome', 'Mini PC')

    // Ghost cleanup on the relay being left, and its URL kept as a suggestion.
    expect(deleteEndpoint).toHaveBeenCalledWith('http://localhost:8787', 'dt-123', 'ep-self')
    expect(store.get('lastRelayUrl')).toBe('http://localhost:8787')
    const state = await getState()
    expect(state.relayUrl).toBe('https://minipc.example:8786')
    expect(state.pendingSwitch).toBeUndefined()
  })

  it('still registers when the relay being left cannot be reached', async () => {
    store.set('registration', registration)
    deleteEndpoint.mockRejectedValue(new Error('network'))
    await switchToRelay('https://minipc.example:8786')
    relayAccepts()

    await createGroup('https://minipc.example:8786', 'Chrome', 'Mini PC')

    // A relay that has moved (or died) is the usual reason for the move in the
    // first place; it must not be able to block the new registration.
    expect((await getState()).relayUrl).toBe('https://minipc.example:8786')
  })

  it('keeps the old pairing when the new relay refuses', async () => {
    store.set('registration', registration)
    await switchToRelay('https://minipc.example:8786')
    vi.mocked(getConfigApi).mockRejectedValueOnce(new Error('nope'))

    await expect(createGroup('https://minipc.example:8786', 'Chrome', 'Mini PC')).rejects.toThrow()

    expect(store.get('registration')).toEqual(registration)
    expect(deleteEndpoint).not.toHaveBeenCalled()
  })

  it('is consumed by the registration it led to', async () => {
    store.set('pendingRelayUrl', 'https://minipc.example:8786')
    store.set('pendingPairingLink', 'https://minipc.example:8786/pair#c=ABC123')
    relayAccepts()

    await createGroup('https://minipc.example:8786', 'Chrome', 'Mini PC')

    expect(store.has('pendingRelayUrl')).toBe(false)
    expect(store.has('pendingPairingLink')).toBe(false)
  })
})

/** Abandoning a move: nothing was given up, so nothing has to be restored. */
describe('cancelSwitch', () => {
  it('forgets the destination and the link, and keeps the pairing', async () => {
    store.set('registration', registration)
    await switchToRelay('https://minipc.example:8786', 'https://minipc.example:8786/pair#c=ABC123')

    await cancelSwitch()

    expect(store.has('pendingRelayUrl')).toBe(false)
    expect(store.has('pendingPairingLink')).toBe(false)
    const state = await getState()
    expect(state.registered).toBe(true)
    expect(state.relayUrl).toBe('http://localhost:8787')
    expect(state.pendingSwitch).toBeUndefined()
  })

  it('is what an outright unpair does too', async () => {
    store.set('registration', registration)
    await switchToRelay('https://minipc.example:8786')

    await resetRegistration()

    // The destination was for a move that no longer has anything to move.
    expect(store.has('pendingRelayUrl')).toBe(false)
    expect((await getState()).pendingSwitch).toBeUndefined()
  })
})

describe('relayId capture at registration', () => {
  it('persists the relayId from /v1/config alongside the registration', async () => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 3,
      minClientProtocol: 3,
      relayId: 'relay-aaa',
    })
    vi.mocked(registerApi).mockResolvedValueOnce({
      endpointId: 'ep-new' as EndpointId,
      groupId: 'g2' as GroupId,
      deviceToken: 'dt-new' as DeviceToken,
    })

    await createGroup('http://localhost:8787', 'Dia', 'MacBook')

    expect(store.get('registration')).toMatchObject({ relayId: 'relay-aaa' })
  })

  it('leaves relayId absent when the relay predates it', async () => {
    vi.mocked(registerApi).mockResolvedValueOnce({
      endpointId: 'ep-new' as EndpointId,
      groupId: 'g2' as GroupId,
      deviceToken: 'dt-new' as DeviceToken,
    })

    await createGroup('http://localhost:8787', 'Dia', 'MacBook')

    expect(store.get('registration')).not.toHaveProperty('relayId')
  })
})

describe('handleAuthRejection', () => {
  it('unpairs only when the relay PROVED the endpoint was removed', async () => {
    store.set('registration', registration)

    await handleAuthRejection(true)

    expect(store.has('registration')).toBe(false)
    expect(store.get('removedNotice')).toBe(true)
  })

  it('keeps the pairing and the outbound queue on an ambiguous 401', async () => {
    // The regression: a relay restarted on an empty database answers exactly
    // this, and the extension used to unpair itself and destroy queued sends
    // over it (dogfood 2026-07-26). Waiting costs nothing; re-pairing is manual.
    store.set('registration', registration)
    store.set('outbound', [{ id: 'm1', targetEndpointId: 'ep-other', envelope: {}, attempts: 0 }])

    await handleAuthRejection(false)

    expect(store.get('registration')).toEqual(registration)
    expect(store.get('outbound')).toHaveLength(1)
    expect(store.get('authWarning')).toBe(true)
    expect(store.has('removedNotice')).toBe(false)
  })
})

/**
 * Onboarding probe (ADR-0022). It decides which affordances the first-run page offers,
 * so its failure mode matters more than its success one: when in doubt it must offer
 * BOTH options and let the register call be the authority, never hide "create" because
 * a relay was briefly unreachable.
 */
describe('probeOnboarding', () => {
  it('reports canCreate=false when the relay declines new groups', async () => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 1,
      minClientProtocol: 1,
      acceptsNewGroups: false,
    })
    expect(await probeOnboarding('http://localhost:8787')).toEqual({ canCreate: false })
  })

  it('reports canCreate=true when the relay still accepts them', async () => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 1,
      minClientProtocol: 1,
      acceptsNewGroups: true,
    })
    expect(await probeOnboarding('http://localhost:8787')).toEqual({ canCreate: true })
  })

  it('treats an older relay without the field as accepting (absent = the old behaviour)', async () => {
    vi.mocked(getConfigApi).mockResolvedValueOnce({
      vapidPublicKey: '',
      protocol: 1,
      minClientProtocol: 1,
    })
    expect(await probeOnboarding('http://localhost:8787')).toEqual({ canCreate: true })
  })

  it('never throws, and stays permissive when the relay is unreachable', async () => {
    vi.mocked(getConfigApi).mockRejectedValueOnce(new Error('Failed to fetch'))
    expect(await probeOnboarding('http://localhost:8787')).toEqual({ canCreate: true })
  })
})

/**
 * The device cap refusing a join [0030]. A relay error envelope normally rides
 * through verbatim, which is right for `group_exists` and the pairing-code
 * refusals: those messages name a fix nobody else knows. This one does not ride
 * through, because the sentence is a cross-client decision and `error.message`
 * is explicitly allowed to change (types.ts §10b).
 *
 * The failure this replaces: `limit_reached` was missing from the code table, so
 * a relay behaving exactly as configured read as an internal fault.
 */
describe('a group that is already full', () => {
  it('says which device to remove instead of blaming the relay', async () => {
    vi.mocked(registerApi).mockRejectedValueOnce(
      new ApiClientError(409, 'limit_reached', 'This group already has the most devices (3).'),
    )

    await expect(joinGroup('http://localhost:8787', 'ABC123', 'Dia')).rejects.toThrow(
      'Your relay has reached its device limit for your group. Remove a device you are not using, then pair this one again.',
    )
  })

  it('leaves the browser unpaired rather than half-registered', async () => {
    vi.mocked(registerApi).mockRejectedValueOnce(
      new ApiClientError(409, 'limit_reached', 'This group already has the most devices (3).'),
    )

    await expect(joinGroup('http://localhost:8787', 'ABC123', 'Dia')).rejects.toThrow()

    expect(store.has('registration')).toBe(false)
  })

  // Every other code keeps the relay's own words: it can name a number this
  // build has no way to know.
  it('still passes a relay message through for the codes that carry one', async () => {
    vi.mocked(registerApi).mockRejectedValueOnce(
      new ApiClientError(409, 'group_exists', 'This relay already hosts a group.'),
    )

    await expect(createGroup('http://localhost:8787', 'Dia', 'MacBook')).rejects.toThrow(
      'This relay already hosts a group.',
    )
  })
})
