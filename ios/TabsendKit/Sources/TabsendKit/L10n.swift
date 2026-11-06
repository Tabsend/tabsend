import Foundation

/// Shared helpers for the String Catalog in `Resources/Localizable.xcstrings`.
///
/// Every sentence this package builds is looked up with
/// `String(localized: ..., bundle: .module, comment: ...)`; the English text is the key
/// (Apple's convention, docs/L10N.md), so a missing translation shows English, never a
/// raw key. Adding a language is a translation of the catalog and nothing else.
enum L10n {
    /// The language the app's text is shown in, as a locale. A date or a time that sits
    /// inside a sentence follows it, so the sentence and its date agree: English text
    /// gets "October 27" and "2:05 PM" whatever region the phone is set to, and a German
    /// sentence will get "27. Oktober" and "14:05".
    static var displayLocale: Locale {
        Locale(identifier: Bundle.module.preferredLocalizations.first ?? "en")
    }

    /// "October 27", in `timeZone`.
    static func monthAndDay(_ date: Date, timeZone: TimeZone, locale: Locale = displayLocale) -> String {
        return date.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: locale.calendar, timeZone: timeZone)
                .month(.wide).day()
        )
    }

    /// "Nov 18", in `timeZone`.
    static func shortMonthAndDay(_ date: Date, timeZone: TimeZone, locale: Locale = displayLocale) -> String {
        return date.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: locale.calendar, timeZone: timeZone)
                .month(.abbreviated).day()
        )
    }

    /// "2:05 PM", in `timeZone`.
    ///
    /// The platform puts a narrow no-break space (U+202F) before AM and PM. The English
    /// text has always had an ordinary space there, and the two print a little
    /// differently, so the ordinary space is kept: nothing about the English card moves.
    static func hourAndMinute(_ date: Date, timeZone: TimeZone, locale: Locale = displayLocale) -> String {
        return date.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, locale: locale, calendar: locale.calendar, timeZone: timeZone)
                .hour().minute()
        ).replacingOccurrences(of: "\u{202F}", with: " ")
    }

    // MARK: ages
    //
    // The compact ages ("3m ago") come from the platform's own relative-time formatter, in
    // the app language, so every language gets its own units, word order and plural
    // forms and there is nothing to translate. English asks for the formatter's
    // abbreviated style, which prints exactly the words every Tabsend client shares
    // ("3m ago", "2h ago", "5d ago", "2mo ago", "1y ago"). Every other language asks for
    // the short style, because the abbreviated one drops the word for "ago" in some
    // languages ("-3 min", "vor 3 m").
    //
    // "just now" is the one age that stays a catalog phrase: the formatter has no
    // sentence for less than a minute.

    static var justNow: String {
        String(
            localized: "just now",
            bundle: .module,
            comment: "Age of something that happened less than a minute ago. Short: it sits in a row of small print, after a dot."
        )
    }

    // The five ages take the locale as a last argument that defaults to the app language.
    // Only the tests pass it: the app's own text always follows `displayLocale`, but a test
    // cannot change which languages the test bundle has, so it names the language instead.
    static func minutesAgo(_ minutes: Int, locale: Locale = displayLocale) -> String { ago(minutes, .minute, locale) }
    static func hoursAgo(_ hours: Int, locale: Locale = displayLocale) -> String { ago(hours, .hour, locale) }
    static func daysAgo(_ days: Int, locale: Locale = displayLocale) -> String { ago(days, .day, locale) }
    static func monthsAgo(_ months: Int, locale: Locale = displayLocale) -> String { ago(months, .month, locale) }
    static func yearsAgo(_ years: Int, locale: Locale = displayLocale) -> String { ago(years, .year, locale) }

    /// `value` of one unit back, said in that unit only: the caller has already chosen it,
    /// so "90 minutes" never turns into "2 hours" here.
    private static func ago(_ value: Int, _ unit: Calendar.Component, _ locale: Locale) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = locale.language.languageCode == .english ? .abbreviated : .short
        var amount = DateComponents()
        amount.setValue(-value, for: unit)
        return formatter.localizedString(from: amount)
    }

    // MARK: lists

    /// "A", "A and B", "A, B and C": the separators, the word for "and" and any comma
    /// before it are the app language's own, from the platform. A name list is not a
    /// sentence anyone translates; the platform knows how each language writes one.
    ///
    /// English is the one exception, and only in the choice of region: the extension and
    /// Android write "A, B and C" with no comma before "and" (the new-device notice is "the
    /// same words on every client"), which is how British English writes a list, while
    /// the platform's plain English adds one ("A, B, and C"). So English asks for that variant.
    static func list(_ items: [String], locale: Locale = displayLocale) -> String {
        let listLocale = locale.language.languageCode == .english ? Locale(identifier: "en_GB") : locale
        return items.formatted(.list(type: .and, width: .standard).locale(listLocale))
    }
}
