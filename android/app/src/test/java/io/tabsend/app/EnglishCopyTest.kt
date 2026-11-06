package io.tabsend.app

import io.tabsend.app.logic.JoinErrors
import io.tabsend.app.logic.Protocol
import io.tabsend.app.logic.RelayErrorText
import io.tabsend.app.logic.RelayErrorText.Action
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.net.UnknownServiceException
import javax.net.ssl.SSLHandshakeException

/**
 * The English a person reads, word for word, for the sentences that were typed into Kotlin before they
 * moved to `strings.xml` (2026-11-05). The expected text below was copied from the old code, so a
 * reworded or mistyped sentence fails here. The dash in four of them is the old text (see
 * `KNOWN_DASH` in android/tools/check-l10n.mjs). Sentences with their own test file (SendFeedbackTest,
 * GoneTargetCopyTest, GroupResetsTest) are not repeated.
 */
class EnglishCopyTest {

    @Test
    fun `the protocol notices`() {
        assertEquals(
            "Linked. A newer Tabsend build is available (this app speaks v3, the relay prefers v4) — " +
                "everything works, but it's worth updating.",
            Protocol.message(EN, Protocol.Check.Outdated(3, 4)),
        )
        assertEquals(
            "This version of the Tabsend app is too old for that relay (app speaks v3, relay needs v4). " +
                "Install the latest build, then pair again.",
            Protocol.message(EN, Protocol.Check.ClientTooOld(3, 4)),
        )
        assertEquals(
            "That relay is running an older version of Tabsend than this app (relay speaks v2, app needs v3). " +
                "Update the relay, then pair again.",
            Protocol.message(EN, Protocol.Check.RelayTooOld(2, 3)),
        )
        assertEquals(null, Protocol.message(EN, Protocol.Check.Ok))
    }

    @Test
    fun `the pairing failures`() {
        val relay = "https://192.168.1.30:8787"
        assertEquals(
            "The relay answered, but its security certificate doesn't match the one in this setup link. " +
                "If the relay was rebuilt or reinstalled it will have a new certificate — create a fresh " +
                "setup link and scan it again.",
            JoinErrors.message(EN, SSLHandshakeException("x"), relay, hadPin = true),
        )
        assertEquals(
            "The relay answered, but this phone doesn't trust its security certificate. The setup link did " +
                "not include the certificate fingerprint this phone needs. Create a fresh link from the " +
                "relay or an updated Tabsend device.",
            JoinErrors.message(EN, SSLHandshakeException("x"), relay, hadPin = false),
        )
        assertEquals(
            "Android won't send plain http anywhere but localhost, so this address is blocked. The relay " +
                "needs an https address — one with its own self-signed certificate is fine, as long as its " +
                "setup link carries the fingerprint.",
            JoinErrors.message(EN, UnknownServiceException("x"), "http://192.168.1.30:8787", hadPin = false),
        )
        assertEquals(
            "http://localhost:8787 means this phone itself, so there's nothing there to reach. That address " +
                "came from a relay that describes itself as localhost, which is a development-only setting. " +
                "Give the relay a PUBLIC_RELAY_URL that other devices can reach, then create a new setup link.",
            JoinErrors.message(EN, IOException("x"), "http://localhost:8787", hadPin = false),
        )
        assertEquals(
            "Couldn't reach the relay at $relay. Check that it's running and that this phone is on the same " +
                "network, then tap Try again.",
            JoinErrors.message(EN, SocketTimeoutException("x"), relay, hadPin = false),
        )
        assertEquals(
            "Couldn't reach the relay at $relay. Check that it's running and that this phone is on the same " +
                "network, then tap Add a device again.",
            JoinErrors.message(
                EN,
                SocketTimeoutException("x"),
                relay,
                hadPin = false,
                retryAction = JoinErrors.RetryAction.ADD_DEVICE,
            ),
        )
    }

    /** The iPhone's own words for each relay answer, in the same places. */
    @Test
    fun `the relay's answers, by what the person was doing`() {
        fun line(code: String, action: Action) = RelayErrorText.line(EN, code, action)

        val unauthorized = "Your relay no longer accepts this phone. Set Tabsend up again here."
        assertEquals(unauthorized, line("unauthorized", Action.REMOVE_DEVICE))
        assertEquals(unauthorized, line("endpoint_removed", Action.STOP_RESET))
        assertEquals(
            "Your relay wouldn't allow that. If your group is suspended, whoever runs the relay can lift the suspension.",
            line("forbidden", Action.PAIRING_LINK),
        )
        for (action in listOf(Action.RENAME_DEVICE, Action.REMOVE_DEVICE)) {
            assertEquals("Your relay couldn't find that device. It may already be gone.", line("not_found", action))
        }
        for (action in listOf(Action.PAIRING_LINK, Action.STOP_RESET)) {
            assertEquals(
                "Your relay no longer has this group. Pair this phone again if you still have access.",
                line("not_found", action),
            )
        }
        for (action in listOf(Action.JOIN, Action.CHECK)) {
            assertEquals(
                "That address didn't answer like a Tabsend relay. Check it and try again.",
                line("not_found", action),
            )
        }
        assertEquals(
            "Your relay didn't understand that. It's most likely running an older version than this phone. " +
                "Updating it should fix this.",
            line("invalid_request", Action.CHECK),
        )
        assertEquals("That setup link is unknown, expired, or already used.", line("invalid_pairing_code", Action.JOIN))
        assertEquals("That pairing code is no longer valid.", line("invalid_pairing_code", Action.PAIRING_LINK))
        assertEquals("Your relay already hosts a group of devices.", line("group_exists", Action.JOIN))
        assertEquals(
            "Your relay has reached its device limit for your group. Remove a device you are not using, then pair this one again.",
            line("limit_reached", Action.JOIN),
        )
        assertEquals(
            "This group already has the most unused pairing links it allows. Try again in a few minutes, " +
                "when the oldest one expires.",
            line("limit_reached", Action.PAIRING_LINK),
        )
        assertEquals("Your relay has reached a limit for your group.", line("limit_reached", Action.REMOVE_DEVICE))
        assertEquals(
            "Your relay is busy right now. Give it a moment and try again.",
            line("rate_limited", Action.STOP_RESET),
        )
        val internal = "Something went wrong inside your relay. It may be worth checking that it is healthy."
        assertEquals(internal, line("internal", Action.JOIN))
        // A code this app has never heard of reads as an internal error.
        assertEquals(internal, line("some_future_code", Action.RENAME_DEVICE))
    }

    @Test
    fun `the screens' own sentences`() {
        fun s(id: Int, vararg args: Any) = EN.string(id, *args)
        assertEquals("That QR code isn't a Tabsend setup link.", s(R.string.join_status_not_setup_link))
        assertEquals("Setup link ready. Tap Pair this phone.", s(R.string.join_status_link_ready))
        assertEquals("Found the setup link you copied. Tap Pair this phone.", s(R.string.join_status_link_found))
        assertEquals("Paste or scan a complete setup link.", s(R.string.join_status_link_incomplete))
        assertEquals("Linking…", s(R.string.join_status_linking))
        assertEquals("Linked", s(R.string.join_linked))
        assertEquals("Paste or scan a setup link created by that relay.", s(R.string.join_next_after_move))
        assertEquals("Paste or scan a new setup link to pair again.", s(R.string.join_next_after_unpair))
        assertEquals("Point the camera at the pairing QR code", s(R.string.scan_prompt))
        assertEquals("Tabsend 0.11.0 (local dev build)", s(R.string.build_info, "0.11.0 (local dev build)"))
        assertEquals("Phone", s(R.string.device_name_fallback))
        assertEquals("Rename this device", s(R.string.rename_device))
        assertEquals("Save", s(R.string.rename_save))
        assertEquals("Couldn't reach the relay to rename.", s(R.string.rename_unreachable))
        assertEquals("Unpair this phone?", s(R.string.unpair_title))
        assertEquals("This phone stops receiving links and leaves the group.", s(R.string.unpair_body))
        assertEquals("Unpair", s(R.string.unpair_confirm))
        assertEquals("Copied", s(R.string.copied))
        assertEquals("to Pixel 8", s(R.string.held_tab_to_device, "Pixel 8"))
        assertEquals("Untitled tab", s(R.string.held_tab_untitled))
        assertEquals("Send to Pixel 8", s(R.string.share_shortcut_long_label, "Pixel 8"))
        assertEquals(
            "That device isn't in your group any more — pick another.",
            s(R.string.share_pick_gone),
        )
        assertEquals(
            "This phone was removed from the group. Pair it again before adding another device.",
            s(R.string.pair_link_phone_removed),
        )
        assertEquals(
            "This phone's relay access is no longer valid. Pair it again before adding another device.",
            s(R.string.pair_link_access_invalid),
        )
        assertEquals("Send to…", s(R.string.gone_target_send_to))
        assertEquals("Your relay is answering again.", s(R.string.send_recovered_detail))
        assertEquals(
            "Pixel 8 never picked it up. Open History to send it again.",
            s(R.string.send_never_arrived_detail, "Pixel 8"),
        )
        assertEquals("Open History to send it again.", s(R.string.send_never_arrived_detail_unnamed))
    }

    @Test
    fun `the notification titles that depend on a count`() {
        fun p(id: Int, n: Int, vararg args: Any) = EN.plural(id, n, *args)
        assertEquals("Couldn't send a tab that was waiting", p(R.plurals.send_dropped_headline, 1, 1))
        assertEquals("Couldn't send 3 tabs that were waiting", p(R.plurals.send_dropped_headline, 3, 3))
        assertEquals("A tab never reached its device", p(R.plurals.send_never_arrived_headline, 1, 1))
        assertEquals("3 tabs never reached their devices", p(R.plurals.send_never_arrived_headline, 3, 3))
        assertEquals("1 tab from Pixel 8", p(R.plurals.batch_summary_title_from, 1, 1, "Pixel 8"))
        assertEquals("4 tabs from Pixel 8", p(R.plurals.batch_summary_title_from, 4, 4, "Pixel 8"))
        assertEquals("4 tabs received", p(R.plurals.batch_summary_title, 4, 4))
        assertEquals("2 of 5 tabs arrived so far", p(R.plurals.batch_summary_partial, 5, 2, 5))
        assertEquals("1 device was added", p(R.plurals.new_devices_alert_title, 1, 1))
        assertEquals("2 devices were added", p(R.plurals.new_devices_alert_title, 2, 2))
        assertEquals("1 device is in your group", p(R.plurals.in_group_several_title, 1, 1))
        assertEquals("2 devices are in your group", p(R.plurals.in_group_several_title, 2, 2))
        assertEquals(
            "Everything your devices sent and received, newest first. The last 50 are kept on this phone for reading offline.",
            p(R.plurals.history_retention, 50, 50),
        )
        assertEquals("3 tabs", p(R.plurals.history_batch_heading, 3, 3))
        assertEquals("2 of 3 tabs", p(R.plurals.history_batch_heading_partial, 3, 2, 3))
        assertEquals("1d ago", p(R.plurals.time_days_ago, 1, 1))
        assertEquals("11mo ago", p(R.plurals.time_months_ago, 11, 11))
        assertEquals("2y ago", p(R.plurals.time_years_ago, 2, 2))
    }
}
