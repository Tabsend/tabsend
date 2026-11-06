package io.tabsend.app.ui

import android.text.TextUtils
import android.util.TypedValue
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import io.tabsend.app.R
import io.tabsend.app.logic.Delivery
import io.tabsend.app.logic.Direction
import io.tabsend.app.logic.History
import io.tabsend.app.logic.HistoryRow
import io.tabsend.app.logic.Inbox
import io.tabsend.app.logic.LatestLine
import io.tabsend.app.logic.relativeTime
import io.tabsend.app.store.Store
import io.tabsend.app.logic.texts

/**
 * Latest on the home screen (docs/HISTORY_PREVIEWS_PLAN.md): the newest two tabs in any
 * direction, as cards with the picture on top. Two side by side, one full width when
 * there is only one, a short line when there are none. Opened tabs stay full strength.
 */
internal class LatestCards(
    private val activity: AppCompatActivity,
    store: Store,
    private val container: LinearLayout,
    private val empty: View,
    private val history: HistoryScreen,
) {
    private val pictures = PictureLoader(activity, store)
    private var drawn: List<HistoryRow>? = null

    /** Leaving the screen: stop asking sites. The next [render] starts over. */
    fun stop() {
        pictures.clear()
        drawn = null
    }

    fun render() {
        val rows = History.latest(history.rows(), { history.openableUrl(it) != null })
        if (rows == drawn) return
        drawn = rows
        pictures.clear()
        container.removeAllViews()
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        rows.forEachIndexed { i, row ->
            container.addView(
                card(row, tall = rows.size == 1).apply {
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f).apply {
                        if (i > 0) marginStart = dp(10)
                    }
                },
            )
        }
        pictures.start()
    }

    private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density).toInt()

    private fun card(row: HistoryRow, tall: Boolean): View {
        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_panel)
            clipToOutline = true
        }
        val slot = PictureSlot(activity, cornerDp = 0, letterSp = 28f).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(if (tall) 148 else 104))
        }
        card.addView(slot)

        val text = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(12))
        }
        text.addView(directionLine(row))
        val title = TextView(activity).apply {
            this.text = History.displayTitle(row)
            setTextAppearance(R.style.TextAppearance_Tabsend_CardTitle)
            maxLines = 3
            ellipsize = TextUtils.TruncateAt.END
            setPadding(0, dp(4), 0, dp(4))
        }
        text.addView(title)
        text.addView(
            TextView(activity).apply {
                this.text = meta(row)
                setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
                textSize = 12f
            },
        )
        card.addView(text)
        // A foreground ripple: the card's background is its panel.
        val ripple = TypedValue()
        activity.theme.resolveAttribute(android.R.attr.selectableItemBackground, ripple, true)
        card.foreground = activity.getDrawable(ripple.resourceId)
        card.isFocusable = true
        card.setOnClickListener { history.open(row) }
        pictures.bind(slot, history.openableUrl(row), row.image, needTitle = row.title.isNullOrBlank()) { title.text = it }
        return card
    }

    /** Which way it went. New is the words and the accent colour; the dot only repeats it. */
    private fun directionLine(row: HistoryRow): TextView {
        val kind = History.latestLine(row)
        return TextView(activity).apply {
            text = when (kind) {
                LatestLine.NEW_FROM -> activity.getString(R.string.latest_new_from, history.label(row.sourceLabel))
                LatestLine.FROM -> activity.getString(R.string.latest_from, history.label(row.sourceLabel))
                LatestLine.SENT_TO -> activity.getString(R.string.latest_sent_to, history.label(row.targetLabel))
                LatestLine.BETWEEN ->
                    activity.getString(R.string.latest_between, history.label(row.sourceLabel), history.label(row.targetLabel))
            }
            setTextAppearance(R.style.TextAppearance_Tabsend_CardLine)
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
            if (kind == LatestLine.NEW_FROM) {
                setTextColor(activity.getColor(R.color.ts_accent_fill))
                setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.bg_new_dot, 0, 0, 0)
                compoundDrawablePadding = dp(6)
            }
        }
    }

    /** `site · age`, and on anything this phone did not receive, how it stands. */
    private fun meta(row: HistoryRow): String {
        val site = row.url?.let { Inbox.hostOf(it) }.orEmpty()
        val age = relativeTime(activity.texts(), row.at)
        if (row.direction == Direction.RECEIVED) return activity.getString(R.string.latest_meta, site, age)
        val status = activity.getString(
            if (row.delivery == Delivery.ARRIVED) R.string.history_status_delivered else R.string.history_status_waiting,
        )
        return activity.getString(R.string.latest_meta_status, site, age, status)
    }
}
