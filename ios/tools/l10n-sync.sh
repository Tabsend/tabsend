#!/bin/sh
# Brings the String Catalogs up to date with the Swift code, or checks that they are.
#
#   ios/tools/l10n-sync.sh           add new strings to the catalogs, mark removed ones stale
#   ios/tools/l10n-sync.sh --check   change nothing; fail if a catalog is out of date
#
# Why a script: Xcode does this by itself when you build in the Xcode window, but a build
# from the command line (and CI) does not touch the catalogs. The Swift compiler writes a
# `.stringsdata` file for every source file, listing the exact keys it found (Text("..."),
# String(localized:), Button("...") and the like, with their comments). `xcstringstool
# sync` merges those into the catalogs. Needs Xcode and XcodeGen; takes a few minutes
# (it is a full unsigned Simulator build).
#
# Catalogs, and which build they listen to:
#   App/Sources/Localizable.xcstrings          app           (table "Localizable")
#   App/ShareExtension/Localizable.xcstrings   share sheet   (table "Localizable")
#   App/Shared/Shared.xcstrings                both          (table "Shared")
#   TabsendKit/Sources/TabsendKit/Resources/Localizable.xcstrings   the package
set -e
cd "$(dirname "$0")/.."

check=0
[ "${1:-}" = "--check" ] && check=1

command -v xcodegen >/dev/null || { echo "XcodeGen is missing: brew install xcodegen" >&2; exit 2; }
xcodegen generate >/dev/null

DD="$PWD/DerivedData/l10n"
mkdir -p "$PWD/DerivedData"
xcodebuild -project Tabsend.xcodeproj -scheme Tabsend -configuration Debug \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build \
    >"$DD.log" 2>&1 || { tail -30 "$DD.log" >&2; echo "build failed, see $DD.log" >&2; exit 2; }

OBJ="$DD/Build/Intermediates.noindex"
KIT="$OBJ/TabsendKit.build/Debug-iphonesimulator/TabsendKit.build/Objects-normal"
APP="$OBJ/Tabsend.build/Debug-iphonesimulator/Tabsend.build/Objects-normal"
SHARE="$OBJ/Tabsend.build/Debug-iphonesimulator/TabsendShare.build/Objects-normal"

# The stringsdata files of one build directory, NUL-separated (the project path may
# contain spaces).
data() { find "$1" -name '*.stringsdata' -print0 2>/dev/null; }

[ -n "$(data "$KIT" | tr -d '\0')" ] && [ -n "$(data "$APP" | tr -d '\0')" ] && [ -n "$(data "$SHARE" | tr -d '\0')" ] || {
    echo "the build left no .stringsdata files: is SWIFT_EMIT_LOC_STRINGS on in project.yml?" >&2
    exit 2
}

CATALOGS="App/Sources/Localizable.xcstrings App/ShareExtension/Localizable.xcstrings App/Shared/Shared.xcstrings TabsendKit/Sources/TabsendKit/Resources/Localizable.xcstrings"

if [ "$check" = 1 ]; then
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    for c in $CATALOGS; do mkdir -p "$WORK/$(dirname "$c")"; cp "$c" "$WORK/$c"; done
    SRC="$WORK"
else
    SRC="."
fi

sync_into() { # catalog, then NUL-separated stringsdata paths on stdin
    xargs -0 xcrun xcstringstool sync "$1" --stringsdata
}
data "$KIT" | sync_into "$SRC/TabsendKit/Sources/TabsendKit/Resources/Localizable.xcstrings"
data "$APP" | sync_into "$SRC/App/Sources/Localizable.xcstrings"
data "$SHARE" | sync_into "$SRC/App/ShareExtension/Localizable.xcstrings"
{ data "$APP"; data "$SHARE"; } | sync_into "$SRC/App/Shared/Shared.xcstrings"

if [ "$check" = 1 ]; then
    status=0
    for c in $CATALOGS; do
        if ! diff -q "$c" "$SRC/$c" >/dev/null; then
            echo "out of date: $c"
            diff "$c" "$SRC/$c" | head -20
            status=1
        fi
    done
    [ "$status" = 0 ] && echo "String Catalogs are up to date with the code."
    [ "$status" = 0 ] || echo "Run ios/tools/l10n-sync.sh, add a comment to each new string, and commit the catalogs."
    exit $status
fi
echo "Catalogs updated. Add a translator comment to each new string, then run ios/tools/check-l10n.mjs."
