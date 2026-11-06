package io.tabsend.app.logic

import java.net.URI

/**
 * The links the account site emails to the phone, and what the app does with them [PLANS.md P-19].
 *
 * Android hands the app a link only when the manifest names the account site's host and path and
 * the site's `/.well-known/assetlinks.json` vouches for the app (otherwise the link opens in the
 * browser, where the web sign-in and the copied setup link still work). Two paths, nothing else:
 *
 * - `/app-start#t=TOKEN`, emailed after "Set up an account". The app uses the token itself
 *   ([io.tabsend.app.net.AccountSiteClient]) and is handed the group's first setup link.
 * - `/app-signin#t=TOKEN`, emailed after a sign-in (Manage account, Delete account, "Sign in"
 *   on the sheet). The app opens its sheet on the sign-in page with the token, so the page signs
 *   in inside the sheet.
 *
 * A link for any other host, port or path is not an account link, and neither is one without a
 * token. The iPhone's twin is `AccountLink.swift`.
 */
sealed interface AccountLink {
    data class NewAccount(val token: String) : AccountLink
    data class SignIn(val token: String) : AccountLink

    companion object {
        /**
         * The account link in [url], or null. [site] is the account site's address (a debug
         * build may point it at a local one); scheme, host and port must all match it.
         */
        fun parse(url: String, site: String = AccountSetup.DEFAULT_SITE): AccountLink? {
            val want = uri(site) ?: return null
            val got = uri(url.trim()) ?: return null
            if (got.scheme?.lowercase() != want.scheme?.lowercase()) return null
            val wantHost = want.host?.lowercase() ?: return null
            if (got.host?.lowercase() != wantHost || got.port != want.port) return null
            if (got.rawUserInfo != null) return null

            val fragment = got.rawFragment ?: return null
            val token = fragment.split('&')
                .firstOrNull { it.startsWith("t=") }
                ?.removePrefix("t=")
                ?.takeIf { isPlausible(it) }
                ?: return null

            return when (got.rawPath?.trimEnd('/')) {
                "/app-start" -> NewAccount(token)
                "/app-signin" -> SignIn(token)
                else -> null
            }
        }

        /**
         * True when [url] is on the account site itself (same scheme, host and port), whatever its
         * path. Such an address is never a pairing link, even if its fragment looks like one: the
         * site's app links reach the app, and a made-up one must not name a relay of its own.
         */
        fun isOnSite(url: String, site: String = AccountSetup.DEFAULT_SITE): Boolean {
            val want = uri(site) ?: return false
            val got = uri(url.trim()) ?: return false
            val wantHost = want.host?.lowercase() ?: return false
            return got.scheme?.lowercase() == want.scheme?.lowercase() &&
                got.host?.lowercase() == wantHost &&
                got.port == want.port
        }

        /**
         * The sign-in page the sheet opens for a [SignIn] link: the same token, in the fragment
         * as the account site always carries it, so the page signs in inside the sheet.
         */
        fun signInPage(link: SignIn, site: String = AccountSetup.DEFAULT_SITE): String =
            "${site.trimEnd('/')}/signin?from=app#t=${link.token}"

        /**
         * The account site's tokens are long and made of letters, digits, `-` and `_`. Anything
         * else is not one, and is not sent anywhere.
         */
        fun isPlausible(token: String): Boolean =
            token.isNotEmpty() && token.length <= 200 && token.all {
                it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '-' || it == '_'
            }

        private fun uri(text: String): URI? = try {
            URI(text)
        } catch (_: Exception) {
            null
        }
    }
}
