#!/usr/bin/env bash
# Makes the Google Play UPLOAD key, once, on the owner's Mac (docs/STORE_LISTING.md,
# "Google Play": "The upload key").
#
# Google signs what users install with its own key (Play App Signing). This key only
# proves to Google that an upload came from us. If it is ever lost or leaked, Play
# Console can replace it ("Request upload key reset"), so losing it costs a few days,
# not the app.
#
# The key never goes in the repo, in chat, in CI or in a log. It lives in one file,
# outside the repo, protected by a password that only the owner knows (keep it in a
# password manager, with a copy of the file).
#
#   android/tools/make-upload-key.sh
#
# Refuses to run if the file is already there: a second key would not match the one
# Google already has.
set -euo pipefail

KEY_DIR="${TABSEND_UPLOAD_KEY_DIR:-$HOME/Tabsend signing}"
KEY_FILE="$KEY_DIR/tabsend-upload.p12"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
KEYTOOL="$JAVA_HOME/bin/keytool"

if [ -e "$KEY_FILE" ]; then
  echo "There is already an upload key at:"
  echo "  $KEY_FILE"
  echo "Nothing was changed. Use that one; Google knows it."
  exit 1
fi
if [ ! -x "$KEYTOOL" ]; then
  echo "Java's keytool was not found at $KEYTOOL." >&2
  echo "Install it with: brew install openjdk@17" >&2
  exit 1
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

echo "Making the Google Play upload key."
echo "keytool asks for a password twice. Pick a new, long one and save it in your"
echo "password manager first. Nothing shows while you type; that is normal."
echo

# RSA 4096, valid about 27 years (Google asks for at least 25). PKCS12 uses one password
# for the file and the key, which is what build-play-bundle.sh expects.
"$KEYTOOL" -genkeypair \
  -keystore "$KEY_FILE" -storetype PKCS12 \
  -alias upload -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Zinnia Drive LLC, O=Zinnia Drive LLC, C=US"

chmod 600 "$KEY_FILE"
echo
echo "Done. The upload key is in:"
echo "  $KEY_FILE"
echo "Put a copy of that file in your password manager, next to the password."
echo "build-play-bundle.sh prints the key's fingerprint each time it builds."
