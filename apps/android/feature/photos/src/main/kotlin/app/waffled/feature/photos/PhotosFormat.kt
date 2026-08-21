package app.waffled.feature.photos

import app.waffled.core.model.WaffledDates
import java.time.ZoneId

/**
 * The pure copy / formatting helpers for the Photos screens.
 *
 * They live outside the composables so they are testable on the JVM, and so the
 * **date math stays out of the render hot path** — the model calls these once per load
 * and the grid does an O(1) lookup. That is one of the two performance traps carried
 * over from iOS (see `apps/android/CLAUDE.md`).
 */
object PhotosFormat {

    /** iOS `moveCountLabel` — "1 photo" / "3 photos". */
    fun photoCount(n: Int): String = "$n photo${if (n == 1) "" else "s"}"

    /** The detail sheet's "N photos in “Album”" line. */
    fun albumLine(album: String, count: Int): String = "${photoCount(count)} in “$album”"

    /**
     * The read-mode "Date" row: the photo's `takenAt`, falling back to its upload date.
     * Null when neither parses — the row shows an em dash rather than a wrong day.
     */
    fun dateLabel(takenAt: String?, createdAt: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val instant = WaffledDates.parseInstant(takenAt, zone)
            ?: WaffledDates.parseInstant(createdAt, zone)
            ?: return null
        // iOS: "EEE, MMM d, yyyy".
        return WaffledDates.format(instant, "EEE, MMM d, yyyy", zone)
    }

    /**
     * The `yyyy-MM-dd` the edit-mode date picker starts on, in the device's zone.
     *
     * Bucketing in UTC would put a late-evening photo on the following day, so the local
     * calendar day is the only correct answer here.
     */
    fun editableDay(takenAt: String?, createdAt: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val instant = WaffledDates.parseInstant(takenAt, zone)
            ?: WaffledDates.parseInstant(createdAt, zone)
            ?: return null
        return WaffledDates.localDay(instant, zone).toString()
    }
}
