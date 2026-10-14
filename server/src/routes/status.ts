import type { EndpointId } from '@tabsend/shared'
import { CLIENT_PROTOCOL, PRESENCE_ONLINE_THRESHOLD_SECONDS } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { acceptsNewGroups, type GroupCreation } from '../config'
import type { AppContext } from '../context'
import { isPostgresUrl } from '../db'
import type { Database } from '../db/schema'
import { NOT_FOUND_BODY } from '../errors'
import { isDirectLocalCall } from '../netguard'
import { iso } from '../time'
import { RELAY_VERSION } from '../version'

/**
 * GET /admin/status — one call that answers "is this relay healthy, and if not, why".
 *
 * WHO THIS IS FOR. A self-hosted relay is maintained by whoever owns the box, often
 * through an agent doing the typing. Until this route existed, the only thing the
 * relay would tell you about itself was its version (GET /v1/config): no way to see
 * whether devices were paired, whether tabs were stuck, or whether anything had
 * failed since boot. Diagnosis meant reading pino JSON out of `docker logs` and
 * knowing what to look for. This route is the answer to that, and `warnings` is the
 * part that matters most — the relay judges its OWN state against the thresholds it
 * already knows, so a caller does not have to carry them.
 *
 * NOT UNDER /v1. `/v1` is the client protocol, versioned and contract-bound
 * (@tabsend/shared). This is an operator surface for one deployment: its shape may
 * change with no protocol bump, and no client ever calls it. Keeping it outside the
 * prefix is what stops it being mistaken for part of the contract.
 *
 * ACCESS. Loopback callers only, AND only when the request did not pass through a
 * proxy (`isDirectLocalCall`, netguard.ts, which carries the reasoning) — anything else
 * gets the ordinary 404, so a LAN scan cannot even learn the route is here. There is no
 * token and deliberately so: a token is a new secret to store, rotate and eventually
 * leak, to guard a body that a caller on the relay's own host could assemble by opening
 * the database. The provisioning API [0031] does NOT get away with that, and requires a
 * bearer credential on top of the same locality rule: it writes rather than reads, so
 * "could have read this anyway" stops being the argument.
 *
 * Reach it from the host with:
 *
 *   docker exec tabsend-relay node -e "fetch('http://127.0.0.1:8787/admin/status')…"
 *
 * from INSIDE the container (scripts/relay-doctor.sh does exactly this), because under
 * bridge networking a call from the host arrives from the docker gateway, not loopback.
 *
 * WHAT IT MUST NEVER CONTAIN: device tokens or their hashes, push subscriptions,
 * pairing codes, the VAPID private key, and DATABASE_URL (a postgres:// URL carries a
 * password). Device labels ARE included: every paired device can already read them via
 * GET /v1/endpoints, so a loopback-only view of them is not a new exposure.
 */

/** A device silent for longer than this is called out. Long enough that a laptop shut
 *  for a holiday is not a finding, short enough to catch one that quietly unpaired. */
const STALE_DEVICE_DAYS = 14

/** Tabs queued longer than this are stuck, not in flight: every transport (socket,
 *  push, the phone's ~5 min poll chain per ADR-0015) has had many chances by now. */
const STUCK_MESSAGE_SECONDS = 60 * 60

/** Sweeper passes that must have been missed before absence counts as broken, rather
 *  than as a relay that simply booted a moment ago. */
const SWEEPER_GRACE_PASSES = 3

/** Floor under the sweeper's "late" window, and the whole window when the sweeper is
 *  switched off. Without it, ciphertext that expired one second ago would be reported
 *  as un-erased on a relay whose next pass is due imminently. */
const SWEEPER_LATE_FLOOR_SECONDS = 300

/** Fraction of streamMaxConnections at which the socket pool is worth reporting. */
const STREAM_PRESSURE_RATIO = 0.9

/** Devices listed individually. A household relay holds a handful; the cap only stops
 *  a pathological relay from returning a megabyte. */
const MAX_LISTED_DEVICES = 50

export interface StatusWarning {
  /** Stable, greppable id. docs/RUNBOOK.md documents the fix for each one. */
  code: string
  /** Plain-language statement of the problem. Written to be quoted as-is. */
  message: string
}

export interface StatusDevice {
  id: string
  label: string
  kind: string
  platform: string
  deviceName?: string
  groupId: string
  /** Same rule the clients see: recent last_seen_at OR a live socket (mappers.ts). */
  online: boolean
  lastSeenAt: string
  secondsSinceSeen: number
  liveSockets: number
  /** 'webpush' | 'forwarder' | 'none'. Never the subscription itself. */
  pushTransport: string
  pushFailures: number
  pushDead: boolean
  createdAt: string
}

export interface RelayStatus {
  generatedAt: string
  relay: {
    version: string | null
    relayId: string
    protocol: number
    startedAt: string
    uptimeSeconds: number
    node: string
  }
  listeners: {
    publicRelayUrl: string
    publicBrowserRelayUrl: string
    tlsSelfSigned: boolean
    certFingerprint: string | null
    cleartextPort: number | null
    cleartextAllowsPublic: boolean
  }
  database: {
    backend: 'sqlite' | 'postgres'
    reachable: boolean
    /** SQLite only, and only when the file is statable from this process. */
    fileBytes?: number
    /** Present only when `reachable` is false. */
    error?: string
  }
  groups: {
    count: number
    /**
     * How many of them are suspended [0031]. A RELAY-WIDE count, not a per-group
     * state: per-group detail belongs to the provisioning API (HOSTED_PLAN §4.2), and
     * this number is here for one narrow reason — an operator debugging "sends are
     * being refused and I do not know why" would otherwise have no way to see that a
     * suspension is the answer without reading the database.
     */
    suspended: number
    acceptsNewGroups: boolean
    /**
     * Whether SEVERAL groups may coexist here — derived from `groupCreation`, which is
     * true for both of the non-default policies. Kept alongside it rather than replaced
     * by it [0029]: an operator (or agent) reading this route already knows this field,
     * and the policy is additive information, not a rename.
     */
    allowMultipleGroups: boolean
    /** Who may create a group here [0029]: `single`, `open`, or `provisioned`. */
    groupCreation: GroupCreation
  }
  devices: {
    total: number
    online: number
    byKind: Record<string, number>
    /** Capped at MAX_LISTED_DEVICES; `total` is always the true count. */
    list: StatusDevice[]
  }
  messages: {
    /** Handed to the relay, not yet collected by the target. */
    waiting: number
    /** Of those, the ones old enough to be stuck rather than in flight. The number the
     *  `tabs_waiting` warning is allowed to quote. */
    stuck: number
    oldestWaitingSeconds: number | null
    /** Collected but never acked: the target read it and did not confirm. */
    deliveredNotAcked: number
    /** Expired but still holding ciphertext. */
    expiredNotSwept: number
    /** How long the longest-expired of those has been past its expiry. A few seconds is
     *  the ordinary gap between sweeps; hours means erasure is not happening. */
    oldestExpiredSeconds: number | null
    totalRows: number
  }
  stream: {
    reservedSockets: number
    endpointsWithSocket: number
    maxConnections: number
  }
  sweeper: {
    intervalSeconds: number
    runs: number
    lastRunAt?: string
    lastPurged: number
    lastDeleted: number
    totalPurged: number
    totalDeleted: number
    errors: number
  }
  refusals: {
    rateLimited: number
    nonPrivateClient: number
    unauthorized: number
    endpointRemoved: number
    internalError: number
  }
  lastError?: { at: string; message: string }
  warnings: StatusWarning[]
}

/** COUNT(*) coerced to a JS number: SQLite hands back a number, Postgres a bigint string. */
async function countAll(
  qb: ReturnType<Kysely<Database>['selectFrom']> | { execute: () => Promise<unknown[]> },
): Promise<number> {
  const rows = (await qb.execute()) as Array<{ n?: unknown }>
  return Number(rows[0]?.n ?? 0)
}

/** Names for a warning: quote a few, then count the rest. `["a","b","c"]` → `"a", "b", "c"`. */
function nameList(labels: string[], limit = 5): string {
  const quoted = labels.slice(0, limit).map((label) => `"${label}"`)
  const rest = labels.length - quoted.length
  return rest > 0 ? `${quoted.join(', ')} and ${rest} more` : quoted.join(', ')
}

function secondsBetween(fromIso: string, now: Date): number {
  const parsed = Date.parse(fromIso)
  if (Number.isNaN(parsed)) return 0
  return Math.max(0, Math.round((now.getTime() - parsed) / 1000))
}

/** Read `transport` out of a stored subscription without ever returning the rest of it. */
function transportOf(pushSubscriptionJson: string): string {
  try {
    const parsed: unknown = JSON.parse(pushSubscriptionJson)
    const transport =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { transport?: unknown }).transport
        : undefined
    return typeof transport === 'string' ? transport : 'unknown'
  } catch {
    return 'unparseable'
  }
}

/**
 * SQLite footprint, for the one number a self-hoster actually watches: is /data filling
 * up. Counts the `-wal` and `-shm` siblings too — the relay runs in WAL mode
 * (db/index.ts), where a large write-ahead log is exactly the growth worth noticing and
 * the main file alone can sit unchanged while the volume fills.
 */
async function sqliteFileBytes(databaseUrl: string): Promise<number | undefined> {
  const { resolveSqlitePath } = await import('../db')
  const path = resolveSqlitePath(databaseUrl)
  if (path === ':memory:') return undefined
  const { statSync } = await import('node:fs')
  let total: number | undefined
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total = (total ?? 0) + statSync(`${path}${suffix}`).size
    } catch {
      // A missing sibling is normal (no active WAL); a missing main file means the
      // relay is not backed by a file we can see, and `total` stays undefined.
    }
  }
  return total
}

/**
 * Assemble the full status. Exported separately from the route so tests (and any
 * future CLI) can call it without going over HTTP.
 *
 * Database failures are CAUGHT, not thrown: a relay whose store is unreachable is
 * exactly when someone is asking, and a 500 here would answer "the diagnostics are
 * broken too" instead of "your database is down". The process-level facts still come
 * back, with `database.reachable: false` and a warning naming it.
 */
export async function buildRelayStatus(ctx: AppContext): Promise<RelayStatus> {
  const now = ctx.now()
  const nowIso = iso(now)
  const backend: 'sqlite' | 'postgres' = isPostgresUrl(ctx.config.databaseUrl)
    ? 'postgres'
    : 'sqlite'
  const stats = ctx.stats.snapshot()
  const uptimeSeconds = Math.max(
    0,
    Math.round((now.getTime() - ctx.stats.startedAt.getTime()) / 1000),
  )

  const warnings: StatusWarning[] = []
  const warn = (code: string, message: string) => warnings.push({ code, message })

  const status: RelayStatus = {
    generatedAt: nowIso,
    relay: {
      version: RELAY_VERSION ?? null,
      relayId: ctx.relayId,
      protocol: CLIENT_PROTOCOL,
      startedAt: ctx.stats.startedAt.toISOString(),
      uptimeSeconds,
      node: process.version,
    },
    listeners: {
      publicRelayUrl: ctx.config.publicRelayUrl,
      publicBrowserRelayUrl: ctx.config.publicBrowserRelayUrl,
      tlsSelfSigned: ctx.config.tlsSelfSigned,
      certFingerprint: ctx.certFingerprint ?? null,
      cleartextPort: ctx.config.httpPort ?? null,
      cleartextAllowsPublic: ctx.config.httpAllowPublic,
    },
    database: { backend, reachable: true },
    groups: {
      count: 0,
      suspended: 0,
      acceptsNewGroups: false,
      // "Several groups may exist here" is exactly the two non-default policies [0029].
      allowMultipleGroups: ctx.config.groupCreation !== 'single',
      groupCreation: ctx.config.groupCreation,
    },
    devices: { total: 0, online: 0, byKind: {}, list: [] },
    messages: {
      waiting: 0,
      stuck: 0,
      oldestWaitingSeconds: null,
      deliveredNotAcked: 0,
      expiredNotSwept: 0,
      oldestExpiredSeconds: null,
      totalRows: 0,
    },
    stream: {
      reservedSockets: ctx.hub.reservedConnections(),
      endpointsWithSocket: ctx.hub.onlineEndpointIds().length,
      maxConnections: ctx.config.streamMaxConnections,
    },
    sweeper: {
      intervalSeconds: Math.round(ctx.config.sweepIntervalMs / 1000),
      ...stats.sweeps,
    },
    refusals: stats.refusals,
    ...(stats.lastError ? { lastError: stats.lastError } : {}),
    warnings,
  }

  try {
    const groupRows = await ctx.db.selectFrom('groups').select(['id', 'suspended_at']).execute()
    status.groups.count = groupRows.length
    status.groups.suspended = groupRows.filter((g) => g.suspended_at !== null).length
    // The same ladder GET /v1/config answers with, called rather than copied [0029] —
    // a `provisioned` relay accepts no new group even with none yet, so reporting "yes"
    // here would send an operator looking for a fault when the refusal is the
    // configuration working.
    status.groups.acceptsNewGroups = acceptsNewGroups(
      ctx.config.groupCreation,
      groupRows.length > 0,
    )

    const endpointRows = await ctx.db
      .selectFrom('endpoints')
      .select([
        'id',
        'group_id',
        'kind',
        'platform',
        'label',
        'device_name',
        'push_subscription',
        'push_failures',
        'last_seen_at',
        'created_at',
      ])
      .orderBy('last_seen_at', 'desc')
      .execute()

    const liveIds = new Set<string>(ctx.hub.onlineEndpointIds())
    const byKind: Record<string, number> = {}
    let online = 0
    const list: StatusDevice[] = []
    const pushDeadLabels: string[] = []
    const staleLabels: string[] = []

    for (const row of endpointRows) {
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
      const liveSockets = ctx.hub.connectionCount(row.id as EndpointId)
      const secondsSinceSeen = secondsBetween(row.last_seen_at, now)
      const isOnline = liveIds.has(row.id) || secondsSinceSeen <= PRESENCE_ONLINE_THRESHOLD_SECONDS
      if (isOnline) online += 1
      const pushDead = row.push_failures >= ctx.config.pushDeadThreshold

      if (list.length < MAX_LISTED_DEVICES) {
        list.push({
          id: row.id,
          label: row.label,
          kind: row.kind,
          platform: row.platform,
          ...(row.device_name ? { deviceName: row.device_name } : {}),
          groupId: row.group_id,
          online: isOnline,
          lastSeenAt: row.last_seen_at,
          secondsSinceSeen,
          liveSockets,
          pushTransport: transportOf(row.push_subscription),
          pushFailures: row.push_failures,
          pushDead,
          createdAt: row.created_at,
        })
      }

      if (pushDead) pushDeadLabels.push(row.label)
      if (secondsSinceSeen > STALE_DEVICE_DAYS * 86400) staleLabels.push(row.label)
    }

    status.devices = { total: endpointRows.length, online, byKind, list }

    // Aggregated rather than one warning per device: the device LIST is capped, so
    // per-row warnings were the one part of the response that could still grow without
    // bound, and five names plus a count reads better than fifty warnings anyway.
    if (pushDeadLabels.length > 0) {
      warn(
        'push_dead',
        `Wake-up messages keep failing for ${nameList(pushDeadLabels)}. Tabs still arrive, but only when the device next checks in.`,
      )
    }
    if (staleLabels.length > 0) {
      warn(
        'device_stale',
        `No contact for over ${STALE_DEVICE_DAYS} days from ${nameList(staleLabels)}.`,
      )
    }

    const waitingRows = await ctx.db
      .selectFrom('messages')
      .select('created_at')
      .where('envelope', 'is not', null)
      .where('delivered_at', 'is', null)
      .where('expires_at', '>', nowIso)
      .orderBy('created_at', 'asc')
      .limit(1)
      .execute()

    status.messages.waiting = await countAll(
      ctx.db
        .selectFrom('messages')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('envelope', 'is not', null)
        .where('delivered_at', 'is', null)
        .where('expires_at', '>', nowIso),
    )
    status.messages.deliveredNotAcked = await countAll(
      ctx.db
        .selectFrom('messages')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('envelope', 'is not', null)
        .where('delivered_at', 'is not', null)
        .where('acked_at', 'is', null)
        .where('expires_at', '>', nowIso),
    )
    status.messages.expiredNotSwept = await countAll(
      ctx.db
        .selectFrom('messages')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('envelope', 'is not', null)
        .where('expires_at', '<=', nowIso),
    )
    status.messages.totalRows = await countAll(
      ctx.db.selectFrom('messages').select(({ fn }) => fn.countAll().as('n')),
    )
    // Counted separately from `waiting` so the warning can name the tabs that are
    // genuinely stuck instead of every tab in flight beside them.
    status.messages.stuck = await countAll(
      ctx.db
        .selectFrom('messages')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('envelope', 'is not', null)
        .where('delivered_at', 'is', null)
        .where('expires_at', '>', nowIso)
        .where('created_at', '<=', iso(new Date(now.getTime() - STUCK_MESSAGE_SECONDS * 1000))),
    )

    const oldest = waitingRows[0]?.created_at
    status.messages.oldestWaitingSeconds = oldest ? secondsBetween(oldest, now) : null

    // How long the longest-overdue purge has been overdue. "Is the sweeper working"
    // cannot be answered by a row count alone: one that expired a second ago is
    // ordinary, one that expired an hour ago is not, and both count as 1.
    const oldestExpired = await ctx.db
      .selectFrom('messages')
      .select('expires_at')
      .where('envelope', 'is not', null)
      .where('expires_at', '<=', nowIso)
      .orderBy('expires_at', 'asc')
      .limit(1)
      .executeTakeFirst()
    status.messages.oldestExpiredSeconds = oldestExpired
      ? secondsBetween(oldestExpired.expires_at, now)
      : null

    if (backend === 'sqlite') {
      const bytes = await sqliteFileBytes(ctx.config.databaseUrl)
      if (bytes !== undefined) status.database.fileBytes = bytes
    }
  } catch (err) {
    status.database.reachable = false
    status.database.error = err instanceof Error ? err.message : String(err)
    warn(
      'database_unreachable',
      'The relay cannot read its own database. Nothing can be paired, sent or received until this is fixed.',
    )
  }

  // --- judgements ---------------------------------------------------------
  // Everything below turns a number into a statement about whether it is a problem,
  // so the caller never has to know the thresholds.

  if (status.database.reachable) {
    // Keyed on multiplicity, not on the create policy [0029]: `provisioned` expects
    // many groups, it just refuses to make them on request.
    if (status.groups.count > 1 && !status.groups.allowMultipleGroups) {
      warn(
        'multiple_groups',
        `This relay holds ${status.groups.count} separate groups, but is configured for one. Devices in different groups cannot see each other, and both sides look correctly paired.`,
      )
    }
    if (status.devices.total === 0) {
      warn(
        'no_devices',
        'No devices are paired with this relay. The pairing link is printed in the relay log at startup.',
      )
    } else if (status.devices.total === 1) {
      warn(
        'single_device',
        'Only one device is paired. Tabsend needs at least two to send anything.',
      )
    }
    if (status.messages.stuck > 0 && status.messages.oldestWaitingSeconds !== null) {
      warn(
        'tabs_waiting',
        `${status.messages.stuck} tab(s) have been waiting to be picked up for over ${Math.floor(status.messages.oldestWaitingSeconds / 3600)} hour(s). The receiving device is not collecting them.`,
      )
    }

    // Is expired ciphertext actually being erased? Answered by the AGE of the oldest
    // unpurged row, not by a count and not by whether the sweeper "ran": a row that
    // expired a second ago is the ordinary gap between passes, and a sweeper that runs
    // every minute without purging anything would satisfy a runs-based check forever.
    const sweeperEnabled = ctx.config.sweepIntervalMs > 0
    const intervalSeconds = sweeperEnabled ? ctx.config.sweepIntervalMs / 1000 : 0
    const lateAfterSeconds = Math.max(
      intervalSeconds * SWEEPER_GRACE_PASSES,
      SWEEPER_LATE_FLOOR_SECONDS,
    )
    if (
      status.messages.oldestExpiredSeconds !== null &&
      status.messages.oldestExpiredSeconds > lateAfterSeconds
    ) {
      warn(
        sweeperEnabled ? 'sweeper_behind' : 'sweeper_disabled',
        sweeperEnabled
          ? `${status.messages.expiredNotSwept} expired message(s) still hold their contents, the oldest for ${Math.floor(status.messages.oldestExpiredSeconds / 3600)} hour(s). The cleanup job is not keeping up.`
          : `The cleanup job is switched off on this relay (SWEEP_INTERVAL_SECONDS=0), and ${status.messages.expiredNotSwept} expired message(s) still hold their contents. Expired tab contents are never erased here.`,
      )
    }
  }

  if (ctx.config.sweepIntervalMs > 0) {
    const expectedPasses = Math.floor(
      uptimeSeconds / Math.max(1, ctx.config.sweepIntervalMs / 1000),
    )
    if (status.sweeper.runs === 0 && expectedPasses >= SWEEPER_GRACE_PASSES) {
      warn(
        'sweeper_idle',
        'The cleanup job has not run once since the relay started, although it should have by now. Expired tab contents are not being erased.',
      )
    }
  }
  if (status.sweeper.errors > 0) {
    warn(
      'sweeper_failing',
      `The cleanup job has failed ${status.sweeper.errors} time(s) since startup.`,
    )
  }
  if (status.refusals.internalError > 0) {
    warn(
      'internal_errors',
      `The relay has hit ${status.refusals.internalError} unexpected error(s) since startup. This is a defect, not a busy relay.`,
    )
  }
  if (status.refusals.nonPrivateClient > 0) {
    warn(
      'public_clients_refused',
      `${status.refusals.nonPrivateClient} request(s) from outside the local network were turned away at the unencrypted port. If that port is reachable from the internet, close it.`,
    )
  }
  if (ctx.config.httpAllowPublic && ctx.config.httpPort !== undefined) {
    warn(
      'cleartext_public',
      'The unencrypted port is set to accept clients from anywhere. Device tokens travel in the clear on it.',
    )
  }
  if (
    status.stream.maxConnections > 0 &&
    status.stream.reservedSockets >= status.stream.maxConnections * STREAM_PRESSURE_RATIO
  ) {
    warn(
      'stream_at_capacity',
      `${status.stream.reservedSockets} of ${status.stream.maxConnections} live connections are in use. New ones will be refused and delivery falls back to slow polling.`,
    )
  }

  return status
}

export function registerStatusRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/admin/status', async (request, reply) => {
    if (!isDirectLocalCall(request)) {
      // The ordinary not-found body, not a 403: a refusal would confirm the route
      // exists to anything scanning the relay. Logged so a legitimate operator who
      // called it from the wrong place can see WHY it 404'd.
      request.log.warn(
        { peer: request.socket.remoteAddress },
        'Refused /admin/status: the caller is not on this host, or reached us through a proxy',
      )
      await reply.code(404).send(NOT_FOUND_BODY)
      return
    }
    return buildRelayStatus(ctx)
  })
}
