import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page an uninstall opens [PLANS P-31 item 1]: set once paired, with a leave token the
 * relay minted; moved with the relay address; cleared when there is no pairing; never set
 * for a relay that has no goodbye page.
 */

const store = new Map<string, unknown>()
const changeListeners: ((changes: Record<string, unknown>, area: string) => void)[] = []
const setUninstallURL = vi.fn(async (_url: string) => {})
vi.mock('../lib/ext', () => ({
  ext: {
    runtime: { setUninstallURL: (url: string) => setUninstallURL(url) },
    storage: {
      onChanged: {
        addListener: (fn: (changes: Record<string, unknown>, area: string) => void) =>
          changeListeners.push(fn),
      },
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v)
          for (const fn of changeListeners) fn(obj, 'local')
        },
        remove: async (keys: string[]) => {
          for (const k of keys) store.delete(k)
        },
      },
    },
  },
}))

const getConfig = vi.fn(async (_relay: string) => ({ vapidPublicKey: '', goodbyePage: true }))
let minted = 0
const mintLeaveToken = vi.fn(async (_relay: string, _token: string, _id: string) => ({
  leaveToken: `leave-${++minted}`,
}))
vi.mock('../lib/api', () => ({
  getConfig: (relay: string) => getConfig(relay),
  mintLeaveToken: (relay: string, token: string, id: string) => mintLeaveToken(relay, token, id),
}))

import { registerUninstallPageSync, syncUninstallPage } from './goodbye'

const registration = {
  endpointId: 'ep-self',
  groupId: 'g1',
  deviceToken: 'dt-123',
  relayUrl: 'https://relay.example',
  label: 'Dia',
  browserName: 'Dia',
  deviceName: '',
  kind: 'extension',
  browser: 'chrome',
  platform: 'macos',
}

function lastUrl(): string | undefined {
  return setUninstallURL.mock.calls.at(-1)?.[0]
}

beforeEach(() => {
  store.clear()
  changeListeners.length = 0
  setUninstallURL.mockClear()
  getConfig.mockClear()
  mintLeaveToken.mockClear()
  minted = 0
})

describe('syncUninstallPage', () => {
  it('sets no page while unpaired', async () => {
    await syncUninstallPage()
    expect(lastUrl()).toBe('')
    expect(mintLeaveToken).not.toHaveBeenCalled()
  })

  it('asks for a leave token once paired, keeps it, and puts it in the fragment', async () => {
    store.set('registration', registration)
    await syncUninstallPage()
    expect(mintLeaveToken).toHaveBeenCalledWith('https://relay.example', 'dt-123', 'ep-self')
    expect(lastUrl()).toBe('https://relay.example/goodbye#t=leave-1')
    expect((store.get('registration') as { leaveToken?: string }).leaveToken).toBe('leave-1')
    // The next start reuses it rather than minting another.
    await syncUninstallPage()
    expect(mintLeaveToken).toHaveBeenCalledTimes(1)
    expect(lastUrl()).toBe('https://relay.example/goodbye#t=leave-1')
  })

  it('sets nothing for a relay without the goodbye page', async () => {
    getConfig.mockResolvedValueOnce({ vapidPublicKey: '' } as never)
    store.set('registration', registration)
    await syncUninstallPage()
    expect(mintLeaveToken).not.toHaveBeenCalled()
    expect(lastUrl()).toBe('')
  })

  it('sets nothing when the relay is out of reach, and tries again later', async () => {
    getConfig.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    store.set('registration', registration)
    await syncUninstallPage()
    expect(lastUrl()).toBe('')
    await syncUninstallPage()
    expect(lastUrl()).toBe('https://relay.example/goodbye#t=leave-1')
  })

  it('drops a token minted for a pairing that changed meanwhile', async () => {
    store.set('registration', registration)
    mintLeaveToken.mockImplementationOnce(async () => {
      store.set('registration', { ...registration, endpointId: 'ep-new', deviceToken: 'dt-new' })
      return { leaveToken: 'stale' }
    })
    await syncUninstallPage()
    expect((store.get('registration') as { leaveToken?: string }).leaveToken).toBeUndefined()
    expect(setUninstallURL.mock.calls.map((c) => c[0])).not.toContain(
      'https://relay.example/goodbye#t=stale',
    )
  })
})

describe('registerUninstallPageSync', () => {
  it('follows the pairing: set on pair, moved with the relay, cleared on unpair', async () => {
    registerUninstallPageSync()
    store.set('registration', registration)
    for (const fn of changeListeners) fn({ registration: {} }, 'local')
    await syncUninstallPage()
    expect(lastUrl()).toBe('https://relay.example/goodbye#t=leave-1')

    const reg = store.get('registration') as Record<string, unknown>
    store.set('registration', { ...reg, relayUrl: 'https://new.example' })
    for (const fn of changeListeners) fn({ registration: {} }, 'local')
    await syncUninstallPage()
    expect(lastUrl()).toBe('https://new.example/goodbye#t=leave-1')
    expect(mintLeaveToken).toHaveBeenCalledTimes(1)

    store.delete('registration')
    for (const fn of changeListeners) fn({ registration: {} }, 'local')
    await syncUninstallPage()
    expect(lastUrl()).toBe('')
  })

  it('ignores changes to other keys and other storage areas', async () => {
    registerUninstallPageSync()
    for (const fn of changeListeners) fn({ prefs: {} }, 'local')
    for (const fn of changeListeners) fn({ registration: {} }, 'sync')
    await Promise.resolve()
    expect(setUninstallURL).not.toHaveBeenCalled()
  })
})
