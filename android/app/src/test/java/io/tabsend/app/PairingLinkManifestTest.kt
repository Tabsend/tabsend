package io.tabsend.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The links the app claims in the manifest, read as written the way [PushWiringTest] reads it.
 * Without a host Android ignores the path, so the app offers to open every https link on
 * the phone, and Google Play reports the link as `https:///pair`, not working.
 */
class PairingLinkManifestTest {

    private val manifest: String =
        listOf(
            File("src/main/AndroidManifest.xml"),
            File("app/src/main/AndroidManifest.xml"),
            File("android/app/src/main/AndroidManifest.xml"),
        ).first { it.exists() }.readText()

    private val httpsRules = Regex("""<data\b[^>]*android:scheme="https"[^>]*>""").findAll(manifest).map { it.value }.toList()

    @Test
    fun `every https link the app claims names a host, and only these two hosts`() {
        // A rule with no host is ignored by Android and the app offers to open every https link.
        assertEquals(3, httpsRules.size)
        for (rule in httpsRules) assertTrue(rule, rule.contains("android:host=\""))
        val relay = httpsRules.filter { it.contains("""android:host="app.tabsend.org"""") }
        val account = httpsRules.filter { it.contains("""android:host="account.tabsend.org"""") }
        assertEquals(1, relay.size)
        assertTrue(relay[0], relay[0].contains("""android:pathPrefix="/pair""""))
        // The account site's two emailed links, as exact paths (PLANS.md P-19), nothing else.
        assertEquals(2, account.size)
        assertEquals(setOf("/app-start", "/app-signin"), account.map { Regex("""android:path="([^"]*)"""").find(it)!!.groupValues[1] }.toSet())
    }

    @Test
    fun `Android is asked to check each link against its site`() {
        for (host in listOf("app.tabsend.org", "account.tabsend.org")) {
            val filter = Regex("""<intent-filter\b[^>]*>(?:(?!</intent-filter>).)*android:host="$host"""", RegexOption.DOT_MATCHES_ALL)
                .find(manifest)!!.value
            assertTrue(host, filter.substringBefore(">").contains("""android:autoVerify="true""""))
        }
    }
}
