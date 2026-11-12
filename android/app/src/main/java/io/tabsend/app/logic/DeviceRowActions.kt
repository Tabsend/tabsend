package io.tabsend.app.logic

/** What a device row's More menu offers. */
enum class DeviceRowAction { RENAME, REMOVE }

/**
 * The rule for a device row's More menu, the same on every client: the browsers'
 * `rowActions` (extension/src/pages/device-list.ts) and the iPhone's `DeviceRowActions`.
 * Every device can be renamed; any device but this phone can be removed (this phone
 * leaves with Unpair, which also wipes what it holds).
 */
object DeviceRowActions {
    fun actions(isThisPhone: Boolean): List<DeviceRowAction> =
        if (isThisPhone) listOf(DeviceRowAction.RENAME) else listOf(DeviceRowAction.RENAME, DeviceRowAction.REMOVE)

    /** The name to send, or null when there is nothing to send (blank). */
    fun cleanedName(typed: String): String? = typed.trim().ifEmpty { null }
}
