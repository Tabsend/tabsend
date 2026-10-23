package io.tabsend.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The home screen's Remove buttons, as far as `MainActivity` takes them
 * (SECURITY_REVIEW L7, X13). The rule itself, the relay's DELETE and then the
 * removal written into the new-device watch, lives in
 * `NewDeviceWatcher.removeFromGroup` and is tested in [NewDevicesTest]. What is
 * left in the activity is the wiring to it, which no JVM test can run, so it is
 * read as written, like [PushWiringTest]: a button that calls the relay itself,
 * or a dialog whose Remove does nothing, fails here.
 */
class RemoveWiringTest {

    /** Gradle runs unit tests from the module directory; an IDE may run them from the root. */
    private fun sourceRoot(): File =
        listOf(File("src/main"), File("app/src/main"), File("android/app/src/main"))
            .first { it.isDirectory }

    private val activity: String =
        File(sourceRoot(), "java/io/tabsend/app/ui/MainActivity.kt").readText()

    /** The body of one Kotlin function, from its signature to the next member. */
    private fun body(file: String, signature: String): String {
        val start = file.indexOf(signature)
        assertTrue("$signature not found", start >= 0)
        val next = Regex("""\n    (private |override |internal )?fun """).find(file, start + signature.length)
        return file.substring(start, next?.range?.first ?: file.length)
    }

    /** The code of the click handler of every button labelled [label]. */
    private fun handlers(file: String, label: String): List<String> =
        Regex("""cardButton\(getString\(R\.string\.$label\)[^{]*\{([^}]*)\}""")
            .findAll(file)
            .map { it.groupValues[1].trim() }
            .toList()

    @Test
    fun `every Remove on the home screen asks first`() {
        // The device row and the first-look card share one label; the new-device
        // banner has its own.
        val rowAndReview = handlers(activity, "review_remove")
        assertEquals("the device row and the first-look card", 2, rowAndReview.size)
        val banner = handlers(activity, "new_device_remove")
        assertEquals("the new-device banner", 1, banner.size)
        for (handler in rowAndReview + banner) {
            assertTrue("a Remove must open the question: $handler", handler.startsWith("confirmRemove("))
        }
        // The device row in particular.
        val rows = body(activity, "private fun renderDevices(")
        assertTrue(handlers(rows, "review_remove").single().startsWith("confirmRemove(ep.id"))
    }

    @Test
    fun `the question's Remove removes that device`() {
        val confirm = body(activity, "private fun confirmRemove(")
        assertTrue(
            confirm.contains(
                ".setPositiveButton(R.string.remove_device_action) { _, _ -> removeDevice(endpointId, label) }",
            ),
        )
    }

    @Test
    fun `removing goes through removeFromGroup, which records it in the watch`() {
        val remove = body(activity, "private fun removeDevice(")
        assertTrue(
            "removeDevice must remove through NewDeviceWatcher.removeFromGroup",
            remove.contains("NewDeviceWatcher.removeFromGroup(store, endpointId) {"),
        )
        // The DELETE is made only as removeFromGroup's own step, never beside it,
        // where a removal would reach the relay and never the watch.
        val calls = Regex("""\.deleteEndpoint\(""").findAll(remove).count()
        assertEquals(1, calls)
        assertTrue(remove.contains("removeFromGroup(store, endpointId) { api.deleteEndpoint(reg.deviceToken, it) }"))
    }

    @Test
    fun `nothing else in the app calls the relay's DELETE for a device`() {
        val callers = sourceRoot().walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { Regex("""\.deleteEndpoint\(""").containsMatchIn(it.readText()) }
            .map { it.name }
            .toList()
        assertEquals(listOf("MainActivity.kt"), callers)
        assertFalse(
            "a second removal path would skip the watch",
            Regex("""\.deleteEndpoint\(""").findAll(activity).count() > 1,
        )
    }
}
