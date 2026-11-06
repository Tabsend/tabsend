package io.tabsend.app.logic

import io.tabsend.app.R
import io.tabsend.app.wire.ServerConfigResponse

/**
 * Wire-protocol compatibility, the Android mirror of shared/src/types.ts §10c.
 *
 * Version skew used to reach the user as a transport failure: a client that could
 * not talk to a relay said "couldn't reach the relay", sending the owner to check
 * a relay that was running perfectly (dogfood 2026-07-26). Skew is not an outage
 * and must never borrow its words — and naming the stale side matters, because
 * "update the app" and "update the relay" are different actions.
 */
object Protocol {

    /** The wire protocol this build speaks. Bump when a flow needs relay support. */
    const val CLIENT_PROTOCOL = 3

    /**
     * v3 relays return complete pairing links and no standalone secrets. Older
     * relays cannot offer the link-only flow, so block before registration.
     */
    const val MIN_RELAY_PROTOCOL = 3

    sealed interface Check {
        object Ok : Check

        /** Behind the recommendation but above the floor: works, worth updating. */
        data class Outdated(val clientProtocol: Int, val recommended: Int) : Check

        /** This app is older than the relay will serve. */
        data class ClientTooOld(val clientProtocol: Int, val relayRequires: Int) : Check

        /** The relay is older than this app can talk to. */
        data class RelayTooOld(val relayProtocol: Int, val clientRequires: Int) : Check
    }

    fun check(config: ServerConfigResponse): Check = when {
        CLIENT_PROTOCOL < config.minClientProtocol ->
            Check.ClientTooOld(CLIENT_PROTOCOL, config.minClientProtocol)
        config.protocol < MIN_RELAY_PROTOCOL ->
            Check.RelayTooOld(config.protocol, MIN_RELAY_PROTOCOL)
        CLIENT_PROTOCOL < (config.recommendedClientProtocol ?: config.minClientProtocol) ->
            Check.Outdated(CLIENT_PROTOCOL, config.recommendedClientProtocol ?: config.minClientProtocol)
        else -> Check.Ok
    }

    /** Does this result stop us pairing? Only the two hard-incompatible cases do. */
    fun blocks(check: Check): Boolean =
        check is Check.ClientTooOld || check is Check.RelayTooOld

    /**
     * What to tell the user. The blocking cases name the stale side and the one
     * action that fixes it; neither mentions reachability, because the relay
     * answered fine. The outdated case is advisory — it accompanies a successful
     * pairing rather than replacing one.
     *
     * The version numbers are passed as text: they are protocol versions ("v3"), not
     * counts, so a language must not turn them into its own digits or plural forms.
     */
    fun message(text: TextSource, check: Check): String? = when (check) {
        is Check.Ok -> null
        is Check.Outdated -> text.string(
            R.string.protocol_outdated,
            check.clientProtocol.toString(),
            check.recommended.toString(),
        )
        is Check.ClientTooOld -> text.string(
            R.string.protocol_client_too_old,
            check.clientProtocol.toString(),
            check.relayRequires.toString(),
        )
        is Check.RelayTooOld -> text.string(
            R.string.protocol_relay_too_old,
            check.relayProtocol.toString(),
            check.clientRequires.toString(),
        )
    }
}
