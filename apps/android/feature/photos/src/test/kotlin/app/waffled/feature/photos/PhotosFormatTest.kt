package app.waffled.feature.photos

import org.junit.After
import org.junit.Before
import org.junit.Test
import java.time.ZoneId
import java.util.Locale
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The pure copy/format helpers the screens read at render time. */
class PhotosFormatTest {

    // `WaffledDates.formatter` builds its pattern against the DEFAULT locale, so the
    // day/month names below depend on it. Pin it, or this suite fails on a French CI box.
    private val original = Locale.getDefault()

    @Before
    fun pinLocale() = Locale.setDefault(Locale.US)

    @After
    fun restoreLocale() = Locale.setDefault(original)

    @Test
    fun `the selection count label pluralises`() {
        assertEquals("0 photos", PhotosFormat.photoCount(0))
        assertEquals("1 photo", PhotosFormat.photoCount(1))
        assertEquals("2 photos", PhotosFormat.photoCount(2))
    }

    @Test
    fun `the album line names the album and its count`() {
        assertEquals("3 photos in “Beach”", PhotosFormat.albumLine("Beach", 3))
    }

    @Test
    fun `the date label formats a taken-at instant in the device zone`() {
        val label = PhotosFormat.dateLabel(
            takenAt = "2026-07-04T12:00:00Z",
            createdAt = "2026-08-01T00:00:00Z",
            zone = ZoneId.of("UTC"),
        )
        assertEquals("Sat, Jul 4, 2026", label)
    }

    @Test
    fun `the date label falls back to created-at when taken-at is missing`() {
        val label = PhotosFormat.dateLabel(
            takenAt = null,
            createdAt = "2026-08-01T12:00:00Z",
            zone = ZoneId.of("UTC"),
        )
        assertEquals("Sat, Aug 1, 2026", label)
    }

    @Test
    fun `an unparseable pair of timestamps has no label`() {
        assertNull(PhotosFormat.dateLabel(takenAt = null, createdAt = "not a date", zone = ZoneId.of("UTC")))
    }

    @Test
    fun `the edit date seeds from taken-at as a local calendar day`() {
        assertEquals(
            "2026-07-04",
            PhotosFormat.editableDay(
                takenAt = "2026-07-04T12:00:00Z",
                createdAt = "2026-08-01T00:00:00Z",
                zone = ZoneId.of("UTC"),
            ),
        )
    }
}
