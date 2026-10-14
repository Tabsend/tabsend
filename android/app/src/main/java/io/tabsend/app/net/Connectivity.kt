package io.tabsend.app.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/**
 * Does the OS think this phone has a network?
 *
 * A weak signal by design — it asks only whether a network claiming internet
 * capability is up, NOT whether it is validated and certainly not whether your
 * relay works — so it is only ever used to DEMOTE a relay-unreachable diagnosis to a
 * plain offline one, never to skip a send attempt (mirrors the extension's use
 * of `navigator.onLine`). Blaming the wifi when the relay is the thing that's
 * down is the bug this whole path exists to stop.
 */
object Connectivity {
    fun isOnline(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return true
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
