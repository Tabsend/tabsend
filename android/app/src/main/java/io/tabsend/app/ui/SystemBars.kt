package io.tabsend.app.ui

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps a screen's content out from under the status bar, the navigation bar and a
 * camera cutout.
 *
 * Since the app targets Android 15 and later (Google Play requires it), Android draws
 * every window edge to edge: the bars sit on top of the content, and the old
 * `statusBarColor` is ignored. This pads [view] by the bars' size, on top of the padding
 * it already has, so the screen looks as it did before: the view's background still
 * fills the area behind the bars, which is what painted the status bar until now.
 */
object SystemBars {
    fun pad(view: View) {
        val start = view.paddingLeft
        val top = view.paddingTop
        val end = view.paddingRight
        val bottom = view.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.setPadding(start + bars.left, top + bars.top, end + bars.right, bottom + bars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }
}
