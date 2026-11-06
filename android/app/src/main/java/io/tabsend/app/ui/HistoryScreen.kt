package io.tabsend.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.doOnPreDraw
import androidx.core.widget.NestedScrollView
import androidx.lifecycle.lifecycleScope
import io.tabsend.app.R
import io.tabsend.app.logic.Delivery
import io.tabsend.app.logic.Direction
import io.tabsend.app.logic.Feedback
import io.tabsend.app.logic.History
import io.tabsend.app.logic.HistoryRow
import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.InboxGroup
import io.tabsend.app.logic.isoOf
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.logic.relativeTime
import io.tabsend.app.net.GroupHistory
import io.tabsend.app.receive.Deliverer
import io.tabsend.app.receive.LinkPolicy
import io.tabsend.app.send.Sender
import io.tabsend.app.store.Store
import io.tabsend.app.wire.SendPayload
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import io.tabsend.app.logic.texts

/**
 * The group's history [P-7, ADR-0028], the app's History tab.
 *
 * One timeline, newest first, of what every device in the group sent and
 * received, not a list of things that happened to this phone. It grew out of
 * the received-tabs screen, which existed because a link lived in exactly one
 * place, its notification, and one swipe lost it. It answers two more questions
 * now: where a tab went, and whether it ever landed.
 *
 * Notifications stay the primary surface (PRD §6.4: Tabsend never intercepts,
 * the user taps). This is the backstop, which is why an already-opened tab stays
 * listed rather than disappearing: the screen has to be worth opening
 * even on the days nothing was lost.
 */
internal class HistoryScreen(
    private val activity: AppCompatActivity,
    private val store: Store,
    private val scroll: NestedScrollView,
    private val list: LinearLayout,
    private val empty: TextView,
) {
    private val pictures = PictureLoader(activity, store)

    /** What is drawn, so a sync that changed nothing leaves the list and its pictures alone. */
    private var drawn: List<HistoryRow>? = null

    init {
        scroll.setOnScrollChangeListener(
            NestedScrollView.OnScrollChangeListener { _, _, _, _, _ -> pictures.start(scroll) },
        )
    }

    /** Leaving the tab: stop asking sites for pictures. The next [render] starts over. */
    fun stop() {
        pictures.clear()
        drawn = null
    }

    /** The timeline as the cache has it now. Empty for no registration or no relay history. */
    fun rows(): List<HistoryRow> {
        val selfId = store.registration?.endpointId ?: return emptyList()
        return History.rows(store.history, store.inbox, selfId, System.currentTimeMillis())
    }

    /**
     * Ask the relay, for whichever tab is showing: the cache is what both Home and this
     * screen draw, and they redraw when it changes.
     *
     * The history can see a tab for this phone before the phone has pulled it (a late or
     * lost wake). Pull it now instead of showing "Waiting for <this phone>"; the drain
     * refreshes history too.
     */
    fun sync() {
        activity.lifecycleScope.launch {
            GroupHistory.syncNow(activity)
            if (History.hasWaitingForSelf(rows())) Deliverer.drain(activity)
        }
    }

    fun render() {
        val rows = rows()
        if (rows == drawn) return
        drawn = rows
        pictures.clear()
        list.removeAllViews()
        // No registration, an empty cache, or a relay too old to serve history all
        // land in the same place: the empty state, which explains what the screen
        // is for rather than looking broken.
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        // Day subheaders over panels of rows (docs/APP_UI.md "Phones: native-leaning").
        // A label is emitted whenever the day changes, so the list's own order
        // (newest first) is kept exactly; nothing here re-sorts it.
        val today = LocalDate.now()
        var section: Int? = null
        var panel: LinearLayout? = null
        for (group in Inbox.group(rows)) {
            val first = group.items.firstOrNull() ?: continue
            val next = sectionOf(first.at, today)
            val current = panel
            val into = if (next != section || current == null) {
                list.addView(sectionLabel(next, isFirst = section == null))
                section = next
                newPanel().also { list.addView(it); panel = it }
            } else {
                current.addView(DeviceRows.hairline(activity))
                current
            }
            into.addView(groupView(group))
        }
        scroll.doOnPreDraw { pictures.start(scroll) }
    }

    /** A tonal panel whose rows are clipped to its corners, so a tinted row stays inside it. */
    private fun newPanel(): LinearLayout = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.bg_panel)
        clipToOutline = true
    }

    /** Today, Yesterday or Earlier, in the phone's own time zone. A future stamp (clock skew) reads as today. */
    private fun sectionOf(iso: String, today: LocalDate): Int {
        val ms = parseIsoMillis(iso) ?: return R.string.history_section_earlier
        val day = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()
        return when {
            !day.isBefore(today) -> R.string.history_section_today
            day == today.minusDays(1) -> R.string.history_section_yesterday
            else -> R.string.history_section_earlier
        }
    }

    private fun sectionLabel(textRes: Int, isFirst: Boolean): View =
        TextView(activity).apply {
            setText(textRes)
            setTextAppearance(R.style.TextAppearance_Tabsend_Subheader)
            setPadding(0, if (isFirst) dp(12) else dp(24), 0, dp(8))
        }.also { ViewCompat.setAccessibilityHeading(it, true) }

    private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density).toInt()

    private fun groupView(group: InboxGroup<HistoryRow>): View {
        val box = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

        // Only a real multi-tab send gets a heading. A single send under a
        // "1 tabs" header would be noise, and its row already names the devices.
        if (group.batchId != null) {
            val head = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(14), dp(10), dp(14), 0)
            }
            head.addView(
                TextView(activity).apply {
                    text = Inbox.batchHeading(activity.texts(), group)
                    setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
                },
            )
            group.items.firstOrNull()?.let { first ->
                head.addView(
                    TextView(activity).apply {
                        text = groupMeta(first)
                        setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                    },
                )
            }
            val openable = group.items.filter { openableUrl(it) != null }
            if (openable.isNotEmpty()) {
                head.addView(
                    com.google.android.material.button.MaterialButton(
                        activity,
                        null,
                        R.attr.tabsendTonalButtonStyle,
                    ).apply {
                        text = activity.getString(R.string.history_open_all)
                        setOnClickListener { openAll(openable) }
                    },
                )
            }
            box.addView(head)
        }

        for (row in group.items) box.addView(rowView(row, grouped = group.batchId != null))
        return box
    }

    /**
     * One row: a direction glyph in the gutter, then what the tab is, where it went
     * and, when there is something to say, what became of it, with its picture at the end.
     */
    private fun rowView(row: HistoryRow, grouped: Boolean): View {
        val failed = row.delivery == Delivery.NEVER_ARRIVED
        val errorColor = activity.getColor(R.color.ts_danger)

        val line = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            minimumHeight = dp(60)
            setPadding(dp(14), dp(8), dp(14), dp(8))
        }
        if (openableUrl(row) != null) DeviceRows.makeTappable(line) { open(row) }

        // Mail imagery, never a bare arrow (ADR-0028 §9): a plane for what this
        // phone sent, a tray for what it received, and a neutral exchange glyph
        // where neither end is this phone.
        line.addView(
            ImageView(activity).apply {
                setImageResource(
                    when (row.direction) {
                        Direction.SENT -> R.drawable.ic_history_sent
                        Direction.RECEIVED -> R.drawable.ic_history_received
                        Direction.ELSEWHERE -> R.drawable.ic_history_elsewhere
                    },
                )
                contentDescription = activity.getString(
                    when (row.direction) {
                        Direction.SENT -> R.string.history_direction_sent
                        Direction.RECEIVED -> R.string.history_direction_received
                        Direction.ELSEWHERE -> R.string.history_direction_between
                    },
                )
                setColorFilter(if (failed) errorColor else activity.getColor(R.color.ts_phone_muted))
                layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply {
                    marginEnd = dp(12)
                    topMargin = dp(2)
                }
            },
        )

        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val title = TextView(activity).apply {
            text = History.displayTitle(row) ?: activity.getString(R.string.history_locked)
            setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        column.addView(title)
        column.addView(
            TextView(activity).apply {
                text = rowMeta(row, grouped)
                setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
            },
        )

        // Where it stands, always in words as well as colour (docs/APP_UI.md), and
        // only when there is something to say: an opened tab just reads as a tab.
        statusLine(row)?.let { (text, color) ->
            column.addView(
                TextView(activity).apply {
                    this.text = text
                    setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                    setTextColor(activity.getColor(color))
                },
            )
        }

        // The one row with something to do about it. Possible at all because the
        // group key kept the plaintext readable on every paired device [0028].
        if (failed && openableUrl(row) != null) {
            column.addView(
                com.google.android.material.button.MaterialButton(
                    activity,
                    null,
                    R.attr.tabsendTonalButtonStyle,
                ).apply {
                    text = activity.getString(R.string.history_send_again)
                    setOnClickListener { sendAgain(row) }
                },
            )
        }
        line.addView(column)

        val slot = PictureSlot(activity, cornerDp = 8, letterSp = 17f).apply {
            layoutParams = LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginStart = dp(12) }
        }
        line.addView(slot)
        val url = openableUrl(row)
        pictures.bind(slot, url, row.image, needTitle = row.title.isNullOrBlank()) { title.text = it }
        // A never-arrived send is the one row asking for something, so the one with a
        // tint. Behind the row, because the row's own background is its tap ripple.
        if (!failed) return line
        return android.widget.FrameLayout(activity).apply {
            setBackgroundColor(activity.getColor(R.color.danger_bg))
            addView(line)
        }
    }

    /**
     * The meta line. A grouped row leaves the devices and the age to its heading.
     *
     * Where neither end is this phone the row names BOTH, because "from" and "to"
     * each need the other end to be us to mean anything (ADR-0028 §9).
     */
    private fun rowMeta(row: HistoryRow, grouped: Boolean): String {
        val site = row.url?.let { Inbox.hostOf(it) } ?: activity.getString(R.string.history_locked_detail)
        if (grouped) return site
        val age = relativeTime(activity.texts(), row.at)
        return when (row.direction) {
            Direction.SENT -> activity.getString(R.string.history_row_to, site, label(row.targetLabel), age)
            Direction.RECEIVED -> activity.getString(R.string.history_row_from, site, label(row.sourceLabel), age)
            Direction.ELSEWHERE -> activity.getString(
                R.string.history_row_between,
                site,
                label(row.sourceLabel),
                label(row.targetLabel),
                age,
            )
        }
    }

    private fun groupMeta(row: HistoryRow): String {
        val age = relativeTime(activity.texts(), row.at)
        return when (row.direction) {
            Direction.SENT -> activity.getString(R.string.history_group_to, label(row.targetLabel), age)
            Direction.RECEIVED -> activity.getString(R.string.history_group_from, label(row.sourceLabel), age)
            Direction.ELSEWHERE ->
                activity.getString(R.string.history_group_between, label(row.sourceLabel), label(row.targetLabel), age)
        }
    }

    /**
     * A received tab that arrived says New until it is opened, then nothing more;
     * everything else says where the delivery stands, and "Delivered" is only said
     * once the target acknowledged it.
     */
    private fun statusLine(row: HistoryRow): Pair<String, Int>? = when (row.delivery) {
        Delivery.ARRIVED -> when {
            row.direction != Direction.RECEIVED ->
                activity.getString(R.string.history_status_delivered) to R.color.ts_success
            row.openedAt == null && row.readable ->
                activity.getString(R.string.history_status_new) to R.color.ts_accent_fill
            else -> null
        }
        Delivery.WAITING -> activity.getString(R.string.history_waiting, label(row.targetLabel)) to R.color.ts_waiting_text
        Delivery.NEVER_ARRIVED -> (
            row.targetLabel?.let { activity.getString(R.string.history_never_arrived, it) }
                ?: activity.getString(R.string.history_never_arrived_unknown)
            ) to R.color.ts_danger
    }

    /** A device this phone has no name for: the blob was sealed under a key it lacks. */
    fun label(label: String?): String = label ?: activity.getString(R.string.history_unknown_device)

    /**
     * The row's URL, but only if it is safe to hand to Android's ACTION_VIEW
     * resolver. Re-checked at render time as well as at receipt: this screen is
     * what turns a stored string back into a navigation, and the check that makes
     * that safe belongs next to the tap.
     */
    fun openableUrl(row: HistoryRow): String? =
        row.url?.takeIf { LinkPolicy.isOpenableWebUrl(it) }

    fun open(row: HistoryRow) {
        val url = openableUrl(row) ?: return
        openUrls(listOf(url))
        markOpened(listOf(row.id))
    }

    private fun openAll(rows: List<HistoryRow>) {
        openUrls(rows.mapNotNull { openableUrl(it) })
        markOpened(rows.map { it.id })
    }

    private fun openUrls(urls: List<String>) {
        for (url in urls) {
            try {
                activity.startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    },
                )
            } catch (_: ActivityNotFoundException) {
                // No browser for this URL; skip it, keep opening the rest.
            }
        }
    }

    /** Bookkeeping strictly after the links are away, exactly as the notification path does. */
    private fun markOpened(ids: List<String>) {
        store.updateInbox { list -> Inbox.markOpened(list, ids, System.currentTimeMillis()) }
    }

    /**
     * Send the same tab to the same device again.
     *
     * A new send, not a retry of the old one: the original expired at the relay
     * and cannot be revived, and it gets a new id, a new envelope and a fresh
     * history blob of its own. The target has to still be in the group: sending
     * to a device that has left would be a guess, and a tab going to the wrong
     * device is not a recoverable mistake.
     */
    private fun sendAgain(row: HistoryRow) {
        val url = openableUrl(row) ?: return
        val target = store.cachedEndpoints.firstOrNull { it.id == row.targetEndpointId }
        if (target == null) {
            Toast.makeText(activity, R.string.history_send_again_gone, Toast.LENGTH_LONG).show()
            return
        }
        activity.lifecycleScope.launch {
            val outcome = Sender.sendTo(
                activity,
                target,
                SendPayload(url = url, title = row.title, sentAt = isoOf(System.currentTimeMillis()), image = row.image),
            )
            Toast.makeText(
                activity,
                Feedback.banner(activity.texts(), outcome.view()).headline,
                Toast.LENGTH_LONG,
            ).show()
            render()
        }
    }
}
