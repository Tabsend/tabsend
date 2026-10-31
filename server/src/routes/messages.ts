import type {
  EndpointId,
  GroupId,
  GroupSealed,
  HistoryResponse,
  IsoTimestamp,
  Message,
  MessageId,
  OutboxMessagesResponse,
  PendingMessagesResponse,
  SendResponse,
} from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import {
  capsActive,
  type GroupCaps,
  historyCutoff,
  hitSendWindow,
  insertMessageWithinCaps,
} from '../caps'
import type { AppContext } from '../context'
import { callerOf, makeRequireAuth } from '../context'
import { isPostgresUrl } from '../db'
import type { Database, EndpointRow } from '../db/schema'
import { fail } from '../errors'
import { keyIdFor } from '../ids'
import { toMessage } from '../mappers'
import { GROUP_GONE_MESSAGE, readGroupGate, SUSPENDED_SEND_MESSAGE } from '../tenancy'
import { addMs, iso } from '../time'
import { asObject, optGroupSealed, reqEnvelope, reqId } from '../validate'
import { ringDoorbell } from '../wake'

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAuth = makeRequireAuth(ctx)

  // POST /v1/messages — persist each item (idempotent) BEFORE any delivery attempt,
  // reject per-item with the contract's reasons, then wake targets (push + WS).
  app.post('/v1/messages', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const body = asObject(request.body)
    if (!Array.isArray(body.items) || body.items.length === 0) {
      fail('invalid_request', 'SendRequest.items must be a non-empty array.')
    }

    const parsed = body.items.map((raw) => {
      const o = asObject(raw, 'send item')
      return {
        id: reqId(o, 'id'),
        targetEndpointId: reqId(o, 'targetEndpointId'),
        envelope: reqEnvelope(o),
        history: optGroupSealed(o),
      }
    })

    const now = ctx.now()
    const nowIso = iso(now)
    const expiresIso = iso(addMs(now, ctx.config.messageTtlMs))
    // Where the history window starts, for the byte cap [0030 amended]: a stored blob
    // counts against the group for exactly as long as the relay owes it back ([0028]).
    const historySince = historyCutoff(now, ctx.config.historyRetentionMs)

    const accepted: MessageId[] = []
    const rejected: SendResponse['rejected'] = []
    const wakes: Array<{ target: EndpointRow; message: Message }> = []

    /**
     * Persist the batch, per item. Batches keep their per-item accept/reject
     * semantics, so a cap may SPLIT a batch — which is already honest on every
     * client ("Sent 2 of 3", ADR-0008 / [0028]) and is why a cap is a per-item
     * rejection rather than a whole-request error.
     */
    const persist = async (
      exec: Kysely<Database>,
      targetMap: Map<string, EndpointRow>,
      caps: GroupCaps,
      enforce: boolean,
    ): Promise<void> => {
      // Which of these ids the relay already holds, in ONE read rather than one per
      // item. Only the capped path asks, and only inside the transaction that
      // serialises the group, which is what makes the answer exact — the same thing
      // that makes the guarded inserts exact. `ON CONFLICT (id) DO NOTHING` is still
      // the authority underneath: this decides only whether an item may skip the send
      // window, never whether a row is written.
      //
      // One consequence, small and worth naming: an item repeated TWICE INSIDE one
      // batch is not in this set the second time, so it spends a send-window unit
      // before the insert dedupes it. A client sending the same id twice in one
      // request is malformed either way, and the row count is still right.
      const alreadyStored = new Set<string>()
      if (enforce) {
        const rows = await exec
          .selectFrom('messages')
          .select('id')
          .where(
            'id',
            'in',
            parsed.map((p) => p.id),
          )
          .execute()
        for (const r of rows) alreadyStored.add(r.id)
      }

      for (const item of parsed) {
        const id = item.id as MessageId
        const target = targetMap.get(item.targetEndpointId)
        // Never issued, or issued to another group: one answer for both [0029].
        // The key check below deliberately stays AFTER this — running it against a
        // foreign endpoint's key would rebuild the same oracle one step further on.
        if (!target) {
          rejected.push({ id, reason: 'unknown_target' })
          continue
        }
        if (item.envelope.targetKeyId !== keyIdFor(target.e2e_pubkey)) {
          rejected.push({ id, reason: 'expired_key' })
          continue
        }

        const row = {
          id: item.id,
          group_id: caller.group_id,
          source_endpoint_id: caller.id,
          target_endpoint_id: target.id,
          envelope: JSON.stringify(item.envelope),
          // Rides the same row it describes [0028]. Unlike `envelope` this is not
          // nulled on ack: the envelope exists to be delivered once, this exists
          // to be read for the history window. With history off (retention 0)
          // it is accepted, so an older client does not start failing, and then
          // not stored: nothing would ever serve it.
          history_blob:
            item.history && ctx.config.historyRetentionMs > 0 ? JSON.stringify(item.history) : null,
          created_at: nowIso,
          expires_at: expiresIso,
        }

        // Reliability invariant: durable row (with expiresAt) BEFORE delivery.
        // Idempotent on the client-generated id — a replay adds no duplicate row.
        if (!enforce) {
          await exec
            .insertInto('messages')
            .values({ ...row, delivered_at: null, acked_at: null })
            .onConflict((oc) => oc.column('id').doNothing())
            .execute()
        } else {
          // A REPLAY of an already-stored item is accepted and counts nothing at
          // all — not a queue slot, not a byte, not a unit of the send window. It
          // already occupies exactly what it occupied the first time, and counting
          // it twice would let a client retrying a timed-out request talk itself
          // out of its own quota (HOSTED_PLAN §4.3).
          if (!alreadyStored.has(row.id)) {
            // Send window first, so a replay never reaches it. An item that a
            // QUEUE cap then refuses has still spent a unit of this window: the
            // window bounds how hard a group may push at the relay, which it did,
            // and giving the unit back would mean a compensating delete on a row
            // that briefly existed. Windows are short (60 s by default), so the
            // group gets it back almost immediately.
            const within = await hitSendWindow(exec, caps, caller.group_id, now)
            if (!within) {
              rejected.push({ id, reason: 'limit_reached', limit: 'sends_per_window' })
              continue
            }
          }
          const outcome = await insertMessageWithinCaps(exec, row, caps, nowIso, historySince)
          if (outcome.capped) {
            rejected.push({ id, reason: 'limit_reached', limit: outcome.capped })
            continue
          }
        }

        accepted.push(id)
        wakes.push({
          target,
          message: {
            id,
            groupId: caller.group_id as GroupId,
            sourceEndpointId: caller.id as EndpointId,
            targetEndpointId: target.id as EndpointId,
            envelope: item.envelope,
            createdAt: nowIso,
            expiresAt: expiresIso,
            deliveredAt: null,
            ackedAt: null,
          },
        })
      }
    }

    // ONE transaction and ONE hold of the group row for the whole batch, not per item.
    //
    // The hold is what makes the batch coherent with everything else happening to this
    // tenancy. Against a concurrent SEND [0030]: the guarded inserts inside it see each
    // other's rows, so a batch cannot talk itself past its own cap, and two senders
    // racing serialise rather than both overshooting. Against a concurrent DELETION
    // [0031 amended]: the row this holds is the row `deleteGroupCascade` holds, so a
    // send either commits before the teardown sweeps `messages` or finds the group gone
    // and writes nothing. Before this, an in-flight send could leave ciphertext behind
    // in a tenancy whose owner had just been told it was deleted — `messages.group_id`
    // is not a foreign key, so nothing underneath was going to refuse the row.
    //
    // Taken on every relay, capped or not. What the caps still decide is which INSERT
    // runs: an uncapped relay runs the same unguarded one it always ran, now costing it
    // one indexed read and a transaction it did not previously open.
    //
    // Queued per group IN PROCESS first (group-queue.ts), so a burst of sends from one
    // group waits in memory for its row rather than parking a pooled connection each
    // on it, which is how one tenant could starve every other of connections.
    await ctx.groupWrites.run(caller.group_id, () =>
      ctx.db.transaction().execute(async (trx) => {
        // One read of the group row, held for the rest of the transaction, answering all
        // three questions this path has about the tenancy.
        //
        // Existence first, because it is the one that changed: a group that went away
        // under an authenticated caller is not a cap refusal and not a suspension.
        //
        // Then suspension [0031]: a suspended tenancy stops ACCEPTING work, so the whole
        // request is refused rather than each item, because the reason has nothing to do
        // with any one tab. Everything else about the group keeps working — queued tabs
        // still drain, acks still erase ciphertext, devices stay paired (tenancy.ts).
        //
        // Then the per-group caps [0030] (HOSTED_PLAN §4.3), which decide only whether
        // the loop below runs guarded inserts or plain ones.
        const gate = await readGroupGate(
          trx,
          ctx.config.caps,
          caller.group_id,
          isPostgresUrl(ctx.config.databaseUrl),
        )
        if (!gate.exists) fail('not_found', GROUP_GONE_MESSAGE)
        if (gate.suspendedAt) fail('forbidden', SUSPENDED_SEND_MESSAGE)

        // Targets are read UNDER the hold [2026-10-01], so a device removal (which holds
        // the same row, routes/endpoints.ts) cannot land between reading a target and
        // storing a tab for it. Read before the transaction, as they used to be, a tab
        // could be queued for a device that had just left the group.
        //
        // Scoped to the CALLER'S GROUP, not looked up globally [0029]. The lookup used
        // to span every group, and the loop below then answered `not_in_group` for a
        // target it found elsewhere — which tells a sender whether a guessed endpoint id
        // is real in somebody else's group. Ids are random, so the leak is small; the
        // fix is smaller (HOSTED_PLAN §4.6). Out of the caller's group now means
        // invisible: identical answer, identical shape, nothing to compare.
        const targetIds = [...new Set(parsed.map((p) => p.targetEndpointId))]
        const targets = await trx
          .selectFrom('endpoints')
          .selectAll()
          .where('id', 'in', targetIds)
          .where('group_id', '=', caller.group_id)
          .execute()
        const targetMap = new Map(targets.map((t) => [t.id, t]))

        await persist(trx, targetMap, gate.caps, capsActive(gate.caps))
      }),
    )

    // Only AFTER rows are durable: wake targets.
    //
    // The fast path gets every message, because it carries them. The doorbell rings
    // ONCE per target per send [2026-10-01]: a wake carries nothing, and a woken device
    // drains its whole queue, so every ring after the first was pure cost. For a phone
    // behind the forwarder that cost was shared: a 150-tab send rang the forwarder 150
    // times against a per-caller limit every tenant on this relay draws from.
    const rung = new Set<string>()
    for (const { target, message } of wakes) {
      ctx.hub.toEndpoint(target.id as EndpointId, { type: 'message', message })
      if (rung.has(target.id)) continue
      rung.add(target.id)
      // The rules for ringing (dead subscriptions, the detached forwarder call, the
      // online check that spares a phone's forwarder budget) live in wake.ts, shared
      // with the reset that rings the same doorbells [P-18 item 12].
      await ringDoorbell(ctx, request.log, target)
    }

    const response: SendResponse = { accepted, rejected }
    return response
  })

  // GET /v1/messages?pending=1 | ?outbox=1
  app.get('/v1/messages', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const query = request.query as { pending?: string; outbox?: string; history?: string }
    const now = ctx.now()
    const nowIso = iso(now)

    if (query.pending === '1') {
      const rows = await ctx.db
        .selectFrom('messages')
        .selectAll()
        .where('target_endpoint_id', '=', caller.id)
        .where('acked_at', 'is', null)
        .where('envelope', 'is not', null)
        .where('expires_at', '>', nowIso)
        .orderBy('created_at')
        .execute()

      // First pull marks delivered_at (the target has the message in hand).
      const undelivered = rows.filter((r) => r.delivered_at === null).map((r) => r.id)
      if (undelivered.length > 0) {
        await ctx.db
          .updateTable('messages')
          .set({ delivered_at: nowIso })
          .where('id', 'in', undelivered)
          .execute()
      }

      const response: PendingMessagesResponse = rows.map((r) =>
        toMessage({ ...r, delivered_at: r.delivered_at ?? nowIso }),
      )
      return response
    }

    if (query.outbox === '1') {
      const rows = await ctx.db
        .selectFrom('messages')
        .select(['id', 'target_endpoint_id', 'created_at', 'expires_at', 'delivered_at'])
        .where('source_endpoint_id', '=', caller.id)
        .where('acked_at', 'is', null)
        .where('expires_at', '>', nowIso)
        .orderBy('created_at')
        .execute()

      const response: OutboxMessagesResponse = rows.map((r) => ({
        id: r.id as MessageId,
        targetEndpointId: r.target_endpoint_id as EndpointId,
        createdAt: r.created_at as IsoTimestamp,
        expiresAt: r.expires_at as IsoTimestamp,
        deliveredAt: (r.delivered_at as IsoTimestamp | null) ?? null,
      }))
      return response
    }

    if (query.history === '1') {
      // The whole GROUP, not just this endpoint's own traffic [0028]. That is the
      // point: a device must be able to answer "where did that tab go" without
      // having been one of the two ends. Scoped to the caller's group by the same
      // auth that scopes everything else; a group is one person's own devices.
      //
      // HISTORY_RETENTION_DAYS=0 disables serving history without breaking a
      // client that keeps sending blobs.
      if (ctx.config.historyRetentionMs <= 0) return []

      // The same window the byte cap counts blobs over (caps.ts), so what the relay
      // charges a group for and what it will actually serve back cannot disagree.
      const sinceIso = historyCutoff(now, ctx.config.historyRetentionMs)
      const rows = await ctx.db
        .selectFrom('messages')
        .select([
          'id',
          'source_endpoint_id',
          'target_endpoint_id',
          'created_at',
          'expires_at',
          'delivered_at',
          'acked_at',
          'history_blob',
        ])
        .where('group_id', '=', caller.group_id)
        .where('history_blob', 'is not', null)
        .where('created_at', '>', sinceIso)
        .orderBy('created_at', 'desc')
        .execute()

      const response: HistoryResponse = rows.flatMap((r) => {
        // Unreadable JSON here would be relay-side corruption, not a client
        // error. Drop the row rather than failing the whole history screen.
        let blob: GroupSealed
        try {
          blob = JSON.parse(r.history_blob as string) as GroupSealed
        } catch {
          return []
        }
        return [
          {
            id: r.id as MessageId,
            sourceEndpointId: r.source_endpoint_id as EndpointId,
            targetEndpointId: r.target_endpoint_id as EndpointId,
            createdAt: r.created_at as IsoTimestamp,
            expiresAt: r.expires_at as IsoTimestamp,
            deliveredAt: (r.delivered_at as IsoTimestamp | null) ?? null,
            ackedAt: (r.acked_at as IsoTimestamp | null) ?? null,
            blob,
          },
        ]
      })
      return response
    }

    fail('invalid_request', 'Specify ?pending=1, ?outbox=1 or ?history=1.')
  })

  // POST /v1/messages/:id/ack — idempotent; deletes the envelope, keeps the routing row.
  app.post<{ Params: { id: string } }>(
    '/v1/messages/:id/ack',
    { preHandler: requireAuth },
    async (request) => {
      const caller = callerOf(request)
      const row = await ctx.db
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst()
      // Not found OR not addressed to the caller → 404 (don't reveal others' messages).
      if (!row || row.target_endpoint_id !== caller.id) {
        fail('not_found', 'Message not found.')
      }

      const now = ctx.now()
      const nowIso = iso(now)

      if (row.acked_at === null) {
        await ctx.db
          .updateTable('messages')
          .set({ acked_at: nowIso, delivered_at: row.delivered_at ?? nowIso, envelope: null })
          .where('id', '=', row.id)
          .execute()
        ctx.hub.toEndpoint(row.source_endpoint_id as EndpointId, {
          type: 'acked',
          messageId: row.id as MessageId,
          targetEndpointId: caller.id as EndpointId,
          ackedAt: nowIso,
        })
      }

      return { ok: true, ackedAt: (row.acked_at ?? nowIso) as IsoTimestamp }
    },
  )
}
