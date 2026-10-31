package io.tabsend.app.wire

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The subset of `shared/src/types.ts` the Android endpoint touches, mirrored as
 * kotlinx.serialization models. Field NAMES match the wire exactly; enums are
 * kept as strings (the wire uses string unions) so an unknown value never crashes
 * a parse — the client just renders it plainly.
 *
 * NO changes to the shared contract are made here; this is a faithful copy of the
 * shapes the relay already speaks (Chunk 2/4).
 */

/** Shared JSON config: tolerant on read, omits nulls on write (so `browser:null`
 *  and absent push-key fields serialize the way the relay's validators expect). */
@OptIn(ExperimentalSerializationApi::class)
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    isLenient = true
}

@Serializable
data class WebPushKeys(val p256dh: String, val auth: String)

/**
 * A push subscription. Android sends one of exactly two:
 *
 *  - `{transport:"none"}` [0015] — the phone is reached over the WS fast path while the app
 *    is alive and by its own polling otherwise; the relay never wakes it. This is what
 *    pairing registers, always, so joining a group still needs no push setup whatever.
 *  - `{transport:"forwarder", wakeToken}` [0032, P-11] — rotated in by heartbeat once Google
 *    push is enrolled, so the relay rings its forwarder instead and the phone needs no
 *    foreground service.
 *
 * The other fields exist so we can PARSE any transport without failing. Nulls are omitted
 * on write (WireJson), which is what keeps `none` a bare `{"transport":"none"}`.
 */
@Serializable
data class PushSubscription(
    val transport: String,
    val endpoint: String? = null,
    val keys: WebPushKeys? = null,
    val token: String? = null,
    val wakeToken: String? = null,
) {
    companion object {
        fun none() = PushSubscription(transport = "none")

        /** The wake-up forwarder path. The token is minted by the forwarder, never the
         *  relay, and is the ONLY thing the relay is told (ADR-0032). */
        fun forwarder(wakeToken: String) =
            PushSubscription(transport = "forwarder", wakeToken = wakeToken)
    }
}

@Serializable
data class EncryptedEnvelope(
    val alg: String,
    val senderKeyId: String,
    val targetKeyId: String,
    val nonce: String,
    val ciphertext: String,
)

@Serializable
data class HistoryOf(val targetEndpointId: String)

/**
 * Present when this tab was sent as part of a multi-tab selection: a random id
 * shared by every tab of the batch, plus how many tabs the batch holds. Lets
 * the receiver group the batch under one summary notification instead of N
 * unrelated alerts. Rides INSIDE the ciphertext; the relay sees only N
 * independent items. Absent on single-tab sends and from older senders.
 */
@Serializable
data class BatchInfo(val id: String, val count: Int)

/** The plaintext tab, sealed inside the envelope (title/favicon ride E2E). */
@Serializable
data class SendPayload(
    val url: String,
    val title: String? = null,
    val favicon: String? = null,
    val sentAt: String,
    val historyOf: HistoryOf? = null,
    val batch: BatchInfo? = null,
)

@Serializable
data class Endpoint(
    val id: String,
    val groupId: String,
    val kind: String,
    val browser: String? = null,
    val platform: String,
    val label: String,
    val e2ePubkey: String,
    val presence: String,
    val lastSeenAt: String,
    val createdAt: String,
)

@Serializable
data class RegisterRequest(
    val label: String,
    val kind: String,
    val browser: String? = null,
    val platform: String,
    val pushSubscription: PushSubscription,
    val e2ePubkey: String,
    val pairingCode: String? = null,
)

@Serializable
data class RegisterResponse(
    val endpointId: String,
    val groupId: String,
    val deviceToken: String,
    /**
     * The label the relay actually stored. It de-duplicates within a group, so a
     * name already taken comes back suffixed ("Pixel 8" -> "Pixel 8 2"). Null from
     * an older relay, which stored the label as sent.
     */
    val label: String? = null,
)

@Serializable
data class HeartbeatRequest(val pushSubscription: PushSubscription? = null)

@Serializable
data class HeartbeatResponse(val presence: String, val serverTime: String)

/**
 * Something sealed to the GROUP history key rather than to one endpoint [0028].
 *
 * `crypto_secretbox` (XSalsa20-Poly1305) — the symmetric half of the `crypto_box`
 * [io.tabsend.app.crypto.CryptoBox] already implements, so ADR-0028 adds no new
 * primitive here either. There is no `senderKeyId` to check: anyone holding the
 * group key could have written it, and everyone holding it is by definition a
 * paired device. A TAB's authenticity still rests on its per-target envelope;
 * this is the record OF that send, not the send itself.
 */
@Serializable
data class GroupSealed(
    val alg: String,
    /**
     * Which group key sealed this. A device holds a SET of keys — rotation keeps
     * the old ones so old history stays readable — so a blob has to name its own,
     * or every reader would be guessing by trial decryption.
     */
    val keyId: String,
    val nonce: String,
    val ciphertext: String,
)

/**
 * What a history blob decrypts to [0028]. The labels are SNAPSHOTS taken at send
 * time: a history row has to still read correctly after a device is renamed or
 * leaves the group, and the relay's routing row only carries ids.
 */
@Serializable
data class HistoryRecord(
    val payload: SendPayload,
    val sourceLabelAtSend: String,
    val targetLabelAtSend: String,
)

@Serializable
data class SendItem(
    val id: String,
    val targetEndpointId: String,
    val envelope: EncryptedEnvelope,
    /**
     * The group-history copy of this same tab [0028]. Omitted when the group has
     * no key yet, and everything else behaves exactly as before — which is also
     * what an older relay sees, since it simply ignores the field.
     */
    val history: GroupSealed? = null,
)

@Serializable
data class SendRequest(val items: List<SendItem>)

@Serializable
data class SendRejection(
    val id: String,
    val reason: String,
    /**
     * Which per-group cap refused this item [0030]. Set only alongside
     * `limit_reached`, and always then; absent from every older relay, which
     * [WireJson]'s `ignoreUnknownKeys` already tolerated in the other direction
     * — so this field is purely additive on both sides of the wire.
     *
     * The reason alone is enough to know the tab should be HELD and retried (a
     * cap clears itself); this names which wait it is in, so the copy can say
     * what ends it. See `SendFeedback.kt`.
     */
    val limit: String? = null,
)

@Serializable
data class SendResponse(
    val accepted: List<String> = emptyList(),
    val rejected: List<SendRejection> = emptyList(),
)

@Serializable
data class Message(
    val id: String,
    val groupId: String,
    val sourceEndpointId: String,
    val targetEndpointId: String,
    val envelope: EncryptedEnvelope,
    val createdAt: String,
    val expiresAt: String,
    val deliveredAt: String? = null,
    val ackedAt: String? = null,
)

/**
 * One row of the group's shared history [0028]: the relay's own routing facts,
 * plus the opaque blob only paired devices can read.
 *
 * `deliveredAt`/`ackedAt` are metadata the relay has always held, which is what
 * lets this phone say "that never arrived" honestly instead of inferring it.
 * `blob` is content the relay cannot read, which is what lets ANY device show the
 * tab rather than only the two ends.
 */
@Serializable
data class HistoryEntry(
    val id: String,
    val sourceEndpointId: String,
    val targetEndpointId: String,
    val createdAt: String,
    val expiresAt: String,
    val deliveredAt: String? = null,
    /** Null past `expiresAt` means it never arrived. */
    val ackedAt: String? = null,
    val blob: GroupSealed,
)

// --- group history key distribution [0028] --------------------------------
//
// Its OWN route, not an ordinary message. A message is a TAB to every client
// already shipped: one carrying a key instead of a URL fails to parse here
// (`SendPayload.url` is non-null), which skips it WITHOUT an ack so it retries on
// every drain until it expires. A route an older client never polls is invisible
// to it — which is exactly the forward compatibility this needs, and the reason
// this client must equally treat a 404 from it as "this relay has no group
// history" rather than as a failure.

/** One copy of the group history key, `crypto_box`-sealed to ONE endpoint's key. */
@Serializable
data class GroupKeyDelivery(
    val id: String,
    /** Who sealed it. The envelope's `senderKeyId` is what actually proves it. */
    val sourceEndpointId: String,
    val envelope: EncryptedEnvelope,
    val createdAt: String,
)

/** What a [GroupKeyDelivery] envelope decrypts to. */
@Serializable
data class GroupKeyRecord(
    /** 32 random bytes, base64. */
    val key: String,
    /**
     * Fingerprint of `key`, so two devices can agree which key is which without
     * comparing secrets, and a blob can name the key that sealed it.
     */
    val keyId: String,
    /**
     * When this key came into being. Newest wins when a device holds several
     * (`createdAt` first, `keyId` as a deterministic tiebreak) — which is what
     * makes rotation and a two-devices-minted-at-once collision the same case.
     */
    val createdAt: String,
    /**
     * The ids of the devices that had left, or been removed, when this key was
     * minted to replace the one they held: the minter's debt. A device that owes a
     * rotation stands down only for a key that names every one of its own departed
     * ids, so a key that merely arrived later does not count (X14). Null on a
     * group's first key; at most 32 ids ([io.tabsend.app.logic.Keyring.isAcceptableDeparted]).
     */
    val departed: List<String>? = null,
)

@Serializable
data class GroupKeyItem(
    val id: String,
    val targetEndpointId: String,
    val envelope: EncryptedEnvelope,
)

@Serializable
data class GroupKeyRequest(val items: List<GroupKeyItem>)

@Serializable
data class GroupKeyRejection(val id: String, val reason: String)

@Serializable
data class GroupKeyResponse(
    val accepted: List<String> = emptyList(),
    val rejected: List<GroupKeyRejection> = emptyList(),
)

/**
 * A reset the account site has scheduled and nobody has stopped yet [P-18 item 12].
 * Mirrors GroupResetState in shared/src/types.ts. `requestedAt` doubles as the
 * reset's identity on this phone: "notified" and "It was me" are keyed by it.
 */
@Serializable
data class GroupResetState(val requestedAt: String, val resetsAt: String)

/**
 * GET /v1/group, and the answer to POST /v1/group/reset/stop (always `reset: null`).
 * An absent `reset` reads as none, like an explicit null.
 */
@Serializable
data class GroupStateResponse(val reset: GroupResetState? = null)

@Serializable
data class CreatePairingResponse(
    val link: String,
    val browserLink: String? = null,
    val expiresAt: String,
)

/**
 * GET /v1/config. `protocol`/`minClientProtocol` are absent on relays predating
 * protocol discovery, so both default to 1 — the original wire protocol.
 * Mirrors ServerConfigResponse in shared/src/types.ts §10c.
 */
@Serializable
data class ServerConfigResponse(
    val vapidPublicKey: String = "",
    val protocol: Int = 1,
    val minClientProtocol: Int = 1,
    /** Null ⇒ fall back to minClientProtocol, i.e. nothing to nag about. */
    val recommendedClientProtocol: Int? = null,
    val relayVersion: String? = null,
    /** Stable random UUID identifying this relay instance; absent on older relays. */
    val relayId: String? = null,
    /**
     * Whether this relay has a wake-up forwarder configured (ADR-0032). Absent on relays
     * predating it, and `false` is the right reading of absent: a client that assumed one
     * would register `{transport:"forwarder"}` and be refused.
     */
    val wakeForwarder: Boolean = false,
)

@Serializable
data class ApiErrorBody(val code: String, val message: String)

@Serializable
data class ApiErrorEnvelope(@SerialName("error") val error: ApiErrorBody)
