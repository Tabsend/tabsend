#!/usr/bin/env bash
# Load the throwaway probe as a TEMPORARY add-on into real Firefox via web-ext and
# let it report whether the Web Push API is reachable from a WebExtension.
# The probe POSTs its result to the relay (/probe -> probe-firefox.json) and logs it.
set -u
cd "$(dirname "$0")/.."   # spikes/transport
FIREFOX="/Applications/Firefox.app/Contents/MacOS/firefox"
LOG="${1:-/tmp/fx-probe.log}"

rm -f probe-firefox.json
echo "[run-probe] launching Firefox via web-ext (temporary add-on)..."
node_modules/.bin/web-ext run \
  --source-dir=firefox/probe-extension \
  --firefox="$FIREFOX" \
  --no-reload \
  --no-input \
  > "$LOG" 2>&1 &
WEBEXT_PID=$!
echo "[run-probe] web-ext pid $WEBEXT_PID; waiting up to 40s for probe result..."

for i in $(seq 1 40); do
  if [ -f probe-firefox.json ]; then
    echo "[run-probe] probe reported."
    break
  fi
  sleep 1
done

echo "===== probe-firefox.json ====="
cat probe-firefox.json 2>/dev/null || echo "(no probe file — check $LOG)"
echo
echo "===== web-ext console (fx-probe lines) ====="
grep -i "fx-probe" "$LOG" 2>/dev/null | head -20

kill "$WEBEXT_PID" 2>/dev/null
pkill -f "firefox.*web-ext" 2>/dev/null
echo "[run-probe] done."
