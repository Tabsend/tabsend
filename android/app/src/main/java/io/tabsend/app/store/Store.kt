package io.tabsend.app.store

import android.content.Context
import android.content.SharedPreferences
import io.tabsend.app.logic.HistoryItem
import io.tabsend.app.logic.InboxItem
import io.tabsend.app.logic.NewDeviceWatch
import io.tabsend.app.logic.OutboundItem
import io.tabsend.app.logic.RelayHealth
import io.tabsend.app.logic.SeenMessage
import io.tabsend.app.logic.SourcePrefs
import io.tabsend.app.push.RelayRef
import io.tabsend.app.push.Retirement
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.wire.GroupKeyRecord
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** This install's X25519 identity (base64 keys) + cached keyId fingerprint. */
data class Identity(val publicKey: String, val privateKey: String, val keyId: String)

/** What register/join returned, plus this endpoint's own descriptors. */
data class Registration(
    val endpointId: String,
    val groupId: String,
    val deviceToken: String,
    val relayUrl: String,
    val label: String,
    /** SPKI-SHA256 pin from the pairing link (P-3); null = platform TLS trust. */
    val certFingerprint: String? = null,
    /** Stable relay identity from GET /v1/config; null on older relays. */
    val relayId: String? = null,
)

/**
 * Device-local persistence (SharedPreferences). Holds the endpoint identity, the
 * registration, the device-local SourcePrefs/MRU (ADR-0009), the idempotency
 * seen-set, and the instant-delivery toggle. Nothing here is on the wire
 * except via ApiClient calls.
 */
class Store private constructor(private val prefs: SharedPreferences) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    // --- identity ---
    var identity: Identity?
        get() {
            val pub = prefs.getString(K_PUB, null) ?: return null
            val priv = prefs.getString(K_PRIV, null) ?: return null
            val kid = prefs.getString(K_KEYID, null) ?: return null
            return Identity(pub, priv, kid)
        }
        set(value) = prefs.edit().apply {
            if (value == null) {
                remove(K_PUB); remove(K_PRIV); remove(K_KEYID)
            } else {
                putString(K_PUB, value.publicKey)
                putString(K_PRIV, value.privateKey)
                putString(K_KEYID, value.keyId)
            }
        }.apply()

    // --- registration ---
    var registration: Registration?
        get() {
            val id = prefs.getString(K_ENDPOINT_ID, null) ?: return null
            return Registration(
                endpointId = id,
                groupId = prefs.getString(K_GROUP_ID, "") ?: "",
                deviceToken = prefs.getString(K_TOKEN, "") ?: "",
                relayUrl = prefs.getString(K_RELAY, "") ?: "",
                label = prefs.getString(K_LABEL, "") ?: "",
                certFingerprint = prefs.getString(K_CERT_FP, null),
                relayId = prefs.getString(K_RELAY_ID, null),
            )
        }
        set(value) = prefs.edit().apply {
            if (value == null) {
                remove(K_ENDPOINT_ID); remove(K_GROUP_ID); remove(K_TOKEN); remove(K_RELAY); remove(K_LABEL)
                remove(K_CERT_FP); remove(K_RELAY_ID)
            } else {
                putString(K_ENDPOINT_ID, value.endpointId)
                putString(K_GROUP_ID, value.groupId)
                putString(K_TOKEN, value.deviceToken)
                putString(K_RELAY, value.relayUrl)
                putString(K_LABEL, value.label)
                putString(K_CERT_FP, value.certFingerprint) // null removes the key
                putString(K_RELAY_ID, value.relayId)
            }
        }.apply()

    val isRegistered: Boolean get() = registration != null

    /**
     * The registered relay's address alone.
     *
     * [RelayHealthTracker] consults this on EVERY api call, only to decide whether
     * the call concerned our own relay, and has no use for the rest of the
     * registration — so it reads the one string instead of assembling the whole
     * object each time. (On iOS the same split matters much more: there
     * `registration` has to read the device token out of the Keychain.)
     */
    val registeredRelayUrl: String? get() = prefs.getString(K_RELAY, null)

    fun updateLabel(label: String) {
        prefs.edit().putString(K_LABEL, label).apply()
    }

    /**
     * Change ONLY the relay address (P-4) — token, pin, and identity stay put.
     * [relayId] backfills a stable id gained since registration (a relay that
     * predated relayId, then upgraded); null leaves whatever is already stored,
     * since one probe not returning it isn't evidence the relay lost it.
     */
    @Synchronized
    fun updateRelay(relayUrl: String, relayId: String? = null) {
        val endpointId = prefs.getString(K_ENDPOINT_ID, null)
        prefs.edit().apply {
            putString(K_RELAY, relayUrl.trimEnd('/'))
            if (relayId != null) putString(K_RELAY_ID, relayId)
        }.apply()
        // A `none` still owed to this endpoint goes to the address that now reaches it, or it
        // would wait for the old one for ever [2026-10-02 verification pass].
        if (endpointId != null) {
            updateRetirements { list ->
                list.map { retirement ->
                    val queued = retirement.relay
                    if (queued != null && queued.endpointId == endpointId) {
                        retirement.copy(relay = queued.copy(relayUrl = relayUrl.trimEnd('/')))
                    } else {
                        retirement
                    }
                }
            }
        }
    }

    // --- instant delivery ---
    // One switch, two ways to honour it [P-11]: Google push (silent) when it is available
    // and not refused, otherwise StreamService (foreground service + the permanent
    // notification Android mandates for one). New installs default to on; an explicit
    // existing opt-out remains respected.
    var instantDelivery: Boolean
        get() = if (prefs.contains(K_INSTANT)) prefs.getBoolean(K_INSTANT, true) else true
        set(value) = prefs.edit().putBoolean(K_INSTANT, value).apply()

    /**
     * The user's explicit "not through Google" [P-11]. Off by default, because the default
     * has to be the one that works without a permanent notification wherever it can, and
     * because a phone that has no Play Services never reaches this question at all.
     *
     * Kept separate from `instantDelivery` deliberately: it records a preference about
     * MEANS, which must survive turning delivery off and on again, and must not be
     * confused with having no Google push available. It survives an unpair too
     * [2026-10-02, SECURITY_REVIEW G5]: [clear] used to wipe it, so the next pairing
     * enrolled with Google despite the refusal.
     */
    var avoidGoogle: Boolean
        get() = prefs.getBoolean(K_AVOID_GOOGLE, false)
        set(value) = prefs.edit().putBoolean(K_AVOID_GOOGLE, value).apply()

    /**
     * The wake token this phone holds from the forwarder, or null when it has none
     * (ADR-0032). Its presence is what "Google push is actually working" means: a token was
     * minted, so somebody can ring this phone.
     *
     * Stored beside, never inside, `Registration`: it is minted by the forwarder rather than
     * the relay, so it survives a relay change and is cleared on unpair instead.
     */
    var wakeToken: String?
        get() = prefs.getString(K_WAKE_TOKEN, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(K_WAKE_TOKEN) else putString(K_WAKE_TOKEN, value)
        }.apply()

    /**
     * The Google push token the wake token above was minted for. Compared on each sync so a
     * rotated token re-enrols and a steady one does not: Google rotates these on its own
     * schedule, and a stale enrolment is a phone that silently stops ringing.
     */
    var pushToken: String?
        get() = prefs.getString(K_PUSH_TOKEN, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(K_PUSH_TOKEN) else putString(K_PUSH_TOKEN, value)
        }.apply()

    /**
     * Which endpoint on which relay was last told about the wake token above, as
     * `endpointId@relayUrl`.
     *
     * Exists because the wake token is NOT relay-scoped — the forwarder minted it, so it
     * survives a relay change — while the relay's knowledge of it very much is. After a
     * re-registration (ADR-0013: changing relay is a re-register) the new relay holds
     * `{transport:"none"}` while this phone still believes Google push is working, which is a
     * phone that rings for nobody. Comparing against this makes the next sync notice and
     * re-announce, whichever path changed the relay.
     */
    var pushAnnouncedTo: String?
        get() = prefs.getString(K_PUSH_ANNOUNCED, null)
        set(value) = prefs.edit().apply {
            if (value == null) remove(K_PUSH_ANNOUNCED) else putString(K_PUSH_ANNOUNCED, value)
        }.apply()

    /** When the relay was handed the live wake token (phone clock), or 0 if never. */
    val enrolledAt: Long get() = prefs.getLong(K_PUSH_ENROLLED_AT, 0L)

    /**
     * Save a Google push enrolment, but only if the pairing is still [expectedTarget]
     * [2026-10-02, SECURITY_REVIEW G11]. Locked against [leavePairing], so an enrolment
     * that finishes after an unpair cannot land in the wiped store. [resetWatch] starts a
     * new watch for missed wakes [G10]: a first enrolment, or the user trying again. A
     * token Google rotated, or the same relay at a new address, keeps the old watch.
     */
    @Synchronized
    fun commitEnrolment(
        expectedTarget: String,
        wakeToken: String,
        pushToken: String,
        enrolledAt: Long,
        resetWatch: Boolean,
    ): Boolean {
        val reg = registration ?: return false
        if ("${reg.endpointId}@${reg.relayUrl}" != expectedTarget) return false
        prefs.edit().apply {
            putString(K_WAKE_TOKEN, wakeToken)
            putString(K_PUSH_TOKEN, pushToken)
            putString(K_PUSH_ANNOUNCED, expectedTarget)
            putLong(K_PUSH_ENROLLED_AT, enrolledAt)
            if (resetWatch) {
                remove(K_PUSH_STRIKE)
                remove(K_PUSH_MISSED)
            }
        }.apply()
        return true
    }

    /**
     * Drop the live enrolment and queue its token for retirement, in one step, so there is
     * no moment where the token is in neither place [G8].
     */
    @Synchronized
    fun retireEnrolment(retirement: Retirement) {
        val queued = retirements + retirement
        prefs.edit()
            .remove(K_WAKE_TOKEN).remove(K_PUSH_TOKEN).remove(K_PUSH_ANNOUNCED)
            .remove(K_PUSH_ENROLLED_AT).remove(K_PUSH_STRIKE).remove(K_PUSH_MISSED)
            .putString(K_PUSH_RETIRING, json.encodeToString(ListSerializer(Retirement.serializer()), queued))
            .apply()
    }

    /**
     * Wake tokens still to be retired at their relay and the forwarder [G8, G9]. Survives
     * [clear], because an unpair is exactly when one is queued.
     */
    val retirements: List<Retirement>
        get() = prefs.getString(K_PUSH_RETIRING, null)
            ?.let { json.decodeFromString(ListSerializer(Retirement.serializer()), it) }
            ?: emptyList()

    @Synchronized
    fun updateRetirements(transform: (List<Retirement>) -> List<Retirement>) {
        val next = transform(retirements)
        prefs.edit().apply {
            if (next.isEmpty()) {
                remove(K_PUSH_RETIRING)
            } else {
                putString(K_PUSH_RETIRING, json.encodeToString(ListSerializer(Retirement.serializer()), next))
            }
        }.apply()
    }

    /**
     * The relay's last definite answer about its wake-up service: true, false, or null when
     * it has not been asked successfully. Only for the line on screen.
     */
    var relayForwarderKnown: Boolean?
        get() = if (prefs.contains(K_PUSH_RELAY_FWD)) prefs.getBoolean(K_PUSH_RELAY_FWD, false) else null
        set(value) = prefs.edit().apply {
            if (value == null) remove(K_PUSH_RELAY_FWD) else putBoolean(K_PUSH_RELAY_FWD, value)
        }.apply()

    // --- did the wakes arrive? [2026-10-02, SECURITY_REVIEW G10] ---
    // A phone on Google push has closed its own connection on the strength of its
    // enrolment, so a doorbell that never rings (P-9: the relay rings a different wake-up
    // service) costs it instant delivery. These are what WakeWatch reads to notice.

    /** When a wake last arrived (phone clock), or null. */
    val lastWakeAt: Long? get() = prefs.getLong(K_PUSH_LAST_WAKE, 0L).takeIf { it > 0L }

    /** When a first unannounced tab was found, or null. One strike; see WakeWatch. */
    val wakeStrikeAt: Long? get() = prefs.getLong(K_PUSH_STRIKE, 0L).takeIf { it > 0L }

    /** When wakes were judged to have stopped arriving, or null. StreamService runs while set. */
    val wakesMissedAt: Long? get() = prefs.getLong(K_PUSH_MISSED, 0L).takeIf { it > 0L }

    /**
     * A wake arrived: record it, and clear any strike or verdict against the doorbell,
     * because it rang [G10]. Returns whether a verdict was cleared, so the caller can stop
     * the connection the verdict started.
     */
    @Synchronized
    fun noteWakeArrived(at: Long): Boolean {
        val hadVerdict = prefs.contains(K_PUSH_MISSED)
        prefs.edit().putLong(K_PUSH_LAST_WAKE, at).remove(K_PUSH_STRIKE).remove(K_PUSH_MISSED).apply()
        return hadVerdict
    }

    /**
     * When a drain last reached the relay (phone clock), or null. Read before the current
     * drain records its own, so the judge sees the gap since the one before it.
     */
    var lastContactAt: Long?
        get() = prefs.getLong(K_PUSH_CONTACT, 0L).takeIf { it > 0L }
        set(value) = prefs.edit().apply {
            if (value == null) remove(K_PUSH_CONTACT) else putLong(K_PUSH_CONTACT, value)
        }.apply()

    /**
     * The relay's clock minus this phone's, from the `serverTime` its heartbeat answer
     * carries; 0 until a heartbeat has answered. Lets the missed-wake check compare a tab's
     * `createdAt` (the relay's clock) with a wake's arrival (this phone's) [G10].
     */
    var relayClockOffsetMs: Long
        get() = prefs.getLong(K_RELAY_CLOCK, 0L)
        set(value) = prefs.edit().putLong(K_RELAY_CLOCK, value).apply()

    /**
     * Record what WakeWatch decided, but only about the enrolment it was judging: a sync
     * may have replaced it since the drain began.
     */
    @Synchronized
    fun recordWakeVerdict(judgedWakeToken: String, strikeAt: Long?, missedAt: Long?) {
        if (wakeToken != judgedWakeToken) return
        prefs.edit().apply {
            if (strikeAt != null) putLong(K_PUSH_STRIKE, strikeAt)
            if (missedAt != null) putLong(K_PUSH_MISSED, missedAt)
        }.apply()
    }

    // --- device-local send prefs (MRU / primary) ---
    var sourcePrefs: SourcePrefs
        get() = prefs.getString(K_PREFS, null)?.let { json.decodeFromString(SourcePrefs.serializer(), it) }
            ?: SourcePrefs()
        set(value) = prefs.edit().putString(K_PREFS, json.encodeToString(SourcePrefs.serializer(), value)).apply()

    // --- idempotency seen-set ---
    var seen: List<SeenMessage>
        get() = prefs.getString(K_SEEN, null)
            ?.let { json.decodeFromString(ListSerializer(SeenMessage.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_SEEN, json.encodeToString(ListSerializer(SeenMessage.serializer()), value))
            .apply()

    // --- received-tabs inbox (P-7) ---
    // A received link used to live only in its notification, and the relay drops
    // the payload on ack, so a swipe lost the tab. This is the record that
    // outlives it, capped at Inbox.MAX.
    var inbox: List<InboxItem>
        get() = prefs.getString(K_INBOX, null)
            ?.let { json.decodeFromString(ListSerializer(InboxItem.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_INBOX, json.encodeToString(ListSerializer(InboxItem.serializer()), value))
            .apply()

    /**
     * Read-modify-write the inbox under a lock, for the same reason as
     * [updateOutbound]: the drain records arrivals while the open-trampoline
     * stamps a tab opened, and a lost update here would either resurrect a
     * dropped row or forget that the user opened one.
     */
    @Synchronized
    fun updateInbox(transform: (List<InboxItem>) -> List<InboxItem>) {
        inbox = transform(inbox)
    }

    // --- group history keyring [0028] ---
    // The SET of group keys this device holds, never one: an old key is what
    // keeps history written before a rotation readable, and they are 32 bytes
    // each. The relay never sees any of them.
    var groupKeys: List<GroupKeyRecord>
        get() = prefs.getString(K_GROUP_KEYS, null)
            ?.let { json.decodeFromString(ListSerializer(GroupKeyRecord.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_GROUP_KEYS, json.encodeToString(ListSerializer(GroupKeyRecord.serializer()), value))
            .apply()

    @Synchronized
    fun updateGroupKeys(transform: (List<GroupKeyRecord>) -> List<GroupKeyRecord>) {
        groupKeys = transform(groupKeys)
    }

    /**
     * `keyId:endpointId` pairs this device has already handed to the relay, so it
     * does not re-post the same copy on every wake. Local only — the relay dedupes
     * on the same id anyway, so a lost list costs a redundant POST and nothing
     * more.
     */
    var deliveredGroupKeys: List<String>
        get() = prefs.getString(K_GROUP_KEYS_SENT, null)
            ?.let { json.decodeFromString(ListSerializer(String.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_GROUP_KEYS_SENT, json.encodeToString(ListSerializer(String.serializer()), value))
            .apply()

    @Synchronized
    fun updateDeliveredGroupKeys(transform: (List<String>) -> List<String>) {
        deliveredGroupKeys = transform(deliveredGroupKeys)
    }

    // --- group history cache [0028] ---
    // The relay's list is authoritative; this is the copy the History screen
    // reads when the phone has no signal, capped at History.MAX.
    var history: List<HistoryItem>
        get() = prefs.getString(K_HISTORY, null)
            ?.let { json.decodeFromString(ListSerializer(HistoryItem.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_HISTORY, json.encodeToString(ListSerializer(HistoryItem.serializer()), value))
            .apply()

    /** Read-modify-write the cache under a lock: a drain and an open screen both refresh it. */
    @Synchronized
    fun updateHistory(transform: (List<HistoryItem>) -> List<HistoryItem>) {
        history = transform(history)
    }

    /**
     * Message ids this phone has already announced as never-arrived, so the
     * notification fires once rather than on every wake for the rest of the
     * relay's retention window.
     */
    var announcedNeverArrived: List<String>
        get() = prefs.getString(K_NEVER_ARRIVED, null)
            ?.let { json.decodeFromString(ListSerializer(String.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_NEVER_ARRIVED, json.encodeToString(ListSerializer(String.serializer()), value))
            .apply()

    @Synchronized
    fun updateAnnouncedNeverArrived(transform: (List<String>) -> List<String>) {
        announcedNeverArrived = transform(announcedNeverArrived)
    }

    // --- last-known group endpoints (so the share chooser works offline) ---
    // Writing the list also stamps WHEN it came from the relay: every writer has
    // just completed a listEndpoints, and `presence` is the part of the snapshot
    // that decays (see Chooser.presenceKnown). 0 means never recorded.
    var cachedEndpoints: List<Endpoint>
        get() = prefs.getString(K_ENDPOINTS, null)
            ?.let { json.decodeFromString(ListSerializer(Endpoint.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_ENDPOINTS, json.encodeToString(ListSerializer(Endpoint.serializer()), value))
            .putLong(K_ENDPOINTS_AT, System.currentTimeMillis())
            .apply()

    /**
     * Drop one device from the cached list (this phone just removed it) without
     * restamping it: the rest of the list is no fresher than it was.
     */
    @Synchronized
    fun dropCachedEndpoint(id: String) {
        val next = cachedEndpoints.filter { it.id != id }
        prefs.edit()
            .putString(K_ENDPOINTS, json.encodeToString(ListSerializer(Endpoint.serializer()), next))
            .apply()
    }

    /** When `cachedEndpoints` was last taken from the relay, epoch ms; 0 if unknown. */
    val cachedEndpointsAt: Long
        get() = prefs.getLong(K_ENDPOINTS_AT, 0L)

    // --- new devices (P-10) ---
    // The device ids in the last accepted list, and the joined devices not yet
    // answered. Device-local, never sent: an answer synced through the relay
    // could be given by a compromised relay. Wiped by [clear] with the pairing.
    var newDeviceWatch: NewDeviceWatch?
        get() = prefs.getString(K_NEW_DEVICES, null)
            ?.let { runCatching { json.decodeFromString(NewDeviceWatch.serializer(), it) }.getOrNull() }
        set(value) = prefs.edit().apply {
            if (value == null) {
                remove(K_NEW_DEVICES)
            } else {
                putString(K_NEW_DEVICES, json.encodeToString(NewDeviceWatch.serializer(), value))
            }
        }.apply()

    /**
     * Read-modify-write the record under a lock: a background drain and an open
     * screen can fetch the list at the same moment, and a lost update would
     * either announce a device twice or forget one the user has not answered.
     */
    @Synchronized
    fun <T> updateNewDeviceWatch(transform: (NewDeviceWatch?) -> Pair<NewDeviceWatch?, T>): T {
        val (next, out) = transform(newDeviceWatch)
        newDeviceWatch = next
        return out
    }

    // --- source-side outbound queue (send while offline) ---
    var outbound: List<OutboundItem>
        get() = prefs.getString(K_OUTBOUND, null)
            ?.let { json.decodeFromString(ListSerializer(OutboundItem.serializer()), it) }
            ?: emptyList()
        set(value) = prefs.edit()
            .putString(K_OUTBOUND, json.encodeToString(ListSerializer(OutboundItem.serializer()), value))
            .apply()

    /**
     * Read-modify-write the queue under a lock.
     *
     * The share activity and the drain/heartbeat workers all mutate this, all in
     * this one process, and they now overlap far more than they used to: a send
     * enqueues its item BEFORE the POST and removes it after, so a flush running
     * at the same moment can be holding a list that is already stale. Every
     * mutation goes through here so the last writer can't resurrect a drained
     * item or drop a freshly queued one. [Store] is a process singleton, so
     * locking the instance is enough.
     */
    @Synchronized
    fun updateOutbound(transform: (List<OutboundItem>) -> List<OutboundItem>) {
        outbound = transform(outbound)
    }

    // --- relay reachability verdict (fed by ordinary traffic, never a probe) ---
    // Persisted so a surface opened later can explain a standing outage instead
    // of rendering a healthy-looking cached device list.
    var relayHealth: RelayHealth?
        get() = prefs.getString(K_RELAY_HEALTH, null)
            ?.let { json.decodeFromString(RelayHealth.serializer(), it) }
        set(value) = prefs.edit().apply {
            if (value == null) {
                remove(K_RELAY_HEALTH)
            } else {
                putString(K_RELAY_HEALTH, json.encodeToString(RelayHealth.serializer(), value))
            }
        }.apply()

    /**
     * Wipe everything on unpair, except two things that outlive a pairing
     * [2026-10-02, SECURITY_REVIEW G5, G9]: "Don't use Google", which is about this phone
     * rather than the group, and the retirements still owed, which an unpair is what queues.
     */
    @Synchronized
    fun clear() {
        val avoid = if (prefs.contains(K_AVOID_GOOGLE)) prefs.getBoolean(K_AVOID_GOOGLE, false) else null
        val retiring = prefs.getString(K_PUSH_RETIRING, null)
        // An editor applies clear() before its puts, whatever the order they were called in.
        prefs.edit().clear().apply {
            if (avoid != null) putBoolean(K_AVOID_GOOGLE, avoid)
            if (retiring != null) putString(K_PUSH_RETIRING, retiring)
        }.apply()
    }

    /**
     * Unpair, or Start fresh: wipe the pairing and queue its wake token for retirement,
     * reading both in the same locked step as the wipe [G9, G11]. The token is told to the
     * relay left behind once, best effort, and revoked at the forwarder until that works.
     */
    @Synchronized
    fun leavePairing() {
        val token = wakeToken
        val reg = registration
        clear()
        // Anything already queued was waiting on this relay to accept `none`; with the pairing
        // gone, it is told once like the rest, or it could wait on a dead relay for ever.
        updateRetirements { list -> list.map { it.copy(relayMustAccept = false) } }
        if (token != null) {
            val relay = reg?.let { RelayRef(it.relayUrl, it.endpointId, it.deviceToken, it.certFingerprint) }
            updateRetirements { it + Retirement(token, relay, relayMustAccept = false) }
        }
    }

    companion object {
        private const val FILE = "tabsend.store"
        private const val K_PUB = "id.pub"
        private const val K_PRIV = "id.priv"
        private const val K_KEYID = "id.keyId"
        private const val K_ENDPOINT_ID = "reg.endpointId"
        private const val K_GROUP_ID = "reg.groupId"
        private const val K_TOKEN = "reg.token"
        private const val K_RELAY = "reg.relayUrl"
        private const val K_LABEL = "reg.label"
        private const val K_CERT_FP = "reg.certFp"
        private const val K_RELAY_ID = "reg.relayId"
        private const val K_INSTANT = "delivery.instant"
        private const val K_AVOID_GOOGLE = "delivery.avoidGoogle"
        private const val K_WAKE_TOKEN = "push.wakeToken"
        private const val K_PUSH_TOKEN = "push.fcmToken"
        private const val K_PUSH_ANNOUNCED = "push.announcedTo"
        private const val K_PUSH_ENROLLED_AT = "push.enrolledAt"
        private const val K_PUSH_RETIRING = "push.retiring"
        private const val K_PUSH_RELAY_FWD = "push.relayForwarder"
        private const val K_PUSH_LAST_WAKE = "push.lastWakeAt"
        private const val K_PUSH_STRIKE = "push.wakeStrikeAt"
        private const val K_PUSH_MISSED = "push.wakesMissedAt"
        private const val K_PUSH_CONTACT = "push.lastContactAt"
        private const val K_RELAY_CLOCK = "relay.clockOffsetMs"
        private const val K_PREFS = "prefs.source"
        private const val K_SEEN = "seen.set"
        private const val K_INBOX = "inbox.received"
        private const val K_GROUP_KEYS = "history.keys"
        private const val K_GROUP_KEYS_SENT = "history.keys.delivered"
        private const val K_HISTORY = "history.cache"
        private const val K_NEVER_ARRIVED = "history.announced"
        private const val K_ENDPOINTS = "endpoints.cache"
        private const val K_ENDPOINTS_AT = "endpoints.cache.at"
        private const val K_NEW_DEVICES = "endpoints.newDevices"
        private const val K_OUTBOUND = "outbound.queue"
        private const val K_RELAY_HEALTH = "relay.health"

        @Volatile
        private var instance: Store? = null

        fun get(context: Context): Store = instance ?: synchronized(this) {
            instance ?: Store(
                context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE),
            ).also { instance = it }
        }

        /** A store over any preferences, for the JVM tests. Never the app's singleton. */
        internal fun over(prefs: SharedPreferences): Store = Store(prefs)
    }
}
