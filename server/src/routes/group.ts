import type { GroupId, GroupStateResponse, StopGroupResetResponse } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { callerOf, makeRequireAuth } from '../context'
import { isPostgresUrl } from '../db'
import { fail } from '../errors'
import { GROUP_GONE_MESSAGE, readGroupReset, stopGroupReset } from '../tenancy'

/**
 * `/v1/group` — the calling device's group, as far as a device needs to know it
 * [P-18 item 12]. Today that is one thing: whether a reset is waiting.
 *
 * A RESET THAT WAITS is how a hosted account whose owner lost every paired device gets
 * a working group back: the control plane schedules it (routes/provisioning.ts), and
 * for the wait every device still paired can see it and stop it. That wait is the
 * safeguard. Someone who got into the owner's email can ask for a reset; only a device
 * already in the group can say no, and any one of them is enough.
 *
 * NOT GATED ON SUSPENSION, either route. Suspension is an acceptance gate for new work
 * (tenancy.ts); a paused group's devices must still be able to see a reset coming and
 * stop it, or an unpaid month would be the one time a reset could not be refused.
 *
 * Nothing here can START a reset or carry one out. A device can only make a pending
 * reset stop.
 */
export function registerGroupRoutes(app: FastifyInstance, ctx: AppContext): void {
  const requireAuth = makeRequireAuth(ctx)

  // GET /v1/group — the pending reset, or null.
  app.get('/v1/group', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const response: GroupStateResponse = { reset: await readGroupReset(ctx.db, caller.group_id) }
    return response
  })

  // POST /v1/group/reset/stop — any device in the group stops a pending reset.
  //
  // Answers `{ reset: null }` whether or not one was pending: the state the device
  // asked for is the state the group is in, so a retry, or two devices pressing Stop at
  // once, both read as done. The group is told only when something actually changed.
  app.post('/v1/group/reset/stop', { preHandler: requireAuth }, async (request) => {
    const caller = callerOf(request)
    const postgres = isPostgresUrl(ctx.config.databaseUrl)
    // Behind the group's queued writes, holding the group row, the way a removal does
    // (routes/endpoints.ts): a Stop and a schedule landing together are ordered, and a
    // device removed a moment ago does not get one last Stop in.
    const outcome = await ctx.groupWrites.run(caller.group_id, () =>
      stopGroupReset(ctx.db, postgres, caller.group_id, caller.id, ctx.now()),
    )
    if (outcome === 'gone') fail('not_found', GROUP_GONE_MESSAGE)
    if (outcome === 'caller_gone') {
      fail('endpoint_removed', 'This endpoint was removed from its group.')
    }
    if (outcome === 'stopped') {
      request.log.info(
        { groupId: caller.group_id, endpointId: caller.id },
        'a device stopped a pending group reset',
      )
      // After the commit, and only then.
      ctx.hub.toGroup(caller.group_id as GroupId, { type: 'group_updated' })
    }
    const response: StopGroupResetResponse = { reset: null }
    return response
  })
}
