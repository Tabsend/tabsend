package io.tabsend.app.logic

/**
 * Default endpoint label for the phone. Prefer the consumer-facing device name
 * the OS already knows (Settings.Global.DEVICE_NAME — "Galaxy S24" on Samsung,
 * or whatever the user renamed their phone to in Settings). Fall back to
 * "Manufacturer Model" ("Google Pixel 8") — never the OS name; the group list
 * already implies these are devices. The user can still rename it
 * (PATCH /v1/endpoints).
 */
object Labels {
    fun defaultDeviceLabel(settingsDeviceName: String?, manufacturer: String?, model: String?): String {
        val named = settingsDeviceName?.trim().orEmpty()
        if (named.isNotEmpty()) return named

        val make = manufacturer?.trim().orEmpty().replaceFirstChar { it.uppercase() }
        val cleanModel = model?.trim().orEmpty()
        return when {
            cleanModel.isEmpty() && make.isEmpty() -> "Phone"
            cleanModel.isEmpty() -> make
            make.isEmpty() -> cleanModel
            // Avoid "OnePlus OnePlus 9": if the model already names the maker, keep the model.
            cleanModel.lowercase().startsWith(make.lowercase()) -> cleanModel
            else -> "$make $cleanModel"
        }
    }
}
