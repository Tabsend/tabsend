import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboundItem } from './model'

/**
 * The outbound queue's write lock (SECURITY_REVIEW L4, L7). A drain, a new send,
 * a cancel and a re-target can all change the queue in the same second. The send
 * tests stand `updateOutbound` in with a synchronous fake, so the lock itself is
 * only exercised here, over a storage whose reads and writes each take a turn of
 * the event loop, as `chrome.storage.local`'s do.
 */

let bag: Record<string, unknown> = {}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
vi.mock('./ext', () => ({
  ext: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          await tick()
          return key in bag ? { [key]: structuredClone(bag[key]) } : {}
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          await tick()
          Object.assign(bag, structuredClone(items))
        }),
        remove: vi.fn(async () => undefined),
      },
    },
  },
}))

import { getOutbound, updateOutbound } from './storage'

function item(id: string): OutboundItem {
  return {
    id,
    targetEndpointId: 'target-1',
    envelope: {
      alg: 'x25519-xsalsa20-poly1305/box',
      senderKeyId: 's',
      targetKeyId: 't',
      nonce: 'n',
      ciphertext: id,
    },
    createdAt: '2026-10-20T00:00:00.000Z',
    attempts: 0,
  }
}

beforeEach(() => {
  bag = {}
})

describe('updateOutbound', () => {
  it('applies two changes started together one after the other, so neither is lost', async () => {
    const [first, second] = await Promise.all([
      updateOutbound((queue) => [...queue, item('a')]),
      updateOutbound((queue) => [...queue, item('b')]),
    ])
    expect(first.map((i) => i.id)).toEqual(['a'])
    expect(second.map((i) => i.id)).toEqual(['a', 'b'])
    expect((await getOutbound()).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('keeps a cancel made while a send is being queued, and the send too', async () => {
    bag = { outbound: [item('held')] }
    await Promise.all([
      updateOutbound((queue) => [...queue, item('new')]),
      updateOutbound((queue) => queue.filter((i) => i.id !== 'held')),
      updateOutbound((queue) => queue.map((i) => (i.id === 'new' ? { ...i, attempts: 1 } : i))),
    ])
    expect(await getOutbound()).toEqual([{ ...item('new'), attempts: 1 }])
  })

  it('carries on after a change that throws', async () => {
    const failed = updateOutbound(() => {
      throw new Error('bad change')
    })
    const next = updateOutbound((queue) => [...queue, item('a')])
    await expect(failed).rejects.toThrow('bad change')
    expect((await next).map((i) => i.id)).toEqual(['a'])
  })
})
