import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./endpoints', () => ({ fetchEndpoints: vi.fn() }))
vi.mock('./identity', () => ({ removeEndpoint: vi.fn(), renameEndpoint: vi.fn() }))
vi.mock('./newdevices', () => ({ currentDeviceWatch: vi.fn() }))
vi.mock('./session', () => ({ currentSession: vi.fn() }))

import type { Endpoint } from '@tabsend/shared'
import { fetchEndpoints } from './endpoints'
import { removeEndpoint, renameEndpoint } from './identity'
import { currentDeviceWatch } from './newdevices'
import { replaceOffer, replaceSelf } from './replacing'
import { currentSession } from './session'

const NOW = Date.parse('2026-11-09T12:00:00.000Z')

function ep(over: Record<string, unknown>): Endpoint {
  return {
    id: 'x',
    groupId: 'g',
    kind: 'extension',
    browser: 'chrome',
    platform: 'macos',
    label: 'x',
    e2ePubkey: 'k',
    presence: 'offline',
    lastSeenAt: '2026-10-30T08:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...over,
  } as Endpoint
}

const me: Endpoint = ep({
  id: 'me',
  label: 'Dia 2 · MacBook Pro M1 Pro',
  presence: 'online',
  lastSeenAt: '2026-11-09T11:59:00.000Z',
  createdAt: '2026-11-09T11:50:00.000Z',
})
const old = ep({ id: 'old', label: 'Dia · MacBook Pro M1 Pro' })

describe('replacing (PLANS.md P-31 item 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.mocked(currentSession).mockResolvedValue({
      registration: { endpointId: 'me' },
    } as never)
    vi.mocked(fetchEndpoints).mockResolvedValue([me, old])
    vi.mocked(currentDeviceWatch).mockResolvedValue(undefined)
    vi.mocked(removeEndpoint).mockReset().mockResolvedValue(undefined)
    vi.mocked(renameEndpoint).mockReset().mockResolvedValue(undefined)
  })

  it('offers the old offline copy of this browser', async () => {
    await expect(replaceOffer()).resolves.toEqual({
      endpointId: 'old',
      label: 'Dia · MacBook Pro M1 Pro',
      appName: 'Dia',
      lastSeenAt: '2026-10-30T08:00:00.000Z',
    })
  })

  it('never offers a device this browser removed', async () => {
    vi.mocked(currentDeviceWatch).mockResolvedValue({
      selfId: 'me',
      known: [],
      unconfirmed: [],
      removed: ['old'],
    })
    await expect(replaceOffer()).resolves.toBeNull()
  })

  it('Replace removes the old entry, then takes its name, and answers nobody', async () => {
    await expect(replaceSelf('old')).resolves.toBe(true)
    expect(removeEndpoint).toHaveBeenCalledWith('old')
    expect(renameEndpoint).toHaveBeenCalledWith('me', 'Dia · MacBook Pro M1 Pro')
    expect(vi.mocked(removeEndpoint).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(renameEndpoint).mock.invocationCallOrder[0] as number,
    )
  })

  it('does nothing when the entry is no longer the match', async () => {
    vi.mocked(fetchEndpoints).mockResolvedValue([
      me,
      ep({ id: 'old', label: old.label, presence: 'online' }),
    ])
    await expect(replaceSelf('old')).resolves.toBe(false)
    expect(removeEndpoint).not.toHaveBeenCalled()
    expect(renameEndpoint).not.toHaveBeenCalled()
  })

  it('refuses any id other than the one the rule picks', async () => {
    await expect(replaceSelf('someone-else')).resolves.toBe(false)
    expect(removeEndpoint).not.toHaveBeenCalled()
  })

  it('keeps its own name when the removal fails', async () => {
    vi.mocked(removeEndpoint).mockRejectedValue(new Error('relay down'))
    await expect(replaceSelf('old')).rejects.toThrow('relay down')
    expect(renameEndpoint).not.toHaveBeenCalled()
  })
})
