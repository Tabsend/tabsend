package io.tabsend.app.logic

/**
 * Classify a candidate relay address as "same relay, new address" or "a
 * different relay", the Android mirror of the extension's `probeRelay`
 * (extension/src/background/identity.ts). Kept pure and unit-tested, same
 * reasoning as [JoinErrors]: the classification is a small decision table, while
 * the network calls that feed it (GET /v1/config, an authenticated
 * GET /v1/endpoints) need Context and a coroutine scope and stay in
 * MainActivity.
 *
 * Split into two steps because the mismatch case must never send the device
 * token: a relayId mismatch is decided BEFORE any authenticated call, so a
 * relay already proven not to be ours never sees the token at all.
 */
object RelayMove {

    sealed class Verdict {
        /** Our relay, reached at [relayUrl]. [verified] false means one side
         *  predates relayId, so the token check alone carries the claim. */
        data class Same(val relayUrl: String, val verified: Boolean) : Verdict()

        /** No record of this phone here. Moving means every device re-pairs. */
        data class Different(val relayUrl: String) : Verdict()

        /** Nothing answered. */
        data class Unreachable(val relayUrl: String) : Verdict()

        /** Answered, but unusable as-is (protocol mismatch, relay-side error). */
        data class Error(val relayUrl: String, val detail: String) : Verdict()
    }

    /**
     * Step 1, before any token leaves the phone: do the relayIds already
     * disagree? Returns [Verdict.Different] only when BOTH sides have an id and
     * they differ, a mismatch that is conclusive on its own. Returns null when
     * the comparison can't decide (either id absent, or they match) — in either
     * case the token probe must still run.
     */
    fun byRelayId(relayUrl: String, storedId: String?, fetchedId: String?): Verdict.Different? =
        if (storedId != null && fetchedId != null && storedId != fetchedId) {
            Verdict.Different(relayUrl)
        } else {
            null
        }

    /**
     * Step 2: the token probe actually ran because step 1 was inconclusive. A
     * rejected token (401) means this relay has never heard of this phone, the
     * same conclusion as a relayId mismatch, just proven a different way.
     */
    fun byTokenProbe(
        relayUrl: String,
        storedId: String?,
        fetchedId: String?,
        tokenRejected: Boolean,
    ): Verdict = if (tokenRejected) {
        Verdict.Different(relayUrl)
    } else {
        Verdict.Same(relayUrl, verified = storedId != null && fetchedId != null)
    }
}
