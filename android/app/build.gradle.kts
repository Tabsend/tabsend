plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

/**
 * Marketing version. Bump by hand for a real release.
 */
val appVersion = "0.8.2"

/**
 * Build identity. Builds are installed by downloading the CI artifact — there is no
 * cable and no adb, so "which build is on the phone?" can only ever be answered by
 * what the app itself displays. A frozen versionCode of 1 made that unanswerable and
 * turned a stale install into hours of relay debugging (dogfood 2026-07-26).
 *
 * In CI, versionCode is the run number (monotonic, so Android treats a newer artifact
 * as an upgrade) and the name carries the commit. Locally both fall back to something
 * obviously non-release, so a dev build can never be mistaken for one from GitHub.
 */
val ciRunNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "").toIntOrNull()
val gitSha = (System.getenv("GITHUB_SHA") ?: "").take(7)

/**
 * Google Play builds are made on the owner's Mac by `tools/build-play-bundle.sh`, never in
 * CI: they are signed with the upload key, which stays on that Mac. The script sets the
 * versionCode to the commit count of the build's commit, which only grows along `main`,
 * so every upload is newer than the last, as Play requires. Play installs and GitHub APKs
 * are signed with different keys, so neither ever updates the other and their numbers
 * need not line up.
 */
val playVersionCode = (System.getenv("TABSEND_PLAY_VERSION_CODE") ?: "").toIntOrNull()
val playSha = (System.getenv("TABSEND_PLAY_SHA") ?: "").take(7)

/**
 * Stable signing identity for CI artifacts. Android refuses to install an APK over
 * an existing one signed by a different key, and a plain `assembleDebug` uses the
 * auto-generated `~/.android/debug.keystore` — which on an ephemeral CI runner is a
 * fresh random key every run. That made every download an uninstall-and-re-pair
 * (dogfood 2026-07-28).
 *
 * The keystore is injected by the workflow from repository secrets; it is never
 * committed. When the variables are absent (any local build) we fall back to the
 * default debug keystore, so nothing extra is needed to build on a laptop.
 */
/**
 * Google push, configured at build time or absent [P-11].
 *
 * There is deliberately NO `com.google.gms.google-services` plugin and no
 * `google-services.json` in this repo. That plugin fails the build when the file is
 * missing, which would make a Firebase project a prerequisite for compiling Tabsend at
 * all — for everyone, including contributors who will never touch push. Firebase is
 * initialised in code instead, from these four values, and when they are blank the app
 * has no Google push and says so on screen. ONE apk serves both cases; there is no
 * flavour, and a Google-free phone loses nothing.
 *
 * All four come out of the `google-services.json` Firebase generates:
 *   APP_ID    → client[0].client_info.mobilesdk_app_id
 *   PROJECT_ID→ project_info.project_id
 *   API_KEY   → client[0].api_key[0].current_key
 *   SENDER_ID → project_info.project_number
 * None of them is a secret: every one ships inside any app that uses Firebase, and the
 * credential that can actually SEND a push lives only on the wake-up forwarder.
 */
fun fcmValue(name: String) = System.getenv(name)?.trim().orEmpty()

/**
 * The wake-up forwarder this build registers with [0032]. Blank in a normal build, which
 * is why Google push is off by default: without a forwarder there is nobody to mint a wake
 * token, so the app keeps its own connection open instead. P-9's hazard applies here as it
 * does on iOS — this is the app's half, and the relay's half is its operator's
 * WAKE_FORWARDER_URL; nothing compares the two.
 */
val wakeForwarderUrl = System.getenv("TABSEND_WAKE_FORWARDER_URL")?.trim().orEmpty()

val signingStoreFile = System.getenv("TABSEND_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
val signingStorePassword = System.getenv("TABSEND_KEYSTORE_PASSWORD") ?: ""
val signingKeyAlias = System.getenv("TABSEND_KEY_ALIAS") ?: ""
val signingKeyPassword = System.getenv("TABSEND_KEY_PASSWORD") ?: ""

android {
    namespace = "io.tabsend.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.tabsend.app"
        minSdk = 26
        targetSdk = 36
        versionCode = playVersionCode ?: ciRunNumber ?: 1
        versionName = when {
            playVersionCode != null -> "$appVersion (Play $playVersionCode · $playSha)"
            ciRunNumber != null && gitSha.isNotEmpty() -> "$appVersion (build $ciRunNumber · $gitSha)"
            ciRunNumber != null -> "$appVersion (build $ciRunNumber)"
            else -> "$appVersion (local dev build)"
        }

        buildConfigField("String", "FCM_APP_ID", "\"${fcmValue("TABSEND_FCM_APP_ID")}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${fcmValue("TABSEND_FCM_PROJECT_ID")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${fcmValue("TABSEND_FCM_API_KEY")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${fcmValue("TABSEND_FCM_SENDER_ID")}\"")
        buildConfigField("String", "WAKE_FORWARDER_URL", "\"$wakeForwarderUrl\"")
    }

    if (signingStoreFile != null) {
        signingConfigs {
            create("tabsend") {
                storeFile = file(signingStoreFile)
                // Explicit, because a PKCS12 store may be produced by openssl rather
                // than keytool; PKCS12 is also the JDK 9+ default, so this is a no-op
                // for a keytool-generated store.
                storeType = "PKCS12"
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            // v1 dogfood ships debug builds, so this is the one that has to be
            // stably signed for an in-place update to work.
            if (signingStoreFile != null) {
                signingConfig = signingConfigs.getByName("tabsend")
            }
        }
        release {
            if (signingStoreFile != null) {
                signingConfig = signingConfigs.getByName("tabsend")
            }
            // v1 dogfood ships debug builds; keep release un-shrunk so the
            // hand-rolled crypto + reflection-free serialization never get stripped.
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
        // AGP 8 stopped generating BuildConfig by default; the app shows
        // VERSION_NAME so the installed build can identify itself on-screen.
        buildConfig = true
    }
    testOptions {
        unitTests {
            // Pure-JVM logic is Android-free; this only guards the odd stub call.
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // Direct Share back-compat. On API 30+ the system reads Sharing Shortcuts
    // itself; below that the share sheet still asks a ChooserTargetService, and
    // this library provides the one that answers from res/xml/shortcuts.xml. No
    // shortcut would reach the sheet on Android 9/10 without it (minSdk is 26).
    implementation("androidx.sharetarget:sharetarget:1.2.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    // App-visible tracking for the WS fast path [0015] (connect while any of our
    // screens is in front; StreamService keeps it up in the background when opted in).
    implementation("androidx.lifecycle:lifecycle-process:2.8.4")

    // Google push, so instant delivery need not hold a foreground service and its
    // permanent notification [P-11]. Present in every build and USED only when the four
    // FCM_* values above are set AND the phone has Play Services AND the user has not
    // opted out — a degoogled phone runs this apk unchanged and falls back to the
    // foreground service. The messaging library is what talks to Google; the credential
    // that can send a push is on the forwarder, never here.
    implementation("com.google.firebase:firebase-messaging:24.0.3")

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // HTTP + the WS fast path to the relay (Apache-2.0; PATCH support
    // HttpURLConnection lacks, WebSocket client built in), and the wake-up forwarder
    // on a build with Google push [0034]. No analytics SDKs.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // E2E crypto. Only X25519 + Poly1305 come from Bouncy Castle (MIT-style
    // "Bouncy Castle Licence", NOT GPL); Salsa20/HSalsa20/XSalsa20 are hand-rolled
    // in crypto/ so crypto_box is byte-for-byte with libsodium (proven by the
    // interop vector) and runs identically on device, host JVM tests, and CI.
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // QR pairing scanner — zxing (Apache-2.0), decodes on-device, no Play
    // Services / ML Kit dependency.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test:1.9.24")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
