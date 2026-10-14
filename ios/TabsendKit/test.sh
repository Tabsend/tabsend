#!/bin/sh
# Runs the TabsendKit test suite on macOS.
#
# With full Xcode installed, a plain `swift test` works. With only the
# Command Line Tools, the Swift Testing framework needs explicit search
# paths — this script supplies them either way.
set -e
cd "$(dirname "$0")"

if xcode-select -p 2>/dev/null | grep -qv CommandLineTools; then
    exec swift test "$@"
fi

FWK=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
LIBS=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
exec swift test \
    -Xswiftc -F"$FWK" \
    -Xlinker -F"$FWK" \
    -Xlinker -rpath -Xlinker "$FWK" \
    -Xlinker -rpath -Xlinker "$LIBS" \
    "$@"
