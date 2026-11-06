import XCTest
@testable import TabsendKit

/// What the platform's date, age and list formatters print for a German phone, so the day
/// German text is added to the catalogs nothing about these is a surprise.
///
/// The formatters take the language from `L10n.displayLocale`, which follows the languages
/// inside the package's catalog. A test cannot add a language to the test bundle, so these
/// name the locale directly (the `locale:` argument every helper takes). `de`, `de_DE`,
/// `de_AT` and `de_CH` are all tried: a phone set to Austria or Switzerland picks German
/// text with its own region, and none of them may read differently here.
///
/// The English side is pinned in `RelayErrorTextTests` and `EnglishCopyGoldenTests`; the
/// last test below checks that naming English explicitly gives the same words.
final class GermanFormatTests: XCTestCase {

    private let germanLocales = ["de", "de_DE", "de_AT", "de_CH"].map(Locale.init(identifier:))

    // MARK: ages

    /// The German style: "vor 5 Min.", "vor 2 Std.". The abbreviated style that English
    /// uses would print "vor 5 m" (no "Min."), so German must stay on the short style.
    func testGermanMinutesAndHoursAreTheShortStyle() {
        for locale in germanLocales {
            XCTAssertEqual(L10n.minutesAgo(1, locale: locale), "vor 1 Min.", locale.identifier)
            XCTAssertEqual(L10n.minutesAgo(5, locale: locale), "vor 5 Min.", locale.identifier)
            XCTAssertEqual(L10n.minutesAgo(59, locale: locale), "vor 59 Min.", locale.identifier)
            XCTAssertEqual(L10n.hoursAgo(1, locale: locale), "vor 1 Std.", locale.identifier)
            XCTAssertEqual(L10n.hoursAgo(2, locale: locale), "vor 2 Std.", locale.identifier)
            XCTAssertEqual(L10n.hoursAgo(23, locale: locale), "vor 23 Std.", locale.identifier)
        }
    }

    /// The German style guide says "vor 3 Tagen" on every client (decided 2026-11-05). The
    /// platform's short and abbreviated styles both print the whole word, with the dative
    /// plural, and no styled form says "Tg.", so the phone needs no special case. This pins
    /// that, so a platform update that changes it shows up here.
    ///
    /// The platform also puts a no-break space (U+00A0) between the number and the word in
    /// "vor 2 Monaten" (and nowhere else here). That keeps the two on one line, which is
    /// right, so it is not removed; this test compares with ordinary spaces so that a
    /// platform update that changes which spaces it uses does not fail it.
    func testGermanDaysMonthsAndYearsAreWholeWordsBecauseThePlatformHasNoShorterForm() {
        for locale in germanLocales {
            XCTAssertEqual(plain(L10n.daysAgo(1, locale: locale)), "vor 1 Tag", locale.identifier)
            XCTAssertEqual(plain(L10n.daysAgo(3, locale: locale)), "vor 3 Tagen", locale.identifier)
            XCTAssertEqual(plain(L10n.daysAgo(29, locale: locale)), "vor 29 Tagen", locale.identifier)
            XCTAssertEqual(plain(L10n.monthsAgo(1, locale: locale)), "vor 1 Monat", locale.identifier)
            XCTAssertEqual(plain(L10n.monthsAgo(2, locale: locale)), "vor 2 Monaten", locale.identifier)
            XCTAssertEqual(plain(L10n.yearsAgo(1, locale: locale)), "vor 1 Jahr", locale.identifier)
            XCTAssertEqual(plain(L10n.yearsAgo(3, locale: locale)), "vor 3 Jahren", locale.identifier)
        }
    }

    /// Ordinary spaces for no-break (U+00A0) and narrow no-break (U+202F) ones.
    private func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
    }

    /// Every German age keeps the word for "ago" in front (the point of the short style),
    /// and the number is the one the caller chose: "90 minutes" stays minutes.
    func testGermanAgesAlwaysSayVorAndKeepTheUnitTheCallerChose() {
        let de = Locale(identifier: "de")
        for n in 1...59 { XCTAssertEqual(L10n.minutesAgo(n, locale: de), "vor \(n) Min.") }
        for n in 1...23 { XCTAssertEqual(L10n.hoursAgo(n, locale: de), "vor \(n) Std.") }
        XCTAssertEqual(L10n.minutesAgo(90, locale: de), "vor 90 Min.")
    }

    // MARK: lists

    /// "A, B und C": no comma before "und", which German does not write. The English
    /// variant asks for British English to get that; German gets it from its own rules.
    func testGermanNameListsUseUndWithNoCommaBeforeIt() {
        for locale in germanLocales {
            XCTAssertEqual(L10n.list([], locale: locale), "", locale.identifier)
            XCTAssertEqual(L10n.list(["A"], locale: locale), "A", locale.identifier)
            XCTAssertEqual(L10n.list(["A", "B"], locale: locale), "A und B", locale.identifier)
            XCTAssertEqual(L10n.list(["A", "B", "C"], locale: locale), "A, B und C", locale.identifier)
            XCTAssertEqual(L10n.list(["A", "B", "C", "D"], locale: locale), "A, B, C und D", locale.identifier)
        }
    }

    // MARK: dates and times

    /// 27 October 2026, 14:05 UTC. German writes the day first with a full stop, the month
    /// name in German, and a 24-hour clock with no AM or PM.
    func testGermanDatesAndTimes() {
        let date = Date(timeIntervalSince1970: 1_793_109_900)
        let utc = TimeZone(identifier: "UTC")!
        for locale in germanLocales {
            XCTAssertEqual(L10n.monthAndDay(date, timeZone: utc, locale: locale), "27. Oktober", locale.identifier)
            XCTAssertEqual(L10n.shortMonthAndDay(date, timeZone: utc, locale: locale), "27. Okt.", locale.identifier)
            XCTAssertEqual(L10n.hourAndMinute(date, timeZone: utc, locale: locale), "14:05", locale.identifier)
        }
    }

    /// The time zone still decides the hour: the same moment is 15:05 in Berlin (CET).
    func testGermanTimesFollowTheTimeZone() {
        let date = Date(timeIntervalSince1970: 1_793_109_900)
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        XCTAssertEqual(L10n.hourAndMinute(date, timeZone: berlin, locale: Locale(identifier: "de_DE")), "15:05")
    }

    // MARK: English is untouched

    /// Naming English explicitly prints the same words as the app does by default, so
    /// the `locale:` argument cannot have moved any English text. The app's own locale is
    /// the bare language ("en", from the name of the language folder in the catalog), never
    /// a region, so those are the ones tried: a region such as `en_GB` would be a different
    /// question (its abbreviated style reads "5 min ago") that the app never asks.
    func testNamingEnglishGivesTheEnglishWordsEveryClientShares() {
        for locale in ["en", "en_US"].map(Locale.init(identifier:)) {
            XCTAssertEqual(L10n.minutesAgo(5, locale: locale), "5m ago", locale.identifier)
            XCTAssertEqual(L10n.hoursAgo(2, locale: locale), "2h ago", locale.identifier)
            XCTAssertEqual(L10n.daysAgo(3, locale: locale), "3d ago", locale.identifier)
            XCTAssertEqual(L10n.list(["A", "B", "C"], locale: locale), "A, B and C", locale.identifier)
        }
        let date = Date(timeIntervalSince1970: 1_793_109_900)
        let utc = TimeZone(identifier: "UTC")!
        let en = Locale(identifier: "en_US")
        XCTAssertEqual(L10n.monthAndDay(date, timeZone: utc, locale: en), "October 27")
        XCTAssertEqual(L10n.shortMonthAndDay(date, timeZone: utc, locale: en), "Oct 27")
        XCTAssertEqual(L10n.hourAndMinute(date, timeZone: utc, locale: en), "2:05 PM")
    }
}
