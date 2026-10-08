package app.waffled.feature.kiosk

import kotlin.test.Test
import kotlin.test.assertEquals

/** The per-device rail pins persist, and every reader sees a write at once. */
class KioskRailStoreTest {

    @Test fun aFreshDeviceGetsTheDefaultRail() {
        assertEquals(KioskRail.defaultRaw, KioskRailStore(MapKeyValueStore()).raw.value)
    }

    @Test fun writesPersistAndPublish() {
        val prefs = MapKeyValueStore()
        val store = KioskRailStore(prefs)
        store.set("goals,lists")
        assertEquals("goals,lists", store.raw.value)
        assertEquals("goals,lists", prefs.values[KioskRail.STORAGE_KEY])
        assertEquals("goals,lists", KioskRailStore(prefs).raw.value)
    }

    @Test fun anEmptyRailIsAChoiceNotTheDefault() {
        val prefs = MapKeyValueStore()
        KioskRailStore(prefs).set("")
        assertEquals("", KioskRailStore(prefs).raw.value)
    }
}
