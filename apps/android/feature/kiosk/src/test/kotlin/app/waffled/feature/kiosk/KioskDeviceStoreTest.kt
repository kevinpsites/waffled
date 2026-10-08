package app.waffled.feature.kiosk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The device identity — separate from, and outliving, any person's session. */
class KioskDeviceStoreTest {

    private val prefs = MapKeyValueStore()
    private val crypto = XorCrypto()
    private val store = KioskDeviceStore(prefs, crypto)

    @Test fun unpairedByDefault() {
        assertFalse(store.isPaired)
        assertNull(store.secret)
        assertNull(store.label)
    }

    @Test fun savingPairsTheDeviceWithTheSecretSealed() {
        store.savePaired(secret = "dev-secret-123", label = "Kitchen")
        assertTrue(store.isPaired)
        assertEquals("dev-secret-123", store.secret)
        assertEquals("Kitchen", store.label)
        assertTrue(prefs.values.values.none { it.contains("dev-secret-123") }, "secret stored in plain text")
    }

    @Test fun blankLabelIsForgotten() {
        store.savePaired(secret = "s", label = "Kitchen")
        store.label = "  "
        assertNull(store.label)
        store.savePaired(secret = "s", label = null)
        assertNull(store.label)
    }

    @Test fun clearForgetsTheIdentity() {
        store.savePaired(secret = "s", label = "Hall")
        store.clear()
        assertFalse(store.isPaired)
        assertNull(store.label)
        assertTrue(prefs.values.isEmpty())
    }

    @Test fun anUnreadableSecretIsTreatedAsUnpairedAndCleared() {
        store.savePaired(secret = "s", label = "Hall")
        crypto.failDecrypt = true
        assertNull(store.secret)
        assertFalse(store.isPaired)
        assertNotEquals(true, prefs.values.containsKey(KioskDeviceStore.SECRET_KEY))
    }
}
