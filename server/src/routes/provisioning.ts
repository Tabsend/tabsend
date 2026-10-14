import { createHash, timingSafeEqual } from 'node:crypto'
import { AUTH_SCHEME, type GroupId } from '@tabsend/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { mintFirstPairingForGroup } from '../bootstrap'
import {
  CAP_COLUMNS,
  capOverridesFromRow,
  capsFromRow,
  type GroupCapOverrides,
  setGroupCapOverrides,
} from '../caps'
import type { AppContext } from '../context'
import { isPostgresUrl, legacyGroupDefaults } from '../db'
import { fail, NOT_FOUND_BODY } from '../errors'
import { newId } from '../ids'
import { isDirectLocalCall } from '../netguard'
import { deleteGroupCascade, groupUsage, setGroupSuspended } from '../tenancy'
import { iso } from '../time'
import { asObject } from '../validate'

/**
 * `/admin/provisioning/*` — the authenticated surface the CONTROL PLANE calls
 * [0031] (HOSTED_PLAN §4.2).
 *
 * WHAT THIS IS. Six operations on one group: create it, mint its first pairing link,
 * set its caps, read its usage, suspend or resume it, delete it. That is the whole of
 * what a hosted signup, a billing webhook and an account deletion need from the relay.
 * The commercial policy that decides WHEN to call any of them — which cap for which
 * price, who gets provisioned, when somebody is cut off — is not here and never will
 * be (HOSTED_PLAN §2.3: mechanism open, policy closed).
 *
 * NOT CLIENT WIRE SURFACE. Like `/admin/status` this sits outside `/v1`, carries no
 * protocol bump, and no client ever calls it. Its shape may change without one.
 *
 * ACCESS REQUIRES BOTH FACTORS, and the reason the second one exists is the whole
 * argument of §4.2. The locality rule (`isDirectLocalCall`, netguard.ts) says the
 * caller is a process on this host and did not arrive through a proxy. That is a
 * LOCATION, not an identity: it cannot tell the control plane from any other process
 * on the same machine — or from the relay itself being used as an SSRF victim by
 * something that can make it fetch a URL. `/admin/status` gets away with locality
 * alone because it is read-only diagnostics a local caller could reconstruct from the
 * database. This route DELETES TENANCIES, so it also demands a bearer credential from
 * the operator's secret store, which gives every destructive call an attribution the
 * relay can log. What the credential does NOT defend against is a compromised relay
 * process: that owns the database and needs no API. Nothing can defend against that,
 * which is why the authoritative audit log lives in the control plane (below).
 *
 * A FAILURE OF EITHER FACTOR ANSWERS 404 — the same body as any unserved URL
 * (`NOT_FOUND_BODY`), never 401 or 403. A 401 would advertise that there is something
 * here worth authenticating to. The operator still gets a `warn` line, so a legitimate
 * caller reaching it from the wrong place, or with a stale credential, can see why.
 *
 * AUDIT. HOSTED_PLAN §4.2 puts the AUTHORITATIVE append-only audit log in the control
 * plane, shipped off-host with the backups, so a later relay compromise cannot rewrite
 * the history of what was asked of it. What the relay keeps is the mirror the plan
 * permits: one structured log line per call, carrying ids, sizes and outcomes. Never a
 * pairing link, never a token — the mint response is the one place a link exists in
 * this module, and its audit line records the EXPIRY, not the link.
 */

/** Per-call audit detail a handler adds to the line the hook writes. Ids and sizes only. */
interface ProvisioningAudit {
  groupId?: string
  [key: string]: unknown
}

declare module 'fastify' {
  interface FastifyRequest {
    provisioningAudit?: ProvisioningAudit
  }
  interface FastifyContextConfig {
    /** Stable name of the operation, for the audit line. Set per route, so it is on
     *  the request even when the guard refuses before any handler runs. */
    provisioningOperation?: string
  }
}

/** SHA-256 of a credential — the fixed-width input `timingSafeEqual` requires. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Constant-time credential comparison.
 *
 * Over DIGESTS rather than the raw strings, for two reasons that both matter:
 * `timingSafeEqual` throws on a length mismatch, which would turn a wrong-length guess
 * into an exception instead of a refusal and leak the expected length; and hashing
 * first means the comparison is over 32 fixed bytes whatever was presented.
 */
function credentialMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented))
}

/** The bearer credential presented, or undefined when the header is absent or malformed. */
function presentedCredential(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (!header) return undefined
  const [scheme, ...rest] = header.split(' ')
  if (scheme !== AUTH_SCHEME) return undefined
  const token = rest.join(' ').trim()
  return token === '' ? undefined : token
}

/**
 * One caller-supplied header, made safe to store and to log.
 *
 * Untrusted input, so it is bounded and stripped of anything that is not printable
 * ASCII: it goes straight into a log line, and a caller must not be able to forge a
 * newline and write a log entry of their own choosing. The same cleaning is what the
 * idempotency key is stored under, so the value the log shows is the value the
 * database holds.
 */
function cleanHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').slice(0, 128)
  return cleaned === '' ? undefined : cleaned
}

/**
 * A caller-supplied correlation id, so one line in this relay's log can be lined up
 * with the control plane's authoritative entry for the same call. Either header will
 * do, because either one identifies the call.
 */
function correlationId(request: FastifyRequest): string | undefined {
  return cleanHeader(request, 'idempotency-key') ?? cleanHeader(request, 'x-request-id')
}

/** Outcome word for the audit line, derived from the status actually sent. */
function outcomeOf(statusCode: number): string {
  if (statusCode < 300) return 'ok'
  if (statusCode === 403) return 'refused'
  if (statusCode === 404) return 'not_found'
  if (statusCode >= 500) return 'error'
  return 'rejected'
}

/** The four overridable caps, by the name they carry on the wire of this API [0030]. */
const CAP_FIELDS = ['endpoints', 'queuedMessages', 'queuedBytes', 'sendsPerWindow'] as const

/**
 * Read a cap-override patch body.
 *
 * THREE states, not two, and keeping them apart is the whole contract [0030]: a field
 * that is absent leaves the override alone, an explicit `null` clears it back to the
 * relay-wide default, and a number sets it — including `0`, which means "unlimited for
 * this group whatever the relay says". Collapsing null and 0 would make every
 * deliberate exemption evaporate the next time an operator raised a default.
 */
function readCapPatch(body: Record<string, unknown>): GroupCapOverrides {
  const patch: GroupCapOverrides = {}
  for (const field of CAP_FIELDS) {
    if (!(field in body)) continue
    const value = body[field]
    if (value === null) {
      patch[field] = null
      continue
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      fail(
        'invalid_request',
        `${field} must be a whole number of 0 or more (0 means unlimited), or null to clear the override.`,
      )
    }
    patch[field] = value
  }
  return patch
}

export function registerProvisioningRoutes(app: FastifyInstance, ctx: AppContext): void {
  const expectedToken = ctx.config.provisioningToken
  // Registering without a credential would be the one shape this must never take:
  // a provisioning API reachable because somebody forgot the token. buildApp only
  // calls this when the token is present; this is the assertion that keeps that true.
  if (!expectedToken) {
    throw new Error(
      'registerProvisioningRoutes was called without a provisioning credential. This is a wiring bug: the routes must not exist unless PROVISIONING_TOKEN (or PROVISIONING_TOKEN_FILE) is configured.',
    )
  }

  // A Fastify plugin scope, so the guard and the audit hook apply to THESE routes and
  // nothing else. Registering them on the root instance would put a bearer check in
  // front of the client API.
  app.register(async (scope) => {
    scope.addHook('onRequest', async (request, reply) => {
      const local = isDirectLocalCall(request)
      const presented = presentedCredential(request)
      const authorised =
        local && presented !== undefined && credentialMatches(expectedToken, presented)
      if (authorised) return
      // One line, and it names WHICH factor failed, because the two have completely
      // different fixes: "you called it from the wrong place" versus "your credential
      // is wrong". Never logs the credential presented.
      request.log.warn(
        {
          peer: request.socket.remoteAddress,
          operation: request.routeOptions.config.provisioningOperation,
          local,
          credential: presented === undefined ? 'absent' : 'mismatch',
        },
        'Refused a provisioning call: it must come from this host, directly, with the configured credential',
      )
      await reply.code(404).send(NOT_FOUND_BODY)
    })

    // The audit mirror. On the RESPONSE, so exactly one line is written per call
    // whatever happened inside — handler, refusal, thrown error — and the outcome is
    // the status actually sent rather than what a handler believed it was sending.
    scope.addHook('onResponse', async (request, reply) => {
      const audit = request.provisioningAudit ?? {}
      const correlation = correlationId(request)
      request.log.info(
        {
          audit: 'provisioning',
          operation: request.routeOptions.config.provisioningOperation ?? request.url,
          outcome: outcomeOf(reply.statusCode),
          status: reply.statusCode,
          ...(correlation ? { requestId: correlation } : {}),
          ...audit,
        },
        'provisioning',
      )
    })

    // POST /admin/provisioning/groups — bring a group into being.
    //
    // Deliberately NOT gated on GROUP_CREATION. That setting answers "may a caller on
    // the public API mint a tenancy", and the whole point of `provisioned` is that the
    // answer there is no while groups still come into being somehow [0029]. This is the
    // somehow. Refusing here on a `single` relay would also be wrong in the other
    // direction: the operator holding this credential is the person who decides.
    //
    // IDEMPOTENT ON `Idempotency-Key`, when the caller sends one. Without the header
    // this is exactly what it always was: every call makes a group. With it, the key is
    // claimed and the group created in ONE transaction, and a repeat of the same key
    // answers with the group the first call made — **200**, not 201, because a replay
    // created nothing and a control plane that counts its 201s should be able to
    // believe them. The retry this exists for is the ordinary one: a create that
    // succeeded, timed out on the way back, and got sent again. Without the key that
    // account ends up owning two tenancies, one of which nobody ever names again.
    scope.post(
      '/admin/provisioning/groups',
      { config: { provisioningOperation: 'create_group' } },
      async (request, reply) => {
        const now = ctx.now()
        const nowIso = iso(now)
        const key = cleanHeader(request, 'idempotency-key')
        // Retired columns, written only where a legacy database still has them [0029] —
        // the same compat every other create path carries. Read BEFORE the transaction:
        // a catalogue query on `ctx.db` while a transaction holds the SQLite connection
        // deadlocks, and handing it the transaction breaks on Postgres [0030].
        const legacyDefaults = await legacyGroupDefaults(ctx.db)

        const outcome = await ctx.db.transaction().execute(async (trx) => {
          const groupId = newId()
          if (key === undefined) {
            await trx
              .insertInto('groups')
              .values({ id: groupId, created_at: nowIso, ...legacyDefaults })
              .execute()
            return { groupId, replayed: false }
          }

          // Claim the key FIRST, and let the primary key decide who won. Two calls
          // racing the same key: the loser's insert does nothing, the SELECT that
          // follows it in the same transaction sees the winner's committed row
          // (Postgres re-reads under READ COMMITTED once the lock it blocked on is
          // released; SQLite serialises the transactions outright), and it returns the
          // winner's group instead of making a second one.
          await trx
            .insertInto('provisioning_idempotency')
            .values({ key, group_id: groupId, created_at: nowIso })
            .onConflict((oc) => oc.column('key').doNothing())
            .execute()
          const claim = await trx
            .selectFrom('provisioning_idempotency')
            .select('group_id')
            .where('key', '=', key)
            .executeTakeFirstOrThrow()
          if (claim.group_id !== groupId) return { groupId: claim.group_id, replayed: true }

          await trx
            .insertInto('groups')
            .values({ id: groupId, created_at: nowIso, ...legacyDefaults })
            .execute()
          return { groupId, replayed: false }
        })

        // A replay answers from the group row rather than from what was recorded, so
        // "suspended" is current rather than historical.
        const group = outcome.replayed
          ? await ctx.db
              .selectFrom('groups')
              .select(['created_at', 'suspended_at'])
              .where('id', '=', outcome.groupId)
              .executeTakeFirst()
          : { created_at: nowIso, suspended_at: null }
        request.provisioningAudit = {
          groupId: outcome.groupId,
          ...(key === undefined ? {} : { idempotent: outcome.replayed }),
        }
        if (!group) {
          // The key was used before and its group has since been deleted. Answering
          // 200 would name a tenancy that is not there; creating a new one would
          // resurrect an account somebody deliberately tore down. So: say what is
          // true, and name the only sensible fix.
          fail(
            'not_found',
            'This Idempotency-Key created a group that has since been deleted, so there is nothing to return. Use a new key if you mean to create another group.',
          )
        }
        reply.code(outcome.replayed ? 200 : 201).send({
          groupId: outcome.groupId as GroupId,
          createdAt: group.created_at,
          suspended: group.suspended_at !== null,
        })
      },
    )

    // POST /admin/provisioning/groups/:id/pairing — the group's FIRST pairing link,
    // and only while it is empty (ADR-0021 extended, ADR-0023's mechanism per group).
    scope.post<{ Params: { id: string } }>(
      '/admin/provisioning/groups/:id/pairing',
      { config: { provisioningOperation: 'mint_first_pairing' } },
      async (request, reply) => {
        const groupId = request.params.id
        request.provisioningAudit = { groupId }
        // One read for both questions it has about the group row — does it exist, and
        // is it accepting devices. They are the same row and the same moment.
        const group = await ctx.db
          .selectFrom('groups')
          .select(['id', 'suspended_at'])
          .where('id', '=', groupId)
          .executeTakeFirst()
        if (!group) fail('not_found', 'No such group on this relay.')

        // A suspended tenancy is not onboarding. Minting here would hand out a
        // credential that `POST /v1/endpoints/register` then refuses, which is a worse
        // answer than this one: a link that cannot be used looks like a broken relay.
        if (group.suspended_at !== null) {
          fail(
            'forbidden',
            'This group is suspended, so a pairing link minted now could not be used to join it. Resume the group first.',
          )
        }

        const outcome = await ctx.groupWrites.run(groupId, () =>
          mintFirstPairingForGroup(ctx.db, ctx.config, groupId, ctx.certFingerprint, ctx.now()),
        )
        // Deleted between the read above and the mint's own hold on the row. Rare, and
        // it gets the same answer as a group that was never there: before the mint said
        // which, this read as "already has a device", which is not true of anything.
        if (outcome.status === 'gone') fail('not_found', 'No such group on this relay.')
        if (outcome.status === 'populated') {
          // The rule that makes the whole bootstrap window safe (HOSTED_PLAN §5): once
          // one device is in, pairing is device-to-device and nothing that can reach
          // this API — including whoever takes over an account's email — can mint a way
          // into a populated group.
          fail(
            'forbidden',
            'This group already has a device in it, so the relay no longer mints links for it. Pairing is device to device from here: make the link on a device that is already paired.',
          )
        }
        const { pairing } = outcome
        // The EXPIRY is audited, never the link. This response is the one place in this
        // module where a pairing credential exists, and a log is exactly the wrong
        // place for it to also exist.
        request.provisioningAudit = { groupId, expiresAt: pairing.expiresAt }
        reply.code(201).send(pairing)
      },
    )

    // GET /admin/provisioning/groups/:id/caps — overrides as set, and what they resolve to.
    scope.get<{ Params: { id: string } }>(
      '/admin/provisioning/groups/:id/caps',
      { config: { provisioningOperation: 'read_caps' } },
      async (request) => {
        const groupId = request.params.id
        request.provisioningAudit = { groupId }
        const caps = await readCaps(ctx, groupId)
        // Explicit, because the row-level resolvers underneath answer happily for a
        // group that is not there: no overrides plus the relay-wide defaults reads as
        // a perfectly healthy group. Only the absent ROW can tell the difference.
        if (!caps) fail('not_found', 'No such group on this relay.')
        return caps
      },
    )

    // PATCH /admin/provisioning/groups/:id/caps — set or clear overrides [0030].
    //
    // PATCH rather than PUT, matching `setGroupCapOverrides`: an omitted cap is left
    // alone and an explicit `null` clears it back to the relay-wide default. Those are
    // three states, not two, and a PUT would have to invent a spelling for "leave it".
    scope.patch<{ Params: { id: string } }>(
      '/admin/provisioning/groups/:id/caps',
      { config: { provisioningOperation: 'set_caps' } },
      async (request) => {
        const groupId = request.params.id
        request.provisioningAudit = { groupId }
        const overrides = readCapPatch(asObject(request.body))
        const written = await setGroupCapOverrides(ctx.db, groupId, overrides)
        if (!written) fail('not_found', 'No such group on this relay.')
        const caps = await readCaps(ctx, groupId)
        if (!caps) fail('not_found', 'No such group on this relay.')
        request.provisioningAudit = { groupId, caps: caps.overrides }
        return caps
      },
    )

    // GET /admin/provisioning/groups/:id/usage — aggregates, and only aggregates.
    scope.get<{ Params: { id: string } }>(
      '/admin/provisioning/groups/:id/usage',
      { config: { provisioningOperation: 'read_usage' } },
      async (request) => {
        const groupId = request.params.id
        request.provisioningAudit = { groupId }
        const usage = await groupUsage(
          ctx.db,
          ctx.config.caps,
          ctx.config.historyRetentionMs,
          groupId,
          ctx.now(),
        )
        if (!usage) fail('not_found', 'No such group on this relay.')
        return usage
      },
    )

    // POST /admin/provisioning/groups/:id/suspend | /resume — the §5 kill switch.
    //
    // Two routes rather than one taking a boolean, because these are the two calls a
    // billing webhook actually makes and a typo'd body must not be able to resume a
    // tenancy that was meant to stay suspended.
    for (const [suffix, suspend, operation] of [
      ['suspend', true, 'suspend_group'],
      ['resume', false, 'resume_group'],
    ] as const) {
      scope.post<{ Params: { id: string } }>(
        `/admin/provisioning/groups/:id/${suffix}`,
        { config: { provisioningOperation: operation } },
        async (request) => {
          const groupId = request.params.id
          request.provisioningAudit = { groupId }
          // The write reports the state it left behind, so there is nothing to read
          // back — and nothing that could answer differently from what just happened.
          const { exists, suspendedAt } = await setGroupSuspended(
            ctx.db,
            groupId,
            suspend,
            ctx.now(),
          )
          if (!exists) fail('not_found', 'No such group on this relay.')
          request.provisioningAudit = { groupId, suspended: suspendedAt !== null }
          return { groupId: groupId as GroupId, suspended: suspendedAt !== null, suspendedAt }
        },
      )
    }

    // DELETE /admin/provisioning/groups/:id — the idempotent cascade (HOSTED_PLAN §5).
    //
    // 200 whether or not the group was there. Account deletion is a multi-step teardown
    // across two systems, so the control plane has to be able to re-run it until every
    // step reports done; a 404 on the second pass would make "already gone" look like a
    // failure and leave a half-deleted tenant, which §5 calls worse than either state.
    scope.delete<{ Params: { id: string } }>(
      '/admin/provisioning/groups/:id',
      { config: { provisioningOperation: 'delete_group' } },
      async (request) => {
        const groupId = request.params.id
        // Behind the group's queued writes in this process (group-queue.ts), so the
        // deletion waits its turn in memory like they do, and they finish or find the
        // group gone rather than racing it for a connection.
        const result = await ctx.groupWrites.run(groupId, () =>
          deleteGroupCascade(ctx.db, isPostgresUrl(ctx.config.databaseUrl), groupId),
        )
        // AFTER the commit, and only then: a rollback must not have closed the sockets
        // of a group that still exists. See Hub.disconnectGroup for why this is
        // "tell them" rather than "close a hole".
        const disconnected = ctx.hub.disconnectGroup(groupId as GroupId)
        request.provisioningAudit = {
          groupId,
          existed: result.existed,
          deleted: result.deleted,
          socketsClosed: disconnected,
        }
        return { groupId: groupId as GroupId, ...result, socketsClosed: disconnected }
      },
    )
  })
}

/**
 * The caps body both cap routes answer with, or null when there is no such group.
 *
 * ONE read of the group row for all three things it decides — does the group exist,
 * what is set on it, and what that resolves to against the relay-wide defaults. It used
 * to be three (`select id`, `getGroupCapOverrides`, `effectiveCaps`), which is three
 * round trips for one row, and the PATCH route ran the lot again after writing.
 */
async function readCaps(ctx: AppContext, groupId: string) {
  const row = await ctx.db
    .selectFrom('groups')
    .select(CAP_COLUMNS)
    .where('id', '=', groupId)
    .executeTakeFirst()
  if (!row) return null
  const overrides = capOverridesFromRow(row)
  const caps = capsFromRow(row, ctx.config.caps)
  return {
    groupId: groupId as GroupId,
    overrides,
    effective: {
      endpoints: caps.endpoints,
      queuedMessages: caps.queuedMessages,
      queuedBytes: caps.queuedBytes,
      sendsPerWindow: caps.sendsPerWindow,
      sendWindowSeconds: Math.round(caps.sendWindowMs / 1000),
    },
  }
}
