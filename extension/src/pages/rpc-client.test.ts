import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ sendMessage: vi.fn() }))

vi.mock('../lib/ext', () => ({
  ext: { runtime: { sendMessage: mocks.sendMessage } },
}))

import { rpcOk } from './rpc-client'

describe('rpcOk', () => {
  it('gives a recovery message when the background service sends no response', async () => {
    mocks.sendMessage.mockResolvedValueOnce(null)

    await expect(rpcOk({ type: 'getState' })).rejects.toThrow(/background service did not respond/i)
  })

  it('keeps a real RPC error intact', async () => {
    mocks.sendMessage.mockResolvedValueOnce({ ok: false, error: 'Relay unavailable.' })

    await expect(rpcOk({ type: 'getState' })).rejects.toThrow('Relay unavailable.')
  })
})
