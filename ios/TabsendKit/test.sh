#!/bin/sh
# Runs the TabsendKit test suite on macOS.
#
# With full Xcode installed, a plain `swift test` works. With only the
# Command Line Tools, the Swift Testing framework needs explicit search
# paths — this script supplies them either way.
#
# The package's text lives in a String Catalog (Sources/TabsendKit/Resources/
# Localizable.xcstrings). SwiftPM's default build copies a catalog without compiling it,
# so plural forms ("1 tab", "2 tabs") would never be found and the tests would read
# the wrong English. This script therefore builds with the same engine Xcode uses
# (`--build-system swiftbuild`, Swift 6.2 and later), which compiles the catalog.
# Without it, the tests are run through `xcodebuild` instead, which does the same.
#
# The English tests (the golden file, the wording tests) read the package's text in the
# language the machine asks for. Once a second language is in the catalog, a Mac whose first
# language is German would read German and fail them. `swift test` cannot be told which
# language to use, but `xcodebuild test` can (`-testLanguage`), so a machine whose first
# language is not English goes through `xcodebuild` with English forced, and the English
# tests mean the same thing everywhere. Dates and lists in other languages are tested with
# an explicit `locale:` (GermanFormatTests), not by switching the machine.
set -e
cd "$(dirname "$0")"

# The machine's first language, such as "de-US" or "en-GB". Empty when it cannot be read.
first_language=$(defaults read -g AppleLanguages 2>/dev/null | sed -n '2p' | tr -d ' ",')
case "$first_language" in
    en*|"") english_first=1 ;;
    *) english_first=0 ;;
esac

if xcode-select -p 2>/dev/null | grep -qv CommandLineTools; then
    if [ "$english_first" = 1 ] && swift test --help 2>&1 | grep -q swiftbuild; then
        exec swift test --build-system swiftbuild "$@"
    fi
    # Older toolchains, or a machine whose first language is not English: run the same tests
    # through Xcode's own build system.
    # (`--filter X` becomes `-only-testing:TabsendKitTests/X`.)
    ONLY=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --filter) shift; ONLY="$ONLY -only-testing:TabsendKitTests/$1" ;;
            *) echo "test.sh: with this toolchain only --filter is supported, got $1" >&2; exit 2 ;;
        esac
        shift
    done
    # shellcheck disable=SC2086
    exec xcodebuild test -scheme TabsendKit -destination 'platform=macOS' -testLanguage en -testRegion US $ONLY
fi

# Command Line Tools only: no catalog compiler is available, so English plural forms
# cannot be checked here. Install Xcode.
echo "test.sh: the full Xcode app is needed so the String Catalog can be compiled (xcode-select -p points at the Command Line Tools)." >&2
exit 2
