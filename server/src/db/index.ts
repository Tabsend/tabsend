import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SQLite from 'better-sqlite3'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { Database } from './schema'

/** True for a `postgres://` / `postgresql://` DATABASE_URL. */
export function isPostgresUrl(databaseUrl: string): boolean {
  return databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')
}

/**
 * Turn a non-Postgres DATABASE_URL into a better-sqlite3 path. Accepts a bare
 * path, `sqlite:`/`sqlite://`/`file:` prefixes, or `:memory:`.
 */
export function resolveSqlitePath(databaseUrl: string): string {
  let path = databaseUrl
  if (path.startsWith('sqlite://')) path = path.slice('sqlite://'.length)
  else if (path.startsWith('sqlite:')) path = path.slice('sqlite:'.length)
  else if (path.startsWith('file:')) path = path.slice('file:'.length)
  return path === '' ? ':memory:' : path
}

/** Options for {@link createDatabase}. `pgSchema` isolates test runs (search_path). */
export interface CreateDatabaseOptions {
  /**
   * Postgres only: pin the connection's `search_path` to this schema so parallel
   * test suites (schema-per-suite) never collide. Ignored for SQLite. The schema
   * itself is created by {@link ensurePgSchema} before {@link migrate}.
   */
  pgSchema?: string
  /**
   * Postgres only: told when a pooled connection fails while idle, for the log. See
   * {@link createPgPool}. Without it the failure goes to stderr.
   */
  onPoolError?: (error: Error) => void
}

/**
 * The relay's Postgres pool.
 *
 * A pooled connection that dies while IDLE (Postgres restarted, an administrator ended
 * the session, the socket dropped) arrives as an `'error'` event on the pool, and pg
 * re-throws an `'error'` event nobody listens for, which ends the process. Found on the
 * hosted machine on 2026-10-13 (`PLANS.md` P-13): stopping Postgres killed the relay
 * instead of it answering "not now" until the database came back, the behaviour
 * HOSTED_PLAN §10.1 asks for and clients already handle (a 5xx holds the tab, ADR-0008).
 * The pool discards the dead connection by itself and opens a fresh one on the next
 * query, so reporting it is all this listener has to do.
 */
export function createPgPool(databaseUrl: string, options: CreateDatabaseOptions = {}): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    // Explicit rather than inherited [2026-10-01 follow-up review, R13]. Ten is pg's
    // own default and plenty for one relay process, because a group's writes queue
    // in memory before they ask for one (group-queue.ts). The wait for a connection
    // is bounded so that if the pool is ever exhausted anyway, requests fail and say
    // so instead of hanging for as long as whatever holds it.
    max: 10,
    connectionTimeoutMillis: 10_000,
    // `-c search_path=<schema>` scopes every connection in the pool to one
    // schema without qualifying a single query (test isolation).
    ...(options.pgSchema ? { options: `-c search_path=${options.pgSchema}` } : {}),
  })
  pool.on('error', (error) => {
    if (options.onPoolError) options.onPoolError(error)
    else console.error(`Tabsend relay: an idle database connection failed: ${error.message}`)
  })
  return pool
}

/**
 * Which live Kysely instances speak Postgres. Recorded at construction because
 * the dialect is not readable off a Kysely instance, and {@link migrate} needs
 * it to pick the right catalogue query (see {@link tableColumns}).
 */
const postgresDbs = new WeakSet<Kysely<Database>>()

/**
 * Open a Kysely instance for the given DATABASE_URL. SQLite (better-sqlite3) is
 * the dev/test default; a `postgres://` URL selects the Postgres dialect (pg
 * Pool) against the SAME migrations and dialect-agnostic queries (Chunk 4a).
 */
export function createDatabase(
  databaseUrl: string,
  options: CreateDatabaseOptions = {},
): Kysely<Database> {
  if (isPostgresUrl(databaseUrl)) {
    const pool = createPgPool(databaseUrl, options)
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    postgresDbs.add(db)
    return db
  }

  const path = resolveSqlitePath(databaseUrl)
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const sqlite = new SQLite(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
}

/**
 * Postgres only: create an isolation schema if it doesn't exist. Called before
 * {@link migrate} when a `pgSchema` is in use (tests). No-op reasoning: CREATE
 * SCHEMA is independent of search_path, so a db whose search_path points at a
 * not-yet-existing schema can still run this to bring it into being.
 */
export async function ensurePgSchema(db: Kysely<Database>, schema: string): Promise<void> {
  await sql`create schema if not exists ${sql.ref(schema)}`.execute(db)
}

/** Postgres only: drop an isolation schema and everything in it (test teardown). */
export async function dropPgSchema(db: Kysely<Database>, schema: string): Promise<void> {
  await sql`drop schema if exists ${sql.ref(schema)} cascade`.execute(db)
}

/**
 * Create the schema if it does not exist. Idempotent. Written with Kysely's
 * dialect-agnostic schema builder so it runs unchanged on SQLite AND Postgres:
 * TEXT ISO-8601 timestamps (fixed-width → sort chronologically as text on both),
 * INTEGER 0/1 booleans, and no dialect-specific column types.
 */
export async function migrate(db: Kysely<Database>): Promise<void> {
  // RETIRED [0029]: `plan` and `has_email` are gone from this table. They were
  // written once ('free', 0) and never read by anything, and the relay is
  // deliberately account-less — per-group state is caps as explicit values and
  // nothing else (HOSTED_PLAN §2.2). A database created BEFORE this still has both
  // columns, and keeps them: there is no shipped one-time migration (house rule).
  // `legacyGroupDefaults` is what lets an INSERT satisfy the old NOT NULL there.
  await db.schema
    .createTable('groups')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('created_at', 'text', (c) => c.notNull())
    // ADDITIVE [0030]: per-group cap overrides (HOSTED_PLAN §4.3). Nullable on
    // purpose — NULL is "no override", which is a different fact from "unlimited"
    // (0) and has to stay tellable apart, or raising the relay-wide default would
    // silently raise it for a group somebody deliberately pinned.
    .addColumn('cap_endpoints', 'integer')
    .addColumn('cap_queued_messages', 'integer')
    .addColumn('cap_queued_bytes', 'integer')
    .addColumn('cap_sends_per_window', 'integer')
    // ADDITIVE [0031]: when this tenancy was suspended (HOSTED_PLAN §5), NULL while
    // it is running. Nullable is the only honest shape: NULL is "not suspended", and
    // a timestamp answers "since when", which is what a grace period counts from.
    .addColumn('suspended_at', 'text')
    .execute()

  await db.schema
    .createTable('endpoints')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull().references('groups.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('browser', 'text')
    .addColumn('platform', 'text', (c) => c.notNull())
    .addColumn('label', 'text', (c) => c.notNull())
    // ADDITIVE (5-ext): device grouping hint, nullable so pre-existing rows work.
    .addColumn('device_name', 'text')
    .addColumn('e2e_pubkey', 'text', (c) => c.notNull())
    .addColumn('push_subscription', 'text', (c) => c.notNull())
    // ADDITIVE (6b): consecutive push-failure counter for dead-subscription pruning.
    .addColumn('push_failures', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('device_token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('last_seen_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createIndex('endpoints_group_id_idx')
    .ifNotExists()
    .on('endpoints')
    .column('group_id')
    .execute()

  await db.schema
    .createTable('messages')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('source_endpoint_id', 'text', (c) => c.notNull())
    .addColumn('target_endpoint_id', 'text', (c) => c.notNull())
    .addColumn('envelope', 'text')
    .addColumn('history_blob', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('delivered_at', 'text')
    .addColumn('acked_at', 'text')
    .execute()

  await db.schema
    .createIndex('messages_target_idx')
    .ifNotExists()
    .on('messages')
    .columns(['target_endpoint_id', 'acked_at'])
    .execute()

  await db.schema
    .createIndex('messages_source_idx')
    .ifNotExists()
    .on('messages')
    .columns(['source_endpoint_id', 'acked_at'])
    .execute()

  // The TTL sweeper (sweep.ts) scans by expiry; index it so purge/prune passes
  // stay cheap as the queue grows.
  await db.schema
    .createIndex('messages_expires_idx')
    .ifNotExists()
    .on('messages')
    .column('expires_at')
    .execute()

  // ADDITIVE [0028]: copies of the group history key, each sealed to one
  // endpoint. Control traffic, kept out of the message queue on purpose — see
  // the table's doc comment.
  await db.schema
    .createTable('group_keys')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('source_endpoint_id', 'text', (c) => c.notNull())
    .addColumn('target_endpoint_id', 'text', (c) => c.notNull())
    .addColumn('envelope', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createIndex('group_keys_target_idx')
    .ifNotExists()
    .on('group_keys')
    .columns(['target_endpoint_id', 'created_at'])
    .execute()

  await db.schema
    .createTable('pairing_codes')
    .ifNotExists()
    .addColumn('code', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull().references('groups.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('consumed_at', 'text')
    .execute()

  // ADDITIVE [2026-10-01]: the two group-scoped reads that run under a held group row
  // were whole-table scans, so their cost grew with every tenant's rows while one
  // tenant's row was held: the live-link count on every device mint and the first-join
  // retirement here, and on `group_keys` the usage report and the deletion cascade.
  await db.schema
    .createIndex('pairing_codes_group_expires_idx')
    .ifNotExists()
    .on('pairing_codes')
    .columns(['group_id', 'expires_at'])
    .execute()
  await db.schema
    .createIndex('group_keys_group_idx')
    .ifNotExists()
    .on('group_keys')
    .column('group_id')
    .execute()

  // ADDITIVE migration (5-ext): `endpoints.device_name`. On a FRESH db the
  // createTable above already includes it; on an EXISTING db (the owner's live
  // relay) ifNotExists skipped the createTable, so add the nullable column here.
  // Idempotent + dialect-agnostic (works on SQLite AND Postgres).
  await ensureColumn(db, 'endpoints', 'device_name', 'text')

  // ADDITIVE migration (6b): `endpoints.push_failures`. Same in-place upgrade path for
  // an existing relay; NOT NULL DEFAULT 0 backfills every pre-existing row to zero.
  await ensureColumn(db, 'endpoints', 'push_failures', 'integer', 0)

  // ADDITIVE migration [0028]: `messages.history_blob`. The group-history copy
  // rides the routing row it describes rather than living in its own table, so
  // there is one row, one lifetime, and no join to dangle. Nullable, so every
  // pre-existing message and every pre-0028 sender stays valid.
  await ensureColumn(db, 'messages', 'history_blob', 'text')

  // The history read scans one group newest-first; without this it is a table
  // scan on every open of a history screen.
  await db.schema
    .createIndex('messages_group_created_idx')
    .ifNotExists()
    .on('messages')
    .columns(['group_id', 'created_at'])
    .execute()

  // ADDITIVE [2026-10-13]: the sweeper drops each history blob at the end of its
  // window (`sweep.ts`), a range on `created_at` across every group that the
  // `(group_id, created_at)` index cannot serve. Partial, so it holds only rows that
  // still carry a blob. Same statement on SQLite and Postgres.
  await sql`create index if not exists messages_history_created_idx on messages (created_at) where history_blob is not null`.execute(
    db,
  )

  // Tombstones for deliberately removed endpoints, so an unknown device token can
  // be answered "you were removed" (definitive) rather than "unauthorized"
  // (ambiguous — also what an empty or restored database says). Endpoints removed
  // BEFORE this table existed leave no tombstone and therefore read as unknown,
  // which is the safe direction: the client keeps its pairing and says so.
  await db.schema
    .createTable('removed_endpoints')
    .ifNotExists()
    .addColumn('device_token_hash', 'text', (c) => c.primaryKey())
    .addColumn('endpoint_id', 'text', (c) => c.notNull())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('removed_at', 'text', (c) => c.notNull())
    .execute()

  // ADDITIVE (P-4): relay-scoped key/value facts (`relay_id`, VAPID keypair).
  await db.schema
    .createTable('meta')
    .ifNotExists()
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .execute()

  // ADDITIVE [0030]: the shared counter store (HOSTED_PLAN §4.4). One row per
  // (limit, subject, window); the composite primary key is what makes the
  // upsert-increment in quota.ts a single atomic statement rather than a
  // read-then-write two clients can interleave. See QuotaCountersTable.
  await db.schema
    .createTable('quota_counters')
    .ifNotExists()
    .addColumn('scope', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('window_start', 'text', (c) => c.notNull())
    .addColumn('window_end', 'text', (c) => c.notNull())
    .addColumn('hits', 'integer', (c) => c.notNull())
    .addPrimaryKeyConstraint('quota_counters_pk', ['scope', 'key', 'window_start'])
    .execute()

  // The sweeper drops whole expired windows by date; without this it is a table
  // scan on every pass, on the one table that grows with request volume.
  await db.schema
    .createIndex('quota_counters_window_end_idx')
    .ifNotExists()
    .on('quota_counters')
    .column('window_end')
    .execute()

  // ADDITIVE migration [0030]: `groups.cap_*`. Same in-place upgrade path as the
  // columns above, for a relay whose `groups` table predates the caps. Nullable, so
  // every pre-existing group starts on the relay-wide defaults (unlimited unless the
  // operator set otherwise) and nothing changes for a relay that never sets a cap.
  await ensureColumn(db, 'groups', 'cap_endpoints', 'integer')
  await ensureColumn(db, 'groups', 'cap_queued_messages', 'integer')
  await ensureColumn(db, 'groups', 'cap_queued_bytes', 'integer')
  await ensureColumn(db, 'groups', 'cap_sends_per_window', 'integer')

  // ADDITIVE migration [0031]: `groups.suspended_at`. Same in-place upgrade path, for
  // a relay whose `groups` table predates suspension. Nullable, so every pre-existing
  // group reads as running — which is what it is. A NOT NULL DEFAULT here would be the
  // one shape that could not work: there is no value that means "not suspended" other
  // than the absence of one.
  await ensureColumn(db, 'groups', 'suspended_at', 'text')

  // ADDITIVE [0031]: which group a control-plane `Idempotency-Key` already created
  // (HOSTED_PLAN §4.2). The header was read and logged from the start and honoured
  // nowhere, so a create the control plane retried after a timeout produced a SECOND
  // tenancy — the exact thing an idempotency key exists to prevent, on the one route
  // where the cost is a duplicate customer. The key is the primary key, which is what
  // makes claiming one an atomic insert rather than a check-then-write: see
  // routes/provisioning.ts. Created from nothing on any relay, and a relay that never
  // turns the provisioning API on simply never writes a row.
  await db.schema
    .createTable('provisioning_idempotency')
    .ifNotExists()
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
}

/**
 * Read this relay's stable id, minting one on the very first boot. NEVER
 * overwrites an existing row — the whole point is that the id survives every
 * restart, migration, and address change (P-4: "same relay, new URL").
 * Idempotent and race-safe: a concurrent mint loses the insert (conflict is
 * ignored) and reads the winner's value.
 */
export async function ensureRelayId(db: Kysely<Database>): Promise<string> {
  await db
    .insertInto('meta')
    .values({ key: 'relay_id', value: randomUUID() })
    .onConflict((oc) => oc.column('key').doNothing())
    .execute()
  const row = await db
    .selectFrom('meta')
    .select('value')
    .where('key', '=', 'relay_id')
    .executeTakeFirstOrThrow()
  return row.value
}

/**
 * Column names of `table` in the schema this connection actually writes to, or an
 * empty list when the table does not exist.
 *
 * Deliberately NOT `db.introspection.getTables()`: that scans every schema in the
 * cluster and calls `pg_get_serial_sequence()` per row, so it both matches
 * same-named tables in OTHER schemas and blows up with `schema "…" does not exist`
 * if any unrelated schema is dropped while the scan runs (which is exactly what
 * parallel schema-per-suite tests do to each other). These queries are scoped to
 * one table in the current schema and touch nothing else.
 */
async function tableColumns(db: Kysely<Database>, table: string): Promise<string[]> {
  if (postgresDbs.has(db)) {
    // current_schema() = the first existing entry of search_path, i.e. the schema
    // createTable just wrote into (a per-suite `ts_…` schema under test).
    const result = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = ${table}
    `.execute(db)
    return result.rows.map((r) => r.column_name)
  }
  const result = await sql<{ name: string }>`
    select name from pragma_table_info(${table})
  `.execute(db)
  return result.rows.map((r) => r.name)
}

/**
 * The retired `groups` columns a legacy database still needs on INSERT [0029].
 * Empty on any database this version created.
 */
export interface LegacyGroupDefaults {
  plan?: string
  has_email?: number
}

/**
 * Values a `groups` INSERT must still carry on a database that predates [0029].
 *
 * The retirement is column-level, not code-level: fresh databases stop creating
 * `plan`/`has_email`, existing ones keep them, and nothing ships a one-time
 * migration to drop them (house rule). That is safe for every retired column so
 * far because they were nullable — `plan` is not. It was created `text NOT NULL`
 * with NO default, so on the owner's live relay (and on any restored backup) an
 * INSERT that simply omits it fails outright, in BOTH dialects, and group creation
 * with it. Relaxing the constraint in place is not an option either: SQLite cannot
 * drop a NOT NULL without rebuilding the table, which is exactly the destructive
 * migration this project does not ship.
 *
 * So the compat lives here, permanently and honestly: probe once per group creation
 * that is actually going to happen, and write the old values only where the old
 * columns are. `has_email` rides along even though it has a DEFAULT 0 — supplying a
 * value costs one probe we are already making, where relying on the default means
 * trusting that every legacy database in the world got it.
 *
 * "Going to happen" is load-bearing and was not always true: the register route used
 * to probe on every bare register, including the ones a `single` relay was about to
 * refuse — which is almost all of them. Callers now ask the create policy first.
 *
 * Not cached: a group is created at most once per tenancy, so one catalogue read
 * per create is cheaper than reasoning about when a cache could go stale.
 */
export async function legacyGroupDefaults(db: Kysely<Database>): Promise<LegacyGroupDefaults> {
  const columns = await tableColumns(db, 'groups')
  return {
    ...(columns.includes('plan') ? { plan: 'free' } : {}),
    ...(columns.includes('has_email') ? { has_email: 0 } : {}),
  }
}

/**
 * Add a column if the table lacks it. Idempotent; no-op when present.
 *
 * With a `defaultValue` the column is NOT NULL and every existing row backfills to it
 * (how `push_failures` arrived). Without one it is nullable, which is the right shape
 * whenever "not set" has to stay distinguishable from any value a caller could set —
 * the `cap_*` columns [0030], where NULL means "no override" and 0 means "unlimited".
 * Dialect-agnostic (SQLite + Postgres) via {@link tableColumns}.
 */
async function ensureColumn(
  db: Kysely<Database>,
  table: string,
  column: string,
  type: 'text' | 'integer',
  defaultValue?: number,
): Promise<void> {
  const columns = await tableColumns(db, table)
  // No columns at all = no such table; the createTable above will have made it on
  // any real relay, so there is nothing to upgrade in place.
  if (columns.length === 0 || columns.includes(column)) return
  await db.schema
    .alterTable(table)
    .addColumn(column, type, (c) =>
      defaultValue === undefined ? c : c.notNull().defaultTo(defaultValue),
    )
    .execute()
}

export type { Database } from './schema'
