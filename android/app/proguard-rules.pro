# v1 debug/release builds do not shrink (isMinifyEnabled = false), so these rules
# are belt-and-braces for a future minified build.

# kotlinx.serialization — keep generated serializers + @Serializable metadata.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class io.tabsend.app.** {
    *** Companion;
}
-keepclasseswithmembers class io.tabsend.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Bouncy Castle providers.
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**

# UnifiedPush connector (reflinjected receiver entry points).
-keep class org.unifiedpush.android.connector.** { *; }
