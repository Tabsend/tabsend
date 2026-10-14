package io.tabsend.app.net

import android.content.Context
import io.tabsend.app.logic.RelayHealth
import io.tabsend.app.logic.foldRelayContact
import io.tabsend.app.store.Store

/**
 * Relay reachability, recorded from ordinary traffic.
 *
 * Every API call reports whether the relay answered ([ApiClient.transportHandler])
 * and the verdict is persisted, so the home screen opened ten minutes into an
 * outage can explain itself rather than rendering a healthy device list from
 * cache while sends pile up in the outbound queue (dogfood 2026-07-29).
 *
 * No probe of its own: the poll chain and periodic heartbeat already talk to the
 * relay every few minutes, so this is fresh for free.
 */
object RelayHealthTracker {

    /** Process-lifetime mirror, so a burst of calls isn't a burst of writes. */
    @Volatile
    private var cached: RelayHealth? = null

    @Volatile
    private var lastWrite = 0L

    fun install(context: Context) {
        val app = context.applicationContext
        ApiClient.transportHandler = { relayUrl, reachable -> record(app, relayUrl, reachable) }
    }

    /**
     * Fold one call's outcome into the stored verdict. Calls aimed at a URL that
     * ISN'T our registered relay (the /v1/config probe behind "Move to another
     * relay", a join attempt) are ignored: they say nothing about the relay we
     * are actually registered to, and letting them write would make a typo in
     * the address box look like an outage.
     */
    @Synchronized
    fun record(context: Context, relayUrl: String, reachable: Boolean) {
        val store = Store.get(context)
        if (store.registeredRelayUrl != relayUrl) return

        val now = System.currentTimeMillis()
        val previous = cached ?: store.relayHealth
        val folded = foldRelayContact(previous, relayUrl, reachable, now, lastWrite)
        if (folded == null) {
            // Warm the mirror even when the write is skipped, so a later
            // transition compares against the truth rather than re-reading storage.
            cached = previous
            return
        }
        cached = folded
        lastWrite = now
        store.relayHealth = folded
    }

    /** The current verdict (storage-backed, so it survives process death). */
    fun current(context: Context): RelayHealth? =
        cached ?: Store.get(context).relayHealth

    /** Drop the mirror — used when the registration changes underneath us. */
    @Synchronized
    fun reset() {
        cached = null
        lastWrite = 0L
    }
}
