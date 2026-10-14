#!/bin/sh
# Regenerate the iOS app icon from the shared brand mark.
#
# Source of truth: assets/tabsend-icon-ios.svg (the same mark as the extension
# and Android use, adapted for iOS: full-bleed, square corners, no transparency).
# Run this after changing that file; the generated PNG is committed so a plain
# `xcodegen generate && xcodebuild` needs no extra tooling.
set -e
cd "$(dirname "$0")/../.."

SRC=assets/tabsend-icon-ios.svg
OUT=ios/App/Assets.xcassets/AppIcon.appiconset/tabsend-1024.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Quick Look is the one SVG renderer every Mac has; no brew install needed.
qlmanage -t -s 1024 -o "$TMP" "$SRC" >/dev/null 2>&1
RENDERED="$TMP/$(basename "$SRC").png"
[ -f "$RENDERED" ] || { echo "qlmanage did not render $SRC" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
swift ios/tools/flatten-png.swift "$RENDERED" "$OUT"
echo "wrote $OUT"
