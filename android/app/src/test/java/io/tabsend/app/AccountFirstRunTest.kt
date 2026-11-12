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
    private val phone = "PhoneNumber-0123456789_abcdefghijklmnopqrs"

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

    // --- the number that ties a link to this phone (AL1, AL3) -------------------

    @Test
    fun `a new number is 43 URL-safe characters and never the same twice`() {
        val first = AccountSetup.newNumber()
        assertEquals(43, first.length)
        assertTrue(first, AccountSetup.isPlausibleNumber(first))
        assertTrue(first, first.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        assertTrue(first != AccountSetup.newNumber())
    }

    @Test
    fun `only 22 to 128 letters, digits, dashes and underscores can be a number`() {
        assertTrue(AccountSetup.isPlausibleNumber("a".repeat(22)))
        assertTrue(AccountSetup.isPlausibleNumber("a-Z_9".repeat(25).take(128)))
        assertFalse(AccountSetup.isPlausibleNumber("a".repeat(21)))
        assertFalse(AccountSetup.isPlausibleNumber("a".repeat(129)))
        for (bad in listOf("", "a".repeat(30) + "=", "a".repeat(30) + " ", "a".repeat(30) + "&", "a".repeat(30) + "#", "a".repeat(30) + "é")) {
            assertFalse(bad, AccountSetup.isPlausibleNumber(bad))
        }
    }

    @Test
    fun `a number is live for a day, then gone, and not before it was made`() {
        val at = 1_000_000_000L
        assertEquals(phone, AccountSetup.liveNumber(phone, at, at))
        assertEquals(phone, AccountSetup.liveNumber(phone, at, at + AccountSetup.PENDING_WINDOW_MS))
        assertNull(AccountSetup.liveNumber(phone, at, at + AccountSetup.PENDING_WINDOW_MS + 1))
        // A clock set back is not live either.
        assertNull(AccountSetup.liveNumber(phone, at, at - 1))
        assertNull(AccountSetup.liveNumber(null, at, at))
        assertNull(AccountSetup.liveNumber(phone, null, at))
        assertNull(AccountSetup.liveNumber("short", at, at))
    }

    @Test
    fun `the store makes one number, reuses it, and moves its day on each time a sheet asks`() {
        val store = Store.over(MemoryPrefs())
        val start = 1_000_000_000L
        assertNull(store.livePhoneNumber(start))
        val first = store.phoneNumber(start)
        assertTrue(first, AccountSetup.isPlausibleNumber(first))
        assertEquals(first, store.livePhoneNumber(start))
        // Asking again later hands out the same number.
        val dayLater = start + AccountSetup.PENDING_WINDOW_MS - 1
        assertEquals(first, store.phoneNumber(dayLater))
        // ...and its day starts again from there: still live past the first day.
        assertEquals(first, store.livePhoneNumber(start + AccountSetup.PENDING_WINDOW_MS + 60_000))
        // Left alone for more than a day it is gone, and the next sheet makes a new one.
        val afterLonely = dayLater + AccountSetup.PENDING_WINDOW_MS + 1
        assertNull(store.livePhoneNumber(afterLonely))
        val second = store.phoneNumber(afterLonely)
        assertTrue(first != second)
        assertEquals(second, store.livePhoneNumber(afterLonely))
    }

    @Test
    fun `reading the number never makes one, and a clock set back reads as none`() {
        val store = Store.over(MemoryPrefs())
        val start = 1_000_000_000L
        assertNull(store.livePhoneNumber(start))
        assertNull(store.livePhoneNumber(start))
        val number = store.phoneNumber(start)
        assertEquals(number, store.livePhoneNumber(start + 1))
        assertNull(store.livePhoneNumber(start - 1))
    }

    @Test
    fun `finishing the pairing and unpairing both forget the number`() {
        val store = Store.over(MemoryPrefs())
        store.phoneNumber(1_000L)
        store.forgetPhoneNumber()
        assertNull(store.livePhoneNumber(1_000L))
        store.phoneNumber(1_000L)
        store.clear()
        assertNull(store.livePhoneNumber(1_000L))
    }

    @Test
    fun `a stored number that was damaged is no number`() {
        val prefs = MemoryPrefs()
        prefs.values["account.phoneNumber"] = "not a number!"
        prefs.values["account.phoneNumberAt"] = 1_000L
        assertNull(Store.over(prefs).livePhoneNumber(1_000L))
    }

    @Test
    fun `every sheet carries the number in its fragment, and the delete page keeps its own marker first`() {
        assertEquals(
            "https://account.tabsend.org/start?from=app#n=$phone",
            AccountSetup.url(AccountSetup.Page.START, number = phone),
        )
        assertEquals(
            "https://account.tabsend.org/account?from=app#n=$phone",
            AccountSetup.url(AccountSetup.Page.ACCOUNT, number = phone),
        )
        assertEquals(
            "https://account.tabsend.org/share?from=app#n=$phone",
            AccountSetup.url(AccountSetup.Page.SHARE, number = phone),
        )
        assertEquals(
            "https://account.tabsend.org/account?from=app#danger&n=$phone",
            AccountSetup.url(AccountSetup.Page.DELETE, number = phone),
        )
        assertEquals(
            "http://10.0.2.2:8790/start?from=app#n=$phone",
            AccountSetup.url(AccountSetup.Page.START, "http://10.0.2.2:8790/", phone),
        )
    }

    @Test
    fun `a number that cannot be one is left out of the address`() {
        for (bad in listOf("", "short", "has space ${"a".repeat(30)}")) {
            assertEquals("https://account.tabsend.org/start?from=app", AccountSetup.url(AccountSetup.Page.START, number = bad))
        }
    }

    @Test
    fun `Google's token goes in ahead of the number, which stays in the fragment`() {
        val url = AccountSetup.url(AccountSetup.Page.START, number = phone)
        assertEquals(
            "https://account.tabsend.org/start?from=app&gpt=TOKEN#n=$phone",
            io.tabsend.app.logic.LinkOut.withToken(url, "TOKEN"),
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
    fun `a sign-in link opens the sheet on the sign-in page with the same token and this phone's number`() {
        val link = AccountLink.SignIn(token)
        assertEquals("https://account.tabsend.org/signin?from=app#t=$token&n=$phone", AccountLink.signInPage(link, phone))
        assertEquals(
            "http://10.0.2.2:8790/signin?from=app#t=$token&n=$phone",
            AccountLink.signInPage(link, phone, "http://10.0.2.2:8790/"),
        )
    }

    @Test
    fun `a sign-in page is not made from a number that cannot be one`() {
        val link = AccountLink.SignIn(token)
        for (bad in listOf("", "short", "has space ${"a".repeat(30)}", "a".repeat(129), "${"a".repeat(30)}&t=x", "${"a".repeat(30)}#x")) {
            assertNull(bad, AccountLink.signInPage(link, bad))
        }
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
            val back = AccountSiteClient({ server.url }).redeem(token, phone)
            assertTrue(back.created)
            assertEquals(setup, back.setupLink)
            assertEquals(java.time.Instant.parse("2026-11-18T14:00:00.000Z").toEpochMilli(), back.trialEndsAt)
            val head = requireNotNull(server.request)
            assertTrue(head, head.startsWith("POST /api/app/redeem "))
            assertTrue(head, head.contains("application/json"))
            assertEquals("""{"token":"$token","nonce":"$phone"}""", server.body)
        }
    }

    @Test
    fun `a returning account has no trial date, and a group with a device has no setup link`() {
        OneShot(200, """{"created":false,"setupLink":null,"trialEndsAt":null}""").use { server ->
            val back = AccountSiteClient({ server.url }).redeem(token, phone)
            assertFalse(back.created)
            assertNull(back.setupLink)
            assertNull(back.trialEndsAt)
        }
    }

    @Test
    fun `an old or used link is 410 and says so`() {
        OneShot(410, """{"error":"gone"}""").use { server ->
            assertKind(AccountSiteException.Kind.LINK_EXPIRED) { AccountSiteClient({ server.url }).redeem(token, phone) }
        }
    }

    @Test
    fun `a link asked for by another phone is 403 and says so`() {
        OneShot(403, """{"error":"link_other_phone"}""").use { server ->
            assertKind(AccountSiteException.Kind.OTHER_PHONE) { AccountSiteClient({ server.url }).redeem(token, phone) }
        }
    }

    @Test
    fun `the hand-back carries the masked email, and one that is not an address is dropped`() {
        val answer = """{"created":true,"setupLink":"$setup","trialEndsAt":null,"email":"m•••@example.org"}"""
        OneShot(200, answer).use { server ->
            assertEquals("m•••@example.org", AccountSiteClient({ server.url }).redeem(token, phone).maskedEmail)
        }
        OneShot(200, """{"created":true,"setupLink":"$setup","email":"   "}""").use { server ->
            assertNull(AccountSiteClient({ server.url }).redeem(token, phone).maskedEmail)
        }
        OneShot(200, """{"created":true,"setupLink":"$setup","email":"${"x".repeat(121)}"}""").use { server ->
            assertNull(AccountSiteClient({ server.url }).redeem(token, phone).maskedEmail)
        }
        OneShot(200, """{"created":true,"setupLink":"$setup"}""").use { server ->
            assertNull(AccountSiteClient({ server.url }).redeem(token, phone).maskedEmail)
        }
    }

    @Test
    fun `a number that cannot be one is never sent`() {
        OneShot(200).use { server ->
            for (bad in listOf("", "short", "has space ${"a".repeat(30)}")) {
                assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token, bad) }
            }
            assertNull(server.request)
        }
    }

    @Test
    fun `any other answer, and an answer that cannot be read, is unexpected`() {
        OneShot(500, "boom").use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token, phone) }
        }
        OneShot(200, "not json").use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token, phone) }
        }
        OneShot(200, """{"created":true,"setupLink":"not a setup link"}""").use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem(token, phone) }
        }
    }

    @Test
    fun `an unreachable site is unreachable`() {
        val closed = OneShot(200).let { it.close(); it.url }
        assertKind(AccountSiteException.Kind.UNREACHABLE) { AccountSiteClient({ closed }).redeem(token, phone) }
    }

    @Test
    fun `a token that cannot be one is never sent`() {
        OneShot(200).use { server ->
            assertKind(AccountSiteException.Kind.UNEXPECTED) { AccountSiteClient({ server.url }).redeem("bad token!", phone) }
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
    fun `the masked email goes on to Name this phone`() {
        val outcome = RedeemOutcome.of { AccountHandBack(created = false, setupLink = setup, trialEndsAt = null, maskedEmail = "m•••@example.org") }
        assertEquals(
            RedeemOutcome.Arrived(AccountArrival(setup, created = false, trialEndsAt = null, maskedEmail = "m•••@example.org")),
            outcome,
        )
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
        assertEquals(RedeemOutcome.Failed(RedeemOutcome.Reason.OTHER_PHONE), failure(AccountSiteException.Kind.OTHER_PHONE))
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
