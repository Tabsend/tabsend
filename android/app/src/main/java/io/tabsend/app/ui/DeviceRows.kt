package io.tabsend.app.ui

import android.content.Context
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.ColorRes
import androidx.annotation.DrawableRes
import io.tabsend.app.R

/**
 * The device row (docs/APP_UI.md, "Phones: native-leaning"), built in code because
 * both lists that show it (the home screen and the share picker) are built in code.
 *
 * A Material 3 two-line list row: a 40dp round `tonal` container holding a filled
 * Material Symbols glyph in `on-tonal`, then the name (Body Large) with an optional
 * "Main" label, over "Kind · status" (Body Medium, muted) with the status word in
 * its own colour. Colour is never the only signal: the status is always a word.
 */
object DeviceRows {

    /**
     * The glyph for an endpoint kind. Tablets can't be told from phones on the wire,
     * so there is no tablet case: ic_device_tablet is drawn and waiting for one.
     */
    @DrawableRes
    fun iconFor(kind: String): Int = when (kind) {
        "mobile" -> R.drawable.ic_device_phone
        "console" -> R.drawable.ic_device_laptop
        else -> R.drawable.ic_device_browser
    }

    fun kindLabel(context: Context, kind: String): String = context.getString(
        when (kind) {
            "mobile" -> R.string.device_kind_phone
            "console" -> R.string.device_kind_console
            else -> R.string.device_kind_browser
        },
    )

    /** "Kind · status", with only the status word coloured. */
    fun detail(context: Context, kind: String, status: String, @ColorRes statusColor: Int): CharSequence {
        val kindWord = kindLabel(context, kind)
        val text = context.getString(R.string.device_detail, kindWord, status)
        val start = text.lastIndexOf(status)
        if (start < 0) return text
        return SpannableString(text).apply {
            setSpan(
                ForegroundColorSpan(context.getColor(statusColor)),
                start,
                start + status.length,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
    }

    /**
     * One row, at least 56dp tall (72dp is Material's two-line height; the floor is
     * what the spec asks for). Not clickable by itself; see [makeTappable].
     */
    fun row(
        context: Context,
        name: String,
        kind: String,
        isMain: Boolean,
        detail: CharSequence,
    ): LinearLayout {
        val res = context.resources
        fun dp(v: Int): Int = (v * res.displayMetrics.density).toInt()

        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(56)
            setPadding(0, dp(8), 0, dp(8))
        }

        // The container is decoration: the kind is also spelled out in the detail line.
        val tile = FrameLayout(context).apply {
            setBackgroundResource(R.drawable.bg_icon_container)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(16) }
        }
        tile.addView(
            ImageView(context).apply {
                setImageResource(iconFor(kind))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                layoutParams = FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER)
            },
        )
        row.addView(tile)

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        column.addView(
            TextView(context).apply {
                text = name
                setTextAppearance(R.style.TextAppearance_Tabsend_RowTitle)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
            },
        )
        column.addView(
            TextView(context).apply {
                text = detail
                setTextAppearance(R.style.TextAppearance_Tabsend_RowDetail)
            },
        )
        row.addView(column)
        // At the row's end rather than after the name, so a long name ellipsizes
        // instead of pushing the label off screen.
        if (isMain) row.addView(mainLabel(context))
        return row
    }

    /** The small "Main" pill. Read out as "main device" rather than a bare "Main". */
    private fun mainLabel(context: Context): TextView {
        val density = context.resources.displayMetrics.density
        fun dp(v: Int): Int = (v * density).toInt()
        return TextView(context).apply {
            text = context.getString(R.string.device_main)
            contentDescription = context.getString(R.string.device_main_description)
            setTextAppearance(R.style.TextAppearance_Tabsend_Status)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTextColor(context.getColor(R.color.ts_accent_fill))
            // Background first, padding second: setting a background resets padding.
            setBackgroundResource(R.drawable.bg_main_label)
            setPadding(dp(8), dp(2), dp(8), dp(2))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { marginStart = dp(8) }
        }
    }

    /**
     * Make a row a tap target: the theme's ripple, focusable, and one listener.
     * Padding is saved and restored because setting a background resets it.
     * A clickable parent is read by TalkBack as one item with its children's text.
     */
    fun makeTappable(row: View, onClick: () -> Unit) {
        val left = row.paddingLeft
        val top = row.paddingTop
        val right = row.paddingRight
        val bottom = row.paddingBottom
        val tv = TypedValue()
        if (row.context.theme.resolveAttribute(android.R.attr.selectableItemBackground, tv, true)) {
            row.setBackgroundResource(tv.resourceId)
        }
        row.setPadding(left, top, right, bottom)
        row.isClickable = true
        row.isFocusable = true
        row.setOnClickListener { onClick() }
    }

    /** A 1dp divider between rows, in the outline-variant colour. */
    fun hairline(context: Context): View = View(context).apply {
        setBackgroundColor(context.getColor(R.color.ts_divider))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            (context.resources.displayMetrics.density).toInt().coerceAtLeast(1),
        )
    }
}
