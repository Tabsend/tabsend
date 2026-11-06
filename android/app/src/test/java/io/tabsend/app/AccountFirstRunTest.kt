package io.tabsend.app

import java.util.Locale
import io.tabsend.app.logic.AccountArrival
import io.tabsend.app.logic.AccountLink
import io.tabsend.app.logic.AccountSetup
import io.tabsend.app.logic.GroupService
import io.tabsend.app.logic.RedeemOutcome
import io.tabsend.app.logic.ServicePlan
import io.tabsend.app.net.AccountHandBack
import io.tabsend.app.net.AccountSiteClient
import io.tabsend.app.net.AccountSiteException
import io.tabsend.app.store.Store
import io.tabsend.app.wire.GroupServiceState
import io.tabsend.app.wire.GroupStateResponse
import io.tabsend.app.wire.WireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.time.ZoneId
import kotlin.concurrent.thread

/** The first run and the account door (PLANS.md P-19): links, plan words, the call to the account site. */
class AccountFirstRunTest {

    private val token = "AbC-123_xyzAbC-123_xyzAbC-123_xyzAbC-123_xyz"
    private val setup = "https://app.tabsend.org/pair#c=ABCD2345"

    // --- the rule for the door -------------------------------------------------

    @Test
    fun `the Play build offers the account door only when Google says the link-out is available`() {
        assertTrue(AccountSetup.allowsAccountSetup(debugBuild = false, linkOutAvailable = true))
        // Not in the US, not enrolled, no Play Store, or no answer yet: no door.
        assertFalse(AccountSetup.allowsAccountSetup(debugBuild = false, linkOutAvailable = false))
    }

    @Test
    fun `a debug build, the GitHub test APK, offers it everywhere`() {
        assertTrue(AccountSetup.allowsAccountSetup(debugBuild = true, linkOutAvailable = false))
        assertTrue(AccountSetup.allowsAccountSetup(debugBuild = true, linkOutAvailable = true))
    }

    // --- a sign-up the person began --------------------------------------------

    @Test
    fun `a sign-up is pending for a day, then forgotten`() {
        val start = 1_000_000_000L
        assertFalse(AccountSetup.isPending(null, start))
        assertTrue(AccountSetup.isPending(start, start + 60_000))
        assertTrue(AccountSetup.isPending(start, start + AccountSetup.PENDING_WINDOW_MS))
        assertFalse(AccountSetup.isPending(start, start + AccountSetup.PENDING_WINDOW_MS + 1))
    }

    @Test
    fun `a clock set back does not keep a sign-up pending for ever`() {
        val start = 1_000_000_000L
        assertFalse(AccountSetup.isPending(start, start - 1))
    }

    @Test
    fun `the sign-up marker lives in the store and goes with the pairing`() {
        val store = Store.over(MemoryPrefs())
        assertNull(store.accountStartedAt)
        store.accountStartedAt = 42L
        assertEquals(42L, store.accountStartedAt)
        store.clear()
        assertNull(store.accountStartedAt)
    }

    // --- the account site's pages ---------------------------------------------

    @Test
    fun `the sheets open the account site pages with from=app`() {
        assertEquals("https://account.tabsend.org/start?from=app", AccountSetup.url(AccountSetup.Page.START))
        assertEquals("https://account.tabsend.org/account?from=app", AccountSetup.url(AccountSetup.Page.ACCOUNT))
        assertEquals("https://account.tabsend.org/account?from=app#danger", AccountSetup.url(AccountSetup.Page.DELETE))
    }

    @Test
    fun `a debug address with a trailing slash still makes a good URL`() {
        assertEquals(
            "http://10.0.2.2:8790/start?from=app",
            AccountSetup.url(AccountSetup.Page.START, "http://10.0.2.2:8790/"),
        )
    }

    // --- the links the account site emails -----------------------------------

    @Test
    fun `an app-start link is a new account`() {
        assertEquals(
            AccountLink.NewAccount(token),
            AccountLink.parse("https://account.tabsend.org/app-start#t=$token"),
        )
    }

    @Test
    fun `an app-signin link is a sign-in, and a trailing slash does not matter`() {
        assertEquals(
            AccountLink.SignIn(token),
            AccountLink.parse("https://account.tabsend.org/app-signin/#t=$token"),
        )
    }

    @Test
    fun `no other host, port, scheme or path is an account link`() {
        val wrong = listOf(
            "https://evil.example/app-start#t=$token",
            "https://account.tabsend.org.evil.example/app-start#t=$token",
            "https://account.tabsend.org:8443/app-start#t=$token",
            "http://account.tabsend.org/app-start#t=$token",
            "https://account.tabsend.org/signin#t=$token",
            "https://account.tabsend.org/app-start/x#t=$token",
            "https://user@account.tabsend.org/app-start#t=$token",
            "tabsend://app-start#t=$token",
            "https://app.tabsend.org/pair#c=ABCD2345",
        )
        for (link in wrong) assertNull(link, AccountLink.parse(link))
    }

    @Test
    fun `an address on the account site is never a pairing link, whatever its path`() {
        val site = AccountSetup.DEFAULT_SITE
        val onSite = listOf(
            "https://account.tabsend.org/app-start#c=ABCD2345&native=https%3A%2F%2Fevil.example",
            "https://ACCOUNT.tabsend.org/anything",
            "https://account.tabsend.org/",
        )
        for (link in onSite) assertTrue(link, AccountLink.isOnSite(link, site))
        val elsewhere = listOf(
            "https://app.tabsend.org/pair#c=ABCD2345",
            "https://account.tabsend.org.evil.example/app-start",
            "http://account.tabsend.org/app-start",
            "https://account.tabsend.org:8443/app-start",
        )
        for (link in elsewhere) assertFalse(link, AccountLink.isOnSite(link, site))
        // The shape from the review has no token, so it is not an account link either.
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start#c=ABCD2345&native=https%3A%2F%2Fevil.example"))
    }

    @Test
    fun `only this machine can stand in for the account site in a debug build`() {
        for (site in listOf("http://10.0.2.2:8790", "http://localhost:8790", "http://127.0.0.1:8790")) {
            assertTrue(site, io.tabsend.app.logic.AccountSite.isLocalSite(site))
        }
        for (site in listOf("https://evil.example", "http://192.168.1.20:8790", "https://localhost.evil.example", "not a url", "")) {
            assertFalse(site, io.tabsend.app.logic.AccountSite.isLocalSite(site))
        }
    }

    @Test
    fun `a date too far away to count reads as no date, not a crash`() {
        assertNull(io.tabsend.app.logic.parseIsoMillis("+300000000-01-01T00:00:00Z"))
        assertNull(io.tabsend.app.logic.parseIsoMillis("garbled"))
        assertEquals(1_000L, io.tabsend.app.logic.parseIsoMillis("1970-01-01T00:00:01Z"))
    }

    @Test
    fun `a link without a usable token is not an account link`() {
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start"))
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start#t="))
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start#x=$token"))
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start#t=bad token!"))
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start#t=${"a".repeat(201)}"))
        assertNull(AccountLink.parse("not a link at all"))
        assertNull(AccountLink.parse(""))
    }

    @Test
    fun `a debug build can point the links at a local account site`() {
        val site = "http://10.0.2.2:8790"
        assertEquals(AccountLink.NewAccount(token), AccountLink.parse("http://10.0.2.2:8790/app-start#t=$token", site))
        assertNull(AccountLink.parse("https://account.tabsend.org/app-start#t=$token", site))
    }

    @Test
    fun `a sign-in link opens the sheet on the sign-in page with the same token`() {
        val link = AccountLink.SignIn(token)
        assertEquals("https://account.tabsend.org/signin?from=app#t=$token", AccountLink.signInPage(link))
        assertEquals("http://10.0.2.2:8790/signin?from=app#t=$token", AccountLink.signInPage(link, "http://10.0.2.2:8790/"))
    }

    // --- the plan words -------------------------------------------------------

    @Test
    fun `the three words become three plans, and an unknown one becomes nothing`() {
        val ends = "2026-11-18T14:00:00.000Z"
        assertEquals(
            ServicePlan.Trial(java.time.Instant.parse(ends).toEpochMilli()),
            GroupService.plan(GroupServiceState("trial", ends)),
        )
        assertEquals(ServicePlan.Trial(null), GroupService.plan(GroupServiceState("trial", "garbled")))
        assertEquals(ServicePlan.TrialEnded, GroupService.plan(GroupServiceState("trial_ended", ends)))
        assertEquals(ServicePlan.Account, GroupService.plan(GroupServiceState("account")))
        assertNull(GroupService.plan(GroupServiceState("something_new")))
        assertNull(GroupService.plan(null))
    }

    @Test
    fun `the end date is a short day in the phone's own time zone`() {
        val millis = java.time.Instant.parse("2026-11-18T03:00:00Z").toEpochMilli()
        assertEquals("Nov 18", GroupService.shortDay(millis, ZoneId.of("UTC"), Locale.US, IcuDatePatterns))
        assertEquals("18. Nov.", GroupService.shortDay(millis, ZoneId.of("UTC"), Locale.GERMANY, IcuDatePatterns))
        assertEquals("Nov 17", GroupService.shortDay(millis, ZoneId.of("America/Chicago"), Locale.US, IcuDatePatterns))
    }

    @Test
    fun `the relay's service field parses, and a missing one is none`() {
        val with = WireJson.decodeFromString(
            GroupStateResponse.serializer(),
            """{"reset":null,"service":{"state":"trial","trialEndsAt":"2026-11-18T14:00:00.000Z"}}""",
        )
        assertEquals(GroupServiceState("trial", "2026-11-18T14:00:00.000Z"), with.service)
        assertNull(WireJson.decodeFromString(GroupStateResponse.serializer(), """{"reset":null}""").service)
        assertNull(WireJson.decodeFromString(GroupStateResponse.serializer(), """{"service":null}""").service)
        assertEquals(
            GroupServiceState("account"),
            WireJson.decodeFromString(GroupStateResponse.serializer(), """{"service":{"state":"account","trialEndsAt":null}}""").service,
        )
    }

    @Test
    fun `the phone keeps the last plan words, and an unpair forgets them`() {
        val store = Store.over(MemoryPrefs())
        assertNull(store.groupService)
        store.groupService = GroupServiceState("trial", "2026-11-18T14:00:00.000Z")
        assertEquals(GroupServiceState("trial", "2026-11-18T14:00:00.000Z"), store.groupService)
        // A good answer with no words (a self-hosted relay) clears them.
        store.groupService = null
        assertNull(store.groupService)
        store.groupService = GroupServiceState("account")
        store.clear()
        assertNull(store.groupService)
    }

    @Test
    fun `plan words that cannot be read are no plan words`() {
        val prefs = MemoryPrefs()
        prefs.values["group.service"] = "{not json"
        assertNull(Store.over(prefs).groupService)
    }

    // --- the one call to the account site -------------------------------------

    @Test
    fun `redeem posts the token and reads the hand-back of a new account`() {
        val answer = """{"created":true,"setupLink":"$setup","trialEndsAt":"2026-11-18T14:00:00.000Z"}"""
        OneShot(200, answer).use { server ->
            val back = AccountSiteClient({ server.url }).redeem(token)
            assertTrue(back.created)
            assertEquals(setup, back.setupLink)
            assertEquals(java.time.Instant.parse("2026-11-18T14:00:00.000Z").toEpochMilli(), back.trialEndsAt)
            val head = requireNotNull(server.request)
            assertTrue(head, head.startsWith("POST /api/app/redeem "))
            assertTrue(head, head.contains("application/json"))
            assertEquals("""{"token":"$token"}""", server.body)
        }
    }

    @Test
    fun `a returning account has no trial date, and a group with a device has no setup link`() {
        OneShot(200, """{"created":false,"setupLink":null,"trialEndsAt":null}""").use { server ->
            val back = AccountSiteClient({ server.url }).redeem(token)
            assertFalse(back.created)
            assertNull(back.setupLink)
            assertNull(back.trialEndsAt)
        }
    }

    @Test
    fun `an old or used link is 410 and says so`() {
        OneShot(410, """{"error":"gone"}""").use { server ->
            assertKind(AccountSiteException.Kind.LINK_EXPIRED) { AccountSiteClient({ server.url }).redeem(token) }
        }
    }

    @Test
    fun `any other answer, and an answer that cannot be read, is unexpected`() {
        OneShot(500, "boom").use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token) }
        }
        OneShot(200, "not json").use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token) }
        }
        OneShot(200, """{"created":true,"setupLink":"not a setup link"}""").use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token) }
        }
    }

    @Test
    fun `an unreachable site is unreachable`() {
        val closed = OneShot(200).let { it.close(); it.url }
        assertKind(AccountSiteException.Kind.UNREACHABLE) { AccountSiteClient({ closed }).redeem(token) }
    }

    @Test
    fun `a token that cannot be one is never sent`() {
        OneShot(200).use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem("bad token!") }
            assertNull(server.request)
        }
    }

    // --- what the app does with the answer --------------------------------------

    @Test
    fun `a new account goes on to Name this phone with the trial date`() {
        val outcome = RedeemOutcome.of { AccountHandBack(created = true, setupLink = setup, trialEndsAt = 5L) }
        assertEquals(RedeemOutcome.Arrived(AccountArrival(setup, created = true, trialEndsAt = 5L)), outcome)
    }

    @Test
    fun `a returning account is never told a trial started`() {
        // Even if the site sent a date, it is not an account this sign-up made.
        val outcome = RedeemOutcome.of { AccountHandBack(created = false, setupLink = setup, trialEndsAt = 5L) }
        assertEquals(RedeemOutcome.Arrived(AccountArrival(setup, created = false, trialEndsAt = null)), outcome)
    }

    @Test
    fun `a group that already has a device has no first setup link, and the person is told`() {
        val outcome = RedeemOutcome.of { AccountHandBack(created = false, setupLink = null, trialEndsAt = null) }
        assertEquals(RedeemOutcome.Failed(RedeemOutcome.Reason.HAS_DEVICE), outcome)
    }

    @Test
    fun `each way the account site can fail has its own line`() {
        fun failure(kind: AccountSiteException.Kind) =
            RedeemOutcome.of { throw AccountSiteException(kind) }
        assertEquals(RedeemOutcome.Failed(RedeemOutcome.Reason.EXPIRED), failure(AccountSiteException.Kind.LINK_EXPIRED))
        assertEquals(RedeemOutcome.Failed(RedeemOutcome.Reason.UNREACHABLE), failure(AccountSiteException.Kind.UNREACHABLE))
        assertEquals(RedeemOutcome.Failed(RedeemOutcome.Reason.UNEXPECTED), failure(AccountSiteException.Kind.UNEXPECTED))
    }

    private fun assertKind(kind: AccountSiteException.Kind, call: () -> Unit) {
        try {
            call()
            fail("expected $kind")
        } catch (e: AccountSiteException) {
            assertEquals(kind, e.kind)
        }
    }

    /** One canned HTTP answer on a loopback port. Records the request line and headers, and the body. */
    private class OneShot(private val status: Int, private val answer: String = "{}") : AutoCloseable {
        private val socket = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val url = "http://127.0.0.1:${socket.localPort}"

        @Volatile
        var request: String? = null

        @Volatile
        var body: String? = null

        init {
            thread(isDaemon = true) {
                try {
                    socket.accept().use { conn ->
                        val input = conn.getInputStream().bufferedReader()
                        val head = StringBuilder()
                        var length = 0
                        while (true) {
                            val line = input.readLine() ?: break
                            if (line.isEmpty()) break
                            head.append(line).append('\n')
                            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                                length = line.substringAfter(':').trim().toInt()
                            }
                        }
                        val chars = CharArray(length)
                        var read = 0
                        while (read < length) {
                            val n = input.read(chars, read, length - read)
                            if (n < 0) break
                            read += n
                        }
                        request = head.toString()
                        body = String(chars, 0, read)
                        val bytes = answer.toByteArray()
                        conn.getOutputStream().apply {
                            write(
                                ("HTTP/1.1 $status Status\r\nContent-Type: application/json\r\n" +
                                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(),
                            )
                            write(bytes)
                            flush()
                        }
                    }
                } catch (_: Exception) {
                    // Closed by the test.
                }
            }
        }

        override fun close() = socket.close()
    }
}
