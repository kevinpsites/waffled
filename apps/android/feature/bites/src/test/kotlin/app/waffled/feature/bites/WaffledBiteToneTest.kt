package app.waffled.feature.bites

import app.waffled.core.network.WaffledJson
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * Port of `WaffledBiteToneTests.swift`. `settings.alarm.tone` holds a stable KEY, not the
 * picker's English label; the firmware's `wb_tone_parse` matches these exact spellings.
 */
class WaffledBiteToneTest {

    @Test
    fun `the picker offers stable keys, not display strings`() {
        val keys = WaffledBiteOptions.alarmTones.map { it.key }
        assertEquals(
            listOf("sunriseChime", "birdsong", "softHarp", "gentleBells", "oceanTide", "twinkleStars"),
            keys,
        )
        assertFalse(keys.any { it.contains(" ") })
    }

    @Test
    fun `each key renders as its human label`() {
        assertEquals("Sunrise chime", WaffledBiteOptions.toneLabel("sunriseChime"))
        assertEquals("Soft harp", WaffledBiteOptions.toneLabel("softHarp"))
        assertEquals("Gentle bells", WaffledBiteOptions.toneLabel("gentleBells"))
        assertEquals("Ocean tide", WaffledBiteOptions.toneLabel("oceanTide"))
        assertEquals("Twinkle stars", WaffledBiteOptions.toneLabel("twinkleStars"))
        assertEquals("Birdsong", WaffledBiteOptions.toneLabel("birdsong"))
        for (tone in WaffledBiteOptions.alarmTones) {
            assertEquals(tone.label, WaffledBiteOptions.toneLabel(tone.key))
        }
    }

    @Test
    fun `an unrecognised stored value still renders as something`() {
        assertEquals("Kazoo fanfare", WaffledBiteOptions.toneLabel("Kazoo fanfare"))
    }

    @Test
    fun `birdsong is the one tone still awaiting a recording`() {
        assertEquals(setOf("birdsong"), WaffledBiteOptions.alarmTonesComingSoon)
    }

    @Test
    fun `a device with no alarm block defaults to a key, not a label`() {
        val empty = WaffledJson.decodeFromString(WaffledBitesApi.Settings.serializer(), "{}")
        assertEquals("sunriseChime", empty.withDefaults().alarm.tone)
    }

    // ---- the rest of the option tables, mirrored from the web panel ----

    @Test
    fun `sounds fall back to a capitalised key and two are coming soon`() {
        assertEquals("Ocean waves", WaffledBiteOptions.soundLabel("ocean"))
        assertEquals("Brown Noise", WaffledBiteOptions.soundLabel("brown noise"))
        assertEquals(setOf("lullaby", "forest"), WaffledBiteOptions.soundsComingSoon)
    }

    @Test
    fun `an unknown nightlight colour falls back to amber`() {
        assertEquals(0xF0A94B, WaffledBiteOptions.nightHex("nope"))
        assertEquals(0x5BC98B, WaffledBiteOptions.nightHex("mint"))
    }

    @Test
    fun `preset labels switch to hours at sixty minutes`() {
        assertEquals("5m", WaffledBiteOptions.presetLabel(5))
        assertEquals("1h", WaffledBiteOptions.presetLabel(60))
        assertEquals("2h", WaffledBiteOptions.presetLabel(120))
    }

    @Test
    fun `custom minutes clamp to one through one hundred eighty`() {
        assertEquals(1, WaffledBiteOptions.clampCustomMinutes(0))
        assertEquals(180, WaffledBiteOptions.clampCustomMinutes(500))
        assertEquals(42, WaffledBiteOptions.clampCustomMinutes(42))
    }

    @Test
    fun `an alarm with no volume reports the default`() {
        val s = WaffledJson.decodeFromString(
            WaffledBitesApi.Settings.serializer(),
            """{"alarm":{"on":true,"hour":7,"min":5,"tone":"softHarp"}}""",
        )
        assertEquals(80, s.withDefaults().alarm.volumeOrDefault)
    }
}
