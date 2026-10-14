package io.tabsend.app.logic

import io.tabsend.app.wire.EncryptedEnvelope
import io.tabsend.app.wire.GroupSealed
import kotlinx.serialization.Serializable

/**
 * A sealed send that hasn't been accepted by the relay yet and is held for retry
 * — the source-side queue (the second of the two queues in PRD §6.1). Lets the
 * "waiting to send" feedback be honest: the link isn't lost.
 *
 * [title] and [url] are the shared page's own, kept in PLAINTEXT and
 * device-locally beside the sealed envelope. The envelope is sealed to the
 * target's key, so a queue of envelopes can be counted but never described, and
 * without these two fields no screen could say WHICH tabs are stuck — the state
 * with the most tabs at risk showed the least evidence (INTERACTION_FLOWS §4b).
 * Nothing extra reaches the relay: it still only ever sees ciphertext, and these
 * die with the item when it drains. The page they name was open on this phone
 * anyway. Both default to null so a queue written by an older build still reads.
 *
 * [HeldItem] is the slice [OutboundQueue] works in, so the rules that bound this
 * queue can be tested without an envelope, a Store or an Android runtime.
 */
@Serializable
data class OutboundItem(
    override val id: String,
    val targetEndpointId: String,
    val envelope: EncryptedEnvelope,
    override val createdAt: String,
    val title: String? = null,
    val url: String? = null,
    /** Label of the target as it read when the send was made, for the held list. */
    val targetLabel: String? = null,
    /**
     * The group-history copy of this tab [0028], sealed at the same moment as the
     * envelope and carried with it.
     *
     * It has to ride the QUEUE, not just the first POST: a tab held through an
     * outage is exactly the one whose fate somebody will want to look up later,
     * and a retry that dropped the blob would leave the group's history with a
     * hole precisely where the trouble was. Null on a group with no key yet, and
     * on anything queued by a build that predates this field.
     */
    val history: GroupSealed? = null,
) : HeldItem
