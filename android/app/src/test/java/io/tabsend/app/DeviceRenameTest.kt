package io.tabsend.app

import io.tabsend.app.logic.DeviceRowAction
import io.tabsend.app.logic.DeviceRowActions
import io.tabsend.app.net.Registrar
import io.tabsend.app.store.Registration
import io.tabsend.app.store.Store
import io.tabsend.app.wire.Endpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Renaming any device from the phone's device list. The rule for the row's More menu
 * mirrors the browsers' `rowActions` and the iPhone's `DeviceRowActions`; the label the
 * relay stored (not the one typed) is what the phone keeps, in the right place.
 */
class DeviceRenameTest {

    private fun ep(id: String, label: String) = Endpoint(
        id = id,
        groupId = "g",
        kind = "browser",
        platform = "macos",
        label = label,
        e2ePubkey = "pk-$id",
        presence = "online",
        lastSeenAt = "2026-11-07T10:00:00.000Z",
        createdAt = "2026-10-01T10:00:00.000Z",
    )

    private fun pairedStore(): Store = Store.over(MemoryPrefs()).apply {
        registration = Registration(
            endpointId = "me",
            groupId = "g",
            deviceToken = "t",
            relayUrl = "https://relay.example",
            label = "Pixel 8",
        )
    }

    @Test
    fun `another device can be renamed and removed`() {
        assertEquals(listOf(DeviceRowAction.RENAME, DeviceRowAction.REMOVE), DeviceRowActions.actions(isThisPhone = false))
    }

    @Test
    fun `this phone can only be renamed, it leaves with Unpair`() {
        assertEquals(listOf(DeviceRowAction.RENAME), DeviceRowActions.actions(isThisPhone = true))
    }

    @Test
    fun `a blank name is not sent, and a typed one is trimmed`() {
        assertNull(DeviceRowActions.cleanedName(""))
        assertNull(DeviceRowActions.cleanedName("  \n "))
        assertEquals("Work laptop", DeviceRowActions.cleanedName("  Work laptop "))
    }

    @Test
    fun `another device's new name is kept in the cached list, the rest untouched`() {
        val store = pairedStore()
        store.cachedEndpoints = listOf(ep("me", "Pixel 8"), ep("a", "Chrome · Mac"), ep("b", "Firefox"))
        val stampedAt = store.cachedEndpointsAt

        Registrar.mirrorRename(store, selfId = "me", endpointId = "a", storedLabel = "Work laptop")

        assertEquals(listOf("Pixel 8", "Work laptop", "Firefox"), store.cachedEndpoints.map { it.label })
        assertEquals("this phone's own name is unchanged", "Pixel 8", store.registration!!.label)
        assertEquals("the list is no fresher than it was", stampedAt, store.cachedEndpointsAt)
    }

    @Test
    fun `this phone's new name is kept in its registration`() {
        val store = pairedStore()
        store.cachedEndpoints = listOf(ep("me", "Pixel 8"), ep("a", "Chrome · Mac"))

        Registrar.mirrorRename(store, selfId = "me", endpointId = "me", storedLabel = "Ben's phone")

        assertEquals("Ben's phone", store.registration!!.label)
        assertEquals(listOf("Pixel 8", "Chrome · Mac"), store.cachedEndpoints.map { it.label })
    }

    @Test
    fun `renaming a device that is not in the list changes nothing`() {
        val store = pairedStore()
        store.cachedEndpoints = listOf(ep("me", "Pixel 8"))

        Registrar.mirrorRename(store, selfId = "me", endpointId = "gone", storedLabel = "Ghost")

        assertEquals(listOf("Pixel 8"), store.cachedEndpoints.map { it.label })
    }
}
