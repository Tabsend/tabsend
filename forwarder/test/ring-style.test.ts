import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Http2ApnsSender } from '../src/apns'
import { DeviceStore } from '../src/store'
import { hashWakeToken, newWakeToken } from '../src/tokens'
import { FAKE_GOOGLE_TLS, startFakeGoogle } from './fake-google'
import {
  fakeApnsToken,
  fakeFcmToken,
  post,
  register,
  startRig,
  TEST_DEVICE_TOKEN_KEY,
  type TestRig,
} from './helpers'

/**
 * The ring style [2026-11-05, docs/PLANS.md P-29]: an iPhone may ask to be rung with a
 * visible "new link" notification its own extension fills in, rather than the silent wake
 * Apple may hold back. A phone that never asks is rung exactly as before.
 */
describe('ring style at sign-up', () => {
  let rig: TestRig | undefined

  afterEach(async () => {
    await rig?.close()
    rig = undefined
  })

  it('rings a phone that never asked with the silent wake, as before', async () => {
    rig = await startRig()
    const { wakeToken, apnsToken } = await register(rig)

    expect((await post(rig, '/v1/wake', {}, wakeToken)).status).toBe(202)
    await vi.waitFor(() =>
      expect(rig?.apns.calls).toEqual([
        { apnsToken, environment: 'production', ringStyle: 'background' },
      ]),
    )
  })

  it('rings a phone that asked for alert with alert, and follows it when it changes its mind', async () => {
    rig = await startRig()
    const apnsToken = fakeApnsToken()
    const first = await post(rig, '/v1/register', { apnsToken, ringStyle: 'alert' })
    expect(first.status).toBe(200)
    expect(rig.store.find(hashWakeToken(first.body.wakeToken))?.ringStyle).toBe('alert')

    await post(rig, '/v1/wake', {}, first.body.wakeToken)
    await vi.waitFor(() =>
      expect(rig?.apns.calls).toEqual([
        { apnsToken, environment: 'production', ringStyle: 'alert' },
      ]),
    )

    // Notifications turned off on the phone: it signs up again as background. That
    // replaces the row, so the old wake token rings nothing.
    const second = await post(rig, '/v1/register', { apnsToken, ringStyle: 'background' })
    expect(second.status).toBe(200)
    expect(rig.store.find(hashWakeToken(first.body.wakeToken))).toBeUndefined()
    expect(rig.store.find(hashWakeToken(second.body.wakeToken))?.ringStyle).toBe('background')
  })

  it('refuses a style it does not know, and alert for an Android phone', async () => {
    rig = await startRig()
    const unknown = await post(rig, '/v1/register', {
      apnsToken: fakeApnsToken(),
      ringStyle: 'loud',
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.code).toBe('invalid_request')

    const android = await post(rig, '/v1/register', {
      fcmToken: fakeFcmToken(),
      ringStyle: 'alert',
    })
    expect(android.status).toBe(400)
    expect(android.body.error.code).toBe('invalid_request')
    expect(rig.store.count()).toBe(0)

    // Background is what an Android phone gets anyway, so saying so is accepted.
    const plain = await post(rig, '/v1/register', {
      fcmToken: fakeFcmToken(),
      ringStyle: 'background',
    })
    expect(plain.status).toBe(200)
  })
})

describe('ring style at rest', () => {
  it('brings a version-3 file forward with every phone on the silent wake', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tabsend-forwarder-'))
    const databasePath = join(dir, 'forwarder.db')
    try {
      const hash = hashWakeToken(newWakeToken())
      const apnsToken = fakeApnsToken()
      const before = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
      before.register({
        wakeTokenHash: hash,
        platform: 'ios',
        deviceToken: apnsToken,
        environment: 'sandbox',
        ringStyle: 'alert',
        now: 5,
      })
      before.close()

      // Turn the file back into what a version-3 forwarder left.
      const db = new SQLite(databasePath)
      db.exec('ALTER TABLE devices DROP COLUMN ring_style')
      db.pragma('user_version = 3')
      db.close()

      const after = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
      try {
        expect(after.find(hash)).toMatchObject({
          deviceToken: apnsToken,
          environment: 'sandbox',
          ringStyle: 'background',
          createdAt: 5,
        })
      } finally {
        after.close()
      }
      const check = new SQLite(databasePath)
      expect(check.pragma('user_version', { simple: true })).toBe(4)
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the visible ring on the wire', () => {
  it('sends a fixed text key, mutable, now, kept for a day, and never collapsed', async () => {
    const apple = await startFakeGoogle()
    apple.answer = () => ({ status: 200 })
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const sender = new Http2ApnsSender(
      {
        keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        keyId: 'ABCD123456',
        teamId: 'TEAM123456',
        topic: 'io.tabsend.app',
        defaultEnvironment: 'production',
        timeoutMs: 2000,
        maxInFlight: 64,
      },
      { origin: apple.origin, connectOptions: FAKE_GOOGLE_TLS },
    )
    try {
      const apnsToken = fakeApnsToken()
      const before = Math.floor(Date.now() / 1000)
      expect(
        await sender.wake({ apnsToken, environment: 'production', ringStyle: 'alert' }),
      ).toEqual({ ok: true })
      const sent = apple.sends.find((send) => send.path === `/3/device/${apnsToken}`)
      expect(sent?.headers['apns-push-type']).toBe('alert')
      expect(sent?.headers['apns-priority']).toBe('10')
      expect(sent?.headers['apns-collapse-id']).toBeUndefined()
      const expiration = Number(sent?.headers['apns-expiration'])
      expect(expiration - before).toBeGreaterThanOrEqual(24 * 60 * 60)
      expect(expiration - before).toBeLessThanOrEqual(24 * 60 * 60 + 5)
      // The whole payload: a text key the phone looks up in its own language, and
      // nothing about what is waiting.
      expect(JSON.parse(sent?.body ?? '')).toEqual({
        aps: { alert: { 'loc-key': 'NEW_LINK' }, sound: 'default', 'mutable-content': 1 },
      })

      // The silent wake is unchanged beside it, collapse id included.
      await sender.wake({ apnsToken, environment: 'production', ringStyle: 'background' })
      const silent = apple.sends.filter((send) => send.path === `/3/device/${apnsToken}`)[1]
      expect(silent?.headers['apns-push-type']).toBe('background')
      expect(silent?.headers['apns-collapse-id']).toBe('wake')
      expect(JSON.parse(silent?.body ?? '')).toEqual({ aps: { 'content-available': 1 } })
    } finally {
      await sender.close()
      await apple.close()
    }
  })
})
