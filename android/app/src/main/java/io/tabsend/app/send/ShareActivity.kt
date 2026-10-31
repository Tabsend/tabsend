package io.tabsend.app.send

import android.app.Dialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.widget.NestedScrollView
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomsheet.BottomSheetDragHandleView
import io.tabsend.app.AppScope
import io.tabsend.app.R
import io.tabsend.app.databinding.ViewSendToastBinding
import io.tabsend.app.logic.Chooser
import io.tabsend.app.logic.ChooserRow
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.SendBanner
import io.tabsend.app.logic.SendFailure
import io.tabsend.app.logic.SendTone
import io.tabsend.app.logic.ShortcutPlan
import io.tabsend.app.logic.isoOf
import io.tabsend.app.net.ApiClient
import io.tabsend.app.receive.GroupResetWatcher
import io.tabsend.app.receive.NewDeviceWatcher
import io.tabsend.app.store.Store
import io.tabsend.app.ui.DeviceRows
import io.tabsend.app.ui.MainActivity
import io.tabsend.app.ui.SystemBars
import io.tabsend.app.wire.SendPayload
import io.tabsend.app.work.Scheduling
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.lang.ref.WeakReference

/**
 * The OS share-sheet target: "Send to Tabsend" appears when sharing a URL from any
 * browser. Shows the group's endpoints (self + consoles excluded, MRU-ordered,
 * presence shown) in a bottom sheet and, on pick, seals + POSTs and shows the send
 * feedback (docs/APP_UI.md; on Android a snackbar-style bar, still called the
 * "toast" in code) while it does: "Sending to X…", then the real outcome. Anything
 * that outlives the toast is reported as a notification (logic/SendFeedback,
 * send/SendNotifications), and if the toast is gone before the outcome arrives the
 * notification carries all of it, exactly as before the toast existed.
 *
 * The sheet may also name a device up front, when the share came from one of the
 * per-device Sharing Shortcuts ([ShareShortcuts]). That is the same intent with a
 * shortcut id attached, and the only difference it makes is skipping the chooser
 * dialog below — capture, seal, send and feedback are one path either way.
 */
class ShareActivity : AppCompatActivity() {

    /** True from the moment a device is picked; guards double taps and recreation. */
    private var sendStarted = false

    /** The toast's views, once a pick has turned this window into the toast. */
    private var toastBinding: ViewSendToastBinding? = null

    private val finishRunnable = Runnable { finish() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Recreated after a pick (rotation is handled in the manifest, but a theme
        // or font-scale change still recreates). The send is already in flight on
        // AppScope and will report through a notification, since the toast it was
        // talking to is gone; offering the chooser again would invite a duplicate.
        if (savedInstanceState?.getBoolean(KEY_SEND_STARTED) == true) {
            finish()
            return
        }

        val url = extractUrl(intent)
        if (url == null) {
            toast(Feedback.failureLine(SendFailure.NothingToSend))
            finish()
            return
        }

        val store = Store.get(this)
        if (!store.isRegistered) {
            toast(Feedback.noDevices())
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        val title = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        val payload = SendPayload(url = url, title = title, sentAt = isoOf(System.currentTimeMillis()))
        val reg = store.registration!!

        // This window is translucent, so the sharing app (e.g. Firefox) stays
        // frozen on screen behind it until we post a first frame — the chooser
        // can't wait on the network for that. Store already keeps the last-known
        // endpoint list around for offline sends, so paint from it immediately;
        // only fall through to a network wait when there's no cache to paint yet.
        val cachedRows = Chooser.build(
            store.cachedEndpoints,
            reg.endpointId,
            store.sourcePrefs,
            System.currentTimeMillis(),
            store.cachedEndpointsAt,
        )

        // A Direct Share pick already named the device, so the chooser is not on
        // the critical path — and neither is the network, since the cached list
        // can resolve the name outright. This is the same "don't make the sharing
        // app wait on a round trip" rule as the cached first paint, applied to the
        // one case that has nothing left to ask.
        val wanted = shortcutTargetId()
        if (wanted != null) {
            val picked = cachedRows.firstOrNull { it.endpoint.id == wanted }
            if (picked != null) {
                send(picked, payload)
                return
            }
        } else if (cachedRows.isNotEmpty()) {
            showChooser(cachedRows, payload)
        }

        lifecycleScope.launch {
            val endpoints = try {
                withContext(Dispatchers.IO) { ApiClient.forRegistration(reg).listEndpoints(reg.deviceToken) }
                    .also { NewDeviceWatcher.record(this@ShareActivity, it) }
            } catch (e: IOException) {
                store.cachedEndpoints // fall back to the last-known list (still sendable; queues)
            }

            ShareShortcuts.sync(this@ShareActivity, endpoints)

            // The reset that waits is asked for wherever the device list is [P-18
            // item 12]. Off the share's path and on the app's scope: the sheet closes
            // the moment a device is picked, and this needs no screen.
            val appContext = applicationContext
            AppScope.launch(Dispatchers.IO) {
                GroupResetWatcher.check(appContext, ApiClient.forRegistration(reg), reg)
            }

            if (wanted == null && cachedRows.isNotEmpty()) return@launch // already showing the cached list

            // A successful fetch restamped the cache, so this reads as fresh; a
            // failed one leaves the old stamp and the rows come back unknown.
            val rows = Chooser.build(
                endpoints,
                reg.endpointId,
                store.sourcePrefs,
                System.currentTimeMillis(),
                store.cachedEndpointsAt,
            )
            if (rows.isEmpty()) {
                toast(Feedback.noDevices())
                finish()
                return@launch
            }

            // The pick named a device the cache didn't have. If the fresh list
            // doesn't have it either — unpaired since the row was published — fall
            // through to the chooser rather than guess at a substitute; sending a
            // tab to the wrong device is not a recoverable mistake.
            if (wanted != null) {
                val picked = rows.firstOrNull { it.endpoint.id == wanted }
                if (picked != null) {
                    send(picked, payload)
                    return@launch
                }
                toast("That device isn't in your group any more — pick another.")
            }
            showChooser(rows, payload)
        }
    }

    /** Held so the tap can take it down before `finish()`, rather than leaving the OS to. */
    private var chooser: Dialog? = null

    /**
     * The device picker, as a Material bottom sheet (docs/APP_UI.md "Phones:
     * native-leaning"): a drag handle, the title, one muted line naming the tab
     * being sent, then the home screen's device rows, each a full-width tap target.
     * Dragging it away or tapping outside cancels, which closes the share, exactly
     * as cancelling the old dialog did.
     */
    private fun showChooser(rows: List<ChooserRow>, payload: SendPayload) {
        if (sendStarted) return
        val density = resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()

        val sheet = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        sheet.addView(
            BottomSheetDragHandleView(this),
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { gravity = android.view.Gravity.CENTER_HORIZONTAL },
        )
        sheet.addView(
            TextView(this).apply {
                setText(R.string.share_chooser_title)
                setTextAppearance(R.style.TextAppearance_Tabsend_SheetTitle)
                setPadding(dp(24), 0, dp(24), dp(4))
            }.also { ViewCompat.setAccessibilityHeading(it, true) },
        )

        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), 0, dp(24), dp(16))
        }
        list.addView(
            TextView(this).apply {
                text = Feedback.heldTabLabel(payload.title, payload.url)
                setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                setPadding(0, 0, 0, dp(8))
            },
        )
        // Plain Material list rows, no dividers: the icon containers separate them.
        rows.forEach { row ->
            // Presence we can't currently check (the list is painted from cache,
            // and the relay may not have answered in hours) says so in words. A
            // green "Online" there would be the same lie the extension popup told.
            val (status, color) = when {
                !row.presenceKnown -> getString(R.string.device_status_unknown) to R.color.ts_phone_muted
                row.online -> getString(R.string.device_status_online) to R.color.ts_success
                row.stale -> getString(R.string.device_status_inactive) to R.color.ts_phone_muted
                else -> getString(R.string.device_status_offline) to R.color.ts_phone_muted
            }
            val view = DeviceRows.row(
                this,
                name = row.endpoint.label,
                kind = row.endpoint.kind,
                isMain = row.isPrimary,
                detail = DeviceRows.detail(this, row.endpoint.kind, status, color),
            )
            DeviceRows.makeTappable(view) { send(row, payload) }
            list.addView(view)
        }

        // A nested-scrolling container, so a long list scrolls inside the sheet
        // instead of fighting the sheet's own drag.
        sheet.addView(
            NestedScrollView(this).apply { addView(list) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
        )

        chooser = BottomSheetDialog(this).apply {
            setContentView(sheet)
            // Open fully: a half-open picker hides devices behind a drag.
            behavior.skipCollapsed = true
            behavior.state = BottomSheetBehavior.STATE_EXPANDED
            setOnCancelListener { finish() }
            show()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(KEY_SEND_STARTED, sendStarted)
    }

    override fun onDestroy() {
        chooser?.dismiss()
        chooser = null
        toastBinding?.root?.removeCallbacks(finishRunnable)
        toastBinding = null
        super.onDestroy()
    }

    /**
     * Take the chooser down, show "Sending to X…", then send and report.
     *
     * This window stays up as the toast now, which it deliberately did not before:
     * it used to `finish()` first so the sharing app wasn't held frozen behind it
     * for a round trip with nothing to show. The toast IS the thing to show, so the
     * wait is no longer blank, and a tap anywhere outside the card (or Back) still
     * lets the person leave at once. Nothing rides on this activity staying alive —
     * [Sender] queues the item BEFORE the POST and only dequeues on a definite
     * answer, so even a process death here costs nothing but a delay.
     *
     * [AppScope] rather than `lifecycleScope`, which `finish()` cancels. The toast
     * is reached through a weak reference: when it is already gone the outcome goes
     * to a notification, the same surface it always had.
     */
    private fun send(row: ChooserRow, payload: SendPayload) {
        if (sendStarted) return // a second tap on the list while it is closing
        sendStarted = true
        val app = applicationContext
        chooser?.dismiss()
        chooser = null
        val tabName = Feedback.heldTabLabel(payload.title, payload.url)
        showSending(row.endpoint.label, tabName)
        val screen = WeakReference(this)
        AppScope.launch {
            val outcome = Sender.sendTo(app, row.endpoint, payload)
            // Republish FIRST, then report the usage — the order is load-bearing.
            // The send just moved this target to the head of the MRU, so the sync
            // both keeps the sheet agreeing with the chooser about what's on top
            // and, when the target was previously below the cut, publishes it at
            // all. Reporting first would attribute usage to a shortcut id the
            // system doesn't know, which drops it: the send that should have
            // introduced a device to the Direct Share row would teach it nothing.
            //
            // This is the only usage signal the system gets for a send made from
            // our own chooser dialog. A pick made in the share sheet is recorded by
            // the platform itself, so that path is merely counted twice.
            //
            // Runs on the application context, like everything else here — this
            // activity may already be gone by now.
            if (outcome.ok) {
                ShareShortcuts.sync(app)
                ShareShortcuts.reportUsed(app, row.endpoint.id)
            }
            val banner = Feedback.banner(outcome.view())
            // AppScope runs on the main thread, so the toast can be touched directly.
            val onScreen = screen.get()?.takeIf { !it.isFinishing && !it.isDestroyed }
            val shownInToast = onScreen?.showOutcome(outcome, banner, tabName) ?: false
            when {
                // The toast was dismissed before the answer came: the notification
                // carries the whole outcome, exactly as it did before the toast.
                !shownInToast -> {
                    val posted = SendNotifications.postOutcome(app, banner, outcome.messageId)
                    // With notifications denied there is no surface left but the
                    // headline itself, so it goes in a system toast rather than
                    // being lost. The waiting list on the home screen is the
                    // durable fallback.
                    if (!posted) Toast.makeText(app, banner.headline, Toast.LENGTH_SHORT).show()
                }
                // A success the person just watched happen needs no second word.
                banner.tone == SendTone.SUCCESS -> Unit
                // Held or failed: the toast says it now, and the notice is the
                // record that outlives the toast (a held one is also the promise
                // the flush workers later withdraw). Posted silently so it lands in
                // the shade without a heads-up on top of the toast.
                else -> SendNotifications.postOutcome(app, banner, outcome.messageId, silent = true)
            }
            if (outcome.failure != null && Feedback.isRecoverable(outcome.failure)) {
                // Retry the held send the moment we have connectivity again.
                Scheduling.enqueueHeartbeat(app)
            }
        }
    }

    // --- the send feedback (docs/APP_UI.md "Send feedback": a snackbar) ----------

    /**
     * Turn this window into the snackbar. The dim that framed the chooser is lifted,
     * so the sharing app shows through around the bar; a tap outside the bar
     * dismisses it, the bar itself swallows taps.
     */
    private fun showSending(label: String, tabName: String) {
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        val b = ViewSendToastBinding.inflate(layoutInflater)
        setContentView(b.root)
        // Keeps the bar above the navigation bar; the rest of the window stays clear.
        SystemBars.pad(b.root)
        toastBinding = b
        b.toastRoot.setOnClickListener { finish() }
        b.toastClose.setOnClickListener { finish() }
        renderToast(
            icon = null,
            headline = getString(R.string.send_toast_sending, label),
            detail = tabName,
            closable = false,
        )
    }

    /**
     * Show what [Sender] actually reported. Three states, each one a distinction
     * [SendOutcome] really carries — nothing here guesses:
     *
     *  - accepted → "Sent to X" + the tab, then closes after about a second. A
     *    target that is not online right now is not called out: the relay holds
     *    the tab for it, so it is sent all the same;
     *  - NOT accepted but held in this phone's queue (a recoverable failure: no
     *    network, relay unreachable or busy, a cap) → "Saved on this phone, not
     *    sent yet" + the specific reason; it retries on its own. Stays until closed;
     *  - refused for good → "Couldn't send to X" + the reason. Stays until closed.
     *
     * No Undo: phone sends are not held back, so there is nothing to take back.
     * No "View" either: the bar is gone too soon to tap it. The failures carry no
     * action: a held send already retries on its own the moment the relay
     * answers, and nothing in the send path retries on demand, so a "Retry" here
     * would promise a reach it doesn't have.
     * Returns false only when the toast is no longer there to show it.
     */
    private fun showOutcome(outcome: SendOutcome, banner: SendBanner, tabName: String): Boolean {
        if (toastBinding == null) return false
        val label = outcome.targetLabel
        val failure = outcome.failure
        when {
            // Accepted is "Sent", whether or not the target is online right now:
            // the relay has it either way, and that is all the person needs to know.
            failure == null && outcome.ok -> {
                renderToast(
                    R.drawable.ic_status_sent,
                    getString(R.string.send_toast_sent, label),
                    tabName,
                    closable = false,
                )
                finishAfter(SENT_DWELL_MS)
            }
            failure != null && Feedback.isRecoverable(failure) -> {
                renderToast(
                    R.drawable.ic_status_waiting,
                    getString(R.string.send_toast_held),
                    banner.detail ?: Feedback.failureLine(failure, label),
                    closable = true,
                )
            }
            else -> {
                renderToast(
                    R.drawable.ic_status_failed,
                    getString(R.string.send_toast_failed, label),
                    banner.detail ?: Feedback.hardError(),
                    closable = true,
                )
            }
        }
        return true
    }

    /**
     * One state of the toast. [icon] null means "still sending" (the spinner).
     * [action] is the snackbar's one text action, if this state has one.
     * The bar is a polite live region, so a screen reader hears each change.
     */
    private fun renderToast(
        @DrawableRes icon: Int?,
        headline: String,
        detail: String?,
        closable: Boolean,
        @StringRes action: Int? = null,
        onAction: (() -> Unit)? = null,
    ) {
        val b = toastBinding ?: return
        b.toastProgress.visibility = if (icon == null) View.VISIBLE else View.GONE
        b.toastIcon.visibility = if (icon == null) View.GONE else View.VISIBLE
        if (icon != null) b.toastIcon.setImageResource(icon)
        b.toastHeadline.text = headline
        b.toastDetail.text = detail
        b.toastDetail.visibility = if (detail.isNullOrBlank()) View.GONE else View.VISIBLE
        b.toastClose.visibility = if (closable) View.VISIBLE else View.GONE
        if (action != null && onAction != null) {
            b.toastAction.setText(action)
            b.toastAction.setOnClickListener { onAction() }
            b.toastAction.visibility = View.VISIBLE
        } else {
            b.toastAction.setOnClickListener(null)
            b.toastAction.visibility = View.GONE
        }
    }

    /**
     * Close the toast after [baseMs], stretched to the user's accessibility
     * timeout preference where the platform has one (API 29+), so someone using a
     * screen reader or a longer "time to take action" setting isn't cut off. While
     * the bar shows an action, it counts as content with controls, so the "time to
     * take action" setting applies to it too.
     */
    private fun finishAfter(baseMs: Int) {
        val b = toastBinding ?: return
        val am = getSystemService(AccessibilityManager::class.java)
        var content = AccessibilityManager.FLAG_CONTENT_ICONS or AccessibilityManager.FLAG_CONTENT_TEXT
        if (b.toastAction.visibility == View.VISIBLE) content = content or AccessibilityManager.FLAG_CONTENT_CONTROLS
        val ms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && am != null) {
            am.getRecommendedTimeoutMillis(baseMs, content)
        } else {
            baseMs
        }
        b.root.removeCallbacks(finishRunnable)
        b.root.postDelayed(finishRunnable, ms.toLong())
    }

    /**
     * The endpoint a Direct Share pick named, if this share came from one of our
     * Sharing Shortcuts. The system attaches the shortcut id to the very same
     * ACTION_SEND intent; anything else (a plain sheet entry, another app's
     * shortcut id) reads as null and takes the chooser path.
     */
    private fun shortcutTargetId(): String? =
        ShortcutPlan.endpointIdOf(intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID))

    /** Browsers put the shared URL in EXTRA_TEXT; pull the first URL-looking token. */
    private fun extractUrl(intent: Intent): String? {
        if (intent.action != Intent.ACTION_SEND) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim() ?: return null
        if (text.isEmpty()) return null
        val token = text.split(Regex("\\s+")).firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
        return token ?: text
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private companion object {
        const val KEY_SEND_STARTED = "io.tabsend.app.send.SEND_STARTED"

        /** "Sent to X": a glance, no more (stretched by the accessibility timeout). */
        const val SENT_DWELL_MS = 1_000
    }
}
