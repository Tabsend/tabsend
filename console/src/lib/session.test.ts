import type { GroupKeyRecord } from '@tabsend/shared'
import { describe, expect, it } from 'vitest'
import type { ConsoleSession } from './model'
import {
  clearSession,
  loadKeyring,
  loadSession,
  MemoryKv,
  relayBaseFor,
  saveKeyring,
  saveSession,
} from './session'

const sample: ConsoleSession = {
  relayUrl: 'https://relay.example',
  endpointId: 'console-1',
  groupId: 'group-1',
  deviceToken: 'tok-abc',
  label: 'Web console',
  publicKey: 'pub',
  privateKey: 'priv',
  keyId: 'kid',
}

describe('session persistence', () => {
  it('round-trips a saved session', () => {
    const kv = new MemoryKv()
    saveSession(sample, kv)
    expect(loadSession(kv)).toEqual(sample)
  })

  it('returns null when nothing is stored', () => {
    expect(loadSession(new MemoryKv())).toBeNull()
  })

  it('returns null for a corrupt payload', () => {
    const kv = new MemoryKv()
    kv.setItem('tabsend.console.session.v1', '{ not json')
    expect(loadSession(kv)).toBeNull()
  })

  it('returns null when required fields are missing', () => {
    const kv = new MemoryKv()
    kv.setItem('tabsend.console.session.v1', JSON.stringify({ endpointId: 'x' }))
    expect(loadSession(kv)).toBeNull()
  })

  it('clears a session', () => {
    const kv = new MemoryKv()
    saveSession(sample, kv)
    clearSession(kv)
    expect(loadSession(kv)).toBeNull()
  })

  it('relayBaseFor is same-origin ("") when unpaired', () => {
    expect(relayBaseFor(null)).toBe('')
    expect(relayBaseFor(sample)).toBe('https://relay.example')
  })
})

describe('group history keyring persistence', () => {
  const key = (keyId: string, createdAt: string): GroupKeyRecord =>
    ({ key: `secret-${keyId}`, keyId, createdAt }) as GroupKeyRecord

  it('round-trips a ring, newest first', () => {
    const kv = new MemoryKv()
    saveKeyring([key('a', '2026-07-01T00:00:00.000Z'), key('b', '2026-08-01T00:00:00.000Z')], kv)
    expect(loadKeyring(kv).map((k) => k.keyId)).toEqual(['b', 'a'])
  })

  it('reads an empty ring when nothing is stored', () => {
    expect(loadKeyring(new MemoryKv())).toEqual([])
  })

  it('reads an empty ring from a corrupt store, because the relay can refill it', () => {
    const kv = new MemoryKv()
    kv.setItem('tabsend.console.keyring.v1', '{ not json')
    expect(loadKeyring(kv)).toEqual([])
  })

  it('drops a malformed record without losing the sound ones beside it', () => {
    const kv = new MemoryKv()
    kv.setItem(
      'tabsend.console.keyring.v1',
      JSON.stringify([{ keyId: 'no-key-field' }, key('a', '2026-07-01T00:00:00.000Z')]),
    )
    expect(loadKeyring(kv).map((k) => k.keyId)).toEqual(['a'])
  })

  it('is cleared with the session, since it is group secret material too', () => {
    const kv = new MemoryKv()
    saveSession(sample, kv)
    saveKeyring([key('a', '2026-07-01T00:00:00.000Z')], kv)
    clearSession(kv)
    expect(loadKeyring(kv)).toEqual([])
  })
})
