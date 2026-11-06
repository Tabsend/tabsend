package io.tabsend.app.logic

import android.text.format.DateFormat
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * How a language writes a date or a time, as a pattern: "MMMM d" in English, "d. MMMM" in
 * German. [skeleton] names the pieces wanted ("MMMMd", "jm") and the locale's own style
 * decides their order, separators and 12 or 24 hours (docs/L10N.md, rule 5).
 *
 * A seam so `logic/` stays plain JVM: the app asks the platform's ICU data
 * ([PlatformDatePatterns]); tests hand in ICU4J, which is the same data on a desktop JVM.
 */
fun interface DatePatterns {
    fun best(locale: Locale, skeleton: String): String
}

/** The phone's own date and time styles (what the clock and calendar apps use). */
object PlatformDatePatterns : DatePatterns {
    override fun best(locale: Locale, skeleton: String): String =
        DateFormat.getBestDateTimePattern(locale, skeleton)
}

/** The skeletons Tabsend asks for. */
object DateSkeleton {
    /** A day without its year: "October 27", "27. Oktober". */
    const val DAY = "MMMMd"

    /** A short day without its year: "Nov 18", "18. Nov.". */
    const val SHORT_DAY = "MMMd"

    /** A time of day in the locale's own clock: "3:05 PM", "15:05". */
    const val TIME = "jm"
}

/**
 * A formatter for [skeleton] in [locale]. A pattern the formatter cannot read (some locales
 * use letters older Java time does not know) falls back to the locale's plain date or time
 * style, which is always valid, so a date is never lost over its layout.
 */
internal fun DatePatterns.formatter(locale: Locale, skeleton: String): DateTimeFormatter =
    try {
        DateTimeFormatter.ofPattern(best(locale, skeleton), locale)
    } catch (_: IllegalArgumentException) {
        if (skeleton == DateSkeleton.TIME) {
            DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale)
        } else {
            DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale)
        }
    }
