# Tabsend — Android app

The Android endpoint: an OS **share-sheet target** ("Send to Tabsend" when you share
a URL from any browser), **received links** → a notification whose tap opens
the URL in the OS default browser, and a **History** screen: one timeline of what
every device in the group sent and received, with delivery state and "Send again"
on a tab that never arrived (ADR-0028). History rides a group key the relay never
holds; a relay that predates ADR-0028 simply has none, and everything else works
unchanged. **Push-less by default** (ADR-0015): pairing needs
no push setup, no distributor app and no Firebase. Since ADR-0034 the app carries Google's
push library and can be rung through the wake-up forwarder instead, but only on a build
given Firebase values (none ships yet), on a phone with Play Services, paired to a relay
with a forwarder, and not if the user chooses "Don't use Google". Delivery: the relay's
WS fast path while the app is alive (plus an "Instant delivery" foreground
service enabled by default for the background), an ~5-min alarm poll chain, the 15-min WorkManager
backstop, and drain on open/boot.

- `applicationId` `io.tabsend.app`, `versionName` `0.6.1`, `minSdk` 26, `targetSdk`/`compileSdk` 34.
- Single-activity, Material 3 (classic Views — no Compose compiler).
- E2E `crypto_box` interoperates **byte-for-byte** with the extension/server
  (proven by a libsodium-generated vector — see `app/src/test/.../CryptoInteropTest`).
- No analytics. Network: the relay, plus the wake-up forwarder and Google's push service
  on a build with Google push.

## Build from the command line (no Android Studio)

Toolchain (installed once via Homebrew on this machine):

```bash
brew install openjdk@17                      # JDK (keg-only, no sudo)
brew install --cask android-commandlinetools # sdkmanager + SDK root
# SDK root: /opt/homebrew/share/android-commandlinetools
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

Point the build at the SDK (either is fine):

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
# …or keep android/local.properties with `sdk.dir=…` (gitignored, machine-local).
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
```

Then, from `android/`:

```bash
./gradlew test           # JVM unit tests (crypto interop + logic) — no emulator
./gradlew assembleDebug  # → app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper (8.9) is committed, so the first run just downloads the
distribution + AGP 8.5.2 / Kotlin 1.9.24 deps.

## Layout

```
app/src/main/java/io/tabsend/app/
  crypto/    Base64x, Salsa20 (hand-rolled HSalsa20/XSalsa20), CryptoBox, Sealer  ← byte-for-byte with libsodium
  wire/      kotlinx.serialization mirrors of shared/src/types.ts
  net/       ApiClient (OkHttp), Registrar (register + heartbeat + rename), Stream (WS fast path [0015])
  store/     Store (SharedPreferences: identity, registration, MRU, seen-set, outbound, endpoint cache)
  logic/     Mru, Chooser, SeenSet, Labels, Pairing, Strings — pure, unit-tested
  send/      ShareActivity (share-sheet target), Sender (seal → POST → outbound queue)
  receive/   Deliverer (one idempotent deliver path), Notifications, StreamService (default instant delivery)
  work/      DrainWorker, HeartbeatWorker, Scheduling, PollReceiver (~5-min chain), BootReceiver
  ui/        MainActivity (pair + manage devices)
app/src/test/  CryptoInteropTest, LogicTest  (+ resources/interop-vector.json)
tools/gen-interop-vector.mjs  regenerates the interop vector from the TS/libsodium side
```

## Owner test drive

**The no-cable path (recommended):** run the relay with `TLS_SELF_SIGNED=1` and
`HOST=0.0.0.0` (see `docs/DEPLOY.md` → "No domain? Self-signed TLS"). The relay
serves HTTPS itself on your LAN IP; the pairing QR/link carries the certificate
fingerprint (`&fp=…`) and the app pins it (ADR-0019). Scan, join, done — no
domain, no adb, no cable. If the relay's LAN IP later changes, use **Change
relay address** on the paired screen (verified in place, no re-pair — ADR-0020).

**Before that works, a paired device or the relay's first-run log must provide the
complete pairing link.** Point the extension at the relay's https address first
when using it to add the phone (the browser must accept the self-signed certificate
once; `DEPLOY.md` has the step). **Check the QR names
the relay's network address and carries `&fp=`.** A QR that says
`http://localhost:8787` comes from an unconfigured relay and can never pair a
phone: on a handset that address means the handset. This was the whole of the
2026-07-28 dogfood failure — see `docs/DOGFOOD.md`.

The older USB route still works where adb is available: see
`docs/reports/chunk-5c.md` for the on-phone manual-verification script. Note:
that report predates ADR-0015 — skip its ntfy/distributor steps; pairing now
needs nothing but the complete pairing link.

Plain `http://` works **only at `localhost`** (`res/xml/network_security_config.xml`
allows cleartext to loopback + the emulator alias `10.0.2.2`; everything else is
https-only, matching DEPLOY.md). For the USB tunnel:

```bash
adb reverse tcp:8787 tcp:8787   # re-run after replugging the phone — it doesn't persist
```

then pair with `http://localhost:8787`. A plain-http LAN IP (`http://192.168.…`)
stays blocked on purpose; off-device is https — CA-issued or pinned self-signed.
