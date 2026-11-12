package io.tabsend.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The home screen's Remove menu items, as far as `MainActivity` takes them
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

    @Test
    fun `every Remove on the home screen asks first`() {
        // Since P-23 the device row's Remove is the only one: the first-look card and
        // the new-device banner, which had their own, are gone. It sits in the row's More
        // menu, next to Rename, and never removes without the question.
        val menu = body(activity, "private fun showRowMenu(")
        val removes = Regex("""DeviceRowAction\.REMOVE ->([^\n]*)""").findAll(menu).map { it.groupValues[1].trim() }.toList()
        assertEquals("the device row's menu", 1, removes.size)
        assertEquals("confirmRemove(ep.id, ep.label)", removes.single())
        assertFalse("no Remove button of its own", activity.contains("R.string.review_remove"))
        assertTrue(Regex("""cardButton\(getString\(R\.string\.new_device_remove\)""").findAll(activity).none())
        // The menu is built for each row from the shared rule, so this phone gets no Remove.
        val rows = body(activity, "private fun renderDevices(")
        assertTrue(rows.contains("moreButton(ep, selfId)"))
        assertTrue(menu.contains("DeviceRowActions.actions(isThisPhone = ep.id == selfId)"))
    }

    @Test
    fun `a device row asks nothing about a new device`() {
        // P-23 (owner, 2026-10-30): a joined device is told once, by the system
        // notification, as information. No "New" tag, no "It's mine", no first-look card.
        val rows = body(activity, "private fun renderDevices(")
        assertFalse(rows.contains("tagged("))
        assertFalse(rows.contains("unanswered"))
        assertFalse(activity.contains("device_its_mine"))
        assertFalse(activity.contains("device_new_tag"))
        assertFalse(activity.contains("confirmMine"))
        assertFalse(activity.contains("NewDeviceWatcher.confirm("))
        assertFalse("confirmReview answers every device at once", activity.contains("confirmReview"))
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
        // The row's Remove and "Replace" (P-31) share one helper; the rule is checked there.
        assertTrue(body(activity, "private fun removeDevice(").contains("removeFromGroup(reg, endpointId)"))
        val remove = body(activity, "private suspend fun removeFromGroup(")
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
            .sorted()
        assertEquals(listOf("MainActivity.kt", "Registrar.kt"), callers)
        assertFalse(
            "a second removal path would skip the watch",
            Regex("""\.deleteEndpoint\(""").findAll(activity).count() > 1,
        )
        // The other caller is this phone leaving, and can name no other device. The watch
        // has nothing to record there: the wipe takes it too.
        val registrar = File(sourceRoot(), "java/io/tabsend/app/net/Registrar.kt").readText()
        assertEquals(1, Regex("""\.deleteEndpoint\(""").findAll(registrar).count())
        assertTrue(registrar.contains(".deleteEndpoint(reg.deviceToken, reg.endpointId)"))
    }
}
