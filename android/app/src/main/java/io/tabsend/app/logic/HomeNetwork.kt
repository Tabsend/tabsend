package io.tabsend.app.logic

/**
 * Is this relay on a home-network address (PLANS.md P-15 item 4)?
 *
 * "Can't reach your relay at http://192.168.1.20:8786" was true, but read as a
 * refresh bug: the device was simply away from home, where that address means
 * nothing. When the address can only work on the network it lives on, the
 * relay-down line adds [HINT], which says why and what to do.
 *
 * Home network: IPv4 10/8, 172.16/12, 192.168/16, link-local 169.254/16; IPv6
 * unique-local fc00::/7 and link-local fe80::/10; names under .local, .lan,
 * .home.arpa and .internal.
 *
 * Never: localhost and loopback (the relay is on this same device, so being away
 * is not the reason); 100.64/10 and Tailscale's IPv6 fd7a:115c:a1e0::/48 (a
 * Tailscale address works from anywhere while Tailscale is on, so "only works on
 * your home network" would be false); a single-label name, which may be a
 * Tailscale MagicDNS name; every public address and name, the hosted relay
 * included.
 *
 * A port of `shared/src/homenetwork.ts`, mirrored by `HomeNetwork.swift` on iOS.
 * All three run `shared/vectors/home-network.json`. Pure: no `android.net.Uri`,
 * so the JVM tests cover it.
 */
object HomeNetwork {

    /** The line added after the relay-down notice when [isHomeNetworkRelay] is true. */
    const val HINT = "This address only works on your home network. Away from home or on " +
        "mobile data? Connect to your home Wi-Fi or turn on your VPN."

    private val HOME_SUFFIXES = listOf(".local", ".lan", ".home.arpa", ".internal")

    /** True when [relayUrl] points at an address that only works on its own local network. */
    fun isHomeNetworkRelay(relayUrl: String): Boolean {
        val host = hostOf(relayUrl.trim()) ?: return false
        ipv4Octets(host)?.let { return isHomeIpv4(it) }
        ipv6Head(host)?.let { return isHomeIpv6(it) }
        if (host.contains(':')) return false
        return HOME_SUFFIXES.any { host.endsWith(it) && host.length > it.length }
    }

    /** Host of an http(s) URL, lowercased, IPv6 without brackets. By hand, like the TS. */
    private fun hostOf(url: String): String? {
        val scheme = url.indexOf("://")
        if (scheme < 0) return null
        var authority = url.substring(scheme + 3).takeWhile { it != '/' && it != '?' && it != '#' }
        val at = authority.lastIndexOf('@')
        if (at >= 0) authority = authority.substring(at + 1)
        var host = if (authority.startsWith("[")) {
            val end = authority.indexOf(']')
            if (end < 0) return null
            authority.substring(1, end)
        } else {
            authority.substringBefore(':')
        }
        host = host.lowercase().removeSuffix(".")
        return host.ifEmpty { null }
    }

    private val IPV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")

    private fun ipv4Octets(host: String): List<Int>? {
        if (!IPV4.matches(host)) return null
        val octets = host.split('.').map { it.toInt() }
        return if (octets.all { it <= 255 }) octets else null
    }

    private fun isHomeIpv4(o: List<Int>): Boolean {
        val (a, b) = o
        return a == 10 ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) ||
            (a == 169 && b == 254)
    }

    private val IPV6_CHARS = Regex("^[0-9a-f:.]+$")
    private val HEXTET = Regex("^[0-9a-f]{1,4}$")

    /** The first three 16-bit groups of an IPv6 address, or null if it is not one. */
    private fun ipv6Head(host: String): List<Int>? {
        val bare = host.substringBefore('%')
        if (!bare.contains(':') || !IPV6_CHARS.matches(bare)) return null
        val halves = bare.split("::")
        if (halves.size > 2) return null
        val left = halves[0].split(':').filter { it.isNotEmpty() }
        // With "::", the group straight after the left half is always zero.
        val groups = if (halves.size == 2) left + listOf("0", "0", "0") else left
        val head = groups.take(3)
        if (head.size < 3 || !head.all { HEXTET.matches(it) }) return null
        return head.map { it.toInt(16) }
    }

    private fun isHomeIpv6(head: List<Int>): Boolean {
        val (g0, g1, g2) = head
        // Tailscale's own range, inside fc00::/7 but reachable from anywhere.
        if (g0 == 0xfd7a && g1 == 0x115c && g2 == 0xa1e0) return false
        if ((g0 and 0xfe00) == 0xfc00) return true // unique-local fc00::/7
        if ((g0 and 0xffc0) == 0xfe80) return true // link-local fe80::/10
        return false
    }
}
