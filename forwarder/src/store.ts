import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import SQLite, { type Database as SQLiteDatabase, type Statement } from 'better-sqlite3'
import type { ApnsEnvironment, DevicePlatform } from './config'
import { DEVICE_TOKEN_KEY_HINT, DeviceTokenBox } from './token-box'

/**
 * The forwarder's entire persistent state: one row per registered phone, holding the
 * doorbell address and nothing else.
 *
 * Invariant: this table never learns a wake token (only its SHA-256), never learns which
 * relay rang, never learns what was waiting, and never grows a row per wake. A wake
 * overwrites `last_wake_at` and bumps a counter, so the hundredth ring leaves exactly as
 * much trace as the first. The full argument for why keeping this much still honours the
 * plan's "stateless" intent is PROTOCOL.md §5; changing this schema means changing that
 * section too.
 *
 * Since schema 3 [2026-10-02] the doorbell address itself is not in the file either:
 * only a keyed hash of it and a ciphertext, under a key the operator holds outside the
 * file (`token-box.ts`). A copy of this database therefore rings nobody, which §5 used to
 * claim before it was true.
 */

export interface DeviceRecord {
  wakeTokenHash: string
  /** Which provider rings this row. Decides which sender `ring` reaches for. */
  platform: DevicePlatform
  /** Apple's device token, or Google's registration token. Never logged. Decrypted
   *  only when a row is read, which on the wake path is after the reply (§4). */
  deviceToken: string
  /**
   * Apple's environment. Meaningless for an `android` row and stored as the forwarder
   * default there: Google has no sandbox/production split, one project serves both
   * debug and release builds of an app.
   */
  environment: ApnsEnvironment
  createdAt: number
  lastWakeAt: number | null
  wakeCount: number
}

/** What `register` needs. Named because the transaction below takes it too. */
export interface RegisterParams {
  wakeTokenHash: string
  platform: DevicePlatform
  deviceToken: string
  environment: ApnsEnvironment
  /** ms since epoch, injected so tests and the routes share one clock. */
  now: number
}

export interface DeviceStoreOptions {
  /**
   * How often the wake tallies held in memory are written out. A wake does not touch the
   * disk itself [2026-10-02, SECURITY_REVIEW G14]: the write it used to make was work only
   * a live token caused after its reply. A small one (this SQLite does not sync to disk on
   * each commit), but work a dead token never did. Defaults to a minute. Every interval writes,
   * whether or not anything rang, so the write itself says nothing about whether a live
   * token was rung in that minute.
   */
  wakeFlushIntervalMs?: number
  /** Told about a flush that failed. The tallies are kept and tried again next time. */
  onFlushError?: (err: unknown) => void
}

interface DeviceRow {
  wake_token_hash: string
  platform: string
  device_token_mac: string
  device_token_enc: string
  environment: string
  created_at: number
  last_wake_at: number | null
  wake_count: number
}

/** Rows as schema 2 kept them: the device token in the clear. Read once, to migrate. */
interface DeviceRowV2 {
  wake_token_hash: string
  platform: string
  device_token: string
  environment: string
  created_at: number
  last_wake_at: number | null
  wake_count: number
}

/**
 * Schema version, tracked in SQLite's own `user_version`. The migration list is
 * append-only, and a fresh file and an upgraded one end identically.
 */
const SCHEMA_VERSION = 3

const DEFAULT_WAKE_FLUSH_INTERVAL_MS = 60_000

const DEVICES_TABLE = `
  CREATE TABLE devices (
    wake_token_hash  TEXT PRIMARY KEY,
    platform         TEXT NOT NULL,
    device_token_mac TEXT NOT NULL UNIQUE,
    device_token_enc TEXT NOT NULL,
    environment      TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    last_wake_at     INTEGER,
    wake_count       INTEGER NOT NULL DEFAULT 0
  );
`

const META_TABLE = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/**
 * Create the file, or tighten an existing one, so only the forwarder's own user can read
 * it [2026-10-02, SECURITY_REVIEW G15]. SQLite gives its `-wal` and `-shm` companions the
 * main file's permissions when it creates them, so the main file is the one that has to
 * be right before SQLite first opens it.
 */
function prepareFile(databasePath: string): void {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  closeSync(openSync(databasePath, 'a', 0o600))
  chmodSync(databasePath, 0o600)
  for (const companion of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(companion)) chmodSync(companion, 0o600)
  }
}

export class DeviceStore {
  private readonly db: SQLiteDatabase
  private readonly box: DeviceTokenBox
  /**
   * Every statement this class runs, compiled once at construction.
   *
   * `db.prepare` parses the SQL and builds a plan, so calling it per request would repeat
   * that work on the wake path, which is the one path that has to stay cheap enough to
   * answer a doorbell. Preparing once is the canonical better-sqlite3 shape and it also
   * means a typo in any of this SQL fails at boot rather than on the first wake.
   */
  private readonly statements: {
    deleteByDeviceToken: Statement
    insert: Statement
    findByHash: Statement
    addWakes: Statement
    deleteByHash: Statement
    count: Statement
    flushedAt: Statement
  }
  /** The register transaction, built once around the statements above. */
  private readonly registerTx: (params: RegisterParams) => { replaced: boolean }
  private readonly flushTx: (entries: [string, PendingWakes][], at: number) => void
  /** Wakes noted since the last flush, by token hash. Bounded by the number of devices. */
  private readonly pendingWakes = new Map<string, PendingWakes>()
  private readonly flushTimer: NodeJS.Timeout
  private readonly onFlushError: ((err: unknown) => void) | undefined

  /**
   * Opens (creating if needed) the SQLite file, brings the schema up to date, and checks
   * that `deviceTokenKey` is the key this file was written with.
   */
  constructor(databasePath: string, deviceTokenKey: Buffer, options: DeviceStoreOptions = {}) {
    this.box = new DeviceTokenBox(deviceTokenKey)
    if (databasePath !== ':memory:') prepareFile(databasePath)
    this.db = new SQLite(databasePath)
    // WAL for the same reason the relay uses it: a reader never blocks the writer.
    this.db.pragma('journal_mode = WAL')
    this.onFlushError = options.onFlushError
    this.migrate()
    this.checkKey()
    try {
      this.scrubIfPending()
    } catch (err) {
      // A failed VACUUM (a full disk, say) must not keep the forwarder down: the old
      // table's pages were zeroed as it was dropped and are checkpointed into the file
      // regardless, so what is left is tidying, tried again at every flush and start.
      this.onFlushError?.(err)
    }
    this.statements = {
      deleteByDeviceToken: this.db.prepare('DELETE FROM devices WHERE device_token_mac = ?'),
      insert: this.db.prepare(
        `INSERT INTO devices
           (wake_token_hash, platform, device_token_mac, device_token_enc, environment,
            created_at, last_wake_at, wake_count)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
      ),
      findByHash: this.db.prepare('SELECT * FROM devices WHERE wake_token_hash = ?'),
      addWakes: this.db.prepare(
        `UPDATE devices
            SET last_wake_at = MAX(COALESCE(last_wake_at, 0), ?), wake_count = wake_count + ?
          WHERE wake_token_hash = ?`,
      ),
      deleteByHash: this.db.prepare('DELETE FROM devices WHERE wake_token_hash = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM devices'),
      flushedAt: this.db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('wakes_flushed_at', ?)",
      ),
    }
    this.registerTx = this.db.transaction((params: RegisterParams) => {
      const mac = this.box.index(params.deviceToken)
      const previous = this.statements.deleteByDeviceToken.run(mac)
      this.statements.insert.run(
        params.wakeTokenHash,
        params.platform,
        mac,
        this.box.seal(params.deviceToken, mac),
        params.environment,
        params.now,
      )
      return { replaced: previous.changes > 0 }
    })
    this.flushTx = this.db.transaction((entries: [string, PendingWakes][], at: number) => {
      for (const [hash, pending] of entries) {
        this.statements.addWakes.run(pending.last, pending.count, hash)
      }
      this.statements.flushedAt.run(String(at))
    })
    this.flushTimer = setInterval(() => {
      try {
        this.flushWakes()
      } catch (err) {
        // Thrown out of a timer, this would end the process. The tallies stay pending.
        this.onFlushError?.(err)
      }
      // A clean-up a busy reader held up at start-up is finished as soon as it can be.
      try {
        this.scrubIfPending()
      } catch (err) {
        this.onFlushError?.(err)
      }
    }, options.wakeFlushIntervalMs ?? DEFAULT_WAKE_FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
  }

  /**
   * Append-only migration list, so a fresh file and an upgraded one end identically.
   * Schema evolution inside this established list is house convention, not one-time
   * clean-up code: every step is how a file written by an earlier release comes forward.
   *
   * - Version 1 was iOS-only (`apns_token`, no platform column).
   * - Version 2 generalised the address to any provider; every row that existed under
   *   version 1 was an iPhone, which is what the DEFAULT says.
   * - Version 3 [2026-10-02] stops keeping the address in the clear: a keyed hash carries
   *   UNIQUE and the address itself is encrypted (`token-box.ts`). One transaction, so a
   *   stop part-way leaves the version-2 file it started from. The old table is dropped
   *   with `secure_delete` on, so the pages it frees are zeroed in that same transaction,
   *   and the transaction also leaves a `scrub_pending` marker: `scrubIfPending` then
   *   rewrites the file and empties the WAL, and it runs again at every start, and at
   *   every flush, until that has completed. A stop between the commit and the end of the
   *   clean-up therefore cannot leave clear text behind for good.
   */
  private migrate(): void {
    let current = this.db.pragma('user_version', { simple: true }) as number
    if (current >= SCHEMA_VERSION) return
    if (current < 1) {
      this.db.transaction(() => {
        this.db.exec(DEVICES_TABLE)
        this.db.exec(META_TABLE)
        this.writeKeyCheck()
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
      })()
      return
    }
    if (current < 2) {
      this.db.exec(`
        ALTER TABLE devices RENAME COLUMN apns_token TO device_token;
        ALTER TABLE devices ADD COLUMN platform TEXT NOT NULL DEFAULT 'ios';
      `)
      this.db.pragma('user_version = 2')
      current = 2
    }
    if (current < 3) {
      this.db.pragma('secure_delete = ON')
      this.db.transaction(() => {
        const rows = this.db.prepare('SELECT * FROM devices').all() as DeviceRowV2[]
        this.db.exec('ALTER TABLE devices RENAME TO devices_v2')
        this.db.exec(DEVICES_TABLE)
        const insert = this.db.prepare(
          `INSERT INTO devices
             (wake_token_hash, platform, device_token_mac, device_token_enc, environment,
              created_at, last_wake_at, wake_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const row of rows) {
          const mac = this.box.index(row.device_token)
          insert.run(
            row.wake_token_hash,
            row.platform,
            mac,
            this.box.seal(row.device_token, mac),
            row.environment,
            row.created_at,
            row.last_wake_at,
            row.wake_count,
          )
        }
        this.db.exec('DROP TABLE devices_v2')
        this.db.exec(META_TABLE)
        this.writeKeyCheck()
        this.db
          .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('scrub_pending', 'vacuum')")
          .run()
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
      })()
      this.db.pragma('secure_delete = OFF')
    }
  }

  /**
   * Finish the clean-up a schema-3 migration owes: rewrite the file with VACUUM, so nothing
   * of the old clear-text table survives even as free space, then checkpoint the WAL into
   * the file and empty it. The marker goes only once the checkpoint reports that it copied
   * everything; while another connection holds a read open, it cannot, and this is tried
   * again at the next flush and the next start. Never throws on a busy file.
   *
   * A VACUUM that fails (it needs free space about the size of the file) still gets the
   * checkpoint: the pages the migration zeroed then reach the file at once, rather than
   * at the next clean shutdown. Its error is passed on after that, and it is retried.
   */
  private scrubIfPending(): void {
    const phase = this.readMeta('scrub_pending')
    if (phase === undefined) return
    let vacuumFailed: unknown
    if (phase === 'vacuum') {
      try {
        this.db.exec('VACUUM')
        this.db.prepare("UPDATE meta SET value = 'checkpoint' WHERE key = 'scrub_pending'").run()
      } catch (err) {
        vacuumFailed = err ?? new Error('VACUUM failed')
      }
    }
    const [result] = this.db.pragma('wal_checkpoint(TRUNCATE)') as {
      busy: number
      log: number
      checkpointed: number
    }[]
    if (vacuumFailed !== undefined) throw vacuumFailed
    if (result && result.busy === 0 && result.checkpointed === result.log) {
      this.db.prepare("DELETE FROM meta WHERE key = 'scrub_pending'").run()
    }
  }

  /** Whether a schema-3 migration's clean-up has still to complete. */
  get scrubPending(): boolean {
    return this.readMeta('scrub_pending') !== undefined
  }

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  private writeKeyCheck(): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('device_token_key_check', ?)")
      .run(this.box.keyCheck)
  }

  /** Refuse to run with a key this file was not written with, rather than ring nobody. */
  private checkKey(): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'device_token_key_check'")
      .get() as { value: string } | undefined
    if (!row) {
      throw new Error(
        'This forwarder database has no device-token key check, so it was not written by this version of the forwarder and its rows cannot be trusted to decrypt. Point DATABASE_PATH at the file this forwarder wrote.',
      )
    }
    if (!this.box.matches(row.value)) {
      throw new Error(
        `DEVICE_TOKEN_KEY is not the key this database was written with. Every phone's push address in it is encrypted under the original key, so with any other key this forwarder could ring nobody. Restore the original key. If it is lost, delete the database file and start again: every phone then has to sign up again before it can be rung. ${DEVICE_TOKEN_KEY_HINT}`,
      )
    }
  }

  private toRecord(row: DeviceRow): DeviceRecord {
    const pending = this.pendingWakes.get(row.wake_token_hash)
    return {
      wakeTokenHash: row.wake_token_hash,
      // Both written by `register`, which only ever accepts the valid values. A row
      // migrated from schema 1 predates Android and defaults to 'ios', correctly.
      platform: row.platform as DevicePlatform,
      deviceToken: this.box.open(row.device_token_enc, row.device_token_mac),
      environment: row.environment as ApnsEnvironment,
      createdAt: row.created_at,
      lastWakeAt: pending ? Math.max(pending.last, row.last_wake_at ?? 0) : row.last_wake_at,
      wakeCount: row.wake_count + (pending?.count ?? 0),
    }
  }

  /**
   * Record a device under a freshly minted wake token, REPLACING any token the same
   * device token already had (PROTOCOL.md §3.1).
   *
   * The delete and the insert are one transaction because the replacement rule is the
   * whole revocation story for a re-registering phone: a window where both tokens work,
   * or where neither does, would be a hole in it. `device_token_mac UNIQUE` is what makes
   * the rule enforced rather than merely intended.
   *
   * Returns whether a previous registration was displaced, for the log line. The HTTP
   * response is identical either way, so this never reaches a caller.
   */
  register(params: RegisterParams): { replaced: boolean } {
    return this.registerTx(params)
  }

  /** The device behind a token hash, or undefined. Callers must not vary their response
   *  on which one they got — see PROTOCOL.md §4. */
  find(wakeTokenHash: string): DeviceRecord | undefined {
    const row = this.statements.findByHash.get(wakeTokenHash) as DeviceRow | undefined
    return row ? this.toRecord(row) : undefined
  }

  /**
   * Note that this device was rung. In memory only, written out by `flushWakes` on a
   * fixed interval; see `DeviceStoreOptions.wakeFlushIntervalMs` for why a ring must not
   * write. Overwrites; never appends.
   */
  recordWake(wakeTokenHash: string, now: number): void {
    const pending = this.pendingWakes.get(wakeTokenHash)
    if (pending) {
      pending.count += 1
      pending.last = Math.max(pending.last, now)
    } else {
      this.pendingWakes.set(wakeTokenHash, { count: 1, last: now })
    }
  }

  /**
   * Write the noted wakes in one transaction, with the time of the flush. It writes even
   * when nothing rang, so a write at the end of a minute is not a sign that a live token
   * was rung in it [2026-10-02]. A row deleted meanwhile is skipped.
   */
  flushWakes(at: number = Date.now()): void {
    const entries = [...this.pendingWakes]
    this.flushTx(entries, at)
    for (const [hash] of entries) this.pendingWakes.delete(hash)
  }

  /** Delete by token hash (revoke, or a provider reporting the device gone). Returns
   *  whether a row went. */
  delete(wakeTokenHash: string): boolean {
    this.pendingWakes.delete(wakeTokenHash)
    return this.statements.deleteByHash.run(wakeTokenHash).changes > 0
  }

  /** Registered devices. Operator-facing aggregate; not served on any public route. */
  count(): number {
    const row = this.statements.count.get() as { n: number }
    return row.n
  }

  /** Write any noted wakes, then close. */
  close(): void {
    clearInterval(this.flushTimer)
    try {
      this.flushWakes()
    } catch (err) {
      this.onFlushError?.(err)
    }
    this.db.close()
  }
}

interface PendingWakes {
  count: number
  last: number
}
