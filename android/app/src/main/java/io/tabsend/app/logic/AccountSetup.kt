package io.tabsend.app.logic

/**
 * Where the Android app may offer an account, what this phone remembers about a sign-up it
 * began, and the account site's pages [PLANS.md P-19, P-25]. The iPhone's twin is
 * `AccountSetup.swift`; the words and the flow are the same.
 *
 * Nothing here is about buying anything. The app is free and sells nothing. Google's billing
 * library is in the Play build for one thing only, the link-out program ([LinkOut]); this
 * object only decides what the first screen and Settings show.
 */
object AccountSetup {

    /**
     * Whether the first screen carries "Set up an account", the sign-up sheet and the Account
     * group in Settings. One rule for all three, so a change is one change here.
     *
     * **Owner ruling, 2026-11-05** (PLANS.md P-19). Google Play allows a link from an app to a
     * web sign-up that leads to payment only for people in the US, through its "External content
     * links" program, and only once Google has approved the app. So the Play build shows the door
     * when Google itself says the link-out is available to this person ([linkOutAvailable], from
     * `PlayLinkOut`): that is Google's own answer on country and enrollment, which is why the
     * phone's network and SIM are no longer looked at. A debug build, which is the GitHub test
     * APK, shows it everywhere so the flow can be tried.
     */
    fun allowsAccountSetup(debugBuild: Boolean, linkOutAvailable: Boolean): Boolean =
        debugBuild || linkOutAvailable

    /**
     * How long after "Set up an account" a setup link that arrives is taken for the account's
     * own link. The email can wait in a mailbox, and the link itself is good for 15 minutes
     * once opened, so a day is generous and still ends by itself.
     */
    const val PENDING_WINDOW_MS: Long = 24L * 60 * 60 * 1000

    /** True while a sign-up the person began is still waiting for its setup link. */
    fun isPending(startedAt: Long?, now: Long): Boolean {
        if (startedAt == null) return false
        val age = now - startedAt
        return age in 0..PENDING_WINDOW_MS
    }

    // --- the number that ties an emailed link to this phone ---------------------

    /**
     * A link the account site emails is good on the phone that asked for it and on no other
     * (security review v0.11.0, AL1 and AL3). The phone makes a random number, sends it with
     * every sheet it opens (in the address's fragment, which no server sees), and the page passes
     * it on when it asks for a link. The site keeps only a hash of it with the link and wants the
     * same number back when the link is used, so a link forwarded to someone else fails there.
     *
     * One number, kept while the person may still be waiting for a link: it is good for
     * [PENDING_WINDOW_MS] from the last time a sheet asked for it. The iPhone's twin is
     * `AccountSetup.phoneNumber` in `AccountSetup.swift`.
     */
    const val NUMBER_BYTES: Int = 32

    /** A new number: [NUMBER_BYTES] random bytes, written as base64url without padding (43 characters). */
    fun newNumber(random: java.security.SecureRandom = java.security.SecureRandom()): String {
        val bytes = ByteArray(NUMBER_BYTES)
        random.nextBytes(bytes)
        return io.tabsend.app.crypto.Base64x.encodeUrlNoPad(bytes)
    }

    /** The account site accepts 22 to 128 characters of letters, digits, `-` and `_`. Anything else is not a number. */
    fun isPlausibleNumber(number: String): Boolean =
        number.length in 22..128 && number.all {
            it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '-' || it == '_'
        }

    /**
     * The number that is still good, or null: there is none, it cannot be one, or it is older than
     * [PENDING_WINDOW_MS]. A number from a clock set back is not good either, so a wrong clock cannot
     * keep one alive for ever.
     */
    fun liveNumber(number: String?, issuedAt: Long?, now: Long): String? {
        if (number == null || issuedAt == null || !isPlausibleNumber(number)) return null
        val age = now - issuedAt
        return number.takeIf { age in 0..PENDING_WINDOW_MS }
    }

    // --- the account site -------------------------------------------------------

    /** The account site's address. A debug build can point at another one ([AccountSite]). */
    const val DEFAULT_SITE: String = "https://account.tabsend.org"

    /**
     * The account site's pages the app opens in a sheet. `from=app` tells the page it was
     * opened from the app: it answers with the app's own look and words, leaves the website
     * out, and emails a link the app opens.
     */
    enum class Page(val path: String) {
        START("/start?from=app"),
        ACCOUNT("/account?from=app"),
        DELETE("/account?from=app#danger"),

        /** The page with this account's personal link and the $5 credit [P-22]. The app never learns the link. */
        SHARE("/share?from=app"),
    }

    /**
     * The address of [page], with this phone's [number] in the fragment (`#n=NUMBER`, or `&n=NUMBER`
     * after the delete page's own `#danger`). A number that cannot be one is left out.
     */
    fun url(page: Page, site: String = DEFAULT_SITE, number: String? = null): String {
        val address = site.trimEnd('/') + page.path
        if (number == null || !isPlausibleNumber(number)) return address
        return address + (if ('#' in page.path) "&n=" else "#n=") + number
    }
}

/**
 * The account site's address for this run. Always [AccountSetup.DEFAULT_SITE] in a release
 * build; a debug build can be pointed at a local one by a launch extra
 * (`MainActivity.EXTRA_DEBUG_ACCOUNT_SITE`), the way the iPhone's debug build takes a launch
 * setting, so the whole flow can be tried against a local account site.
 */
object AccountSite {
    @Volatile
    var override: String? = null

    /**
     * Only this machine may stand in for the account site (the emulator's alias for its host
     * included). The GitHub test APK is a debug build, and another app on the phone could
     * otherwise point it at its own server with a launch extra (security review v0.11.0, AL5).
     */
    fun isLocalSite(site: String): Boolean = try {
        java.net.URI(site.trim()).host?.lowercase() in setOf("localhost", "127.0.0.1", "10.0.2.2")
    } catch (_: Exception) {
        false
    }

    val base: String get() = override ?: AccountSetup.DEFAULT_SITE
}
