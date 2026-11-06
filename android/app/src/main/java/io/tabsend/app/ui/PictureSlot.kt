package io.tabsend.app.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.NestedScrollView
import androidx.lifecycle.lifecycleScope
import io.tabsend.app.R
import io.tabsend.app.logic.History
import io.tabsend.app.store.Store
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Where a tab's picture goes (docs/HISTORY_PREVIEWS_PLAN.md "Picture slot"): a plain tile
 * while loading, the picture cropped to fill once loaded, and the site's first letter when
 * there is none or it failed, so a broken-image icon can never show. Decoration: the row's
 * own words say what the tab is.
 */
internal class PictureSlot(context: Context, cornerDp: Int, letterSp: Float) : FrameLayout(context) {
    private val letter = TextView(context).apply {
        setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_TitleMedium)
        textSize = letterSp
        setTextColor(context.getColor(R.color.ts_on_tonal))
        visibility = View.GONE
    }
    private val image = ImageView(context).apply {
        scaleType = ImageView.ScaleType.CENTER_CROP
        visibility = View.GONE
    }

    init {
        background = GradientDrawable().apply {
            setColor(context.getColor(R.color.ts_tonal))
            cornerRadius = cornerDp * resources.displayMetrics.density
        }
        clipToOutline = true
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        addView(letter, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun showLetter(text: String?) {
        letter.text = text.orEmpty()
        letter.visibility = View.VISIBLE
    }

    fun showPicture(bitmap: Bitmap) {
        image.setImageBitmap(bitmap)
        image.visibility = View.VISIBLE
        letter.visibility = View.GONE
    }
}

/**
 * Fills a screen's slots. Nothing is asked of any site until a slot is near the screen, so
 * opening a long list does not contact every site in it, and [clear] drops whatever has
 * not finished when the list is rebuilt or left.
 */
internal class PictureLoader(private val activity: AppCompatActivity, private val store: Store) {
    private class Pending(val slot: PictureSlot, val load: () -> Job)

    private val pending = mutableListOf<Pending>()
    private val jobs = mutableListOf<Job>()

    fun clear() {
        pending.clear()
        jobs.forEach { it.cancel() }
        jobs.clear()
    }

    fun bind(
        slot: PictureSlot,
        url: String?,
        image: String?,
        needTitle: Boolean = false,
        onTitle: (String) -> Unit = {},
    ) {
        val letter = History.siteLetter(url)
        if (url == null || !store.websiteImages || !HistoryPreviews.eligible(url)) {
            slot.showLetter(letter)
            return
        }
        pending += Pending(slot) {
            activity.lifecycleScope.launch {
                val preview = HistoryPreviews.load(url, image, needTitle)
                val bitmap = preview?.image
                if (bitmap != null) slot.showPicture(bitmap) else slot.showLetter(letter)
                if (needTitle) preview?.title?.takeIf { it.isNotBlank() }?.let(onTitle)
            }
        }
    }

    /** Start what is on or near the screen, or everything when there is no [scroll]. */
    fun start(scroll: NestedScrollView? = null) {
        val margin = (NEAR_DP * activity.resources.displayMetrics.density).toInt()
        val iterator = pending.iterator()
        while (iterator.hasNext()) {
            val next = iterator.next()
            if (scroll != null) {
                val place = Rect(0, 0, next.slot.width, next.slot.height)
                scroll.offsetDescendantRectToMyCoords(next.slot, place)
                if (place.bottom < scroll.scrollY - margin || place.top > scroll.scrollY + scroll.height + margin) continue
            }
            iterator.remove()
            jobs += next.load()
        }
    }

    private companion object {
        const val NEAR_DP = 300
    }
}
