import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveCaps, getGroupCapOverrides, setGroupCapOverrides } from '../src/caps'
import type { GroupCapDefaults } from '../src/config'
import {
  createDatabase,
  type Database,
  dropPgSchema,
  ensurePgSchema,
  legacyGroupDefaults,
  migrate,
} from '../src/db'
import { toEndpoint } from '../src/mappers'
import { hitQuota, quotaHits } from '../src/quota'
import { groupSuspendedAt, setGroupSuspended } from '../src/tenancy'
import { PG_URL, USE_POSTGRES } from './helpers'

/** Distinctive relay-wide caps, so a fallback is visibly a fallback [0030]. */
const DEFAULTS: GroupCapDefaults = {
  endpoints: 4,
  queuedMessages: 9,
  queuedBytes: 1234,
  sendsPerWindow: 7,
  sendWindowMs: 60_000,
}

/**
 * The additive `device_name` column (5-ext) must upgrade a PRE-EXISTING relay
 * database IN PLACE — the owner runs a live relay with real rows that predate the
 * column. This proves the idempotent in-place ALTER: an old-shape
 * `endpoints` table (no device_name) gains the nullable column on migrate(),
 * existing rows survive with device_name = null, and the mapper omits it on the wire.
 *
 * Runs on whichever dialect the suite is pointed at (SQLite in-memory by default,
 * an isolated Postgres schema under TABSEND_TEST_PG=1) — the "does this column
 * already exist?" probe behind the ALTER is dialect-specific, so both branches
 * need real coverage.
 */

let db: Kysely<Database>
let pgSchema: string | undefined

beforeEach(async () => {
  if (USE_POSTGRES) {
    pgSchema = `ts_${randomBytes(8).toString('hex')}`
    db = createDatabase(PG_URL, { pgSchema })
    await ensurePgSchema(db, pgSchema)
    return
  }
  pgSchema = undefined
  db = createDatabase('sqlite::memory:')
})
afterEach(async () => {
  if (pgSchema) await dropPgSchema(db, pgSchema)
  await db.destroy()
})

/** Build the chunk-4 endpoints table shape — everything EXCEPT device_name. */
async function createLegacySchema(): Promise<void> {
  await db.schema
    .createTable('groups')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('created_at', 'text', (c) => c.notNull())
    // `plan` and `has_email` exactly as migrate() used to create them, up to and
    // including [0029], which stopped creating them on a fresh database and ships no
    // migration to drop them (house rule). `plan` is NOT NULL with NO default, which
    // is the whole reason the write side needs `legacyGroupDefaults`: an INSERT that
    // simply omits it fails here, in both dialects.
    .addColumn('plan', 'text', (c) => c.notNull())
    .addColumn('has_email', 'integer', (c) => c.notNull().defaultTo(0))
    // Present on purpose: ADR-0021 stopped writing this column but ships no migration to
    // drop it, so a relay predating the removal (or restored from an old backup) still
    // has it. Keeping it in the fixture proves current inserts work against such a
    // database — the column is nullable and nothing references it any more.
    .addColumn('recovery_verifier', 'text')
    .execute()
  await db.schema
    .createTable('endpoints')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull().references('groups.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('browser', 'text')
    .addColumn('platform', 'text', (c) => c.notNull())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('e2e_pubkey', 'text', (c) => c.notNull())
    .addColumn('push_subscription', 'text', (c) => c.notNull())
    .addColumn('device_token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('last_seen_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  // The messages table as it stood before ADR-0028, i.e. without history_blob.
  await db.schema
    .createTable('messages')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('source_endpoint_id', 'text', (c) => c.notNull())
    .addColumn('target_endpoint_id', 'text', (c) => c.notNull())
    .addColumn('envelope', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('delivered_at', 'text')
    .addColumn('acked_at', 'text')
    .execute()
}

describe('additive device_name migration (owner live-data upgrade)', () => {
  it('adds the nullable column to a pre-existing table; old rows survive', async () => {
    await createLegacySchema()
    const now = '2026-07-18T00:00:00.000Z'
    await db
      .insertInto('groups')
      .values({ id: 'g', created_at: now, plan: 'free', has_email: 0 })
      .execute()
    // Legacy row has no device_name column yet (cast: the typed schema knows it).
    await db
      .insertInto('endpoints')
      .values({
        id: 'ep-old',
        group_id: 'g',
        kind: 'extension',
        browser: 'chrome',
        platform: 'macos',
        label: 'Chrome · MacBook',
        e2e_pubkey: 'pk',
        push_subscription: '{}',
        device_token_hash: 'hash',
        last_seen_at: now,
        created_at: now,
      } as any)
      .execute()

    // Run the real migration over the legacy db — idempotent createTable + ALTER.
    await migrate(db)
    // Running it twice must not error (the column already exists the second time).
    await migrate(db)

    const row = await db
      .selectFrom('endpoints')
      .selectAll()
      .where('id', '=', 'ep-old')
      .executeTakeFirstOrThrow()
    expect('device_name' in row).toBe(true)
    expect(row.device_name).toBeNull() // pre-existing row: no tie
    expect(row.label).toBe('Chrome · MacBook') // untouched

    // The mapper omits the null tie on the wire (matches the optional field).
    const wire = toEndpoint(row, new Date(now), false)
    expect(wire).not.toHaveProperty('deviceName')

    // And a NEW row can now carry a device_name.
    await db
      .updateTable('endpoints')
      .set({ device_name: 'MacBook' })
      .where('id', '=', 'ep-old')
      .execute()
    const patched = await db
      .selectFrom('endpoints')
      .selectAll()
      .where('id', '=', 'ep-old')
      .executeTakeFirstOrThrow()
    expect(toEndpoint(patched, new Date(now), false).deviceName).toBe('MacBook')
  })
})

/**
 * Retiring `groups.plan` / `groups.has_email` [0029] must not break group creation on
 * a database that still has them (HOSTED_PLAN §2.2).
 *
 * The other retirements were free because the columns were nullable. `plan` is not: it
 * was created NOT NULL with no default, so "the code stops writing it" would mean the
 * owner's live relay could not create a group at all after an upgrade — silently, and
 * only at the moment someone tried to pair a first device into a new group. That is
 * what `legacyGroupDefaults` exists for, and this proves it in both dialects rather
 * than assuming the constraint could be relaxed (SQLite cannot drop a NOT NULL without
 * rebuilding the table, which is the destructive migration this project does not ship).
 */
describe('retired groups.plan / groups.has_email (legacy database still works)', () => {
  const now = '2026-07-18T00:00:00.000Z'

  it('creates a group on a legacy database, filling the retired columns', async () => {
    await createLegacySchema()
    await migrate(db)
    await migrate(db) // idempotent

    // The legacy columns are still there — nothing drops them.
    const defaults = await legacyGroupDefaults(db)
    expect(defaults).toEqual({ plan: 'free', has_email: 0 })

    // Exactly the expression both create paths use (bootstrap + register).
    await db
      .insertInto('groups')
      .values({ id: 'g-new', created_at: now, ...defaults })
      .execute()

    const row = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', 'g-new')
      .executeTakeFirstOrThrow()
    expect(row.id).toBe('g-new')
    expect(row.plan).toBe('free')
    expect(row.has_email).toBe(0)
  })

  it('proves the compat is load-bearing: the same insert without it fails', async () => {
    await createLegacySchema()
    await migrate(db)

    // If this ever stops throwing, the NOT NULL is gone and the probe can go with it.
    await expect(
      db.insertInto('groups').values({ id: 'g-bare', created_at: now }).execute(),
    ).rejects.toThrow()
  })

  it('creates neither column on a fresh database, and needs no defaults there', async () => {
    await migrate(db)

    expect(await legacyGroupDefaults(db)).toEqual({})
    await db.insertInto('groups').values({ id: 'g-fresh', created_at: now }).execute()

    const row = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', 'g-fresh')
      .executeTakeFirstOrThrow()
    expect('plan' in row).toBe(false)
    expect('has_email' in row).toBe(false)
  })
})

/**
 * The same in-place upgrade for `messages.history_blob` [ADR-0028]. The owner runs
 * a live relay whose messages table predates group history, and a relay that fails
 * to start after an upgrade is worse than one without the feature.
 */
describe('additive history_blob migration (owner live-data upgrade)', () => {
  it('adds the nullable column to a pre-existing messages table; queued rows survive', async () => {
    await createLegacySchema()
    const now = '2026-07-18T00:00:00.000Z'
    await db
      .insertInto('groups')
      .values({ id: 'g', created_at: now, plan: 'free', has_email: 0 })
      .execute()
    // A message queued by the old relay, mid-flight across the upgrade.
    await db
      .insertInto('messages')
      .values({
        id: 'm-old',
        group_id: 'g',
        source_endpoint_id: 'ep-a',
        target_endpoint_id: 'ep-b',
        envelope: '{"alg":"x25519-xsalsa20-poly1305/box"}',
        created_at: now,
        expires_at: '2026-07-25T00:00:00.000Z',
        delivered_at: null,
        acked_at: null,
      } as any)
      .execute()

    await migrate(db)
    await migrate(db) // idempotent: the column already exists the second time

    const row = await db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', 'm-old')
      .executeTakeFirstOrThrow()
    expect('history_blob' in row).toBe(true)
    // A message that predates group history has none, and is still deliverable.
    expect(row.history_blob).toBeNull()
    expect(row.envelope).not.toBeNull()
    expect(row.acked_at).toBeNull()

    // And a new send can carry one.
    await db
      .updateTable('messages')
      .set({ history_blob: '{"alg":"xsalsa20-poly1305/secretbox"}' })
      .where('id', '=', 'm-old')
      .execute()
    const patched = await db
      .selectFrom('messages')
      .select('history_blob')
      .where('id', '=', 'm-old')
      .executeTakeFirstOrThrow()
    expect(patched.history_blob).toContain('secretbox')
  })
})

/**
 * The per-group caps and the shared quota store [0030] must land on the owner's live
 * relay the same way every other additive change has: `groups` gains four nullable
 * columns in place, `quota_counters` is created from nothing, and a relay that has
 * been up since before either one still starts and still works.
 *
 * The nullability is the part worth a test rather than a glance. NULL means "no
 * override, follow the relay" and 0 means "unlimited for this group"; if the ALTER
 * ever arrived with a NOT NULL DEFAULT 0 instead, every pre-existing group would
 * silently become permanently exempt from a cap its operator later set relay-wide,
 * and nothing would report it.
 */
describe('additive caps + quota migration (owner live-data upgrade)', () => {
  const now = '2026-07-18T00:00:00.000Z'

  it('adds nullable cap columns to a pre-existing groups table; old groups follow the relay', async () => {
    await createLegacySchema()
    await db
      .insertInto('groups')
      .values({ id: 'g-old', created_at: now, plan: 'free', has_email: 0 })
      .execute()

    await migrate(db)
    await migrate(db) // idempotent: the columns already exist the second time

    const row = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', 'g-old')
      .executeTakeFirstOrThrow()
    expect('cap_endpoints' in row).toBe(true)
    // NULL, not 0: "nobody set a cap here", which is what makes the relay-wide
    // default apply to a group that predates caps entirely.
    expect(row.cap_endpoints).toBeNull()
    expect(row.cap_queued_messages).toBeNull()
    expect(row.cap_queued_bytes).toBeNull()
    expect(row.cap_sends_per_window).toBeNull()
    expect(await effectiveCaps(db, DEFAULTS, 'g-old')).toMatchObject({
      endpoints: 4,
      queuedMessages: 9,
    })

    // And an override can be set on that same legacy row, including 0 for unlimited.
    expect(await setGroupCapOverrides(db, 'g-old', { endpoints: 2, queuedBytes: 0 })).toBe(true)
    expect(await getGroupCapOverrides(db, 'g-old')).toEqual({
      endpoints: 2,
      queuedMessages: null,
      queuedBytes: 0,
      sendsPerWindow: null,
    })
    expect(await effectiveCaps(db, DEFAULTS, 'g-old')).toMatchObject({
      endpoints: 2,
      queuedBytes: 0,
    })
  })

  /**
   * `groups.suspended_at` [0031] lands the same way, and its nullability is the part
   * worth a test: NULL is the ONLY spelling of "not suspended". A NOT NULL DEFAULT
   * would have needed a sentinel timestamp meaning "not really", and every reader of
   * the column would have had to know it.
   */
  it('adds a nullable suspended_at to a pre-existing groups table; old groups read as running', async () => {
    await createLegacySchema()
    await db
      .insertInto('groups')
      .values({ id: 'g-old', created_at: now, plan: 'free', has_email: 0 })
      .execute()

    await migrate(db)
    await migrate(db) // idempotent: the column already exists the second time

    const row = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', 'g-old')
      .executeTakeFirstOrThrow()
    expect('suspended_at' in row).toBe(true)
    expect(row.suspended_at).toBeNull()
    expect(await groupSuspendedAt(db, 'g-old')).toBeNull()

    // And a group that predates suspension can be suspended and resumed. The write
    // reports the state it left behind, so the caller needs no read-back.
    const at = new Date('2026-08-20T09:00:00.000Z')
    expect(await setGroupSuspended(db, 'g-old', true, at)).toEqual({
      exists: true,
      suspendedAt: '2026-08-20T09:00:00.000Z',
    })
    expect(await groupSuspendedAt(db, 'g-old')).toBe('2026-08-20T09:00:00.000Z')

    // Suspending an ALREADY suspended group keeps the original timestamp: a grace
    // period is counted from it, and an idempotent retry must not restart that clock.
    expect(
      await setGroupSuspended(db, 'g-old', true, new Date('2026-09-01T00:00:00.000Z')),
    ).toEqual({ exists: true, suspendedAt: '2026-08-20T09:00:00.000Z' })
    expect(await groupSuspendedAt(db, 'g-old')).toBe('2026-08-20T09:00:00.000Z')

    expect(await setGroupSuspended(db, 'g-old', false, at)).toEqual({
      exists: true,
      suspendedAt: null,
    })
    expect(await groupSuspendedAt(db, 'g-old')).toBeNull()
    // No such group reports so, rather than succeeding silently.
    expect(await setGroupSuspended(db, 'g-nope', true, at)).toEqual({
      exists: false,
      suspendedAt: null,
    })
  })

  /**
   * `provisioning_idempotency` [0031] arrives on a relay that predates it exactly as
   * `quota_counters` did: created from nothing, idempotently, on both dialects. Its
   * primary key is what makes claiming a key atomic rather than a check-then-write, so
   * a duplicate insert must be refused by the DATABASE and not by a JavaScript branch.
   */
  it('creates the idempotency table on a legacy database, with the key as its primary key', async () => {
    await createLegacySchema()
    await migrate(db)
    await migrate(db) // idempotent: the table already exists the second time

    await db
      .insertInto('provisioning_idempotency')
      .values({ key: 'signup-1', group_id: 'g-1', created_at: now })
      .execute()
    await expect(
      db
        .insertInto('provisioning_idempotency')
        .values({ key: 'signup-1', group_id: 'g-2', created_at: now })
        .execute(),
    ).rejects.toThrow()

    // And the claim-shaped insert answers "somebody else already has it" without
    // throwing, which is what the create route relies on under a race.
    await db
      .insertInto('provisioning_idempotency')
      .values({ key: 'signup-1', group_id: 'g-2', created_at: now })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute()
    const row = await db
      .selectFrom('provisioning_idempotency')
      .select('group_id')
      .where('key', '=', 'signup-1')
      .executeTakeFirstOrThrow()
    expect(row.group_id).toBe('g-1')
  })

  it('creates the quota table on a database that has never had one, and counts there', async () => {
    await createLegacySchema()
    await migrate(db)
    await migrate(db)

    const at = new Date('2026-07-18T00:00:30.000Z')
    const req = { scope: 'register_ip', key: '10.0.0.1', max: 1, windowMs: 60_000, now: at }
    expect((await hitQuota(db, req)).ok).toBe(true)
    expect((await hitQuota(db, req)).ok).toBe(false)
    expect(await quotaHits(db, 'register_ip', '10.0.0.1', 60_000, at)).toBe(1)
    // Composite primary key present: a second row for the same window is impossible.
    await expect(
      db
        .insertInto('quota_counters')
        .values({
          scope: 'register_ip',
          key: '10.0.0.1',
          window_start: '2026-07-18T00:00:00.000Z',
          window_end: '2026-07-18T00:01:00.000Z',
          hits: 1,
        })
        .execute(),
    ).rejects.toThrow()
  })
})
