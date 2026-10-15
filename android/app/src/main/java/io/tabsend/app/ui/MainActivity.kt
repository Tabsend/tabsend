package io.tabsend.app.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import com.google.android.material.color.MaterialColors
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import io.tabsend.app.AppScope
import io.tabsend.app.BuildConfig
import io.tabsend.app.R
import io.tabsend.app.databinding.ActivityMainBinding
import io.tabsend.app.logic.Chooser
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.InboxItem
import io.tabsend.app.logic.JoinErrors
import io.tabsend.app.logic.Labels
import io.tabsend.app.logic.NewDeviceNotice
import io.tabsend.app.logic.Pairing
import io.tabsend.app.logic.Protocol
import io.tabsend.app.logic.RelayMove
import io.tabsend.app.logic.isRelayDown
import io.tabsend.app.logic.minutesSinceLastOk
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.logic.relativeTime
import io.tabsend.app.net.ApiClient
import io.tabsend.app.net.ApiException
import io.tabsend.app.net.RelayHealthTracker
import io.tabsend.app.push.DeliveryMode
import io.tabsend.app.push.DeliveryReason
import io.tabsend.app.push.PushSetup
import io.tabsend.app.net.Registrar
import io.tabsend.app.net.StreamManager
import io.tabsend.app.receive.LinkPolicy
import io.tabsend.app.receive.NewDeviceWatcher
import io.tabsend.app.receive.StreamService
import io.tabsend.app.send.SendNotifications
import io.tabsend.app.send.Sender
import io.tabsend.app.send.ShareShortcuts
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import io.tabsend.app.work.Scheduling
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Single-activity home: pair this phone with one complete link or, once paired,
 * manage devices (mint a pairing link, rename, list the group, unpair).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val store by lazy { Store.get(this) }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best-effort */ }

    // QR pairing scanner (zxing, via QrScanActivity; it asks for the camera itself).
    private val qrScanner = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult // cancelled
        val link = Pairing.scannedLink(contents)
        if (link == null) {
            binding.joinStatus.text = "That QR code isn't a Tabsend pairing link."
            return@registerForActivityResult
        }
        // Keep the COMPLETE link. Reducing it to the secret here used to discard
        // the fp= certificate pin before doJoin reparsed the field.
        binding.pairingLinkInput.setText(link)
        binding.joinStatus.text = "Pairing link ready. Tap Pair this phone."
        // The link lands in the paste form, so open it: the Pair button lives there.
        revealPasteForm()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        requestNotificationsIfNeeded()
        handleDeepLink(intent)

        binding.buildInfo.text = "Tabsend ${BuildConfig.VERSION_NAME}"
        binding.joinBuildInfo.text = binding.buildInfo.text

        binding.joinButton.setOnClickListener { doJoin() }
        binding.scanQrButton.setOnClickListener { launchQrScanner() }
        binding.pasteLinkButton.setOnClickListener {
            revealPasteForm()
            binding.pairingLinkInput.requestFocus()
        }
        binding.howPairingButton.setOnClickListener { showHowPairingWorks() }
        binding.historyButton.setOnClickListener {
            startActivity(Intent(this, HistoryActivity::class.java))
        }
        binding.addDeviceButton.setOnClickListener { mintLink() }
        binding.renameButton.setOnClickListener { promptRename() }
        binding.relayMoveButton.setOnClickListener { promptMoveRelay() }
        binding.refreshButton.setOnClickListener { render(); heartbeatNow() }
        binding.unpairButton.setOnClickListener { confirmUnpair() }

        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDeepLink(intent)
    }

    override fun onResume() {
        super.onResume()
        // Re-render rather than only re-listing devices: a send from the share
        // sheet, or a queue that drained while we were backgrounded, both change
        // the waiting list and the outage line.
        if (store.isRegistered) showPaired()
        // Settle delivery whenever this screen comes back: a fallback decided in the
        // background may not have been allowed to start the service, and an enrolment that
        // failed earlier gets another try while someone is looking [G8, G10]. A screen in
        // front may start the service; the sync ends by doing so.
        settleDelivery { if (store.isRegistered) renderDeliveryMethod(PushSetup.state(this)) }
    }

    // --- rendering -----------------------------------------------------------

    private fun render() {
        if (store.isRegistered) showPaired() else showJoin()
    }

    private fun showJoin() {
        binding.joinCard.visibility = View.VISIBLE
        binding.pairedCard.visibility = View.GONE
        // The pairing screen sits on the generic ground (APP_UI "The signature moment").
        window.statusBarColor = getColor(R.color.ts_ground)

        if (binding.deviceNameInput.text.isNullOrBlank()) {
            binding.deviceNameInput.setText(defaultDeviceName())
        }
        // A link already in the field (a scan or deep link before an unpair, or a
        // failed attempt) keeps its form open, with the Pair button under it.
        if (!binding.pairingLinkInput.text.isNullOrBlank()) revealPasteForm()
    }

    /**
     * Open the paste path: the pairing-link field, the name field and the Pair button.
     * Hidden at first so the screen leads with scanning, which is the primary path;
     * opened by "Paste a pairing link instead", and by anything that fills the link in
     * (a scan, a pairing deep link), since the Pair button that completes it is here.
     */
    private fun revealPasteForm() {
        binding.pasteForm.visibility = View.VISIBLE
        binding.pasteLinkButton.visibility = View.GONE
    }

    private fun showHowPairingWorks() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.pairing_how)
            .setMessage(R.string.pairing_how_body)
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun showPaired() {
        binding.joinCard.visibility = View.GONE
        binding.pairedCard.visibility = View.VISIBLE
        window.statusBarColor = getColor(R.color.ts_phone_ground)

        val reg = store.registration ?: return
        binding.pairedTitle.text = "Linked as ${reg.label}"
        val state = PushSetup.state(this)
        val delivery = when (state.mode) {
            DeliveryMode.GOOGLE -> "instant (push, no notification)"
            DeliveryMode.OWN_CONNECTION -> "instant (connection kept open)"
            DeliveryMode.OFF -> "instant while the app is open, otherwise checked every few minutes"
        }
        binding.pairedInfo.text = "Relay: ${reg.relayUrl}\nDelivery: $delivery"

        // Instant delivery [0015, P-11]: one switch. Which mechanism honours it is the app's
        // decision, reported underneath rather than asked about.
        binding.instantSwitch.setOnCheckedChangeListener(null)
        binding.instantSwitch.isChecked = store.instantDelivery
        binding.instantSwitch.setOnCheckedChangeListener { _, checked ->
            store.instantDelivery = checked
            syncDelivery()
        }
        renderDeliveryMethod(state)
        renderSendState(reg)
        renderNewDevices()
        renderReceived()
        loadDevices()
    }

    /**
     * What the new-device watch asks this phone to look at [P-10], top to bottom: the
     * first-look card (one answer for the whole first list, GH6), one notice per device
     * that joined and then disappeared (GH7), and one card per device that joined and
     * has not been answered on this phone. They stay until answered, so a phone with
     * notifications off still finds out the next time this screen opens.
     */
    private fun renderNewDevices() {
        val review = NewDeviceWatcher.review(this)
        val vanished = NewDeviceWatcher.vanished(this)
        val pending = NewDeviceWatcher.pending(this)
        binding.newDevicesList.removeAllViews()
        binding.newDevicesList.visibility =
            if (review.isEmpty() && vanished.isEmpty() && pending.isEmpty()) View.GONE else View.VISIBLE
        if (review.isNotEmpty()) binding.newDevicesList.addView(reviewCard(review))
        for (notice in vanished) binding.newDevicesList.addView(vanishedCard(notice))
        for (notice in pending) binding.newDevicesList.addView(newDeviceCard(notice))
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** The amber card all three share. Fixed tint in both themes, so its text colour is fixed too. */
    private fun warningCard(title: String): LinearLayout {
        val warning = getColor(R.color.relay_warning)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_warning)
            setPadding(dp(16), dp(12), dp(16), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(16) }
        }
        card.addView(
            TextView(this).apply {
                text = title
                setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_TitleSmall)
                setTextColor(warning)
            }.also { androidx.core.view.ViewCompat.setAccessibilityHeading(it, true) },
        )
        return card
    }

    private fun warningBody(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium)
        setTextColor(getColor(R.color.relay_warning))
        setPadding(0, dp(4), 0, dp(4))
    }

    /** A Material 3 text button, quiet because the amber card already carries the weight. */
    private fun cardButton(text: String, color: Int, onClick: () -> Unit): MaterialButton =
        MaterialButton(this, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
            this.text = text
            setTextColor(color)
            setOnClickListener { onClick() }
        }

    /** Buttons end-aligned like a dialog's. */
    private fun buttonRow(vararg buttons: View): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.END
        for ((index, button) in buttons.withIndex()) {
            if (index > 0) {
                button.layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { marginStart = dp(8) }
            }
            addView(button)
        }
    }

    /** The first look (GH6): one card, one answer. A row per device, each with its own Remove. */
    private fun reviewCard(devices: List<NewDeviceNotice>): View {
        val warning = getColor(R.color.relay_warning)
        val card = warningCard(getString(R.string.review_title))
        card.addView(warningBody(getString(R.string.review_body)))
        for (device in devices) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }
            row.addView(
                TextView(this).apply {
                    text = device.label
                    setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium)
                    setTextColor(warning)
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                },
            )
            row.addView(
                cardButton(getString(R.string.review_remove), getColor(R.color.ts_danger)) {
                    confirmRemove(device.id, device.label)
                }.apply {
                    // So a screen reader says which device, not "Remove, Remove".
                    contentDescription = getString(R.string.review_remove_for, device.label)
                },
            )
            card.addView(row)
        }
        card.addView(
            buttonRow(
                cardButton(getString(R.string.review_confirm), warning) {
                    NewDeviceWatcher.confirmReview(this@MainActivity)
                    renderNewDevices()
                },
            ),
        )
        return card
    }

    /** A device that joined and then disappeared (GH7). Stays until dismissed. */
    private fun vanishedCard(notice: NewDeviceNotice): View {
        val card = warningCard(getString(R.string.vanished_title, notice.label))
        val time = NewDeviceWatcher.whenText(notice.createdAt)
        card.addView(
            warningBody(
                if (time != null) {
                    getString(R.string.vanished_body, time)
                } else {
                    getString(R.string.vanished_body_no_time)
                },
            ),
        )
        card.addView(
            buttonRow(
                cardButton(getString(R.string.vanished_dismiss), getColor(R.color.relay_warning)) {
                    NewDeviceWatcher.dismissVanished(this@MainActivity, notice.id)
                    renderNewDevices()
                },
            ),
        )
        return card
    }

    private fun newDeviceCard(notice: NewDeviceNotice): View {
        val card = warningCard(getString(R.string.new_device_title, notice.label))
        val time = NewDeviceWatcher.whenText(notice.createdAt)
        card.addView(
            warningBody(
                if (time != null) {
                    getString(R.string.new_device_banner_body, time)
                } else {
                    getString(R.string.new_device_banner_body_no_time)
                },
            ),
        )
        card.addView(
            buttonRow(
                cardButton(getString(R.string.new_device_remove), getColor(R.color.ts_danger)) {
                    confirmRemove(notice.id, notice.label)
                },
                cardButton(getString(R.string.new_device_confirm), getColor(R.color.relay_warning)) {
                    NewDeviceWatcher.confirm(this@MainActivity, notice.id)
                    renderNewDevices()
                },
            ),
        )
        return card
    }

    /**
     * The home screen's received panel: the newest few tabs this phone received,
     * from the same device-local inbox History reads [P-7]. Tapping one opens it
     * exactly as History does (link policy first, then marked opened); the full
     * list, and everything the rest of the group sent, stays one tap away.
     */
    private fun renderReceived() {
        val recent = store.inbox.take(RECEIVED_ON_HOME)
        binding.receivedList.removeAllViews()
        binding.receivedEmpty.visibility = if (recent.isEmpty()) View.VISIBLE else View.GONE
        recent.forEachIndexed { i, item ->
            if (i > 0) binding.receivedList.addView(DeviceRows.hairline(this))
            binding.receivedList.addView(receivedRow(item))
        }
    }

    private fun receivedRow(item: InboxItem): View {
        val density = resources.displayMetrics.density
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            minimumHeight = (56 * density).toInt()
            setPadding(0, (10 * density).toInt(), 0, (10 * density).toInt())
        }
        column.addView(
            TextView(this).apply {
                text = Feedback.heldTabLabel(item.title, item.url)
                setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
            },
        )
        column.addView(
            TextView(this).apply {
                text = getString(R.string.received_row_from, item.sourceLabel, relativeTime(item.sentAt))
                setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
            },
        )
        // Dimmed once opened, still listed: the same rule History follows.
        column.alpha = if (item.openedAt != null) 0.6f else 1f
        if (LinkPolicy.isOpenableWebUrl(item.url)) {
            DeviceRows.makeTappable(column) { openReceived(item) }
        }
        return column
    }

    private fun openReceived(item: InboxItem) {
        if (!LinkPolicy.isOpenableWebUrl(item.url)) return
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(item.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: ActivityNotFoundException) {
            return // no browser for it; nothing was opened, so nothing to mark
        }
        // Bookkeeping strictly after the link is away, as History and the notification do.
        store.updateInbox { list -> Inbox.markOpened(list, item.id, System.currentTimeMillis()) }
        renderReceived()
    }

    /**
     * The two send-side truths the home screen owes the user: whether the relay
     * is answering, and which tabs are still sitting here because it isn't.
     *
     * Kept as two blocks. The outage line explains a cause and is gated behind a
     * 30 s grace so a container restart isn't announced; the list is a fact about
     * this phone and shows whenever there is anything in it, outage or not — the
     * phone having been in a tunnel isn't an outage, but the tabs are waiting all
     * the same. Merging them would let one hide the other.
     *
     * Deliberately NOT merged with any "waiting for <device>" count either: that
     * counts tabs the relay already HAS and is holding for a sleeping target, and
     * its source is the relay's own outbox, which is unreachable exactly when
     * tabs start piling up here. During an outage it reads zero (§4b).
     */
    private fun renderSendState(reg: Registration) {
        val now = System.currentTimeMillis()
        val health = RelayHealthTracker.current(this)
        if (health != null && isRelayDown(health, now)) {
            binding.relayOutage.visibility = View.VISIBLE
            binding.relayOutage.text =
                Feedback.relayDownLine(reg.relayUrl, minutesSinceLastOk(health, now))
        } else {
            binding.relayOutage.visibility = View.GONE
        }

        // Newest first: the tab someone just tried to send is the one they are
        // looking for an explanation of.
        val held = store.outbound.sortedByDescending { parseIsoMillis(it.createdAt) ?: 0L }
        // This list and the "Waiting to send" notices in the shade are the same
        // claim on two surfaces, so they are reconciled together: anything the
        // list no longer shows must not still be sitting in the shade saying the
        // relay is unreachable. The flush workers do this too — here as well
        // because opening the app is the moment a stale notice is most obviously
        // wrong, and because nothing guarantees a worker ran first.
        //
        // Off the main thread and on the application context: reading the shade
        // back is a binder round trip carrying every posted notification, and
        // this runs on every resume. Nothing on screen waits for it, and it goes
        // on [AppScope] rather than `lifecycleScope` because housekeeping should
        // finish even if the user leaves the screen the moment it starts.
        val heldIds = held.map { it.id }
        val app = applicationContext
        AppScope.launch(Dispatchers.Default) {
            SendNotifications.reconcilePending(app, heldIds)
        }
        binding.heldTabsList.removeAllViews()
        val show = held.isNotEmpty()
        binding.heldTabsHeading.visibility = if (show) View.VISIBLE else View.GONE
        binding.heldTabsHint.visibility = if (show) View.VISIBLE else View.GONE
        // Only worth saying while something is actually at stake.
        binding.notificationsOffHint.visibility =
            if (show && !SendNotifications.enabled(this)) View.VISIBLE else View.GONE
        if (!show) return

        binding.heldTabsHeading.text = Feedback.heldTabsHeading(held.size)
        val density = resources.displayMetrics.density
        for (item in held) {
            // The row is now two columns: what is waiting, and the way out of the
            // wait. Until this the list was read-only, so a tab aimed at a relay
            // that was never coming back could only be watched.
            if (binding.heldTabsList.childCount > 0) {
                binding.heldTabsList.addView(DeviceRows.hairline(this))
            }
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                minimumHeight = (56 * density).toInt()
                setPadding(0, (8 * density).toInt(), 0, (8 * density).toInt())
            }
            // NOT named `text`: inside `TextView(this).apply { … }` a local of
            // that name shadows the TextView's own `text` property, so every
            // assignment below binds to this column instead and the file stops
            // compiling ("Val cannot be reassigned").
            val column = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            column.addView(
                TextView(this).apply {
                    text = Feedback.heldTabLabel(item.title, item.url)
                    setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
                },
            )
            // Naming the destination is the point of the row: "which tab, going
            // where". The label was captured when the send was made, since the
            // envelope is sealed and can't be asked who it was for.
            item.targetLabel?.let { label ->
                column.addView(
                    TextView(this).apply {
                        text = "to $label"
                        setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                    },
                )
            }
            row.addView(column)
            row.addView(cancelHeldButton(item.id))
            binding.heldTabsList.addView(row)
        }
    }

    /**
     * "Stop waiting" — abandon one held tab.
     *
     * Worded for what it can actually do. It is a pure local delete: nothing is
     * transmitted, because there is nothing to retract, and an item whose POST is
     * in flight at this instant may still land. "Cancel" would promise a reach
     * this has never had, on the one screen where the user is least able to check.
     *
     * A borderless button rather than a swipe: the list is a plain LinearLayout
     * of rows, and a hidden gesture on a screen someone opens once a month is a
     * feature nobody finds. Re-rendering afterwards is what also takes the tab's
     * "Waiting to send" notice out of the shade, since [renderSendState]
     * reconciles the notices against the queue it has just changed (§4d).
     */
    private fun cancelHeldButton(messageId: String): Button =
        Button(this, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
            text = getString(R.string.held_tab_cancel)
            // A text button in the accent colour, full touch height.
            setTextColor(getColor(R.color.ts_accent_fill))
            setAllCaps(false)
            minHeight = (48 * resources.displayMetrics.density).toInt()
            setOnClickListener {
                isEnabled = false
                Sender.cancelHeld(this@MainActivity, messageId)
                showPaired()
            }
        }

    // --- join ----------------------------------------------------------------

    private fun doJoin() {
        val parsed = Pairing.parse(binding.pairingLinkInput.text?.toString() ?: "")
        if (parsed == null) {
            binding.joinStatus.text = "Paste or scan a complete pairing link."
            return
        }
        val relay = parsed.relayUrl
        val deviceName = binding.deviceNameInput.text?.toString()?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: defaultDeviceName()

        binding.joinButton.isEnabled = false
        binding.joinStatus.text = "Linking…"

        lifecycleScope.launch {
            // Pairing needs nothing besides the relay [0015] — no push setup at all.
            try {
                // Handshake BEFORE registering: an incompatible relay answers /v1/config
                // perfectly well, so without this the mismatch only shows up later as a
                // rejected or malformed call and gets misread as the relay being down.
                // The pairing link may pin the relay's self-signed cert (P-3) —
                // every call from here on, preflight included, uses that pin.
                val config = withContext(Dispatchers.IO) { ApiClient(relay, parsed.certFingerprint).getConfig() }
                val compat = Protocol.check(config)
                if (Protocol.blocks(compat)) {
                    failJoin(Protocol.message(compat).orEmpty())
                    return@launch
                }
                Registrar.join(
                    this@MainActivity, relay, parsed.code, deviceName,
                    certFingerprint = parsed.certFingerprint,
                    relayId = config.relayId,
                )
                Scheduling.ensurePeriodicHeartbeat(this@MainActivity)
                Scheduling.enqueueDrain(this@MainActivity)
                Scheduling.armPoll(this@MainActivity)
                StreamManager.refresh(this@MainActivity) // fast path up right away
                // Start the default persistent connection immediately. Waiting for
                // the next app launch would leave a just-paired phone on polling.
                StreamService.sync(this@MainActivity)
                // An outdated-but-workable build pairs normally and says so after
                // the fact — the advisory rides along with success, never instead of it.
                val linked = Protocol.message(compat) ?: "Linked"
                Toast.makeText(this@MainActivity, linked, Toast.LENGTH_LONG).show()
                render()
            } catch (e: ApiException) {
                failJoin(
                    when (e.code) {
                        "invalid_pairing_code" -> "That pairing link is unknown, expired, or already used."
                        // The group is full [0030]. The relay's own message names the
                        // number, but `message` is written for a log and may change,
                        // and the fix is the same on every client — so this is one of
                        // the two codes answered in Tabsend's own words.
                        "limit_reached" -> Feedback.DEVICE_LIMIT_LINE
                        else -> "Relay refused the request: ${e.message}"
                    },
                )
            } catch (e: IOException) {
                // Covers the TLS failures too: SSLException and UnknownServiceException
                // both extend IOException, and telling them apart is the whole point —
                // see JoinErrors.
                failJoin(JoinErrors.message(e, relay, hadPin = parsed.certFingerprint != null))
            }
        }
    }

    /**
     * Land a failed join: show why, and re-arm the button as an explicit "Try again".
     * Every failure here is retryable in place — the scanned pairing link stays
     * in their fields — but the old button label gave no hint of that, so the
     * transient case (relay not up yet) read as a dead end.
     */
    private fun failJoin(reason: String) {
        binding.joinButton.isEnabled = true
        binding.joinButton.setText(R.string.join_retry_button)
        binding.joinStatus.text = reason
    }

    // --- paired: device management ------------------------------------------

    private fun loadDevices() {
        val reg = store.registration ?: return
        // Paint the last-known list straight away rather than leaving the section
        // empty for a round trip; the refresh below replaces it in place. Same
        // reasoning as the share chooser, minus the frozen browser.
        val cached = store.cachedEndpoints
        if (cached.isNotEmpty()) renderDevices(cached, reg.endpointId) else binding.devicesList.removeAllViews()
        lifecycleScope.launch {
            val endpoints = try {
                withContext(Dispatchers.IO) {
                    ApiClient.forRegistration(reg).listEndpoints(reg.deviceToken)
                        .also { NewDeviceWatcher.record(applicationContext, it) }
                }
            } catch (e: IOException) {
                store.cachedEndpoints
            }
            // The device list just changed on screen; the share sheet's Direct
            // Share row is built from the same list, so it changes with it.
            ShareShortcuts.sync(this@MainActivity, endpoints)
            renderDevices(endpoints, reg.endpointId)
            // The fetch may have found a new device, or lost one with a notice.
            renderNewDevices()
        }
    }

    private fun renderDevices(endpoints: List<Endpoint>, selfId: String) {
        binding.devicesList.removeAllViews()
        // Presence is only claimable while the snapshot it came from is recent;
        // this list is painted from cache first and again after a fetch that may
        // have failed, so an unreachable relay must not leave green dots behind.
        val known = Chooser.presenceKnown(store.cachedEndpointsAt, System.currentTimeMillis())
        // The device sends go to first (the chooser's own primary), marked "Main".
        val mainId = store.sourcePrefs.primaryTargetId
        // Plain Material list rows, no dividers: the icon containers separate them.
        endpoints.sortedBy { it.label.lowercase() }.forEach { ep ->
            // A word for every state; green only for the one that is a live fact.
            val (status, color) = when {
                ep.id == selfId -> getString(R.string.device_this_phone) to R.color.ts_phone_muted
                !known -> getString(R.string.device_status_unknown) to R.color.ts_phone_muted
                ep.presence == "online" -> getString(R.string.device_status_online) to R.color.ts_success
                else -> getString(R.string.device_status_offline) to R.color.ts_phone_muted
            }
            val row = DeviceRows.row(
                this,
                name = ep.label,
                kind = ep.kind,
                isMain = ep.id == mainId && ep.id != selfId,
                detail = DeviceRows.detail(this, ep.kind, status, color),
            )
            // Every other device can be removed from here [P-10]; this phone
            // leaves with Unpair instead, which also wipes what it holds.
            if (ep.id != selfId) {
                DeviceRows.makeTappable(row) { confirmRemove(ep.id, ep.label) }
                androidx.core.view.ViewCompat.replaceAccessibilityAction(
                    row,
                    androidx.core.view.accessibility.AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK,
                    getString(R.string.device_row_remove_hint),
                    null,
                )
            }
            binding.devicesList.addView(row)
        }
    }

    /**
     * Remove another device: the same question the extension and the console
     * ask, then the relay's DELETE. Used by a device row and by the
     * new-device banner's "Remove it".
     */
    private fun confirmRemove(endpointId: String, label: String) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.remove_device_title, label))
            .setMessage(getString(R.string.remove_device_body, label))
            .setPositiveButton(R.string.remove_device_action) { _, _ -> removeDevice(endpointId, label) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun removeDevice(endpointId: String, label: String) {
        val reg = store.registration ?: return
        if (endpointId == reg.endpointId) return // never this phone; Unpair is the way out
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    ApiClient.forRegistration(reg).deleteEndpoint(reg.deviceToken, endpointId)
                }
            } catch (e: ApiException) {
                toastLong(getString(R.string.remove_device_refused, label, e.message.orEmpty()))
                return@launch
            } catch (e: IOException) {
                toastLong(getString(R.string.remove_device_offline, label))
                return@launch
            }
            NewDeviceWatcher.removed(this@MainActivity, endpointId)
            val remaining = store.cachedEndpoints
            ShareShortcuts.sync(this@MainActivity, remaining)
            renderNewDevices()
            renderDevices(remaining, reg.endpointId)
            Toast.makeText(this@MainActivity, getString(R.string.remove_device_done, label), Toast.LENGTH_SHORT).show()
        }
    }

    private fun toastLong(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    private fun mintLink() {
        val reg = store.registration ?: return
        lifecycleScope.launch {
            try {
                val resp = withContext(Dispatchers.IO) { ApiClient.forRegistration(reg).mintPairing(reg.deviceToken) }
                showPairingDialog(resp.browserLink ?: resp.link)
            } catch (e: ApiException) {
                // ApiException is an IOException for transport callers, but it means
                // the relay DID answer. Do not send a stale-token or authorization
                // failure down the "couldn't reach" path.
                val message = when (e.code) {
                    "endpoint_removed" ->
                        "This phone was removed from the group. Pair it again before adding another device."
                    "unauthorized" ->
                        "This phone's relay access is no longer valid. Pair it again before adding another device."
                    else -> "The relay refused to create a pairing link: ${e.message.orEmpty()}"
                }
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
            } catch (e: IOException) {
                // TLS failures also extend IOException. Reuse the join classifier
                // so a changed certificate is diagnosed rather than called offline.
                Toast.makeText(
                    this@MainActivity,
                    JoinErrors.message(
                        e,
                        reg.relayUrl,
                        hadPin = reg.certFingerprint != null,
                        retryAction = "tap Pair a device again",
                    ),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    private fun showPairingDialog(link: String) {
        val message = "Browser pairing link:\n$link\n\nPaste this into the Tabsend extension. A phone can also paste it; the app will select the secure phone route automatically."
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.add_device)
            .setMessage(message)
            .setPositiveButton("Copy link") { _, _ -> copyToClipboard("Tabsend pairing link", link) }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun promptRename() {
        val reg = store.registration ?: return
        val input = EditText(this).apply {
            setText(reg.label)
            setSelection(text.length)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Rename this device")
            .setView(input)
            .setPositiveButton("Save") { _, _ ->
                val label = input.text.toString().trim()
                if (label.isEmpty()) return@setPositiveButton
                lifecycleScope.launch {
                    try {
                        Registrar.rename(this@MainActivity, label)
                        render()
                    } catch (e: IOException) {
                        Toast.makeText(this@MainActivity, "Couldn't reach the relay to rename.", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // --- paired: move to another relay (P-4, merged 2026-07-29) --------------

    /**
     * One field, a Check, one verdict, exactly one matching action — the Android
     * mirror of the extension's rewrite (extension/src/pages/options.ts,
     * renderRelayMove). The old shape was two buttons that asked the person to
     * classify their own situation before the app would verify it; the app can
     * already tell (relayId plus an authenticated probe, ADR-0020 / [RelayMove]),
     * so it answers instead of asking.
     *
     * The dialog's positive button starts as "Check" and is NOT wired through
     * `setPositiveButton`'s auto-dismissing lambda, because it has to survive the
     * check, relabel itself to the action that matched the verdict, and only
     * dismiss once that action actually commits.
     */
    private fun promptMoveRelay() {
        val reg = store.registration ?: return
        val density = resources.displayMetrics.density
        val input = EditText(this).apply {
            setText(reg.relayUrl)
            setSelection(text.length)
            hint = getString(R.string.relay_move_hint)
        }
        val status = TextView(this).apply {
            setPadding(0, (12 * density).toInt(), 0, 0)
            visibility = View.GONE
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
            addView(status)
        }

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.relay_move_title)
            .setView(container)
            .setPositiveButton(R.string.relay_move_check, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()

        dialog.setOnShowListener {
            val actionButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            val errorColor = MaterialColors.getColor(status, com.google.android.material.R.attr.colorError)
            var commit: (() -> Unit)? = null

            fun setStatus(text: String, color: Int) {
                status.visibility = View.VISIBLE
                status.text = text
                status.setTextColor(color)
            }

            fun runCheck() {
                val candidate = input.text.toString().trim().trimEnd('/')
                if (candidate.isEmpty()) {
                    setStatus(getString(R.string.relay_move_empty), errorColor)
                    return
                }
                actionButton.isEnabled = false
                commit = null
                actionButton.setText(R.string.relay_move_check)
                setStatus(getString(R.string.relay_move_checking), getColor(R.color.ts_phone_muted))
                lifecycleScope.launch {
                    val verdict = probeRelay(reg, candidate)
                    actionButton.isEnabled = true
                    when (verdict) {
                        is RelayMove.Verdict.Same -> {
                            setStatus(
                                if (verdict.verified) {
                                    getString(R.string.relay_move_same)
                                } else {
                                    getString(R.string.relay_move_same_unverified)
                                },
                                getColor(R.color.ts_success),
                            )
                            actionButton.setText(R.string.relay_move_switch)
                            commit = { commitAddressSwitch(reg, candidate, dialog, status, errorColor) }
                        }
                        is RelayMove.Verdict.Different -> {
                            setStatus(getString(R.string.relay_move_different), getColor(R.color.relay_warning))
                            actionButton.setText(R.string.relay_move_start_fresh)
                            commit = {
                                dialog.dismiss()
                                confirmStartFresh(candidate)
                            }
                        }
                        is RelayMove.Verdict.Unreachable ->
                            setStatus(getString(R.string.relay_move_unreachable, candidate), errorColor)
                        is RelayMove.Verdict.Error ->
                            setStatus(verdict.detail, errorColor)
                    }
                }
            }

            actionButton.setOnClickListener {
                val action = commit
                if (action != null) action() else runCheck()
            }
            // A verdict describes the address just checked, not whatever is being
            // typed now — the moment the field changes, the button reverts to
            // "Check" rather than committing to a stale finding.
            input.doAfterTextChanged {
                if (commit != null) {
                    commit = null
                    actionButton.setText(R.string.relay_move_check)
                    status.visibility = View.GONE
                }
            }
        }
        dialog.show()
    }

    /**
     * The network half of the classification: GET /v1/config, then [RelayMove]'s
     * pure functions decide from there. The relayId comparison runs BEFORE any
     * token leaves the phone — on a definitive mismatch the token probe is
     * skipped entirely, matching [RelayMove.byRelayId]'s contract.
     */
    private suspend fun probeRelay(reg: Registration, candidate: String): RelayMove.Verdict {
        val api = ApiClient(candidate, reg.certFingerprint)
        val config = try {
            withContext(Dispatchers.IO) { api.getConfig() }
        } catch (e: ApiException) {
            return RelayMove.Verdict.Error(candidate, getString(R.string.relay_move_refused, e.message.orEmpty()))
        } catch (e: IOException) {
            return RelayMove.Verdict.Unreachable(candidate)
        }
        val check = Protocol.check(config)
        if (Protocol.blocks(check)) {
            return RelayMove.Verdict.Error(candidate, Protocol.message(check).orEmpty())
        }
        RelayMove.byRelayId(candidate, reg.relayId, config.relayId)?.let { return it }
        return try {
            withContext(Dispatchers.IO) { api.listEndpoints(reg.deviceToken) }
            RelayMove.byTokenProbe(candidate, reg.relayId, config.relayId, tokenRejected = false)
        } catch (e: ApiException) {
            if (e.status == 401) {
                RelayMove.byTokenProbe(candidate, reg.relayId, config.relayId, tokenRejected = true)
            } else {
                RelayMove.Verdict.Error(candidate, getString(R.string.relay_move_refused, e.message.orEmpty()))
            }
        } catch (e: IOException) {
            RelayMove.Verdict.Unreachable(candidate)
        }
    }

    /**
     * Commit the address swap: same relay, so the group is untouched. Re-runs
     * both calls rather than trusting the earlier probe outright — the world can
     * move between Check and this tap (the relay restarts on an empty database,
     * say) — which is cheap since it's the same two calls again.
     */
    private fun commitAddressSwitch(
        reg: Registration,
        relayUrl: String,
        dialog: AlertDialog,
        status: TextView,
        errorColor: Int,
    ) {
        val actionButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
        actionButton.isEnabled = false
        lifecycleScope.launch {
            try {
                val api = ApiClient(relayUrl, reg.certFingerprint)
                val config = withContext(Dispatchers.IO) { api.getConfig() }
                withContext(Dispatchers.IO) { api.listEndpoints(reg.deviceToken) }
                store.updateRelay(relayUrl, config.relayId)
                // The stored verdict is about the OLD address; keeping it would
                // let a healthy new relay render as a standing outage.
                RelayHealthTracker.reset()
                showPaired() // refreshes pairedInfo (and re-lists devices)
                StreamManager.restart(this@MainActivity) // drop the old-URL socket now
                dialog.dismiss()
                Toast.makeText(
                    this@MainActivity,
                    getString(R.string.relay_move_done, relayUrl),
                    Toast.LENGTH_LONG,
                ).show()
            } catch (e: ApiException) {
                actionButton.isEnabled = true
                status.text = getString(R.string.relay_move_commit_failed, e.message.orEmpty())
                status.setTextColor(errorColor)
            } catch (e: IOException) {
                actionButton.isEnabled = true
                status.text = getString(
                    R.string.relay_move_commit_failed,
                    getString(R.string.relay_move_unreachable, relayUrl),
                )
                status.setTextColor(errorColor)
            }
        }
    }

    /**
     * Leave for a different relay. Confirmed, because this is the one
     * irreversible branch: the group stays behind and every device re-pairs.
     * The new relay still requires its own complete pairing link. The checked
     * address is useful confirmation here, but cannot replace that relay's
     * one-time credential and optional TLS trust pin.
     */
    private fun confirmStartFresh(relayUrl: String) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.relay_move_start_fresh_confirm_title, relayUrl))
            .setMessage(R.string.relay_move_start_fresh_confirm_body)
            .setPositiveButton(R.string.relay_move_start_fresh) { _, _ ->
                leaveGroup()
                binding.joinStatus.text =
                    "Paste or scan a pairing link created by that relay."
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * The one line under the switch saying which way instant delivery went, plus the single
     * action that changes it [P-11 option C].
     *
     * The action is offered only where it means something: a phone with no Google services,
     * or a relay with no wake-up service, has nothing to choose between, so showing a button
     * that cannot change the outcome would be worse than showing none.
     */
    private fun renderDeliveryMethod(state: io.tabsend.app.push.DeliveryState) {
        if (state.mode == DeliveryMode.OFF) {
            binding.instantStatus.visibility = View.GONE
            binding.instantMethodButton.visibility = View.GONE
            binding.instantSecondaryButton.visibility = View.GONE
            return
        }

        binding.instantStatus.visibility = View.VISIBLE
        binding.instantStatus.setText(
            when (state.reason) {
                DeliveryReason.GOOGLE_ACTIVE -> R.string.instant_via_google
                DeliveryReason.GOOGLE_REFUSED -> R.string.instant_via_own_no_google
                DeliveryReason.GOOGLE_UNAVAILABLE -> R.string.instant_via_own_unavailable
                DeliveryReason.GOOGLE_NOT_BUILT -> R.string.instant_via_own_not_built
                DeliveryReason.NO_FORWARDER -> R.string.instant_via_own_no_forwarder
                DeliveryReason.GOOGLE_PENDING -> R.string.instant_via_own_pending
                DeliveryReason.GOOGLE_NOT_ARRIVING -> R.string.instant_via_own_wakes_stopped
                DeliveryReason.DISABLED -> R.string.instant_via_own_connection
            }
        )

        // Wakes stopped arriving [G10]: two answers. Try again once whatever stopped them is
        // fixed, or give Google up, which this phone is still registered with.
        if (state.reason == DeliveryReason.GOOGLE_NOT_ARRIVING) {
            binding.instantMethodButton.visibility = View.VISIBLE
            binding.instantMethodButton.setText(R.string.instant_retry_google)
            binding.instantMethodButton.setOnClickListener { retryGooglePush() }
            binding.instantSecondaryButton.visibility = View.VISIBLE
            binding.instantSecondaryButton.setText(R.string.instant_avoid_google)
            binding.instantSecondaryButton.setOnClickListener {
                store.avoidGoogle = true
                syncDelivery()
            }
            return
        }
        binding.instantSecondaryButton.visibility = View.GONE

        val offerOptOut = state.reason == DeliveryReason.GOOGLE_ACTIVE ||
            state.reason == DeliveryReason.GOOGLE_PENDING
        val offerOptIn = state.reason == DeliveryReason.GOOGLE_REFUSED
        binding.instantMethodButton.visibility =
            if (offerOptOut || offerOptIn) View.VISIBLE else View.GONE
        if (offerOptOut || offerOptIn) {
            binding.instantMethodButton.setText(
                if (offerOptOut) R.string.instant_avoid_google else R.string.instant_allow_google
            )
            binding.instantMethodButton.setOnClickListener {
                store.avoidGoogle = offerOptOut
                syncDelivery()
            }
        }
    }

    /**
     * "Try Google push again" [G10]: a fresh enrolment, and a fresh watch for wakes. When it
     * could not get through, say so: the line would otherwise sit unchanged, as if the tap
     * had done nothing.
     */
    private fun retryGooglePush() {
        binding.instantMethodButton.isEnabled = false
        val app = applicationContext
        AppScope.launch {
            val settled = PushSetup.retryGoogle(app)
            if (isFinishing || isDestroyed) return@launch
            binding.instantMethodButton.isEnabled = true
            if (settled.mode != DeliveryMode.GOOGLE) {
                Toast.makeText(this@MainActivity, R.string.instant_retry_failed, Toast.LENGTH_LONG).show()
            }
            if (store.isRegistered) showPaired()
        }
    }

    /**
     * Run a sync in the app-wide scope, so leaving the screen cannot cancel it half-way
     * (a setting stored but not applied), then [after] on this screen if it is still here.
     */
    private fun settleDelivery(after: () -> Unit) {
        val app = applicationContext
        AppScope.launch {
            PushSetup.sync(app)
            if (!isFinishing && !isDestroyed) after()
        }
    }

    /**
     * Apply a delivery-settings change, then redraw once it has settled.
     *
     * Off the main thread because settling may enrol at the forwarder and heartbeat the
     * relay. The line redraws immediately from stored state too, so the switch never looks
     * stuck while the network is being waited on.
     */
    private fun syncDelivery() {
        renderDeliveryMethod(PushSetup.state(this))
        settleDelivery { if (store.isRegistered) showPaired() }
    }

    private fun heartbeatNow() {
        if (store.isRegistered) Scheduling.enqueueHeartbeat(this)
    }

    private fun confirmUnpair() {
        // A plain "leave the group" action — moving to a different relay has its
        // own flow now ("Move to another relay…" above). Rejoining still requires
        // a newly minted link; a remembered address is not a credential.
        MaterialAlertDialogBuilder(this)
            .setTitle("Unpair this phone?")
            .setMessage("This phone stops receiving links and leaves the group.")
            .setPositiveButton("Unpair") { _, _ ->
                leaveGroup()
                binding.joinStatus.text = "Paste or scan a new pairing link to pair again."
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /**
     * Leave the group: Unpair and Start fresh both end here [2026-10-02, SECURITY_REVIEW G9].
     *
     * Start fresh used to skip the clean-up Unpair did, so the relay left behind kept a live
     * wake token and rang this phone through Google on every send to its orphaned entry,
     * for as long as it ran. The wake token is read and queued for retirement in the same
     * locked step as the wipe, and the retirement then runs off the main thread under the
     * push lock, retried later if this phone is offline now.
     */
    private fun leaveGroup() {
        Scheduling.cancelAll(this)
        store.leavePairing()
        ShareShortcuts.clear(this) // no group, so no device may keep a share-sheet slot
        // The queue went with the store, so every promise made about it
        // is now unkeepable and must not be left standing in the shade.
        SendNotifications.clearAll(this)
        RelayHealthTracker.reset()
        StreamService.sync(this)    // stops the instant-delivery service
        StreamManager.refresh(this) // drops the fast-path socket
        val app = applicationContext
        // Fire and forget: nothing on screen depends on the outcome, and what fails now is
        // retried at the next start.
        AppScope.launch { PushSetup.sync(app) }
        render()
    }

    // --- helpers -------------------------------------------------------------

    private companion object {
        /** How many received tabs the home card shows; History has the rest. */
        const val RECEIVED_ON_HOME = 3
    }

    /**
     * Consumer-facing default: the device name from Settings ("Galaxy S24", or
     * whatever the user renamed their phone to), falling back to make + model.
     */
    private fun defaultDeviceName(): String {
        val settingsName = try {
            Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)
        } catch (e: SecurityException) {
            null // some OEM builds gate this; the fallback is fine
        }
        return Labels.defaultDeviceLabel(settingsName, Build.MANUFACTURER, Build.MODEL)
    }

    private fun launchQrScanner() {
        qrScanner.launch(
            ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt("Point the camera at the pairing QR code")
                setBeepEnabled(false)
                setCaptureActivity(QrScanActivity::class.java)
            },
        )
    }

    private fun handleDeepLink(intent: Intent?) {
        val data = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data ?: return
        val link = Pairing.scannedLink(data.toString()) ?: return
        binding.pairingLinkInput.setText(link)
        binding.joinStatus.text = "Pairing link ready. Tap Pair this phone."
        revealPasteForm()
    }

    private fun requestNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun copyToClipboard(label: String, text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
    }
}
