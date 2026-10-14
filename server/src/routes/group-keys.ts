import type { EndpointId, GroupKeyResponse, GroupKeysResponse, IsoTimestamp } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import { hitSendWindow, insertGroupKeyWithinBound } from '../caps'
import type { AppContext } from '../context'
import { callerOf, makeRequireAuth } from '../context'
import { isPostgresUrl } from '../db'
import { fail } from '../errors'
import { keyIdFor } from '../ids'
import { GROUP_GONE_MESSAGE, readGroupGate } from '../tenancy'
import { iso } from '../time'
import { asObject, reqEnvelope, reqId } from '../validate'

/**
 * The largest sealed copy of a group key this relay will store, in bytes of JSON.
 *
 * A structural bound, not a product cap [0031 amended]. What rides in one of these is
 * a `GroupKeyRecord` — 32 random bytes, their fingerprint, and a timestamp — sealed
 * with `crypto_box`; serialised with its envelope that is a few hundred bytes, and it
 * cannot grow with anything a user does, because no user content ever enters it. So
 * anything an order of magnitude larger is not a group key, and this route is the one
 * place a client could otherwise hand the relay an arbitrarily large blob it stores
 * for the whole history window and charges nobody for. Refused as malformed rather
 * than as a limit, because it is: no retry of the same item can ever succeed.
 */
const MAX_GROUP_KEY_BYTES = 4096

/**
 * The most sealed copies of a group key the relay holds for ONE target device
 * [0030 amended 2026-10-01]. Structural, like the size bound above, so always on.
 *
 * What legitimately lands here is one copy per key generation per recipient: a device
 * is handed the current key once, and again only when the group rotates, which it does
 * when a device is removed. Copies leave at the history cutoff (the sweeper), with
 * their device, or with their group. So 64 is many times what any real device holds,
 * and a target past it is not a busy group, it is somebody storing bytes.
 */
const MAX_GROUP_KEY_COPIES_PER_TARGET = 64

/**
 * Group history key distribution [ADR-0028].
 *
 * The relay's whole job here is to hold a sealed blob for a device that is not
 * online right now, and hand it over when it is. It cannot read any of it: each
 * copy is `crypto_box`-sealed to one endpoint's published `e2ePubkey`, exactly
 * like a tab, and the relay imports no crypto (ADR-0016).
 *
 * Why this is not a message: an ordinary message is a TAB to every client
 * already shipped. One carrying a key instead of a URL fails to parse on
 * Android (its `url` is non-null), which skips it WITHOUT an ack so it retries
 * on every drain until it expires, and iOS would show the user "Unsupported link
 * blocked". A route an older client never polls is invisible to it.
 */
export function registerGroupKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAuth = makeRequireAuth(ctx)

  // POST /v1/group-keys — hand the group key to endpoints that lack it. Mirrors
  // POST /v1/messages: per-item rejection with the same reasons, idempotent on a
  // client-generated id, so two devices racing to help the same newcomer is a
  // no-op rather than a conflict.
  //
  // WHAT BOUNDS THIS ROUTE [0031 amended]. It used to be bounded by nothing at all:
  // it stores a row per item, the rows survive until the sweeper ages them out at the
  // history window, and neither the per-group caps nor the usage report could see
  // them. A tenant — a suspended one included, since key distribution deliberately
  // stays open under suspension (tenancy.ts) — could therefore fill a relay's disk
  // while every number an operator looks at said it was well inside its quota. Four
  // things bound it now, and each one is a different kind of bound:
  //
  //  - SIZE, per item: {@link MAX_GROUP_KEY_BYTES}, plus the id length bound every
  //    stored id has (validate.ts). A group key is a fixed-size thing, so an oversized
  //    one is malformed, not throttled.
  //  - COUNT, per target: {@link MAX_GROUP_KEY_COPIES_PER_TARGET}, always on, so
  //    storage is bounded by devices times copies times size with no cap configured
  //    at all [0030 amended 2026-10-01]. The first version of this fix leaned on the
  //    send window for the count, which is off by default.
  //  - RATE, per group, when the group has a send window: each newly stored copy
  //    spends one unit of it, the same budget a tab spends. That is the cap that
  //    measures "how hard may this group push at the relay".
  //  - AGE: the sweeper, which already dropped these at the history cutoff.
  //
  // The QUEUE caps still do not apply, and that is still deliberate (ADR-0028,
  // ADR-0030): refusing a key because the group's message queue is full would leave a
  // paired device permanently unable to read history it is entitled to, and a queue
  // drains on its own while the missing key does not. A window unit is the opposite
  // kind of refusal — it clears in `CAP_SEND_WINDOW_SECONDS`, and every client already
  // retries a `limit_reached` item on its next wake rather than marking it done.
  app.post('/v1/group-keys', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const body = asObject(request.body)
    if (!Array.isArray(body.items) || body.items.length === 0) {
      fail('invalid_request', 'GroupKeyRequest.items must be a non-empty array.')
    }

    const parsed = body.items.map((raw) => {
      const o = asObject(raw, 'group key item')
      const envelope = reqEnvelope(o)
      const stored = JSON.stringify(envelope)
      // Refused with the request's other SHAPE errors rather than as a per-item
      // limit, because that is what it is: no retry of this item can ever succeed,
      // and `reqEnvelope` above already fails the whole request for a wrong `alg`.
      if (Buffer.byteLength(stored, 'utf8') > MAX_GROUP_KEY_BYTES) {
        fail(
          'invalid_request',
          `A group-key envelope must be at most ${MAX_GROUP_KEY_BYTES} bytes. What belongs in one is a sealed 32-byte key and its fingerprint, which is a few hundred bytes; anything this large is not a group key.`,
        )
      }
      return {
        id: reqId(o, 'id'),
        targetEndpointId: reqId(o, 'targetEndpointId'),
        targetKeyId: envelope.targetKeyId,
        stored,
      }
    })

    const now = ctx.now()
    const nowIso = iso(now)
    const accepted: string[] = []
    const rejected: GroupKeyResponse['rejected'] = []

    // One transaction holding the group row, for the same reasons the send path takes
    // one: the window has to be spent and the row written without another writer in
    // between, and a tenancy being deleted must not have sealed key material land in
    // it afterwards. `group_keys.group_id` is not a foreign key, so as with `messages`
    // nothing underneath would have refused the row. Queued per group in process
    // first, for the same reason as the send (group-queue.ts).
    await ctx.groupWrites.run(caller.group_id, () =>
      ctx.db.transaction().execute(async (trx) => {
        const gate = await readGroupGate(
          trx,
          ctx.config.caps,
          caller.group_id,
          isPostgresUrl(ctx.config.databaseUrl),
        )
        if (!gate.exists) fail('not_found', GROUP_GONE_MESSAGE)

        // Targets are read UNDER the hold [2026-10-01]. A device removal holds the same
        // row (routes/endpoints.ts), so a device removed a moment before this is not
        // offered a copy, and one removed a moment after takes its copies with it. Read
        // before the transaction, as it used to be, a removal could land in between and
        // leave a copy stored for a device that was no longer in the group.
        //
        // Group-scoped for the same reason as the send route, and it has to be BOTH: the
        // two routes took the same shape, so a fix on one alone would just leave the
        // oracle here [0029, HOSTED_PLAN §4.6]. An endpoint in another group is
        // indistinguishable from one that does not exist.
        const targetIds = [...new Set(parsed.map((p) => p.targetEndpointId))]
        const targets = await trx
          .selectFrom('endpoints')
          .selectAll()
          .where('id', 'in', targetIds)
          .where('group_id', '=', caller.group_id)
          .execute()
        const targetMap = new Map(targets.map((t) => [t.id, t]))

        // Which of these the relay already holds, in one read. A replay is accepted and
        // counts nothing: not a window unit, and not a slot under the per-target bound.
        // It already occupies exactly what it occupied the first time, and charging for
        // it would let a client retrying a timed-out request talk itself out of its own
        // budget — the same rule the send path applies.
        const alreadyStored = new Set<string>()
        const stored = await trx
          .selectFrom('group_keys')
          .select('id')
          .where(
            'id',
            'in',
            parsed.map((p) => p.id),
          )
          .execute()
        for (const r of stored) alreadyStored.add(r.id)

        for (const item of parsed) {
          const target = targetMap.get(item.targetEndpointId)
          // Never issued, or issued to another group: one answer for both [0029].
          if (!target) {
            rejected.push({ id: item.id, reason: 'unknown_target' })
            continue
          }
          // Same staleness check as a send: a copy sealed to a key the target has
          // since replaced is undecryptable, and silently storing it would leave the
          // device permanently without a key it appears to have been given.
          if (item.targetKeyId !== keyIdFor(target.e2e_pubkey)) {
            rejected.push({ id: item.id, reason: 'expired_key' })
            continue
          }
          if (alreadyStored.has(item.id)) {
            accepted.push(item.id)
            continue
          }

          const within = await hitSendWindow(trx, gate.caps, caller.group_id, now)
          if (!within) {
            rejected.push({ id: item.id, reason: 'limit_reached', limit: 'sends_per_window' })
            continue
          }

          const outcome = await insertGroupKeyWithinBound(
            trx,
            {
              id: item.id,
              group_id: caller.group_id,
              source_endpoint_id: caller.id,
              target_endpoint_id: target.id,
              envelope: item.stored,
              created_at: nowIso,
            },
            MAX_GROUP_KEY_COPIES_PER_TARGET,
          )
          if (!outcome.inserted && !outcome.duplicate) {
            // The target already holds more copies than any real device needs. Still
            // `limit_reached`, the one per-item reason a client holds and retries
            // rather than drops, and it does clear: the oldest copies leave at the
            // history cutoff. No `limit` name, because this is not one of the group's
            // caps [0030], and no client shows a refused key copy to anybody.
            rejected.push({ id: item.id, reason: 'limit_reached' })
            continue
          }
          accepted.push(item.id)
        }
      }),
    )

    const response: GroupKeyResponse = { accepted, rejected }
    return response
  })

  // GET /v1/group-keys — every copy sealed TO the caller, oldest first so a
  // client folding them into its keyring in order ends on the newest.
  //
  // Deliberately NOT consumed on read. A device that fetches and then dies
  // before persisting must be able to fetch again; the sweeper ages these out
  // instead. Re-reading costs nothing — the client already holds the key.
  app.get('/v1/group-keys', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const rows = await ctx.db
      .selectFrom('group_keys')
      .selectAll()
      .where('target_endpoint_id', '=', caller.id)
      .orderBy('created_at')
      .execute()

    const response: GroupKeysResponse = rows.flatMap((r) => {
      let envelope: ReturnType<typeof reqEnvelope>
      try {
        envelope = JSON.parse(r.envelope)
      } catch {
        // Relay-side corruption, not a client error. Drop the row rather than
        // failing the whole fetch and leaving the device with no key at all.
        return []
      }
      return [
        {
          id: r.id,
          sourceEndpointId: r.source_endpoint_id as EndpointId,
          envelope,
          createdAt: r.created_at as IsoTimestamp,
        },
      ]
    })
    return response
  })
}
