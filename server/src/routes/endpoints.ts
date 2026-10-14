import type {
  BrowserFamily,
  EndpointId,
  GroupId,
  HeartbeatResponse,
  ListEndpointsResponse,
  Platform,
  PushSubscription,
  RegisterResponse,
} from '@tabsend/shared'
import { uniqueLabel } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { insertEndpointWithinCap, lockGroup } from '../caps'
import type { GroupCreation } from '../config'
import type { AppContext } from '../context'
import { callerOf, makeRequireAuth } from '../context'
import { isPostgresUrl, legacyGroupDefaults } from '../db'
import type { Database } from '../db/schema'
import { fail } from '../errors'
import { hashToken, newDeviceToken, newId } from '../ids'
import { toEndpoint } from '../mappers'
import { makeRateLimit } from '../ratelimit'
import { readGroupGate, SUSPENDED_JOIN_MESSAGE } from '../tenancy'
import { iso } from '../time'
import {
  asObject,
  optString,
  type PushPolicy,
  reqBrowser,
  reqKind,
  reqPlatform,
  reqPushSubscription,
  reqString,
} from '../validate'

/** Fields that identify an enrolling endpoint, on both the create and join paths. */
interface EnrollFields {
  label: string
  kind: ReturnType<typeof reqKind>
  browser: BrowserFamily | null
  platform: Platform
  pushSubscription: PushSubscription
  e2ePubkey: string
  deviceName: string | undefined
}

/** Read the common endpoint fields from a register body. */
function readEnrollFields(body: Record<string, unknown>, policy: PushPolicy): EnrollFields {
  return {
    label: reqString(body, 'label'),
    kind: reqKind(body),
    browser: reqBrowser(body),
    platform: reqPlatform(body),
    pushSubscription: reqPushSubscription(body, policy),
    e2ePubkey: reqString(body, 'e2ePubkey'),
    deviceName: optString(body, 'deviceName'),
  }
}

/**
 * Make `label` distinct within its group, suffixing a counter if it isn't
 * ("Chrome" → "Chrome 2"; see `uniqueLabel`).
 *
 * The relay is the ONLY place that sees every client, so it is the only place
 * this invariant can actually hold. Each client deduping for itself doesn't work:
 * the extension can, but the console and the Android app don't, and a browser
 * that can't identify itself registers the same fallback guess as the last one
 * that couldn't ("Chrome"). Doing it here covers every client, including ones
 * written later.
 *
 * Suffixes rather than rejects. A name clash is cosmetic; failing someone's join
 * over it is not, and the user can rename afterwards either way.
 *
 * Race-proof for joins, as a side effect rather than a goal: a join now holds the
 * group row for its whole transaction (see the register route), so two joins cannot
 * both read the same name as free. A rename still can race a join or another rename;
 * a duplicate name is cosmetic, and deliberately not worth serialising renames for.
 */
async function distinctLabel(
  exec: Kysely<Database>,
  groupId: string,
  label: string,
  exceptEndpointId?: string,
): Promise<string> {
  let query = exec.selectFrom('endpoints').select('label').where('group_id', '=', groupId)
  if (exceptEndpointId !== undefined) query = query.where('id', '!=', exceptEndpointId)
  const rows = await query.execute()
  return uniqueLabel(
    label,
    rows.map((r) => r.label),
  )
}

/**
 * Insert a new endpoint into an existing group. Returns the new id + fresh token +
 * the label actually stored (which the dedupe may have changed), or `null` when the
 * group's endpoint cap refused it [0030].
 *
 * Announcing is the CALLER'S job now, and deliberately: this runs inside the register
 * transaction, so firing `endpoint_added` here would tell the group about a device
 * that a rollback is about to un-create.
 */
async function enrollEndpoint(
  trx: Kysely<Database>,
  groupId: string,
  fields: EnrollFields,
  nowIso: string,
  endpointCap: number,
): Promise<{ endpointId: string; deviceToken: string; label: string } | null> {
  const endpointId = newId()
  const deviceToken = newDeviceToken()
  const label = await distinctLabel(trx, groupId, fields.label)
  const row = {
    id: endpointId,
    group_id: groupId,
    kind: fields.kind,
    browser: fields.browser,
    platform: fields.platform,
    label,
    device_name: fields.deviceName ?? null,
    e2e_pubkey: fields.e2ePubkey,
    push_subscription: JSON.stringify(fields.pushSubscription),
    push_failures: 0,
    device_token_hash: hashToken(deviceToken),
    last_seen_at: nowIso,
    created_at: nowIso,
  }

  // No cap in force ⇒ the plain insert this route has always run, byte for byte.
  // A relay that sets no caps must not pay for machinery it did not ask for [0030].
  if (endpointCap <= 0) {
    await trx.insertInto('endpoints').values(row).execute()
    return { endpointId, deviceToken, label }
  }

  const outcome = await insertEndpointWithinCap(trx, row, endpointCap)
  return outcome.inserted ? { endpointId, deviceToken, label } : null
}

/**
 * A first-run link the group's first join retired [0031 amended 2026-10-01]: its expiry
 * was pulled back to its own creation time, which no link is ever minted with, so the
 * row says what happened to it without a column for it. See the join below.
 */
function isRetiredFirstRunCode(code: { created_at: string; expires_at: string }): boolean {
  return code.expires_at <= code.created_at
}

/**
 * What a join is told when its code vanished or failed in a way it cannot name, and
 * what to do about it.
 */
const NO_LONGER_VALID_MESSAGE =
  'Pairing link is no longer valid. Get a new one from a device that is already paired.'

/**
 * Turn away a pairing code that can no longer be used, saying which way it died.
 * Returns only for a code that is still live as far as `nowIso` can tell.
 */
function refuseDeadCode(
  code: { consumed_at: string | null; created_at: string; expires_at: string },
  nowIso: string,
): void {
  if (code.consumed_at !== null) fail('invalid_pairing_code', 'Pairing link already used.')
  if (isRetiredFirstRunCode(code)) fail('invalid_pairing_code', RETIRED_LINK_MESSAGE)
  if (code.expires_at <= nowIso) fail('invalid_pairing_code', 'Pairing link has expired.')
}

/**
 * Read a join's pairing code without a lock and answer for a dead one at once; a live
 * one yields the group the join must queue for. See the register route for why first.
 */
async function liveJoinCode(
  db: Kysely<Database>,
  code: string,
  nowIso: string,
): Promise<{ code: string; groupId: string }> {
  const row = await db
    .selectFrom('pairing_codes')
    .selectAll()
    .where('code', '=', code)
    .executeTakeFirst()
  if (!row) fail('invalid_pairing_code', 'Unknown pairing link.')
  refuseDeadCode(row, nowIso)
  return { code, groupId: row.group_id }
}

/**
 * What somebody holding a retired first-run link is told. The other device is the way
 * in now, and saying so is the whole fix: the extension and the console show this text
 * as it is.
 */
const RETIRED_LINK_MESSAGE =
  'This setup link stopped working when the first device joined this group. Make a new pairing link on that device instead.'

/**
 * Refuse a public CREATE that the group-creation policy does not allow [0029], or
 * return so the caller may make the group.
 *
 * EXHAUSTIVE over {@link GroupCreation}, and that is the point of it being a switch
 * rather than the two `if`s it replaced: those answered "allowed" for anything they did
 * not recognise, so a fourth policy added to the union would have shipped as a relay
 * that let strangers mint tenancies, silently, with every test still green. Now it is a
 * compile error.
 *
 * `hasAnyGroup` is the caller's read, because only `single` needs it and only the caller
 * knows whether it is inside the transaction.
 */
function assertMayCreateGroup(policy: GroupCreation, hasAnyGroup: boolean): void {
  switch (policy) {
    case 'provisioned':
      // This door is shut permanently, empty relay or not. A relay somebody else runs
      // must not let a stranger mint a tenancy past whatever signup, billing and caps
      // sit in front of it (HOSTED_PLAN §4.1); groups there are made out of band. That
      // "even when there are zero groups" is the whole difference from `single`, which
      // is a one-shot rather than a policy.
      //
      // `forbidden` (403), not `group_exists` (409), and the choice matters: 409 means
      // "it conflicts with what is already here", which on an empty provisioned relay
      // is simply untrue, and its shipped copy on four clients says so out loud. 403 is
      // the honest one — allowed for some callers, never for this one. Reusing an
      // existing code also keeps every already-shipped client able to explain the
      // refusal; the actionable half rides in the message, which register-path clients
      // surface verbatim.
      fail(
        'forbidden',
        'This relay does not create groups on request. Whoever runs it sets each group up, so ask them for a pairing link and join with that instead.',
      )
      break
    case 'single':
      // The default — ADR-0022: allowed exactly once, and in practice never, since the
      // relay makes its own group at boot (ADR-0023). Afterwards the only way in is a
      // pairing link from a device that is already a member. Without this, a browser
      // that picked "create" instead of "join" would land in a second, invisible group
      // on the same relay and silently fail to see its peers, with nothing anywhere
      // reporting a problem.
      if (hasAnyGroup) {
        fail(
          'group_exists',
          'This relay already has a group. Join it with a pairing link from a device that is already paired. Setting up your first device? Use the pairing link the relay printed in its startup log.',
        )
      }
      break
    case 'open':
      // Many groups, anyone may make one. Nothing to check.
      break
    default: {
      const unreachable: never = policy
      throw new Error(`Unhandled group-creation policy: ${String(unreachable)}`)
    }
  }
}

export function registerEndpointRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAuth = makeRequireAuth(ctx)
  const rateLimit = makeRateLimit(ctx.rateLimiter)

  // POST /v1/endpoints/register — create a group (no code) OR join one (with code). No
  // auth. Whether the create half is available at all is GROUP_CREATION's answer [0029].
  app.post('/v1/endpoints/register', { preHandler: rateLimit }, async (request, reply) => {
    const body = asObject(request.body)
    const fields = readEnrollFields(body, ctx.config)
    const pairingCode = optString(body, 'pairingCode')

    const now = ctx.now()
    const nowIso = iso(now)
    const postgres = isPostgresUrl(ctx.config.databaseUrl)
    const isCreate = pairingCode === undefined

    // Only `single` cares whether a group is already here; the other two policies
    // answer from config alone and are not charged a read for it.
    const gateCreate = async (exec: Kysely<Database>) => {
      const existing =
        ctx.config.groupCreation === 'single'
          ? await exec.selectFrom('groups').select('id').limit(1).executeTakeFirst()
          : undefined
      assertMayCreateGroup(ctx.config.groupCreation, existing !== undefined)
    }

    // The create policy [0029] is asked TWICE on purpose, and this is the cheap half.
    // A refused create must not pay for the catalogue probe below, and on the default
    // relay — `single`, with its own group already made at boot (ADR-0023) — a refusal
    // is what a bare register almost always is. So the gate runs here first, before
    // anything reads a catalogue or opens a transaction. The authoritative one is
    // inside the transaction, where a concurrent create cannot slip past it.
    if (isCreate) await gateCreate(ctx.db)

    // The retired-column probe [0029] runs BEFORE the transaction, and only on a create
    // that the gate above allowed, because it cannot run inside one: Kysely's SQLite
    // driver serves a single connection behind a mutex, so a query on `ctx.db` while a
    // transaction holds it deadlocks — and handing it the transaction instead is no
    // better, because the probe picks its dialect-specific catalogue query off the
    // object it is given and a transaction is not the instance `createDatabase`
    // registered. Nothing is lost: a table's columns are not something a transaction
    // can change.
    const legacyDefaults = isCreate ? await legacyGroupDefaults(ctx.db) : ({} as const)

    // ONE transaction for the whole join [0030]. It exists so a cap refusal can roll
    // the pairing link back to unconsumed: burning somebody's single-use link and then
    // telling them the group is full would cost them a link per attempt, and the link
    // is the only credential in the product (ADR-0024). It also closes a smaller hole
    // that predates caps — a crash between "consume" and "insert the endpoint" used to
    // burn the link with nothing to show for it.
    //
    // A join learns its group only from its pairing code, so the code is read FIRST,
    // without a lock, and a dead one is turned away right here [2026-10-01]. A code
    // never comes back to life (used stays used, expired stays expired, retired stays
    // retired), so that answer is final, and only a live code goes on to queue for its
    // group's row. The join used to take the row first and judge the code after, so
    // any code of a group, dead ones included and with no device token at all, could
    // park a pooled connection on that group's row for as long as it was held.
    const join =
      pairingCode === undefined ? undefined : await liveJoinCode(ctx.db, pairingCode, nowIso)

    const enroll = () =>
      ctx.db.transaction().execute(async (trx) => {
        let groupId: string

        if (join !== undefined) {
          // The group row FIRST, before the code row below [0031 amended 2026-10-01]. A
          // deletion and a first-link mint hold the group row and then touch this
          // group's pairing codes; a join that consumed its code first and only reached
          // the group row afterwards (its endpoint insert's foreign key) took the same
          // two locks in the opposite order, and Postgres broke that cycle by failing
          // one side with a 500. The consume below re-checks the code under the hold.
          if (!(await lockGroup(trx, postgres, join.groupId))) {
            // Deleted while this request was in flight; its codes went with it.
            fail('invalid_pairing_code', NO_LONGER_VALID_MESSAGE)
          }

          // Consume atomically: only while unconsumed, unexpired and not retired. The
          // last condition is not implied by the second: a retired code's expiry was
          // pulled back to at most the retiring join's clock, and a join whose clock
          // reads earlier (a second relay process, a clock stepped back) would otherwise
          // still find it in date.
          const consumed = await trx
            .updateTable('pairing_codes')
            .set({ consumed_at: nowIso })
            .where('code', '=', join.code)
            .where('consumed_at', 'is', null)
            .where('expires_at', '>', nowIso)
            .whereRef('expires_at', '>', 'created_at')
            .executeTakeFirst()
          if (Number(consumed?.numUpdatedRows ?? 0n) !== 1) {
            // Re-read under the hold: the unlocked read above may predate a join that
            // used this code or retired it a moment ago.
            const current = await trx
              .selectFrom('pairing_codes')
              .selectAll()
              .where('code', '=', join.code)
              .executeTakeFirst()
            if (!current) fail('invalid_pairing_code', NO_LONGER_VALID_MESSAGE)
            refuseDeadCode(current, nowIso)
            fail('invalid_pairing_code', NO_LONGER_VALID_MESSAGE)
          }
          groupId = join.groupId

          // No unclaimed link survives the FIRST join [0031 amended 2026-10-01]. While a
          // group is empty, every link it holds is a way to become its first device, and
          // several can be live at once: each boot of an unpaired relay prints one, and an
          // account page may be opened twice. The moment one of them works, the rest stop
          // meaning "first device" and start meaning "a way into a populated group that
          // nobody handed out", which is the hole HOSTED_PLAN §5 forbids. So the join that
          // makes the group non-empty retires them, in this transaction, under the hold
          // the mints also take: a mint either lands before this and is retired here, or
          // lands after and finds a device and mints nothing (bootstrap.ts).
          //
          // RETIRED rather than deleted, by pulling each one's expiry back to its own
          // creation time — a moment no real expiry can be, so it marks the row without a
          // schema change — so whoever tries one later is told what happened rather than
          // "unknown link". Or back to now, if that is earlier: a code stamped a moment
          // ahead of this clock (a clock stepped back, or a test minting "later") would
          // otherwise stay live until its own creation time came round. The sweeper
          // removes them on the ordinary schedule.
          const member = await trx
            .selectFrom('endpoints')
            .select('id')
            .where('group_id', '=', groupId)
            .limit(1)
            .executeTakeFirst()
          if (!member) {
            await trx
              .updateTable('pairing_codes')
              .set({
                expires_at: sql<string>`case when created_at < ${nowIso} then created_at else ${nowIso} end`,
              })
              .where('group_id', '=', groupId)
              .where('consumed_at', 'is', null)
              .where('expires_at', '>', nowIso)
              .execute()
          }
        } else {
          // CREATE path, gated by the group-creation policy [0029] — the authoritative
          // half, inside the transaction so that on SQLite (one connection, one writer)
          // two simultaneous creates cannot both read an empty relay and both make a
          // group.
          await gateCreate(trx)
          groupId = newId()
          await trx
            .insertInto('groups')
            .values({
              id: groupId,
              created_at: nowIso,
              // Retired columns, written only where a legacy database still has them
              // [0029]. Probed above, outside this transaction — see why there.
              ...legacyDefaults,
            })
            .execute()
        }

        // One read of the group row, for both things it decides.
        //
        // Suspension [0031], and this is the answer to the question ADR-0029 left open:
        // a suspended tenancy takes no new devices. It is checked INSIDE the transaction
        // and after the link is consumed on purpose — throwing here rolls the consumption
        // back, so somebody handed a link before the suspension still holds a good one
        // when the group is resumed. Burning it instead would charge them a single-use
        // credential (ADR-0024) for a refusal they could do nothing about, exactly as a
        // cap refusal would [0030]. The create path cannot reach this: a group made one
        // statement ago is not suspended.
        //
        // Then the endpoint cap [0030], which needs the group known for the same reason:
        // a per-group override outranks the relay-wide default. Its count is exact because
        // the join already holds the group row (above), and a create needs no hold at all:
        // the group it counts was made one statement ago in this transaction, so nothing
        // else can see it yet.
        const gate = await readGroupGate(trx, ctx.config.caps, groupId)
        if (gate.suspendedAt) fail('forbidden', SUSPENDED_JOIN_MESSAGE)
        const caps = gate.caps
        const result = await enrollEndpoint(trx, groupId, fields, nowIso, caps.endpoints)
        if (!result) {
          // Rolls the consumed pairing link back with it, so the link is still good
          // once somebody makes room. The message names the fix, because the caller
          // cannot: they are joining a group that is not theirs to prune.
          fail(
            'limit_reached',
            `This group already has the most devices it is allowed (${caps.endpoints}). Remove a device you no longer use from any paired device, then join again with a new pairing link.`,
          )
        }
        return { ...result, groupId }
      })

    // Queued per group like every other group-scoped write (group-queue.ts), so a burst
    // of joins waits in memory for its group's row, not in the pool. A create has no
    // group yet for anything to queue behind.
    const enrolled =
      join !== undefined ? await ctx.groupWrites.run(join.groupId, enroll) : await enroll()

    // Only after COMMIT: a rollback must not have told the group about a device that
    // does not exist. The read is a fresh one because the row is the mapper's input.
    if (!isCreate) {
      const row = await ctx.db
        .selectFrom('endpoints')
        .selectAll()
        .where('id', '=', enrolled.endpointId)
        .executeTakeFirstOrThrow()
      ctx.hub.toGroup(
        enrolled.groupId as GroupId,
        { type: 'endpoint_added', endpoint: toEndpoint(row, now, false) },
        enrolled.endpointId as EndpointId,
      )
    }

    const response: RegisterResponse = {
      endpointId: enrolled.endpointId as EndpointId,
      groupId: enrolled.groupId as GroupId,
      deviceToken: enrolled.deviceToken as RegisterResponse['deviceToken'],
      label: enrolled.label,
    }
    reply.code(201).send(response)
  })

  // POST /v1/endpoints/:id/heartbeat — refresh presence + optionally rotate push sub.
  app.post<{ Params: { id: string } }>(
    '/v1/endpoints/:id/heartbeat',
    { preHandler: requireAuth },
    async (request) => {
      const caller = callerOf(request)
      if (request.params.id !== caller.id) {
        fail('forbidden', 'A device token can only heartbeat its own endpoint.')
      }
      const body = request.body ? asObject(request.body) : {}
      if (body.pushSubscription !== undefined) {
        const sub = reqPushSubscription(body, ctx.config)
        // A rotated subscription is the client's self-heal: clear any dead-marking so
        // wakes resume against the fresh endpoint (chunk-4 VAPID-rotation self-heal).
        await ctx.db
          .updateTable('endpoints')
          .set({ push_subscription: JSON.stringify(sub), push_failures: 0 })
          .where('id', '=', caller.id)
          .execute()
      }
      // Auth preHandler already refreshed last_seen_at, so presence is online.
      const response: HeartbeatResponse = { presence: 'online', serverTime: iso(ctx.now()) }
      return response
    },
  )

  // GET /v1/endpoints — every endpoint in the caller's group (presence derived).
  app.get('/v1/endpoints', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const rows = await ctx.db
      .selectFrom('endpoints')
      .selectAll()
      .where('group_id', '=', caller.group_id)
      .orderBy('created_at')
      .execute()
    const now = ctx.now()
    const response: ListEndpointsResponse = rows.map((r) =>
      toEndpoint(r, now, ctx.hub.isOnline(r.id as EndpointId)),
    )
    return response
  })

  // PATCH /v1/endpoints/:id — rename (any endpoint in the caller's group).
  app.patch<{ Params: { id: string } }>(
    '/v1/endpoints/:id',
    { preHandler: requireAuth },
    async (request) => {
      const caller = callerOf(request)
      const body = asObject(request.body)
      const label = reqString(body, 'label')
      // ADDITIVE (5-ext): optional device grouping tie. Omitted ⇒ leave untouched.
      const deviceName = optString(body, 'deviceName')
      const row = await ctx.db
        .selectFrom('endpoints')
        .selectAll()
        .where('id', '=', request.params.id)
        .where('group_id', '=', caller.group_id)
        .executeTakeFirst()
      if (!row) fail('not_found', 'Endpoint not found in your group.')
      // Same invariant as enrolment, and the same reasoning: a rename that lands
      // on a name already in the group would recreate exactly the ambiguity the
      // dedupe exists to prevent. The response carries the stored label, so a
      // renaming client sees what it actually got.
      const distinct = await distinctLabel(ctx.db, caller.group_id, label, row.id)
      const patch =
        deviceName !== undefined
          ? { label: distinct, device_name: deviceName }
          : { label: distinct }
      await ctx.db.updateTable('endpoints').set(patch).where('id', '=', row.id).execute()
      const updated = toEndpoint(
        { ...row, ...patch },
        ctx.now(),
        ctx.hub.isOnline(row.id as EndpointId),
      )
      ctx.hub.toGroup(caller.group_id as GroupId, { type: 'endpoint_updated', endpoint: updated })
      return updated
    },
  )

  // DELETE /v1/endpoints/:id — remove an endpoint from the group.
  app.delete<{ Params: { id: string } }>(
    '/v1/endpoints/:id',
    { preHandler: requireAuth },
    async (request) => {
      const caller = callerOf(request)
      const postgres = isPostgresUrl(ctx.config.databaseUrl)

      // ONE transaction holding the group row [0031 amended 2026-10-01], because both
      // halves of a removal race something that holds it too. `removed_endpoints` has
      // no foreign key to `groups`, so a removal racing a tenancy deletion used to be
      // able to commit its tombstone after the cascade had swept that table, leaving a
      // token hash naming a tenancy reported as gone. And the send and the group-key
      // upload now read their targets under the same hold, so a removal either lands
      // first, and they no longer see the device, or lands after them, and the
      // group-key delete below sweeps whatever they stored for it.
      const row = await ctx.groupWrites.run(caller.group_id, () =>
        ctx.db.transaction().execute(async (trx) => {
          if (!(await lockGroup(trx, postgres, caller.group_id))) {
            fail(
              'not_found',
              'This group no longer exists on this relay, so there is nothing left to remove.',
            )
          }
          // The device asking must still be in the group, read under the hold every
          // removal takes: a device removed a moment ago gets the answer its next call
          // would get, rather than one last removal of somebody else.
          const stillHere = await trx
            .selectFrom('endpoints')
            .select('id')
            .where('id', '=', caller.id)
            .executeTakeFirst()
          if (!stillHere) fail('endpoint_removed', 'This endpoint was removed from its group.')
          const found = await trx
            .selectFrom('endpoints')
            .selectAll()
            .where('id', '=', request.params.id)
            .where('group_id', '=', caller.group_id)
            .executeTakeFirst()
          if (!found) fail('not_found', 'Endpoint not found in your group.')
          // Tombstone BEFORE the delete, so the removed device gets a definitive
          // "you were removed" on its next call instead of an ambiguous 401 it would
          // have to guess about. Same transaction as the delete: a removal without its
          // tombstone is exactly the ambiguity this exists to remove.
          await trx
            .insertInto('removed_endpoints')
            .values({
              device_token_hash: found.device_token_hash,
              endpoint_id: found.id,
              group_id: found.group_id,
              removed_at: iso(ctx.now()),
            })
            .execute()
          await trx.deleteFrom('endpoints').where('id', '=', found.id).execute()
          // Its copies of the group key go with it [0028]. They are sealed to a key
          // only the removed device holds, so they are unreadable to everyone else
          // and useless to it once its token is gone — but leaving them would mean
          // the relay stores key material for a device that is no longer in the
          // group, which is exactly the state a rotation exists to end.
          await trx.deleteFrom('group_keys').where('target_endpoint_id', '=', found.id).execute()
          // And the copies it sent. No client opens one once its sender has left the
          // list, so they unlock nothing, but they still fill the recipient's slots
          // (at most 64 copies per device, caps.ts): a device about to be removed
          // could post 64 copies to each other member and leave them behind, and the
          // rotation that follows its removal would be refused `limit_reached` for
          // the whole history window, with history still sealed under the key it
          // holds (review 2026-10-13).
          // Scoped to the group so it uses `group_keys_group_idx` rather than scanning
          // every tenant's copies while this group's row is held.
          await trx
            .deleteFrom('group_keys')
            .where('group_id', '=', found.group_id)
            .where('source_endpoint_id', '=', found.id)
            .execute()
          return found
        }),
      )

      // After the commit, and only then: a rollback must not announce a removal.
      ctx.hub.toGroup(caller.group_id as GroupId, {
        type: 'endpoint_removed',
        endpointId: row.id as EndpointId,
      })
      // And its open sockets go too, after it has been told above. A socket
      // authenticates once, in its hello (routes/stream.ts), so without this a removed
      // device kept receiving the group's broadcasts for as long as it held its socket
      // open: every later device's label, name and public key, and presence. Its token
      // stopped working at once; its fast path did not.
      ctx.hub.disconnectEndpoint(row.id as EndpointId, 'endpoint removed')
      return { ok: true }
    },
  )
}
