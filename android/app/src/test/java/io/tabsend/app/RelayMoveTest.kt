package io.tabsend.app

import io.tabsend.app.logic.RelayMove
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The two invariants that matter more than any individual verdict: a relayId
 * mismatch is decided WITHOUT the token probe running at all (so a relay
 * already proven not to be ours never sees the device token), and a check
 * that's inconclusive on relayId alone falls through to the token probe
 * rather than guessing same or different.
 */
class RelayMoveTest {
    private val url = "https://minipc.example:8786"

    @Test
    fun `matching relayId alone is inconclusive, the token probe still decides`() {
        assertNull(RelayMove.byRelayId(url, "relay-aaa", "relay-aaa"))
    }

    @Test
    fun `mismatched relayId is a definitive different relay, no token probe needed`() {
        assertEquals(RelayMove.Verdict.Different(url), RelayMove.byRelayId(url, "relay-aaa", "relay-bbb"))
    }

    @Test
    fun `either side missing relayId is inconclusive, not treated as a mismatch`() {
        assertNull(RelayMove.byRelayId(url, null, "relay-bbb"))
        assertNull(RelayMove.byRelayId(url, "relay-aaa", null))
        assertNull(RelayMove.byRelayId(url, null, null))
    }

    @Test
    fun `token accepted with both relayIds known is a verified same relay`() {
        assertEquals(
            RelayMove.Verdict.Same(url, verified = true),
            RelayMove.byTokenProbe(url, "relay-aaa", "relay-aaa", tokenRejected = false),
        )
    }

    @Test
    fun `token accepted with either relayId missing is same but unverified`() {
        assertEquals(
            RelayMove.Verdict.Same(url, verified = false),
            RelayMove.byTokenProbe(url, null, "relay-aaa", tokenRejected = false),
        )
        assertEquals(
            RelayMove.Verdict.Same(url, verified = false),
            RelayMove.byTokenProbe(url, "relay-aaa", null, tokenRejected = false),
        )
    }

    @Test
    fun `a rejected token is a different relay regardless of what the relayIds said`() {
        assertEquals(
            RelayMove.Verdict.Different(url),
            RelayMove.byTokenProbe(url, "relay-aaa", null, tokenRejected = true),
        )
    }
}
