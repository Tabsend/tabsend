package io.tabsend.app

import com.ibm.icu.text.DateTimePatternGenerator
import com.ibm.icu.text.PluralRules
import com.ibm.icu.util.ULocale
import io.tabsend.app.logic.DatePatterns
import io.tabsend.app.logic.TextSource
import org.w3c.dom.Element
import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The app's sentences for the JVM tests, read from the real `res/values/strings.xml`.
 *
 * A test that asserts an English sentence therefore asserts the exact text a person sees, and
 * a sentence edited in strings.xml shows up in the tests. No Robolectric: this reads the file,
 * applies the same text rules the Android resource compiler applies (whitespace, escapes) and
 * the same formatting and plural-form choice Android uses (`String.format` with the locale,
 * CLDR plural categories from ICU).
 *
 * [locale] picks the plural form and the number format, so a test can ask what a count looks
 * like in another language. The wording stays English (there is no other catalog yet); once a
 * `values-xx` folder exists, point [catalog] at it.
 */
class XmlText(
    private val locale: Locale,
    catalog: File = sourceFile("src/main/res/values/strings.xml"),
) : TextSource {
    private val strings = HashMap<String, String>()
    private val plurals = HashMap<String, Map<String, String>>()

    init {
        val root = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(catalog).documentElement
        val nodes = root.childNodes
        for (i in 0 until nodes.length) {
            val node = nodes.item(i) as? Element ?: continue
            when (node.tagName) {
                "string" -> strings[node.getAttribute("name")] = decode(node.textContent)
                "plurals" -> {
                    val items = node.getElementsByTagName("item")
                    plurals[node.getAttribute("name")] = (0 until items.length).associate {
                        val item = items.item(it) as Element
                        item.getAttribute("quantity") to decode(item.textContent)
                    }
                }
            }
        }
    }

    override fun string(id: Int, vararg args: Any): String {
        val raw = strings[nameOfString(id)] ?: error("no string with id $id")
        return if (args.isEmpty()) raw else String.format(locale, raw, *args)
    }

    override fun plural(id: Int, quantity: Int, vararg args: Any): String {
        val name = nameOfPlural(id)
        val forms = plurals[name] ?: error("no plurals $name")
        val category = categoryOf(locale, quantity)
        // Android falls back to "other" when a language has a category the catalog does not carry.
        val raw = forms[category] ?: forms["other"] ?: error("plurals $name has no 'other' form")
        return if (args.isEmpty()) raw else String.format(locale, raw, *args)
    }

    companion object {
        /** English, the source language and the final fallback. */
        val english: TextSource by lazy { XmlText(Locale.US) }

        /** The CLDR plural category ("one", "few", "other"...) a language uses for [quantity]. */
        fun categoryOf(locale: Locale, quantity: Int): String =
            PluralRules.forLocale(ULocale.forLocale(locale)).select(quantity.toDouble())

        /** Gradle runs unit tests from the module directory; an IDE may run them from the root. */
        fun sourceFile(path: String): File =
            listOf(File(path), File("app/$path"), File("android/app/$path")).first { it.isFile }

        private val stringNames: Map<Int, String> by lazy { idsOf(R.string::class.java) }
        private val pluralNames: Map<Int, String> by lazy { idsOf(R.plurals::class.java) }

        private fun idsOf(holder: Class<*>): Map<Int, String> =
            holder.fields.filter { it.type == Int::class.javaPrimitiveType }.associate { it.getInt(null) to it.name }

        private fun nameOfString(id: Int) = stringNames[id] ?: error("R.string has no id $id")
        private fun nameOfPlural(id: Int) = pluralNames[id] ?: error("R.plurals has no id $id")

        /**
         * Text as the resource compiler stores it: runs of white space become one space, the ends are
         * trimmed, then backslash escapes are resolved. A string in quotes keeps its spaces; none here
         * is.
         */
        fun decode(raw: String): String {
            val collapsed = raw.trim().replace(Regex("\\s+"), " ")
            val out = StringBuilder()
            var i = 0
            while (i < collapsed.length) {
                val c = collapsed[i]
                if (c == '\\' && i + 1 < collapsed.length) {
                    when (val next = collapsed[i + 1]) {
                        'n' -> out.append('\n')
                        't' -> out.append('\t')
                        'u' -> {
                            out.append(collapsed.substring(i + 2, i + 6).toInt(16).toChar())
                            i += 4
                        }
                        else -> out.append(next) // \' \" \\ \@ \?
                    }
                    i += 2
                } else {
                    out.append(c)
                    i++
                }
            }
            return out.toString()
        }
    }
}

/** What Android's own date patterns say, from the ICU data a desktop JVM can load. */
object IcuDatePatterns : DatePatterns {
    override fun best(locale: Locale, skeleton: String): String =
        DateTimePatternGenerator.getInstance(ULocale.forLocale(locale)).getBestPattern(skeleton)
}

/** English, as the tests assert it. */
val EN: TextSource get() = XmlText.english
