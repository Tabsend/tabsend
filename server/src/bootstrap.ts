import type { PairingCodeValue } from '@tabsend/shared'
import type { Kysely } from 'kysely'
import { lockGroup } from './caps'
import type { Config } from './config'
import { type Database, isPostgresUrl, legacyGroupDefaults } from './db'
import { newId, newPairingCode } from './ids'
import { pairingLinks } from './pairing-links'
import { addMs, iso } from './time'

/**
 * First-run setup for a single-group relay (ADR-0023).
 *
 * The group used to be created by whichever client registered first, which made
 * "create a group" a step in every client's onboarding — a step with no decisions in
 * it, and one a phone could not perform at all (the iOS and Android apps only ever
 * join with a pairing link). Setting up a relay and then separately setting up its
 * one group is two steps where the user experiences one thing.
 *
 * So the relay creates its own group at boot, next to the relay id it already mints,
 * and prints a pairing link while that group is still empty. Every client — phone,
 * browser, console — then does the same single thing: join.
 */

/** What boot needs to tell the operator, or null when there is nothing to say. */
export interface FirstRunPairing {
  link: string
  qrLink: string
  expiresAt: string
}

/**
 * Create this relay's group if it has none. `GROUP_CREATION=single` only (the default):
 * on any multi-group relay (ADR-0022, and `open`/`provisioned` since [0029]) every group
 * belongs to somebody who asked for it, so minting an owner-less one at boot would just
 * leave an orphan for the first arrival to land in by accident. A `provisioned` relay in
 * particular is empty on purpose until its provisioning path makes the first group.
 *
 * Idempotent — a relay that already has a group (including every relay that predates
 * this) is left exactly as it is.
 */
export async function ensureBootstrapGroup(
  db: Kysely<Database>,
  config: Config,
  now: Date,
): Promise<void> {
  if (config.groupCreation !== 'single') return
  const existing = await db.selectFrom('groups').select('id').limit(1).executeTakeFirst()
  if (existing) return
  await db
    .insertInto('groups')
    // Retired columns, written only where a legacy database still has them [0029].
    .values({ id: newId(), created_at: iso(now), ...(await legacyGroupDefaults(db)) })
    .execute()
}

/**
 * Mint the first-run pairing link, or return null when one is not needed.
 *
 * Needed only while the group has NO endpoints. That is the one moment the normal rule
 * — links are minted by a device already in the group — has nobody to apply to, so the
 * relay stands in. The moment a first device joins, this stops and pairing goes back to
 * being device-to-device.
 *
 * Deliberately a LONGER life than a normal pairing link (10 minutes, ADR-0008). That
 * window is sized for handing a link between two devices you are holding; this one is
 * read out of a boot log by someone who may finish setting up hours later, and a link
 * that has quietly expired is a worse first experience than a slightly longer window on
 * a relay that has nothing in it yet. Restarting the relay prints a fresh one, and every
 * link an earlier boot printed keeps working until the first device joins, at which
 * point the join retires the rest (routes/endpoints.ts).
 */
export async function mintFirstRunPairing(
  db: Kysely<Database>,
  config: Config,
  certFingerprint: string | undefined,
  now: Date,
): Promise<FirstRunPairing | null> {
  // Same rule as ensureBootstrapGroup [0029]: only the single-group relay has "the"
  // group to hand out a link for. Where several groups may exist, a link belongs to
  // one of them, and choosing which is the provisioning path's job, not boot's —
  // which is exactly what {@link mintFirstPairingForGroup} is, called with an id.
  if (config.groupCreation !== 'single') return null

  const group = await db.selectFrom('groups').select('id').limit(1).executeTakeFirst()
  if (!group) return null
  const outcome = await mintFirstPairingForGroup(db, config, group.id, certFingerprint, now)
  return outcome.status === 'minted' ? outcome.pairing : null
}

/**
 * What a first-link mint for one group did. `populated` and `gone` are both "no link",
 * and they are kept apart because they need different words: a group that already has a
 * device is a reason, a group that was deleted under the call is a 404.
 */
export type FirstPairingOutcome =
  | { status: 'minted'; pairing: FirstRunPairing }
  | { status: 'populated' }
  | { status: 'gone' }

/**
 * Mint the first pairing link for ONE named group. The mechanism above, generalized per
 * group [0031] (HOSTED_PLAN §4.2).
 *
 * The rule it carries across is ADR-0021's, extended: **only while the group has no
 * endpoints.** On a single-group relay that rule is what makes the boot-log link safe
 * — the relay stands in for a member only while there is no member to stand in for.
 * On a provisioned relay the same rule is what stops the control plane, and therefore
 * anyone who takes over an account's email, from minting a way into a populated group:
 * once one device is in, pairing is device-to-device and the relay is not a party to it
 * (HOSTED_PLAN §5, "the account page cannot mint into a populated group").
 *
 * The refusal is deliberately NOT an error. "Already populated" is a legitimate answer
 * to "is a bootstrap link needed here", and it is the same answer boot gives itself on
 * every restart after the first device joined. The caller decides what to say about it.
 *
 * Uses the bootstrap TTL rather than the ordinary 10-minute pairing lifetime, for the
 * reason above: this link is read out of a boot log or a signup page by someone who may
 * finish setting up hours later, not handed between two devices in your hands.
 *
 * TWO THINGS MAKE THAT RULE ACTUALLY HOLD [0031 amended].
 *
 * FIRST, the emptiness check and the insert are one transaction holding the group row.
 * They used to be two statements with nothing between them, so a device joining in the
 * gap produced a link minted "for an empty group" that was already a link into a
 * populated one — the exact outcome §5 spends its length forbidding. The hold is the
 * same one the join, `deleteGroupCascade` and every group-scoped write take first
 * (caps.ts, `lockGroup`), so they are ordered on both dialects.
 *
 * SECOND, no unclaimed first-run link survives the first join, and that is the JOIN's
 * job, not this function's [0031 amended 2026-10-01]. The join that makes a group
 * non-empty retires every other unconsumed code the group holds (routes/endpoints.ts).
 * Until then several may be live at once, and that is fine: each is a way to become the
 * group's FIRST device, which is what every one of them was minted to be. This function
 * used to enforce it the other way round, by deleting the group's earlier links on every
 * mint. That closed the hole, at a price: each restart of an unpaired self-hosted relay
 * killed the link the previous boot had printed, a second look at an account page
 * killed the link already on screen, and the delete took pairing-code rows in the
 * opposite order to a join, which deadlocked the two on Postgres.
 */
export async function mintFirstPairingForGroup(
  db: Kysely<Database>,
  config: Config,
  groupId: string,
  certFingerprint: string | undefined,
  now: Date,
): Promise<FirstPairingOutcome> {
  const postgres = isPostgresUrl(config.databaseUrl)
  const code = newPairingCode() as PairingCodeValue
  const expiresAt = iso(addMs(now, config.bootstrapPairingTtlMs))

  const status = await db.transaction().execute(async (trx) => {
    if (!(await lockGroup(trx, postgres, groupId))) return 'gone' as const

    const endpoint = await trx
      .selectFrom('endpoints')
      .select('id')
      .where('group_id', '=', groupId)
      .limit(1)
      .executeTakeFirst()
    if (endpoint) return 'populated' as const // somebody is already in; they mint links now

    await trx
      .insertInto('pairing_codes')
      .values({
        code,
        group_id: groupId,
        created_at: iso(now),
        expires_at: expiresAt,
        consumed_at: null,
      })
      .execute()
    return 'minted' as const
  })
  if (status !== 'minted') return { status }

  const links = pairingLinks(config, code, certFingerprint)
  return {
    status,
    pairing: { link: links.browserLink, qrLink: links.nativeLink, expiresAt },
  }
}
