package io.tabsend.app.receive

import java.net.URI

/** Security boundary for links received from another group device. */
object LinkPolicy {
    fun isOpenableWebUrl(value: String?): Boolean {
        if (value.isNullOrBlank()) return false
        return try {
            val uri = URI(value)
            (uri.scheme?.equals("http", ignoreCase = true) == true ||
                uri.scheme?.equals("https", ignoreCase = true) == true) &&
                !uri.host.isNullOrBlank()
        } catch (_: Exception) {
            false
        }
    }
}
