import { CLIENT_PROTOCOL, MIN_RELAY_PROTOCOL, type ServerConfigResponse } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import { acceptsNewGroups } from '../config'
import type { AppContext } from '../context'
import { RELAY_VERSION } from '../version'

/**
 * GET /v1/config — public relay capability discovery (@tabsend/shared §10c).
 * UNauthenticated: the VAPID public key is the browser's `applicationServerKey`,
 * not a secret. Empty string when no VAPID is configured (push disabled) — the
 * client then simply skips subscribing and relies on the poll/queue path.
 *
 * Also the protocol handshake. Clients read this before pairing so version skew
 * is reported as version skew, rather than surfacing later as a transport error
 * that blames a perfectly healthy relay.
 */
export function registerConfigRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/config', async () => {
    // Onboarding hint (ADR-0022, policy-aware since [0029]): can a client still
    // CREATE a group here, or must it join an existing one? The ladder itself lives in
    // config.ts, shared with `/admin/status` so the two answers cannot drift. Only ever
    // "in use / not in use" — no ids, no counts, no membership, and it does not say
    // WHICH policy is in force. Enforcement lives on the register route regardless.
    //
    // The read only happens where its answer matters (`single`), which is also why it
    // is not folded into the helper.
    const hasAnyGroup =
      ctx.config.groupCreation === 'single'
        ? (await ctx.db.selectFrom('groups').select('id').limit(1).executeTakeFirst()) !== undefined
        : false

    const response: ServerConfigResponse = {
      vapidPublicKey: ctx.config.vapid?.publicKey ?? '',
      protocol: CLIENT_PROTOCOL,
      // The floor stays at the oldest protocol ever shipped and moves only when
      // serving it becomes genuinely impossible: raising it strands devices that
      // were working a moment earlier. Nudging goes through `recommended`.
      minClientProtocol: MIN_RELAY_PROTOCOL,
      recommendedClientProtocol: CLIENT_PROTOCOL,
      // Stable identity (P-4): lets a client verify "same relay, new address"
      // before adopting a changed relay URL. Not a credential, not secret.
      relayId: ctx.relayId,
      // Build id, not a compatibility signal (the protocol numbers above are that).
      // A self-hoster upgrades the relay by hand, so "which build is actually running"
      // is a question they otherwise have no way to answer from the outside.
      relayVersion: RELAY_VERSION,
      acceptsNewGroups: acceptsNewGroups(ctx.config.groupCreation, hasAnyGroup),
      // Can this relay ring a phone [0032, 0034]? Emitted only where a forwarder is
      // configured, so a relay without one is byte-for-byte the relay it was before
      // the field existed — and an old client, which ignores unknown fields, is
      // unaffected either way. The URL itself never appears: which forwarder a relay
      // rings is its operator's business, and this route is unauthenticated.
      ...(ctx.config.wakeForwarderUrl ? { wakeForwarder: true } : {}),
    }
    return response
  })
}
