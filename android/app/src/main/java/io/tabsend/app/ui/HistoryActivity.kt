package io.tabsend.app.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.lifecycle.lifecycleScope
import io.tabsend.app.R
import io.tabsend.app.databinding.ActivityHistoryBinding
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
import io.tabsend.app.receive.LinkPolicy
import io.tabsend.app.send.Sender
import io.tabsend.app.store.Store
import io.tabsend.app.wire.SendPayload
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * The group's history [P-7, ADR-0028].
 *
 * One timeline, newest first, of what every device in the group sent and
 * received — not a list of things that happened to this phone. It grew out of
 * the received-tabs screen, which existed because a link lived in exactly one
 * place, its notification, and one swipe lost it. It answers two more questions
 * now: where a tab went, and whether it ever landed.
 *
 * Notifications stay the primary surface (PRD §6.4: Tabsend never intercepts,
 * the user taps). This is the backstop, which is why an already-opened tab stays
 * listed but dimmed rather than disappearing: the screen has to be worth opening
 * even on the days nothing was lost.
 */
class HistoryActivity : AppCompatActivity() {

    private lateinit var binding: ActivityHistoryBinding
    private val store by lazy { Store.get(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityHistoryBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // The theme has no window action bar; the layout's top app bar stands in for it.
        setSupportActionBar(binding.toolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        title = getString(R.string.history_title)
        binding.historyRetention.text = getString(R.string.history_retention, History.MAX)
    }

    // Rebuilt on every return rather than once at create: the user leaves this
    // screen BY opening a tab, and comes back to a row that should now be dimmed.
    override fun onResume() {
        super.onResume()
        // Paint the cache first, then go and ask. The relay is authoritative but
        // it is also a round trip, and a screen that starts empty for a second
        // reads as "nothing here" rather than "loading".
        render()
        lifecycleScope.launch {
            GroupHistory.syncNow(this@HistoryActivity)
            render()
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }

    private fun render() {
        // No registration, an empty cache, or a relay too old to serve history all
        // land in the same place: the empty state, which explains what the screen
        // is for rather than looking broken.
        val selfId = store.registration?.endpointId
        if (selfId == null) {
            binding.historyList.removeAllViews()
            binding.historyEmpty.visibility = View.VISIBLE
            return
        }
        val rows = History.rows(
            store.history,
            store.inbox,
            selfId,
            System.currentTimeMillis(),
        )
        binding.historyList.removeAllViews()
        binding.historyEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        // Day subheaders over plain list rows (docs/APP_UI.md "Phones: native-leaning").
        // A label is emitted whenever the day changes, so the list's own order
        // (newest first) is kept exactly; nothing here re-sorts it.
        val today = LocalDate.now()
        var section: Int? = null
        for (group in Inbox.group(rows)) {
            val first = group.items.firstOrNull() ?: continue
            val next = sectionOf(first.at, today)
            if (next != section) {
                binding.historyList.addView(sectionLabel(next, isFirst = section == null))
                section = next
            } else {
                binding.historyList.addView(DeviceRows.hairline(this))
            }
            binding.historyList.addView(groupView(group))
        }
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
        TextView(this).apply {
            setText(textRes)
            setTextAppearance(R.style.TextAppearance_Tabsend_Subheader)
            setPadding(0, if (isFirst) dp(16) else dp(28), 0, dp(4))
        }.also { ViewCompat.setAccessibilityHeading(it, true) }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun groupView(group: InboxGroup<HistoryRow>): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(8))
        }

        // Only a real multi-tab send gets a heading. A single send under a
        // "1 tabs" header would be noise, and its row already names the devices.
        if (group.batchId != null) {
            box.addView(
                TextView(this).apply {
                    text = Inbox.batchHeading(group)
                    setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
                },
            )
            group.items.firstOrNull()?.let { first ->
                box.addView(
                    TextView(this).apply {
                        text = groupMeta(first)
                        setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                    },
                )
            }
            val openable = group.items.filter { openableUrl(it) != null }
            if (openable.isNotEmpty()) {
                box.addView(
                    com.google.android.material.button.MaterialButton(
                        this,
                        null,
                        R.attr.tabsendTonalButtonStyle,
                    ).apply {
                        text = getString(R.string.history_open_all)
                        setOnClickListener { openAll(openable) }
                    },
                )
            }
        }

        for (row in group.items) box.addView(rowView(row, grouped = group.batchId != null))
        return box
    }

    /**
     * One row: a direction glyph in the gutter, then what the tab is, where it
     * went, and — when that is not simply "it arrived" — what became of it.
     */
    private fun rowView(row: HistoryRow, grouped: Boolean): View {
        val failed = row.delivery == Delivery.NEVER_ARRIVED
        val errorColor = getColor(R.color.ts_danger)

        val line = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            minimumHeight = dp(56)
            setPadding(if (grouped) dp(12) else 0, dp(10), 0, dp(10))
        }
        DeviceRows.makeTappable(line) { open(row) }

        // Mail imagery, never a bare arrow (ADR-0028 §9): a plane for what this
        // phone sent, a tray for what it received, and a neutral exchange glyph
        // where neither end is this phone.
        line.addView(
            ImageView(this).apply {
                setImageResource(
                    when (row.direction) {
                        Direction.SENT -> R.drawable.ic_history_sent
                        Direction.RECEIVED -> R.drawable.ic_history_received
                        Direction.ELSEWHERE -> R.drawable.ic_history_elsewhere
                    },
                )
                contentDescription = getString(
                    when (row.direction) {
                        Direction.SENT -> R.string.history_direction_sent
                        Direction.RECEIVED -> R.string.history_direction_received
                        Direction.ELSEWHERE -> R.string.history_direction_between
                    },
                )
                setColorFilter(if (failed) errorColor else getColor(R.color.ts_phone_muted))
                layoutParams = LinearLayout.LayoutParams(dp(20), dp(20)).apply {
                    marginEnd = dp(12)
                    topMargin = dp(2)
                }
            },
        )

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        column.addView(
            TextView(this).apply {
                text = History.displayTitle(row) ?: getString(R.string.history_locked)
                setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
            },
        )
        column.addView(
            TextView(this).apply {
                text = rowMeta(row, grouped)
                setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
            },
        )

        // The delivery verdict, and only when there is one to give. An arrived
        // tab needs no line saying so; the absence IS the good news.
        stateLine(row)?.let { text ->
            column.addView(
                TextView(this).apply {
                    this.text = text
                    setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                    setTextColor(if (failed) errorColor else getColor(R.color.ts_waiting_text))
                },
            )
        }

        // The one row with something to do about it. Possible at all because the
        // group key kept the plaintext readable on every paired device [0028].
        if (failed && openableUrl(row) != null) {
            column.addView(
                com.google.android.material.button.MaterialButton(
                    this,
                    null,
                    R.attr.tabsendTonalButtonStyle,
                ).apply {
                    text = getString(R.string.history_send_again)
                    setOnClickListener { sendAgain(row) }
                },
            )
        }

        line.addView(column)
        // The status word, always a word as well as a colour (docs/APP_UI.md).
        val (word, wordColor) = statusWord(row)
        line.addView(
            TextView(this).apply {
                setText(word)
                setTextAppearance(R.style.TextAppearance_Tabsend_Status)
                setTextColor(getColor(wordColor))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    marginStart = dp(12)
                    topMargin = dp(2)
                }
            },
        )
        // Dimmed once opened, still listed. The contrast is the point: what is
        // full-strength here is what has not been dealt with yet. Only a received
        // row carries this — nothing "opens" a tab this phone sent away.
        line.alpha = if (row.direction == Direction.RECEIVED && row.openedAt != null) 0.5f else 1f
        return line
    }

    /**
     * The meta line. A grouped row leaves the devices and the age to its heading.
     *
     * Where neither end is this phone the row names BOTH, because "from" and "to"
     * each need the other end to be us to mean anything (ADR-0028 §9).
     */
    private fun rowMeta(row: HistoryRow, grouped: Boolean): String {
        val site = row.url?.let { Inbox.hostOf(it) } ?: getString(R.string.history_locked_detail)
        if (grouped) return site
        val age = relativeTime(row.at)
        return when (row.direction) {
            Direction.SENT -> getString(R.string.history_row_to, site, label(row.targetLabel), age)
            Direction.RECEIVED -> getString(R.string.history_row_from, site, label(row.sourceLabel), age)
            Direction.ELSEWHERE -> getString(
                R.string.history_row_between,
                site,
                label(row.sourceLabel),
                label(row.targetLabel),
                age,
            )
        }
    }

    private fun groupMeta(row: HistoryRow): String {
        val age = relativeTime(row.at)
        return when (row.direction) {
            Direction.SENT -> getString(R.string.history_group_to, label(row.targetLabel), age)
            Direction.RECEIVED -> getString(R.string.history_group_from, label(row.sourceLabel), age)
            Direction.ELSEWHERE ->
                getString(R.string.history_group_between, label(row.sourceLabel), label(row.targetLabel), age)
        }
    }

    /**
     * One word per row. A received tab that arrived is either opened or not, which
     * is the thing worth knowing about it here; everything else says where the
     * delivery stands, and "Delivered" is only said once the target acknowledged it.
     */
    private fun statusWord(row: HistoryRow): Pair<Int, Int> = when {
        row.direction == Direction.RECEIVED && row.delivery == Delivery.ARRIVED ->
            if (row.openedAt != null) {
                R.string.history_status_opened to R.color.ts_phone_muted
            } else {
                R.string.history_status_new to R.color.ts_accent_fill
            }
        row.delivery == Delivery.ARRIVED -> R.string.history_status_delivered to R.color.ts_success
        row.delivery == Delivery.WAITING -> R.string.history_status_waiting to R.color.ts_waiting_text
        else -> R.string.history_status_never_arrived to R.color.ts_danger
    }

    private fun stateLine(row: HistoryRow): String? = when (row.delivery) {
        Delivery.ARRIVED -> null
        Delivery.WAITING -> getString(R.string.history_waiting, label(row.targetLabel))
        Delivery.NEVER_ARRIVED -> row.targetLabel
            ?.let { getString(R.string.history_never_arrived, it) }
            ?: getString(R.string.history_never_arrived_unknown)
    }

    /** A device this phone has no name for: the blob was sealed under a key it lacks. */
    private fun label(label: String?): String = label ?: getString(R.string.history_unknown_device)

    /**
     * The row's URL, but only if it is safe to hand to Android's ACTION_VIEW
     * resolver. Re-checked at render time as well as at receipt: this screen is
     * what turns a stored string back into a navigation, and the check that makes
     * that safe belongs next to the tap.
     */
    private fun openableUrl(row: HistoryRow): String? =
        row.url?.takeIf { LinkPolicy.isOpenableWebUrl(it) }

    private fun open(row: HistoryRow) {
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
                startActivity(
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
     * history blob of its own. The target has to still be in the group — sending
     * to a device that has left would be a guess, and a tab going to the wrong
     * device is not a recoverable mistake.
     */
    private fun sendAgain(row: HistoryRow) {
        val url = openableUrl(row) ?: return
        val target = store.cachedEndpoints.firstOrNull { it.id == row.targetEndpointId }
        if (target == null) {
            Toast.makeText(this, R.string.history_send_again_gone, Toast.LENGTH_LONG).show()
            return
        }
        lifecycleScope.launch {
            val outcome = Sender.sendTo(
                this@HistoryActivity,
                target,
                SendPayload(url = url, title = row.title, sentAt = isoOf(System.currentTimeMillis())),
            )
            Toast.makeText(
                this@HistoryActivity,
                Feedback.banner(outcome.view()).headline,
                Toast.LENGTH_LONG,
            ).show()
            render()
        }
    }
}
