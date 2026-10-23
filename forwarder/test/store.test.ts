import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SQLite from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceStore } from '../src/store'
import { DeviceTokenBox } from '../src/token-box'
import { hashWakeToken, newWakeToken } from '../src/tokens'
import {
  fakeApnsToken,
  fakeFcmToken,
  post,
  register,
  registerAndroid,
  startRig,
  TEST_DEVICE_TOKEN_KEY,
} from './helpers'

/**
 * What a copy of the forwarder's database is worth [2026-10-02, SECURITY_REVIEW G15].
 *
 * Registration replaces whatever row holds the same device token, so a list of device
 * tokens lets its holder cut every phone off and ring it. The file used to be that list,
 * readable by every user on the machine. Now it holds a keyed hash and a ciphertext per
 * phone, under a key kept outside the file, and only its owner can read it.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabsend-forwarder-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Every byte SQLite has on disk for this database: the file and its companions. */
function bytesOnDisk(databasePath: string): string {
  return ['', '-wal', '-shm']
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path).toString('latin1'))
    .join('\n')
}

const mode = (path: string) => statSync(path).mode & 0o777

describe('device tokens at rest', () => {
  it('never writes a device token into the database file, its WAL or its index', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const rig = await startRig({ databasePath })
    const apnsToken = fakeApnsToken()
    const fcmToken = fakeFcmToken()
    try {
      const phone = await register(rig, apnsToken)
      const droid = await registerAndroid(rig, fcmToken)
      // Ring both, replace one, so every write path has run.
      await post(rig, '/v1/wake', {}, phone.wakeToken)
      await post(rig, '/v1/wake', {}, droid.wakeToken)
      await register(rig, apnsToken)

      // While the forwarder is running, in whatever the WAL holds...
      const live = bytesOnDisk(databasePath)
      expect(live).not.toContain(apnsToken)
      expect(live).not.toContain(fcmToken)
    } finally {
      await rig.close()
    }
    // ...and once it has shut down and checkpointed.
    const closed = bytesOnDisk(databasePath)
    expect(closed).not.toContain(apnsToken)
    expect(closed).not.toContain(fcmToken)
  })

  it('still finds the device, rings it with its real address, and replaces it on re-registration', async () => {
    const rig = await startRig()
    try {
      const fcmToken = fakeFcmToken()
      const first = await registerAndroid(rig, fcmToken)
      expect(rig.store.find(hashWakeToken(first.wakeToken))?.deviceToken).toBe(fcmToken)
      const second = await registerAndroid(rig, fcmToken)
      expect(rig.store.count()).toBe(1)
      expect(rig.store.find(hashWakeToken(first.wakeToken))).toBeUndefined()
      await post(rig, '/v1/wake', {}, second.wakeToken)
      expect(rig.fcm?.calls).toEqual([{ fcmToken }])
    } finally {
      await rig.close()
    }
  })

  it('refuses to open a database with any key but the one it was written with', () => {
    const databasePath = join(dir, 'forwarder.db')
    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
    store.register({
      wakeTokenHash: hashWakeToken(newWakeToken()),
      platform: 'ios',
      deviceToken: fakeApnsToken(),
      environment: 'production',
      now: 1,
    })
    store.close()

    expect(
      () =>
        new DeviceStore(
          databasePath,
          Buffer.from('72d6705af9b7b5a1206982ee51af10966a0c15779ab6f24696b3c0b6479b16ad', 'hex'),
        ),
    ).toThrow(/not the key this database was written with/)
    // The right key still opens it.
    new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY).close()
  })
})

describe('database file permissions', () => {
  it('creates the file readable by its owner only, companions included', () => {
    const databasePath = join(dir, 'fresh', 'forwarder.db')
    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
    try {
      store.register({
        wakeTokenHash: hashWakeToken(newWakeToken()),
        platform: 'ios',
        deviceToken: fakeApnsToken(),
        environment: 'production',
        now: 1,
      })
      expect(mode(databasePath)).toBe(0o600)
      expect(mode(`${databasePath}-wal`)).toBe(0o600)
      expect(mode(`${databasePath}-shm`)).toBe(0o600)
    } finally {
      store.close()
    }
  })

  it('tightens a file an earlier version left readable by everyone', () => {
    const databasePath = join(dir, 'forwarder.db')
    writeFileSync(databasePath, '')
    chmodSync(databasePath, 0o644)

    new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY).close()

    expect(mode(databasePath)).toBe(0o600)
  })
})

describe('schema migrations', () => {
  function seed(databasePath: string, schema: 1 | 2, rows: unknown[][]): void {
    const db = new SQLite(databasePath)
    // As the forwarder that wrote it left it: every version has used WAL.
    db.pragma('journal_mode = WAL')
    const column = schema === 1 ? 'apns_token' : 'device_token'
    db.exec(`CREATE TABLE devices (
      wake_token_hash TEXT PRIMARY KEY,
      ${schema === 2 ? 'platform TEXT NOT NULL,' : ''}
      ${column}       TEXT NOT NULL UNIQUE,
      environment     TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      last_wake_at    INTEGER,
      wake_count      INTEGER NOT NULL DEFAULT 0
    );`)
    const placeholders = rows[0]?.map(() => '?').join(', ')
    const insert = db.prepare(`INSERT INTO devices VALUES (${placeholders})`)
    for (const row of rows) insert.run(...row)
    db.pragma(`user_version = ${schema}`)
    db.close()
  }

  it('encrypts a version-2 file in place, keeps every row, and leaves no address behind', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const phone = { wakeToken: newWakeToken(), apnsToken: fakeApnsToken() }
    const droid = { wakeToken: newWakeToken(), fcmToken: fakeFcmToken() }
    seed(databasePath, 2, [
      [hashWakeToken(phone.wakeToken), 'ios', phone.apnsToken, 'sandbox', 10, 20, 3],
      [hashWakeToken(droid.wakeToken), 'android', droid.fcmToken, 'production', 11, null, 0],
    ])

    const rig = await startRig({ databasePath })
    try {
      expect(rig.store.find(hashWakeToken(phone.wakeToken))).toEqual({
        wakeTokenHash: hashWakeToken(phone.wakeToken),
        platform: 'ios',
        deviceToken: phone.apnsToken,
        environment: 'sandbox',
        createdAt: 10,
        lastWakeAt: 20,
        wakeCount: 3,
      })
      expect(bytesOnDisk(databasePath)).not.toContain(phone.apnsToken)
      expect(bytesOnDisk(databasePath)).not.toContain(droid.fcmToken)

      await post(rig, '/v1/wake', {}, phone.wakeToken)
      await post(rig, '/v1/wake', {}, droid.wakeToken)
      expect(rig.apns.calls).toEqual([{ apnsToken: phone.apnsToken, environment: 'sandbox' }])
      expect(rig.fcm?.calls).toEqual([{ fcmToken: droid.fcmToken }])
    } finally {
      await rig.close()
    }
    const db = new SQLite(databasePath, { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    db.close()
  })

  /**
   * Found by the 2026-10-02 verification pass: the rewrite that clears the old table's
   * pages ran after the commit and never again, so a stop between the two left the
   * clear-text addresses in the file for good. The commit now leaves a marker, and the
   * rewrite runs at every start until it has completed.
   */
  /**
   * Zeroing what the migration frees is not enough on its own: an earlier version deleted
   * rows (revokes, replacements, removed apps) without zeroing them, so a version-2 file
   * can hold addresses in its free space already. The rewrite is what removes those.
   */
  it('also removes addresses an earlier version deleted but left in the file', () => {
    const databasePath = join(dir, 'forwarder.db')
    const tokens = Array.from({ length: 200 }, () => fakeApnsToken())
    seed(
      databasePath,
      2,
      tokens.map((token) => [
        hashWakeToken(newWakeToken()),
        'ios',
        token,
        'production',
        1,
        null,
        0,
      ]),
    )
    const gone = tokens.slice(0, 150)
    const old = new SQLite(databasePath)
    old.pragma('secure_delete = OFF')
    const remove = old.prepare('DELETE FROM devices WHERE device_token = ?')
    for (const token of gone) remove.run(token)
    old.close()
    expect(gone.some((token) => bytesOnDisk(databasePath).includes(token))).toBe(true)

    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
    try {
      expect(store.count()).toBe(50)
      const text = bytesOnDisk(databasePath)
      for (const token of tokens) expect(text).not.toContain(token)
    } finally {
      store.close()
    }
  })

  /**
   * The old table is dropped with `secure_delete` on, so its pages are zeroed inside the
   * migration itself. That is what keeps the addresses out of the file when the rewrite
   * cannot run at all: VACUUM needs free space about the size of the file, and a full disk
   * refuses it at every start.
   */
  it('leaves no address behind even when the rewrite cannot run', () => {
    const databasePath = join(dir, 'forwarder.db')
    const tokens = Array.from({ length: 50 }, () => fakeApnsToken())
    seed(
      databasePath,
      2,
      tokens.map((token) => [
        hashWakeToken(newWakeToken()),
        'ios',
        token,
        'production',
        1,
        null,
        0,
      ]),
    )
    const exec = SQLite.prototype.exec
    const full = vi.spyOn(SQLite.prototype, 'exec').mockImplementation(function (
      this: SQLite.Database,
      sql: string,
    ) {
      if (sql === 'VACUUM') throw new Error('database or disk is full')
      return exec.call(this, sql)
    })
    const errors: unknown[] = []
    let store: DeviceStore | undefined
    try {
      store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY, {
        onFlushError: (err) => errors.push(err),
      })
      expect(store.scrubPending).toBe(true)
      expect(errors).toHaveLength(1)
      // While it runs, not only after a clean shutdown.
      const text = bytesOnDisk(databasePath)
      for (const token of tokens) expect(text).not.toContain(token)
    } finally {
      store?.close()
      full.mockRestore()
    }
  })

  it('finishes the clean-up at the next start when the last one was cut short', () => {
    const databasePath = join(dir, 'forwarder.db')
    const apnsToken = fakeApnsToken()
    seed(databasePath, 2, [
      [hashWakeToken(newWakeToken()), 'ios', apnsToken, 'production', 1, null, 0],
    ])
    // What a stop straight after the migration's commit leaves: the new table written,
    // the old one dropped with nothing zeroed or rewritten, and the marker set.
    const box = new DeviceTokenBox(TEST_DEVICE_TOKEN_KEY)
    const db = new SQLite(databasePath)
    db.exec(`
      ALTER TABLE devices RENAME TO devices_v2;
      CREATE TABLE devices (
        wake_token_hash TEXT PRIMARY KEY, platform TEXT NOT NULL,
        device_token_mac TEXT NOT NULL UNIQUE, device_token_enc TEXT NOT NULL,
        environment TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_wake_at INTEGER, wake_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    const mac = box.index(apnsToken)
    db.prepare(
      'INSERT INTO devices SELECT wake_token_hash, platform, ?, ?, environment, created_at, last_wake_at, wake_count FROM devices_v2',
    ).run(mac, box.seal(apnsToken, mac))
    db.exec('DROP TABLE devices_v2')
    db.prepare(
      "INSERT INTO meta VALUES ('device_token_key_check', ?), ('scrub_pending', 'vacuum')",
    ).run(box.keyCheck)
    db.pragma('user_version = 3')
    db.close()
    expect(bytesOnDisk(databasePath)).toContain(apnsToken)

    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
    try {
      expect(store.scrubPending).toBe(false)
      expect(bytesOnDisk(databasePath)).not.toContain(apnsToken)
    } finally {
      store.close()
    }
  })

  it('keeps the clean-up owed while a reader holds the file, and finishes it at a flush', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const apnsToken = fakeApnsToken()
    seed(databasePath, 2, [
      [hashWakeToken(newWakeToken()), 'ios', apnsToken, 'production', 1, null, 0],
    ])
    // An operator's query, or a backup, with a read open while the forwarder starts.
    const reader = new SQLite(databasePath, { readonly: true })
    reader.prepare('BEGIN').run()
    reader.prepare('SELECT COUNT(*) FROM devices').get()

    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY, { wakeFlushIntervalMs: 25 })
    try {
      // The checkpoint could not copy everything past the open read, so the marker stays.
      expect(store.scrubPending).toBe(true)

      reader.prepare('COMMIT').run()
      reader.close()
      await vi.waitFor(() => expect(store.scrubPending).toBe(false), { timeout: 2000 })
      expect(bytesOnDisk(databasePath)).not.toContain(apnsToken)
    } finally {
      store.close()
    }
  })

  it('brings a version-1 file forward as iPhones, counters intact', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const wakeToken = newWakeToken()
    const apnsToken = 'ab'.repeat(32)
    seed(databasePath, 1, [[hashWakeToken(wakeToken), apnsToken, 'sandbox', 123, 456, 7]])

    const rig = await startRig({ databasePath })
    try {
      expect(rig.store.find(hashWakeToken(wakeToken))).toEqual({
        wakeTokenHash: hashWakeToken(wakeToken),
        platform: 'ios',
        deviceToken: apnsToken,
        environment: 'sandbox',
        createdAt: 123,
        lastWakeAt: 456,
        wakeCount: 7,
      })
      await post(rig, '/v1/wake', {}, wakeToken)
      expect(rig.apns.calls).toEqual([{ apnsToken, environment: 'sandbox' }])
    } finally {
      await rig.close()
    }
  })
})

/**
 * A ring does not touch the disk [2026-10-02, SECURITY_REVIEW G14]. The write it used
 * to make was work only a live token caused after its reply. The tallies are kept in
 * memory and written once a minute, every minute.
 */
describe('wake tallies', () => {
  it('counts a ring in memory and writes it at the next flush, not during the ring', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const rig = await startRig({ databasePath })
    try {
      const { wakeToken } = await register(rig)
      const hash = hashWakeToken(wakeToken)
      await post(rig, '/v1/wake', {}, wakeToken)
      await post(rig, '/v1/wake', {}, wakeToken)

      const onDisk = () => {
        const db = new SQLite(databasePath, { readonly: true })
        try {
          return db
            .prepare('SELECT wake_count, last_wake_at FROM devices WHERE wake_token_hash = ?')
            .get(hash) as { wake_count: number; last_wake_at: number | null }
        } finally {
          db.close()
        }
      }
      // The store's own view includes the rings; the file does not, yet.
      expect(rig.store.find(hash)?.wakeCount).toBe(2)
      expect(onDisk()).toEqual({ wake_count: 0, last_wake_at: null })

      rig.store.flushWakes()
      expect(onDisk()).toEqual({ wake_count: 2, last_wake_at: rig.clock.now() })
      expect(rig.store.find(hash)?.wakeCount).toBe(2)
    } finally {
      await rig.close()
    }
  })

  it('writes on its timer, and writes even when nothing rang', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY, { wakeFlushIntervalMs: 25 })
    const reader = () => new SQLite(databasePath, { readonly: true })
    try {
      const wakeToken = newWakeToken()
      const hash = hashWakeToken(wakeToken)
      store.register({
        wakeTokenHash: hash,
        platform: 'ios',
        deviceToken: fakeApnsToken(),
        environment: 'production',
        now: 1,
      })
      store.recordWake(hash, 5)
      await vi.waitFor(
        () => {
          const db = reader()
          try {
            const row = db
              .prepare('SELECT wake_count FROM devices WHERE wake_token_hash = ?')
              .get(hash) as { wake_count: number }
            expect(row.wake_count).toBe(1)
          } finally {
            db.close()
          }
        },
        { timeout: 2000 },
      )

      // A quiet minute writes too: the write is not a sign that a live token was rung.
      const flushedAt = () => {
        const db = reader()
        try {
          return (
            db.prepare("SELECT value FROM meta WHERE key = 'wakes_flushed_at'").get() as {
              value: string
            }
          ).value
        } finally {
          db.close()
        }
      }
      const first = flushedAt()
      await vi.waitFor(() => expect(flushedAt()).not.toBe(first), { timeout: 2000 })
    } finally {
      store.close()
    }
  })

  it('reports a flush that failed, keeps what it held, and writes it at the next one', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const errors: unknown[] = []
    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY, {
      wakeFlushIntervalMs: 25,
      onFlushError: (err) => errors.push(err),
    })
    try {
      const hash = hashWakeToken(newWakeToken())
      store.register({
        wakeTokenHash: hash,
        platform: 'ios',
        deviceToken: fakeApnsToken(),
        environment: 'production',
        now: 1,
      })
      // Something else takes the table the flush writes its time to, so the flush fails.
      const other = new SQLite(databasePath)
      other.exec('ALTER TABLE meta RENAME TO meta_away')
      store.recordWake(hash, 5)
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 2000 })
      expect(store.find(hash)?.wakeCount).toBe(1)

      other.exec('ALTER TABLE meta_away RENAME TO meta')
      other.close()
      await vi.waitFor(
        () => {
          const db = new SQLite(databasePath, { readonly: true })
          try {
            const row = db
              .prepare('SELECT wake_count FROM devices WHERE wake_token_hash = ?')
              .get(hash) as { wake_count: number }
            expect(row.wake_count).toBe(1)
          } finally {
            db.close()
          }
        },
        { timeout: 2000 },
      )
    } finally {
      store.close()
    }
  })

  it('writes what is pending when it closes', async () => {
    const databasePath = join(dir, 'forwarder.db')
    const rig = await startRig({ databasePath })
    const { wakeToken } = await register(rig)
    await post(rig, '/v1/wake', {}, wakeToken)
    await rig.close()

    const store = new DeviceStore(databasePath, TEST_DEVICE_TOKEN_KEY)
    try {
      expect(store.find(hashWakeToken(wakeToken))?.wakeCount).toBe(1)
    } finally {
      store.close()
    }
  })
})

/**
 * The 2026-10-20 review of SECURITY_REVIEW G16: the ceiling had no way down, so once a
 * flood filled the table every new phone was refused for good. Near the ceiling, rows never
 * rung are now removed oldest first, on their own schedule, and at no other time.
 */
describe('trimming a nearly full table', () => {
  function storeWith(maxDevices: number, removed: number[]) {
    return new DeviceStore(join(dir, 'trim.db'), TEST_DEVICE_TOKEN_KEY, {
      maxDevices,
      trimIntervalMs: 20,
      onTrimmed: (n) => removed.push(n),
    })
  }
  function add(store: DeviceStore, at: number): string {
    const hash = hashWakeToken(newWakeToken())
    store.register({
      wakeTokenHash: hash,
      platform: 'ios',
      deviceToken: fakeApnsToken(),
      environment: 'production',
      now: at,
    })
    return hash
  }

  it('removes the oldest rows never rung, down to the low-water mark, and nothing rung', async () => {
    const removed: number[] = []
    const store = storeWith(20, removed)
    try {
      const start = Date.UTC(2026, 9, 20, 12, 0, 0)
      // The oldest row is a real phone, rung only in memory so far: the trim must write
      // that out before judging, and keep it.
      const realPhone = add(store, start)
      store.recordWake(realPhone, start + 1)
      const flood = Array.from({ length: 18 }, (_, i) => add(store, start + 10 + i))
      const newest = add(store, start + 100)
      expect(store.count()).toBe(20)

      // Full (20 ≥ 19): trimmed to 18, taking the two oldest never rung.
      await vi.waitFor(() => expect(removed).toEqual([2]))
      expect(store.count()).toBe(18)
      expect(store.find(realPhone)).toBeDefined()
      expect(store.find(flood[0] as string)).toBeUndefined()
      expect(store.find(flood[1] as string)).toBeUndefined()
      expect(store.find(flood[2] as string)).toBeDefined()
      expect(store.find(newest)).toBeDefined()
      // A new phone fits again.
      add(store, start + 200)
      expect(store.count()).toBe(19)
    } finally {
      store.close()
    }
  })

  it('removes nothing below the high-water mark, however old', async () => {
    const removed: number[] = []
    const store = storeWith(20, removed)
    try {
      for (let i = 0; i < 18; i++) add(store, Date.UTC(2020, 0, 1) + i)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(removed).toEqual([])
      expect(store.count()).toBe(18)
    } finally {
      store.close()
    }
  })
})
