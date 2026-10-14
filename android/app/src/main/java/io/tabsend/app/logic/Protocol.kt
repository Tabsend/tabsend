package io.tabsend.app.logic

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
     */
    fun message(check: Check): String? = when (check) {
        is Check.Ok -> null
        is Check.Outdated ->
            "Linked. A newer Tabsend build is available " +
                "(this app speaks v${check.clientProtocol}, the relay prefers v${check.recommended}) — " +
                "everything works, but it's worth updating."
        is Check.ClientTooOld ->
            "This version of the Tabsend app is too old for that relay " +
                "(app speaks v${check.clientProtocol}, relay needs v${check.relayRequires}). " +
                "Install the latest build, then pair again."
        is Check.RelayTooOld ->
            "That relay is running an older version of Tabsend than this app " +
                "(relay speaks v${check.relayProtocol}, app needs v${check.clientRequires}). " +
                "Update the relay, then pair again."
    }
}
