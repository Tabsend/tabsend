import type {
  Endpoint,
  GroupKeyDelivery,
  GroupKeyRecord,
  GroupKeyRequest,
  IsoTimestamp,
  NewDeviceWatch,
} from '@tabsend/shared'
import { confirmNewDevice, removeDevice, watchDevices } from '@tabsend/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generateGroupKey,
  generateKeyPair,
  groupKeyId,
  type KeyPairB64,
  keyId,
  seal,
} from '../lib/crypto'

/**
 * The extension's key sync (ADR-0028 §4-§7), against a fake relay and real
 * crypto. Added by the 2026-10-13 group-history review, which found this path
 * had no test at all: a list without this device still decided who got the key,
 * a crafted `createdAt` was accepted, and nothing ever rotated.
 */

const h = vi.hoisted(() => {
  const state = {
    cache: [] as Endpoint[],
    ring: [] as GroupKeyRecord[],
    delivered: [] as string[],
    watch: undefined as NewDeviceWatch | undefined,
    incoming: [] as GroupKeyDelivery[],
    posted: [] as GroupKeyRequest[],
    selfId: 'me',
    identity: { keyId: '', privateKey: '' },
    failFetch: false,
    unsupportedAt: undefined as number | undefined,
  }
  return { state }
})

vi.mock('../lib/api', () => ({
  getGroupKeys: vi.fn(async () => {
    if (h.state.failFetch) throw new Error('relay down')
    return h.state.incoming
  }),
  postGroupKeys: vi.fn(async (_url: string, _token: string, body: GroupKeyRequest) => {
    h.state.posted.push(body)
    return { accepted: body.items.map((i) => i.id), rejected: [] }
  }),
  isHistoryUnsupported: () => false,
}))
vi.mock('../lib/storage', () => ({
  getCachedEndpoints: vi.fn(async () => h.state.cache),
  getGroupKeys: vi.fn(async () => h.state.ring),
  setGroupKeys: vi.fn(async (v: GroupKeyRecord[]) => {
    h.state.ring = v
  }),
  getDeliveredKeys: vi.fn(async () => h.state.delivered),
  setDeliveredKeys: vi.fn(async (v: string[]) => {
    h.state.delivered = v
  }),
  getHistoryUnsupportedAt: vi.fn(async () => h.state.unsupportedAt),
  setHistoryUnsupportedAt: vi.fn(async () => {}),
  clearHistoryUnsupportedAt: vi.fn(async () => {}),
}))
vi.mock('./endpoints', () => ({ fetchEndpoints: vi.fn(async () => h.state.cache) }))
vi.mock('./newdevices', async () => {
  const { rotationDone } =
    await vi.importActual<typeof import('@tabsend/shared')>('@tabsend/shared')
  return {
    currentDeviceWatch: vi.fn(async () => h.state.watch),
    markRotationDone: vi.fn(async (owedAt: string) => {
      if (h.state.watch) h.state.watch = rotationDone(h.state.watch, owedAt)
    }),
  }
})
vi.mock('./session', () => ({
  currentSession: vi.fn(async () => ({
    registration: { relayUrl: 'http://relay', deviceToken: 't', endpointId: h.state.selfId },
    identity: h.state.identity,
  })),
}))

const { syncGroupKeys } = await import('./groupkeys')

const me = await generateKeyPair()
const phone = await generateKeyPair()
const evil = await generateKeyPair()

function ep(id: string, pair: KeyPairB64, kind: Endpoint['kind'] = 'extension'): Endpoint {
  return {
    id,
    label: id,
    groupId: 'g',
    kind,
    browser: 'chrome',
    platform: 'macos',
    e2ePubkey: pair.publicKey,
    presence: 'online',
    lastSeenAt: '2026-10-13T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
  } as Endpoint
}

/** A copy of `record` sealed by `from` to this device, as the relay would hand it over. */
async function copyFrom(
  from: KeyPairB64,
  record: GroupKeyRecord,
  id = 'c1',
): Promise<GroupKeyDelivery> {
  const box = await seal(JSON.stringify(record), me.publicKey, from.privateKey)
  return {
    id,
    sourceEndpointId: 'x',
    targetEndpointId: 'me',
    envelope: {
      alg: 'x25519-xsalsa20-poly1305/box',
      senderKeyId: await keyId(from.publicKey),
      targetKeyId: await keyId(me.publicKey),
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    },
    createdAt: '2026-10-13T00:00:00.000Z',
  } as unknown as GroupKeyDelivery
}

async function record(createdAt: string): Promise<GroupKeyRecord> {
  const key = await generateGroupKey()
  return { key, keyId: await groupKeyId(key), createdAt } as GroupKeyRecord
}

/** A list the new-device watch has accepted: in the cache and in the watch. */
function accept(list: Endpoint[]): void {
  h.state.cache = list
  h.state.watch = {
    selfId: 'me',
    known: list.map((e) => e.id),
    unconfirmed: [],
    keys: Object.fromEntries(list.map((e) => [e.id, e.e2ePubkey])),
  }
}

function postedTargets(): string[] {
  return h.state.posted.flatMap((b) => b.items.map((i) => i.targetEndpointId as string))
}

beforeEach(async () => {
  h.state.cache = []
  h.state.ring = []
  h.state.delivered = []
  h.state.watch = undefined
  h.state.incoming = []
  h.state.posted = []
  h.state.selfId = 'me'
  h.state.failFetch = false
  h.state.unsupportedAt = undefined
  h.state.identity = { keyId: await keyId(me.publicKey), privateKey: me.privateKey }
})

describe('a list without this device', () => {
  it('hands the key to nobody in it and trusts no copy from it', async () => {
    h.state.ring = [await record('2026-10-01T00:00:00.000Z')]
    // The relay leaves this browser out and slips in a device of its own.
    h.state.cache = [ep('phone', phone), ep('evil', evil)]
    h.state.incoming = [await copyFrom(evil, await record('2026-10-12T00:00:00.000Z'))]
    const ring = await syncGroupKeys()
    expect(postedTargets()).toEqual([])
    expect(ring).toHaveLength(1)
  })
})

describe('createdAt on a received key', () => {
  for (const createdAt of [
    'Wed, 31 Dec 9999 00:00:00 GMT',
    '9999-12-31T23:59:59.999Z',
    '2026-10-12T00:00:00Z',
  ]) {
    it(`refuses ${createdAt}`, async () => {
      accept([ep('me', me), ep('phone', phone)])
      h.state.incoming = [await copyFrom(phone, await record(createdAt))]
      const ring = await syncGroupKeys()
      expect(ring.map((k) => k.createdAt)).not.toContain(createdAt)
    })
  }

  it('accepts a canonical date from a member', async () => {
    accept([ep('me', me), ep('phone', phone)])
    const good = await record('2026-10-12T00:00:00.000Z')
    h.state.incoming = [await copyFrom(phone, good)]
    const ring = await syncGroupKeys()
    expect(ring.map((k) => k.keyId)).toContain(good.keyId)
  })

  it('refuses a record whose keyId is not the fingerprint of its key', async () => {
    accept([ep('me', me), ep('phone', phone)])
    const real = await record('2026-10-12T00:00:00.000Z')
    const swapped = { ...(await record('2026-10-12T00:00:00.000Z')), keyId: real.keyId }
    h.state.incoming = [await copyFrom(phone, swapped)]
    const ring = await syncGroupKeys()
    expect(ring.map((k) => k.key)).not.toContain(swapped.key)
  })

  it('refuses a key that is not 32 bytes', async () => {
    accept([ep('me', me), ep('phone', phone)])
    const key = 'AAAA'
    const short = { key, keyId: await groupKeyId(key), createdAt: '2026-10-12T00:00:00.000Z' }
    h.state.incoming = [await copyFrom(phone, short as GroupKeyRecord)]
    const ring = await syncGroupKeys()
    expect(ring.map((k) => k.keyId)).not.toContain(short.keyId)
  })
})

describe('rotation when a device has left', () => {
  const owedAt = '2026-10-12T08:00:00.000Z' as IsoTimestamp

  it('mints a new current key, hands it only to who is left, and clears the debt', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone)])
    h.state.delivered = [`gk-${old.keyId}-phone`, `gk-${old.keyId}-evil`]
    h.state.watch = {
      ...h.state.watch!,
      rotateOwedAt: owedAt,
      rotateFrom: old.createdAt,
      rotateFor: ['evil', 'ghost'],
    }
    const ring = await syncGroupKeys()
    expect(ring).toHaveLength(2)
    expect(ring[0]?.keyId).not.toBe(old.keyId)
    // It names the devices it replaces (sorted), so others can tell it from a key that merely arrived later.
    expect(ring[0]?.departed).toEqual(['evil', 'ghost'])
    expect(postedTargets()).toEqual(['phone'])
    expect(h.state.posted[0]?.items[0]?.id).toBe(`gk-${ring[0]?.keyId}-phone`)
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
    expect(h.state.watch?.rotateFrom).toBeUndefined()
    expect(h.state.watch?.rotateFor).toBeUndefined()
  })

  it('does not mint again when another device already rotated, and settles the debt', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    // Dated BEFORE this device noticed the departure (its clock is behind ours),
    // and still a rotation, because it is newer than the key that was current.
    const theirs = await record('2026-10-12T07:59:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone)])
    h.state.incoming = [await copyFrom(phone, theirs)]
    h.state.watch = { ...h.state.watch!, rotateOwedAt: owedAt, rotateFrom: old.createdAt }
    const ring = await syncGroupKeys()
    expect(ring.map((k) => k.keyId)).toEqual([theirs.keyId, old.keyId])
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
  })

  it('still rotates past a key planted ahead of the clock before the departure', async () => {
    // A device about to be removed hands out a key dated hours ahead. Compared
    // with the departure's clock it looked like a rotation already made.
    const planted = await record(new Date(Date.now() + 23 * 3600_000).toISOString())
    h.state.ring = [planted]
    accept([ep('me', me), ep('phone', phone)])
    h.state.watch = { ...h.state.watch!, rotateOwedAt: owedAt, rotateFrom: planted.createdAt }
    const ring = await syncGroupKeys()
    expect(ring[0]?.keyId).not.toBe(planted.keyId)
    expect(ring[0]!.createdAt > planted.createdAt).toBe(true)
  })

  it('never hands the new key to a device the watch has dropped, even if the cache lists it', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone)])
    h.state.cache = [ep('me', me), ep('phone', phone), ep('evil', evil)] // older list
    h.state.watch = { ...h.state.watch!, rotateOwedAt: owedAt, rotateFrom: old.createdAt }
    await syncGroupKeys()
    expect(postedTargets()).toEqual(['phone'])
  })

  it('does nothing when no rotation is owed', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone)])
    h.state.delivered = [`gk-${old.keyId}-phone`]
    const ring = await syncGroupKeys()
    expect(ring).toEqual([old])
    expect(postedTargets()).toEqual([])
  })
})

describe('a newer key is not proof of a rotation (X14)', () => {
  const owedAt = '2026-10-12T08:00:00.000Z' as IsoTimestamp
  const oldKey = '2026-10-01T00:00:00.000Z'

  /** This device owes a rotation for `evil`, which left; `phone` is a member. */
  async function owing(): Promise<GroupKeyRecord> {
    const old = await record(oldKey)
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone)])
    h.state.watch = {
      ...h.state.watch!,
      rotateOwedAt: owedAt,
      rotateFrom: old.createdAt,
      rotateFor: ['evil'],
    }
    return old
  }

  it('rotates anyway when a newer key arrives that does not name the departed device', async () => {
    // The relay held a key back until now. It is newer than the key current when
    // `evil` left, but it was minted before, and `evil` may hold it.
    const old = await owing()
    const lagging = await record('2026-10-12T07:59:00.000Z')
    h.state.incoming = [await copyFrom(phone, lagging)]
    const ring = await syncGroupKeys()
    expect(ring).toHaveLength(3)
    expect(ring[0]?.keyId).not.toBe(lagging.keyId)
    expect(ring[0]?.keyId).not.toBe(old.keyId)
    expect(ring[0]?.departed).toEqual(['evil'])
    expect(postedTargets()).toEqual(['phone'])
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
  })

  it('stands down for a newer key that names the departed device', async () => {
    await owing()
    const theirs = { ...(await record('2026-10-12T07:59:00.000Z')), departed: ['evil'] }
    h.state.incoming = [await copyFrom(phone, theirs)]
    const ring = await syncGroupKeys()
    expect(ring).toHaveLength(2)
    expect(ring[0]?.keyId).toBe(theirs.keyId)
    expect(ring[0]?.departed).toEqual(['evil'])
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
  })

  it('does not take a sender at its word that it has left itself', async () => {
    // A device that owes nothing to itself cannot vouch for its own departure: the
    // key it names itself in is one it holds. Stored without that claim, so it pays
    // no debt, and this device rotates.
    const old = await owing()
    h.state.watch = { ...h.state.watch!, rotateFor: ['phone'] }
    const selfNamed = { ...(await record('2026-10-12T07:59:00.000Z')), departed: ['phone'] }
    h.state.incoming = [await copyFrom(phone, selfNamed)]
    const ring = await syncGroupKeys()
    const stored = ring.find((k) => k.keyId === selfNamed.keyId)
    expect(stored).toBeDefined()
    expect(stored?.departed).toBeUndefined()
    expect(ring[0]?.keyId).not.toBe(selfNamed.keyId)
    expect(ring[0]?.keyId).not.toBe(old.keyId)
    expect(ring[0]?.departed).toEqual(['phone'])
  })

  it('refuses a record whose departed list is not a short list of distinct ids', async () => {
    accept([ep('me', me), ep('phone', phone)])
    for (const departed of [
      ['a', 'a'],
      [''],
      'a',
      [1],
      Array.from({ length: 33 }, (_, i) => `d${i}`),
    ]) {
      const bad = { ...(await record('2026-10-12T00:00:00.000Z')), departed }
      h.state.incoming = [await copyFrom(phone, bad as unknown as GroupKeyRecord)]
      const ring = await syncGroupKeys()
      expect(ring.map((k) => k.keyId)).not.toContain(bad.keyId)
    }
  })
})

describe('a relay that fails the key routes after a removal', () => {
  async function owingForEvil(): Promise<GroupKeyRecord> {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone), ep('evil', evil)])
    h.state.watch = removeDevice(h.state.watch!, 'evil', '2026-10-12T08:00:00.000Z', old.createdAt)
    return old
  }

  it('still replaces the key when the fetch fails, and hands it out on a later wake', async () => {
    const old = await owingForEvil()
    h.state.failFetch = true
    const ring = await syncGroupKeys()
    expect(ring).toHaveLength(2)
    expect(ring[0]?.keyId).not.toBe(old.keyId)
    expect(ring[0]?.departed).toEqual(['evil'])
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
    // Nothing could be posted while the routes failed...
    expect(postedTargets()).toEqual([])
    // ...and the next wake that can reach them hands the new key to who is left.
    h.state.failFetch = false
    await syncGroupKeys()
    expect(postedTargets()).toEqual(['phone'])
  })

  it('still replaces the key during the hour a relay is marked as predating group history', async () => {
    const old = await owingForEvil()
    h.state.unsupportedAt = Date.now()
    const ring = await syncGroupKeys()
    expect(ring[0]?.keyId).not.toBe(old.keyId)
    expect(postedTargets()).toEqual([])
  })
})

describe('a removed device listed again under a new id (X13)', () => {
  it('is handed nothing until the user says it is theirs', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone), ep('evil', evil)])
    h.state.watch = removeDevice(h.state.watch!, 'evil', '2026-10-12T08:00:00.000Z', old.createdAt)
    // The relay answers the removal, then lists the same key under a fresh id.
    const relisted = [ep('me', me), ep('phone', phone), ep('evil2', evil)]
    h.state.cache = relisted
    h.state.watch = watchDevices(h.state.watch, relisted, 'me', '2026-10-12T09:00:00.000Z').watch!
    expect(h.state.watch.unconfirmed.map((n) => n.id)).toEqual(['evil2'])

    await syncGroupKeys()
    expect(postedTargets()).toEqual(['phone'])

    // "Yes, it's mine": an honest re-pair of the same browser is let in after one tap.
    h.state.watch = confirmNewDevice(h.state.watch, 'evil2')
    h.state.posted = []
    await syncGroupKeys()
    // 'phone' already has this key; only the newly accepted device is still owed it.
    expect(postedTargets()).toEqual(['evil2'])
  })
})

describe('a key copy has to fit the relay', () => {
  it('seals a record naming 32 ids of 64 characters under the relay cap of 4096 bytes', async () => {
    const ids = Array.from({ length: 32 }, (_, i) => `${i}`.padStart(2, '0').repeat(32))
    const worst = { ...(await record('2026-10-12T00:00:00.000Z')), departed: ids }
    const box = await seal(JSON.stringify(worst), phone.publicKey, me.privateKey)
    const envelope = {
      alg: 'x25519-xsalsa20-poly1305/box',
      senderKeyId: await keyId(me.publicKey),
      targetKeyId: await keyId(phone.publicKey),
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    }
    // server/src/routes/group-keys.ts refuses an envelope over 4096 bytes.
    expect(new TextEncoder().encode(JSON.stringify(envelope)).length).toBeLessThan(4096)
  })
})

describe('a departure that lands while a mint is in flight (X15, narrowed)', () => {
  it('mints again at the next sync, naming the device the first key did not', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone)])
    h.state.watch = {
      ...h.state.watch!,
      rotateOwedAt: '2026-10-12T08:00:00.000Z' as IsoTimestamp,
      rotateFrom: old.createdAt,
      rotateFor: ['gone-1'],
    }
    const first = await syncGroupKeys()
    expect(first[0]?.departed).toEqual(['gone-1'])

    // Another device leaves just after that key was minted: the watch owes a new
    // rotation for it, on top of the debt the first key paid.
    h.state.watch = {
      ...h.state.watch!,
      rotateOwedAt: '2026-10-12T08:00:05.000Z' as IsoTimestamp,
      rotateFrom: first[0]!.createdAt,
      rotateFor: ['gone-1', 'gone-2'],
    }
    const second = await syncGroupKeys()
    expect(second).toHaveLength(3)
    expect(second[0]?.keyId).not.toBe(first[0]?.keyId)
    expect(second[0]?.departed).toEqual(['gone-1', 'gone-2'])
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
  })
})

describe('a relay that keeps a removed device listed (X13)', () => {
  it('rotates at once and hands the new key to everyone but the removed device', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    // Before the removal: both are members, and the old key went to both.
    accept([ep('me', me), ep('phone', phone), ep('evil', evil)])
    h.state.delivered = [`gk-${old.keyId}-phone`, `gk-${old.keyId}-evil`]
    // The user taps Remove, the relay answers yes, and then goes on listing it.
    h.state.watch = removeDevice(h.state.watch!, 'evil', '2026-10-12T08:00:00.000Z', old.createdAt)
    expect(h.state.cache.map((e) => e.id)).toContain('evil')

    const ring = await syncGroupKeys()

    expect(ring).toHaveLength(2)
    expect(ring[0]?.keyId).not.toBe(old.keyId)
    expect(ring[0]?.departed).toEqual(['evil'])
    expect(postedTargets()).toEqual(['phone'])
    expect(h.state.watch?.rotateOwedAt).toBeUndefined()
  })

  it('trusts no key copy from the removed device either', async () => {
    const old = await record('2026-10-01T00:00:00.000Z')
    h.state.ring = [old]
    accept([ep('me', me), ep('phone', phone), ep('evil', evil)])
    h.state.watch = removeDevice(h.state.watch!, 'evil', '2026-10-12T08:00:00.000Z', old.createdAt)
    const planted = await record('2026-10-12T09:00:00.000Z')
    h.state.incoming = [await copyFrom(evil, planted)]
    const ring = await syncGroupKeys()
    expect(ring.map((k) => k.keyId)).not.toContain(planted.keyId)
  })
})

describe('the first key', () => {
  it('is minted by the lowest non-console id, even when a console sorts lower', async () => {
    accept([ep('a-console', phone, 'console'), ep('me', me)])
    const ring = await syncGroupKeys()
    expect(ring).toHaveLength(1)
  })
})
