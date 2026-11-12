import type { EndpointId, GroupId } from '@tabsend/shared'
import type { Kysely } from 'kysely'
import { lockGroup } from './caps'
import type { AppContext } from './context'
import { isPostgresUrl } from './db'
import type { Database, EndpointRow } from './db/schema'
import { fail } from './errors'
import { type RevokeLog, revokeDeleted } from './push'
import { iso } from './time'

/**
 * Remove one endpoint from its group: the one removal every route shares.
 *
 * `DELETE /v1/endpoints/:id` (a device removing another, or itself) and
 * `POST /v1/endpoints/leave` (the `/goodbye` page after an uninstall, PLANS P-31 item 1)
 * both come here, so a device that leaves by either door leaves the same way: a
 * tombstone, its group-key copies gone, the group told, its sockets closed and its
 * doorbell revoked. The other devices see `endpoint_removed` and rotate the key as for
 * any removal.
 *
 * `pick` runs inside the transaction, under the group's hold, and names the row to
 * remove (or fails the request, or returns undefined for "nothing to remove"). Reading
 * the row there, not before, is what makes a removal racing another removal safe.
 *
 * Returns the removed row, or null when `pick` found nothing.
 */
export async function removeEndpoint(
  ctx: AppContext,
  groupId: string,
  pick: (trx: Kysely<Database>) => Promise<EndpointRow | undefined>,
  log: RevokeLog,
  onGroupGone: () => never | null = () => null,
): Promise<EndpointRow | null> {
  const postgres = isPostgresUrl(ctx.config.databaseUrl)

  // ONE transaction holding the group row [0031 amended 2026-10-01], because both
  // halves of a removal race something that holds it too. `removed_endpoints` has
  // no foreign key to `groups`, so a removal racing a tenancy deletion used to be
  // able to commit its tombstone after the cascade had swept that table, leaving a
  // token hash naming a tenancy reported as gone. And the send and the group-key
  // upload now read their targets under the same hold, so a removal either lands
  // first, and they no longer see the device, or lands after them, and the
  // group-key delete below sweeps whatever they stored for it.
  const row = await ctx.groupWrites.run(groupId, () =>
    ctx.db.transaction().execute(async (trx) => {
      if (!(await lockGroup(trx, postgres, groupId))) return onGroupGone()
      const found = await pick(trx)
      if (!found) return null
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
      // Tabs still waiting for it can never arrive now: they read "never arrived"
      // at once, so the sender is offered Send again (PLANS P-31 item 4).
      await endWaitingSends(trx, found.group_id, [found.id], iso(ctx.now()))
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
  if (!row) return null

  // After the commit, and only then: a rollback must not announce a removal.
  ctx.hub.toGroup(groupId as GroupId, {
    type: 'endpoint_removed',
    endpointId: row.id as EndpointId,
  })
  // And its open sockets go too, after it has been told above. A socket
  // authenticates once, in its hello (routes/stream.ts), so without this a removed
  // device kept receiving the group's broadcasts for as long as it held its socket
  // open: every later device's label, name and public key, and presence. Its token
  // stopped working at once; its fast path did not.
  ctx.hub.disconnectEndpoint(row.id as EndpointId, 'endpoint removed')
  // And its doorbell [2026-10-20, PLANS P-17]: a removed phone is never rung again,
  // so without this the forwarder kept its record for good. Detached; see push.ts.
  revokeDeleted(ctx.push, [{ endpointId: row.id, pushSubscription: row.push_subscription }], log)
  return row
}

/** Fail the request the way the DELETE route always has when the group is gone. */
export function groupGone(): never {
  fail(
    'not_found',
    'This group no longer exists on this relay, so there is nothing left to remove.',
  )
}

/**
 * End every send still waiting for devices that are leaving the group (PLANS P-31
 * item 4). Called inside the transaction that deletes them, by every path that
 * removes a device: `removeEndpoint` above (the remove button and the goodbye page)
 * and a cleared leftover (bootstrap.ts). A new removal path must call it too.
 *
 * Nothing can pick these up any more: the pending read is by the target's own token,
 * and that token stops working in the same transaction. Left alone, each one read
 * "Waiting" in every device's History until its TTL ran out, days later, and the
 * sender was offered nothing. Pulling the expiry back to now makes the relay's own
 * history say what is true, "never arrived", on every client, shipped ones included,
 * because each already derives that state from `expires_at` alone.
 *
 * The envelope goes with it: it is sealed to a key only the removed device holds, so
 * it can never be opened, and keeping it would hold ciphertext for a device that is
 * gone (the same reason its group-key copies are deleted). The routing row and its
 * history blob stay, so the sender can still read what it sent and send it again.
 *
 * Only rows still waiting are touched: an acked send arrived, and an expired one
 * already reads "never arrived".
 */
export async function endWaitingSends(
  trx: Kysely<Database>,
  groupId: string,
  endpointIds: readonly string[],
  nowIso: string,
): Promise<number> {
  if (endpointIds.length === 0) return 0
  const result = await trx
    .updateTable('messages')
    .set({ expires_at: nowIso, envelope: null })
    .where('group_id', '=', groupId)
    .where('target_endpoint_id', 'in', [...endpointIds])
    .where('acked_at', 'is', null)
    .where('expires_at', '>', nowIso)
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0n)
}
