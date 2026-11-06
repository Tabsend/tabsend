package io.tabsend.app.logic

import android.content.Context
import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes

/**
 * Where every sentence the app says comes from (docs/L10N.md).
 *
 * The wording lives in `res/values/strings.xml` and nowhere else. Code that has to
 * choose a sentence (which failure, which count) asks this for a resource id, so it
 * never holds English itself and a translated `values-xx/strings.xml` is picked up
 * with no code change.
 *
 * A seam instead of a bare `Context`, because the sentence-choosing code in `logic/`
 * is plain JVM and tested without Robolectric. The app passes [ResourceText]; the
 * tests pass a reader of the real `strings.xml` (`EnglishText` in the test sources),
 * so a test still proves the exact English a person sees.
 *
 * Arguments fill `%1$s`-style placeholders. A plural is chosen by the platform from
 * the number ([plural]); code never compares a count to 1 to pick a sentence.
 */
interface TextSource {
    /** The string [id], with [args] filled in. */
    fun string(@StringRes id: Int, vararg args: Any): String

    /** The form of plural [id] that fits [quantity], with [args] filled in (usually the number itself). */
    fun plural(@PluralsRes id: Int, quantity: Int, vararg args: Any): String
}

/** [TextSource] over the app's resources, in the language the phone is set to. */
class ResourceText(private val resources: Resources) : TextSource {
    // Without arguments the text is returned as written: Resources.getString(id, *args) runs
    // String.format even for an empty list, which would choke on a literal percent sign.
    override fun string(id: Int, vararg args: Any): String =
        if (args.isEmpty()) resources.getString(id) else resources.getString(id, *args)

    override fun plural(id: Int, quantity: Int, vararg args: Any): String =
        if (args.isEmpty()) resources.getQuantityString(id, quantity) else resources.getQuantityString(id, quantity, *args)
}

/** The sentences of this context, for the code in `logic/` that picks one. */
fun Context.texts(): TextSource = ResourceText(resources)

/**
 * The language a date or time should be written in: the phone's first language. The text itself
 * comes from the best matching `values-xx` folder, which can be a later language on the list when
 * the app has no translation for the first; that rare mismatch is noted in docs/L10N.md.
 */
fun Context.uiLocale(): java.util.Locale = resources.configuration.locales[0]
