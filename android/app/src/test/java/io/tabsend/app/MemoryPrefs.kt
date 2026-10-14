package io.tabsend.app

import android.content.SharedPreferences

/** SharedPreferences in memory, with the editor's real rule: clear() goes first. */
internal class MemoryPrefs : SharedPreferences {
    val values = mutableMapOf<String, Any?>()

    /** Keys whose writes fail, to test what a caller does when saving goes wrong. */
    var failingKeys: Set<String> = emptySet()

    override fun getAll(): MutableMap<String, *> = values.toMutableMap()
    override fun getString(key: String, defValue: String?): String? = values[key] as String? ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? =
        values[key] as MutableSet<String>? ?: defValues
    override fun getInt(key: String, defValue: Int): Int = values[key] as Int? ?: defValue
    override fun getLong(key: String, defValue: Long): Long = values[key] as Long? ?: defValue
    override fun getFloat(key: String, defValue: Float): Float = values[key] as Float? ?: defValue
    override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as Boolean? ?: defValue
    override fun contains(key: String): Boolean = values.containsKey(key)
    override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        private var clear = false
        private val changes = mutableMapOf<String, Any?>()
        private val removals = mutableSetOf<String>()
        override fun putString(key: String, value: String?) = apply { put(key, value) }
        override fun putStringSet(key: String, values: MutableSet<String>?) = apply { put(key, values) }
        override fun putInt(key: String, value: Int) = apply { put(key, value) }
        override fun putLong(key: String, value: Long) = apply { put(key, value) }
        override fun putFloat(key: String, value: Float) = apply { put(key, value) }
        override fun putBoolean(key: String, value: Boolean) = apply { put(key, value) }
        override fun remove(key: String) = apply { removals += key; changes.remove(key) }
        override fun clear() = apply { clear = true }
        override fun commit(): Boolean {
            apply()
            return true
        }
        override fun apply() {
            if (clear) values.clear()
            removals.forEach { values.remove(it) }
            changes.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
        }
        private fun put(key: String, value: Any?) {
            if (key in failingKeys) throw IllegalStateException("write to $key failed")
            removals -= key
            changes[key] = value
        }
    }
}
