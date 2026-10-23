#!/usr/bin/env bash
# Builds the bundle (.aab) to upload to Google Play, signed with the upload key from
# make-upload-key.sh (docs/STORE_LISTING.md, "Google Play").
#
#   android/tools/build-play-bundle.sh
#
# Asks for the upload key's password; it is passed to the build in memory only, never
# written down or printed. Builds only a committed, unchanged checkout, so every upload
# matches a commit. Runs the unit tests first.
#
# The versionCode is the commit count of the checked-out commit, so each upload from a
# later commit on `main` is newer than the last (app/build.gradle.kts).
#
# Google push is OFF unless the TABSEND_FCM_* and TABSEND_WAKE_FORWARDER_URL values are
# set in the environment; SECURITY_REVIEW.md G6 gates the first build that carries them.
set -euo pipefail

cd "$(dirname "$0")/.."

KEY_FILE="${TABSEND_UPLOAD_KEY:-$HOME/Tabsend signing/tabsend-upload.p12}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

if [ ! -f "$KEY_FILE" ]; then
  echo "No upload key at $KEY_FILE." >&2
  echo "Make it once with: android/tools/make-upload-key.sh" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "This checkout has changes that are not committed. Commit or drop them first," >&2
  echo "so the upload matches a commit." >&2
  git status --short >&2
  exit 1
fi

sha=$(git rev-parse --short=7 HEAD)
code=$(git rev-list --count HEAD)
echo "Building commit $sha ($(git log -1 --format=%s HEAD))"
echo "versionCode $code"
if [ -z "${TABSEND_FCM_APP_ID:-}" ]; then
  echo "Google push: off (no Firebase values). Phones keep their own connection instead."
fi
echo

printf 'Upload key password: '
read -rs password
echo

export TABSEND_KEYSTORE_FILE="$KEY_FILE"
export TABSEND_KEYSTORE_PASSWORD="$password"
export TABSEND_KEY_ALIAS=upload
export TABSEND_KEY_PASSWORD="$password"
export TABSEND_PLAY_VERSION_CODE="$code"
export TABSEND_PLAY_SHA="$sha"
unset password

./gradlew --no-daemon --quiet :app:testDebugUnitTest :app:bundleRelease

out="dist-play/tabsend-play-$code-$sha.aab"
mkdir -p dist-play
cp app/build/outputs/bundle/release/app-release.aab "$out"

echo
echo "Signed with this key (compare with Play Console > Test and release > App integrity"
echo "> Upload key certificate, SHA-256):"
"$JAVA_HOME/bin/keytool" -printcert -jarfile "$out" | grep "SHA256:" | head -1
echo
echo "Ready to upload:"
echo "  $(pwd)/$out"
