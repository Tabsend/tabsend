import type { CreatePairingResponse, PairingCodeValue } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import { insertPairingCodeWithinCap } from '../caps'
import type { AppContext } from '../context'
import { callerOf, makeRequireAuth } from '../context'
import { isPostgresUrl } from '../db'
import { fail } from '../errors'
import { newPairingCode } from '../ids'
import { pairingLinks } from '../pairing-links'
import { GROUP_GONE_MESSAGE, groupSuspendedAt, SUSPENDED_PAIRING_MESSAGE } from '../tenancy'
import { addMs, iso } from '../time'

export function registerPairingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAuth = makeRequireAuth(ctx)

  // POST /v1/pairing — an already-paired endpoint mints a short-lived pairing link.
  app.post('/v1/pairing', { preHandler: requireAuth }, async (request, reply) => {
    const caller = callerOf(request)
    // A suspended tenancy invites nobody [0031], which is the other half of ADR-0029's
    // open question. Refused at the MINT as well as at the join, because a link that
    // register would then turn away is worse than a refusal here: the user would carry
    // a credential they believe works, and find out on the new device.
    //
    // A link minted BEFORE the suspension stays a valid credential until it expires,
    // and is refused at register instead. That asymmetry is deliberate — invalidating
    // outstanding links would mean deleting rows on suspension, and suspension is the
    // one operation whose whole promise is that it deletes nothing (HOSTED_PLAN §5).
    if (await groupSuspendedAt(ctx.db, caller.group_id)) {
      fail('forbidden', SUSPENDED_PAIRING_MESSAGE)
    }
    const now = ctx.now()
    const createdAt = iso(now)
    const expiresAt = iso(addMs(now, ctx.config.pairingCodeTtlMs))
    const code = newPairingCode() as PairingCodeValue

    // Bounded, in the statement that would exceed the bound [0031 amended]. This route
    // writes a row per call and nothing counted them: an authenticated device could
    // mint links in a loop and grow the relay's database without end, past every cap,
    // because the caps govern the message queue and this is not one. LIVE codes only —
    // unconsumed and unexpired — so a group that mints links normally drains its own
    // allowance simply by the links expiring, and nobody ever meets this limit.
    //
    // Written as `insert … select … where (select count(*) …) < ?` under a hold on the
    // group row, rather than a read and a decision, for the reason caps.ts states as its
    // invariant: devices racing the last slot must produce one row, not several, and
    // only the database can say so. The same hold also answers the two questions the
    // limit does not: is the group still there, and is the device asking still in it
    // (caps.ts, insertPairingCodeWithinCap).
    const outcome = await ctx.groupWrites.run(caller.group_id, () =>
      insertPairingCodeWithinCap(
        ctx.db,
        isPostgresUrl(ctx.config.databaseUrl),
        {
          code,
          group_id: caller.group_id,
          created_at: createdAt,
          expires_at: expiresAt,
        },
        caller.id,
        ctx.config.pairingCodesMaxLive,
        createdAt,
      ),
    )
    if (outcome === 'gone') fail('not_found', GROUP_GONE_MESSAGE)
    // Removed from the group while this request was in flight. The same answer its
    // next call would get from authentication, said now rather than after handing it
    // a way back into the group it was just removed from.
    if (outcome === 'caller_gone') {
      fail('endpoint_removed', 'This endpoint was removed from its group.')
    }
    if (outcome === 'capped') {
      // Says what to DO, which the first version of this did not: it told people to
      // "use one of those", and no client can show a link again once it has been
      // made. Every live link expires within one link lifetime of now, so that wait
      // is always enough.
      fail(
        'limit_reached',
        `This group has ${ctx.config.pairingCodesMaxLive} unused pairing links, the most allowed at once. Try again in ${minutesPhrase(ctx.config.pairingCodeTtlMs)}, when the oldest expires.`,
      )
    }

    const links = pairingLinks(ctx.config, code, ctx.certFingerprint)
    const response: CreatePairingResponse = {
      // `link` stays the native presentation for older clients, whose QR renderer
      // knows nothing about browserLink. Updated clients copy browserLink and render
      // this legacy field as the QR, avoiding an update-order trap.
      link: links.nativeLink,
      browserLink: links.browserLink,
      expiresAt,
    }
    reply.code(201).send(response)
  })
}

/** "10 minutes", "1 minute": a link lifetime as a person reads it. */
function minutesPhrase(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}
