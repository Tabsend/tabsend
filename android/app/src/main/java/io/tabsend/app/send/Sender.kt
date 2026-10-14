package io.tabsend.app.send

import android.content.Context
import io.tabsend.app.crypto.Sealer
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.GaveUpReason
import io.tabsend.app.logic.Keyring
import io.tabsend.app.logic.Mru
import io.tabsend.app.logic.OutboundItem
import io.tabsend.app.logic.OutboundQueue
import io.tabsend.app.logic.SendFailure
import io.tabsend.app.logic.SendOutcomeView
import io.tabsend.app.net.ApiClient
import io.tabsend.app.net.ApiException
import io.tabsend.app.net.Connectivity
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.HistoryRecord
import io.tabsend.app.wire.SendItem
import io.tabsend.app.wire.SendPayload
import io.tabsend.app.wire.SendRequest
import io.tabsend.app.wire.WireJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

/**
 * Outcome of a single send.
 *
 * [failure] is the classified reason it didn't land, and its ABSENCE is the only
 * licence a surface has to say "Sent". A tab held in the outbound queue is
 * `ok` — it isn't lost — but it is not sent, so it carries a recoverable
 * failure and renders as "Waiting to send" (ADR-0008 amendment).
 */
data class SendOutcome(
    val ok: Boolean,
    /** Accepted by the relay, but the target is asleep: opens when it wakes. */
    val queued: Boolean,
    val targetLabel: String,
    /** Title of the tab this outcome is about, so several sends stay distinct. */
    val title: String? = null,
    val failure: SendFailure? = null,
    /**
     * The message id. One notification id per send is derived from it, so two
     * concurrent sends never clobber each other's outcome, while a single send's
     * own later state does replace its earlier one.
     */
    val messageId: String = "",
) {
    fun view(): SendOutcomeView = SendOutcomeView(ok, queued, targetLabel, title, failure)
}

/** What one queue flush achieved, so the queue can report on itself. */
data class FlushReport(
    val sent: Int,
    val firstTitle: String?,
    /** Items that stayed queued because the relay still isn't answering. */
    val stillHeld: Int,
    /**
     * Items the relay finally REFUSED, so they left the queue unsent.
     *
     * Reported for the same reason the rest of this change exists: the user was
     * told "waiting to send" and walked away. A tab that then dies on a 401 or a
     * `not_in_group` when the relay comes back would otherwise vanish with
     * nothing said, which is the original bug with a longer fuse.
     */
    val dropped: Int = 0,
    val firstDroppedTitle: String? = null,
    val firstDroppedTargetLabel: String? = null,
    val firstDroppedFailure: SendFailure? = null,
) {
    val recovered: Boolean get() = sent > 0
}

/**
 * The send pipeline — the Android analogue of the extension's `background/send.ts`.
 * Seal per target (E2E), POST with a client-generated id (idempotent), and hold
 * the sealed item in the source-side outbound queue whenever the relay hasn't
 * accepted it, so nothing is ever silently dropped.
 */
object Sender {

    /**
     * Ids this process is POSTing right now.
     *
     * A send enqueues its item before the POST, so a drain worker firing in that
     * window would POST the same id (harmless, the relay dedupes) and then count
     * it as a recovered tab — announcing "Sent the tab that was waiting" on top
     * of the share sheet's own confirmation. Skipping in-flight ids keeps the
     * flush to tabs that are genuinely stuck.
     *
     * Process-local, which covers the Android case completely (one process) and
     * only the same-process case on iOS.
     */
    private val inFlight: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    suspend fun sendTo(context: Context, target: Endpoint, payload: SendPayload): SendOutcome =
        withContext(Dispatchers.IO) {
            val store = Store.get(context)
            val identity = store.identity
            val reg = store.registration
            if (identity == null || reg == null) {
                return@withContext SendOutcome(
                    ok = false, queued = false, targetLabel = target.label,
                    title = payload.title, failure = SendFailure.RelayUnauthorized,
                )
            }

            // Sealing can throw on a malformed target key (a truncated e2ePubkey
            // from an older or misbehaving relay). Uncaught it propagated out of
            // lifecycleScope and CRASHED the share sheet, which is a worse
            // failure than any of the ones this file exists to report.
            val envelope = try {
                Sealer.seal(
                    payloadJson = WireJson.encodeToString(SendPayload.serializer(), payload),
                    targetPubB64 = target.e2ePubkey,
                    senderPrivB64 = identity.privateKey,
                    senderKeyId = identity.keyId,
                )
            } catch (e: Exception) {
                return@withContext SendOutcome(
                    ok = false, queued = false, targetLabel = target.label,
                    title = payload.title, failure = SendFailure.RelayError("internal"),
                )
            }
            // The group-history copy [0028]. Sealed to the GROUP key rather than
            // to this target, so every paired device can read the record of the
            // send; one blob, not one per device. Best-effort in the strongest
            // sense: no key yet, or anything at all going wrong here, omits the
            // field and the send proceeds exactly as it did before ADR-0028.
            val history = try {
                Keyring.current(store.groupKeys)?.let { key ->
                    Sealer.sealGroup(
                        plaintextJson = WireJson.encodeToString(
                            HistoryRecord.serializer(),
                            HistoryRecord(
                                payload = payload,
                                // Snapshots: a rename must not rewrite what a past
                                // send says, and the relay's row holds only ids.
                                sourceLabelAtSend = reg.label,
                                targetLabelAtSend = target.label,
                            ),
                        ),
                        keyB64 = key.key,
                        keyId = key.keyId,
                    )
                }
            } catch (e: Exception) {
                null
            }

            val id = UUID.randomUUID().toString()
            val item = OutboundItem(
                id = id,
                targetEndpointId = target.id,
                envelope = envelope,
                createdAt = payload.sentAt,
                title = payload.title,
                url = payload.url,
                targetLabel = target.label,
                history = history,
            )

            // Queue FIRST, then POST, then dequeue on a definite answer. The share
            // activity can be killed mid-POST (it's a transient task the OS is
            // happy to reap), and a tab that was never queued and never accepted
            // is simply lost with no record anywhere. Replaying is safe: the relay
            // inserts on the client-generated id with ON CONFLICT DO NOTHING, so a
            // second POST of the same id adds no duplicate row.
            // Claim before enqueuing, not after: between the two the item would be
            // visible in the queue but unowned, and a concurrent flush could POST
            // it (harmless, the relay dedupes) and then announce it a second time
            // on top of this send's own report.
            inFlight.add(id)
            // Bounding the queue is part of enqueuing it, not a separate sweep:
            // this is the moment the queue can grow, and the tabs it has to let
            // go of are announced here rather than deleted quietly. Never the
            // item just added — eviction is oldest-first, and the newest is the
            // one the user just asked for.
            announceGivenUp(context, enqueueOutbound(store, item))

            try {
                val resp = ApiClient.forRegistration(reg).sendMessages(
                    reg.deviceToken,
                    SendRequest(items = listOf(SendItem(id, target.id, envelope, history))),
                )
                val rejected = resp.rejected.firstOrNull { it.id == id }
                if (rejected != null) {
                    val failure = SendFailure.RelayRejected(rejected.reason, rejected.limit)
                    if (Feedback.isRecoverable(failure)) {
                        // A per-group cap [0030] is the relay saying "not this
                        // minute", not "no": the send window rolls over on its
                        // own, and the queue caps drain as the target reads its
                        // tabs. The item was queued BEFORE the POST, so holding
                        // it is simply not dequeuing — the ordinary flush (drain
                        // and heartbeat workers, both CONNECTED-constrained)
                        // retries it, and the queue's own bounds still apply, so
                        // this can neither spin nor grow without limit.
                        recordSend(store, target.id)
                        SendOutcome(
                            ok = true, queued = false, targetLabel = target.label,
                            title = payload.title, failure = failure, messageId = id,
                        )
                    } else {
                        // The relay answered and refused this item; retrying won't help.
                        dequeueOutbound(store, id)
                        SendOutcome(
                            ok = false, queued = false, targetLabel = target.label,
                            title = payload.title, failure = failure, messageId = id,
                        )
                    }
                } else {
                    dequeueOutbound(store, id)
                    recordSend(store, target.id)
                    SendOutcome(
                        ok = true,
                        queued = target.presence != "online",
                        targetLabel = target.label,
                        title = payload.title,
                        messageId = id,
                    )
                }
            } catch (e: ApiException) {
                // The relay answered with an error envelope. Only the CODE travels
                // into the copy — `message` is written for a log and the contract
                // says it may change (shared/types.ts §10b).
                //
                // A refusal is final, so the item leaves the queue: retrying
                // identical input fails identically. But a 429 or a 5xx is NOT a
                // refusal, and dropping the tab there was silent data loss — a
                // reverse proxy in front of a restarting relay answers HTML 502.
                val failure = classifyApi(e)
                if (Feedback.isRecoverable(failure)) {
                    recordSend(store, target.id)
                    SendOutcome(
                        ok = true, queued = false, targetLabel = target.label,
                        title = payload.title, failure = failure, messageId = id,
                    )
                } else {
                    dequeueOutbound(store, id)
                    SendOutcome(
                        ok = false, queued = false, targetLabel = target.label,
                        title = payload.title, failure = failure, messageId = id,
                    )
                }
            } catch (e: IOException) {
                // The relay never answered. The item stays queued, and the tone is
                // pending, not "Sent" — and not "No connection" either unless the
                // OS agrees there is genuinely no network.
                recordSend(store, target.id)
                SendOutcome(
                    ok = true, queued = false, targetLabel = target.label,
                    title = payload.title,
                    failure = classifyTransport(context, reg.relayUrl),
                    messageId = id,
                )
            } finally {
                inFlight.remove(id)
            }
        }

    /**
     * Retry the source-side outbound queue. Called by the drain/heartbeat workers
     * (which carry a CONNECTED constraint).
     *
     * An item leaves the queue only on a DEFINITE answer: accepted, or refused in
     * a way that retrying cannot change. Silence, a 429, any 5xx and a per-group
     * cap refusal [0030] all keep it for the next attempt — including the HTML
     * 502 a proxy returns for a restarting relay, which used to empty the whole
     * queue in one pass.
     */
    suspend fun flushOutbound(context: Context): FlushReport = withContext(Dispatchers.IO) {
        val store = Store.get(context)
        val reg = store.registration ?: return@withContext FlushReport(0, null, 0)
        val queue = store.outbound
        if (queue.isEmpty()) return@withContext FlushReport(0, null, 0)

        val api = ApiClient.forRegistration(reg)
        // Ids this pass settled one way or another. Removing exactly these,
        // rather than writing back a whole list computed before the network
        // calls, is what keeps a send queued mid-flush from being clobbered.
        val settled = mutableSetOf<String>()
        var stillHeld = 0
        var sent = 0
        var dropped = 0
        var firstTitle: String? = null
        var firstDroppedTitle: String? = null
        var firstDroppedLabel: String? = null
        var firstDroppedFailure: SendFailure? = null

        // Give up on the dead ones BEFORE anything is POSTed, and this half is
        // the one that ends the failure the queue could not end by itself: an
        // envelope one relay 5xxes forever is never competing with newer sends
        // for the size cap, so nothing but its own age can finish it. Without
        // this it is retried on every drain and every heartbeat, for as long as
        // the app is installed. They ride out on the same report as a relay's
        // own refusals, because from the user's side both are "a tab you were
        // promised is not going".
        val plan = OutboundQueue.plan(queue, System.currentTimeMillis())
        for ((item, failure) in givenUp(plan)) {
            settled += item.id
            dropped++
            if (firstDroppedFailure == null) {
                firstDroppedTitle = item.title
                firstDroppedLabel = item.targetLabel
                firstDroppedFailure = failure
            }
        }
        for (item in plan.keep) {
            // Claim the id: this both skips a send still POSTing and stops two
            // concurrent flushes (DrainWorker and HeartbeatWorker use different
            // unique-work names, so they can overlap) from each counting the same
            // tab as recovered.
            if (!inFlight.add(item.id)) {
                stillHeld++
                continue
            }
            try {
                val resp = api.sendMessages(
                    reg.deviceToken,
                    SendRequest(
                        items = listOf(
                            SendItem(item.id, item.targetEndpointId, item.envelope, item.history),
                        ),
                    ),
                )
                // A per-item rejection is still HTTP 200. Most are final, so the
                // item leaves the queue either way — but only an acceptance
                // counts towards the "your tabs went out" announcement. A cap
                // refusal [0030] is the exception and stays queued: the cap
                // clears itself, so the next flush tries again, and announcing
                // it would withdraw a promise that is still being kept.
                val rejection = resp.rejected.firstOrNull { it.id == item.id }
                val rejectionFailure = rejection?.let {
                    SendFailure.RelayRejected(it.reason, it.limit)
                }
                if (rejection == null) {
                    settled.add(item.id)
                    sent++
                    if (firstTitle == null) firstTitle = item.title
                } else if (rejectionFailure != null && Feedback.isRecoverable(rejectionFailure)) {
                    stillHeld++
                } else {
                    settled.add(item.id)
                    dropped++
                    if (firstDroppedFailure == null) {
                        firstDroppedTitle = item.title
                        firstDroppedLabel = item.targetLabel
                        firstDroppedFailure = rejectionFailure
                    }
                }
            } catch (e: ApiException) {
                // A refusal is final and the item goes; "not now" keeps it. Without
                // this split one pass against a 502-ing relay emptied the entire
                // queue, which is the largest possible version of the bug this
                // whole change exists to prevent.
                val failure = classifyApi(e)
                if (Feedback.isRecoverable(failure)) {
                    stillHeld++
                } else {
                    settled.add(item.id)
                    dropped++
                    if (firstDroppedFailure == null) {
                        firstDroppedTitle = item.title
                        firstDroppedLabel = item.targetLabel
                        firstDroppedFailure = failure
                    }
                }
            } catch (e: IOException) {
                stillHeld++ // relay still not answering → keep
            } catch (e: kotlinx.coroutines.CancellationException) {
                // A stopped worker must actually stop. Rethrown ahead of the
                // catch-all below, which would otherwise absorb it and keep
                // flushing after the OS asked us to give the CPU back.
                throw e
            } catch (e: Exception) {
                // Anything else (a malformed response that fails to deserialise,
                // say) must not escape the loop: that would skip the prune below,
                // leaving already-accepted items queued to be announced a second
                // time on the next pass.
                stillHeld++
            } finally {
                inFlight.remove(item.id)
            }
        }
        store.updateOutbound { current -> current.filterNot { it.id in settled } }
        FlushReport(
            sent = sent,
            firstTitle = firstTitle,
            stillHeld = stillHeld,
            dropped = dropped,
            firstDroppedTitle = firstDroppedTitle,
            firstDroppedTargetLabel = firstDroppedLabel,
            firstDroppedFailure = firstDroppedFailure,
        )
    }

    /**
     * A transport failure means the relay never answered. With a network up that
     * is a RELAY problem — wrong address, container down, TLS refused — and
     * naming the URL is the only thing the user can act on. The OS reachability
     * check only ever demotes that to a plain offline diagnosis.
     */
    private fun classifyTransport(context: Context, relayUrl: String): SendFailure =
        if (!Connectivity.isOnline(context)) {
            SendFailure.PhoneOffline
        } else {
            SendFailure.RelayUnreachable(relayUrl)
        }

    /**
     * The relay DID answer, which is a different conversation from silence. What
     * matters for whether we keep the tab is the STATUS, not the code: a proxy's
     * HTML 502 has no error envelope at all and [ApiClient] can only label it
     * `internal`, so switching on the code alone would treat it as a permanent
     * relay bug and throw the tab away.
     */
    private fun classifyApi(e: ApiException): SendFailure = when {
        e.status == 401 -> SendFailure.RelayUnauthorized
        e.status == 429 || e.status >= 500 -> SendFailure.RelayBusy
        else -> SendFailure.RelayError(e.code)
    }

    /** The label a held item should show, falling back to its site. */
    fun heldLabel(item: OutboundItem): String = Feedback.heldTabLabel(item.title, item.url)

    private fun recordSend(store: Store, targetId: String) {
        store.sourcePrefs = Mru.recordSend(store.sourcePrefs, targetId)
    }

    /**
     * Hold a sealed item for retry, and bound what is being held.
     *
     * The queue's rule for LETTING GO is unchanged and deliberate: only a
     * definite answer from the relay releases an item. What was missing was a
     * bound on the other side, so a week of outage grew this list forever — on a
     * phone, where the whole queue is one blob rewritten on every change.
     * Returns whatever had to be given up, for the caller to announce.
     */
    private fun enqueueOutbound(store: Store, item: OutboundItem): List<Pair<OutboundItem, SendFailure>> {
        var plan = OutboundQueue.Plan(emptyList<OutboundItem>())
        store.updateOutbound { queue ->
            val appended = if (queue.any { it.id == item.id }) queue else queue + item
            plan = OutboundQueue.plan(appended, System.currentTimeMillis())
            plan.keep
        }
        return givenUp(plan)
    }

    /**
     * The tabs a plan gave up on, paired with the sentence to say about each.
     *
     * Expired first, so that when one pass manages to do both, the line the
     * notification shows is the one about waiting too long — the cause a
     * self-hoster can actually act on.
     */
    private fun givenUp(plan: OutboundQueue.Plan<OutboundItem>): List<Pair<OutboundItem, SendFailure>> =
        plan.expired.map { it to SendFailure.GaveUp(GaveUpReason.TOO_OLD) } +
            plan.evicted.map { it to SendFailure.GaveUp(GaveUpReason.QUEUE_FULL) }

    /**
     * Say so. Never silent: the user was told "the tab is held here and sends
     * itself once the relay answers again", and this is the moment that stops
     * being true. Exactly the §4d rule — a promise is withdrawn out loud.
     */
    private fun announceGivenUp(context: Context, given: List<Pair<OutboundItem, SendFailure>>) {
        val (first, failure) = given.firstOrNull() ?: return
        SendNotifications.postDropped(context, given.size, first.title, first.targetLabel, failure)
    }

    /**
     * Abandon one held tab, at the user's request (INTERACTION_FLOWS §4f).
     *
     * A pure local delete: nothing is transmitted, because there is nothing to
     * retract. The honest limit, which the button's wording respects too — this
     * stops Tabsend TRYING. An item whose POST is in flight at this instant can
     * still be accepted and delivered, and a tab the relay has already taken is
     * long past anything this can reach. There is no unsend and this is not one.
     *
     * No announcement: the user just did it, and §4d's rule is about withdrawing
     * a promise the user has not been watching.
     */
    fun cancelHeld(context: Context, id: String) {
        Store.get(context).updateOutbound { OutboundQueue.cancel(it, id) }
    }

    private fun dequeueOutbound(store: Store, id: String) {
        store.updateOutbound { queue -> queue.filterNot { it.id == id } }
    }
}
