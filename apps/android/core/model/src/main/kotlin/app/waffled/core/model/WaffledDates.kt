package app.waffled.core.model

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Shared date handling — parse, bucket, format.
 *
 * Twin of `Sync/DateFmt.swift` + the `EventTime` parsing in `Sync/Events.swift`.
 * `java.time` is available because `minSdk` is 26, so no desugaring is needed.
 *
 * ⚠️ **Keep date math out of the render/sort/filter hot path.** Building a formatter per
 * row, or calling `startOfDay` inside a comparator, janks hard — it is one of the two
 * documented performance traps carried over from iOS. Precompute per-row values in the
 * model once per data load, then look them up. [formatter] is cached for the cases where
 * formatting at render time is unavoidable.
 */
object WaffledDates {

    private val formatters = ConcurrentHashMap<String, DateTimeFormatter>()

    /**
     * Parse a server timestamp.
     *
     * Accepts a full ISO-8601 instant (with `Z` or a numeric offset, with or without
     * fractional seconds) **and** a bare `yyyy-MM-dd`, which is resolved to midnight in
     * [zone]. Returns null rather than throwing — these values come over the wire.
     */
    fun parseInstant(value: String?, zone: ZoneId = ZoneId.systemDefault()): Instant? {
        val raw = value?.trim().orEmpty()
        if (raw.isEmpty()) return null

        // Full instant with an offset.
        runCatching { return Instant.parse(raw) }

        // Offset forms Instant.parse rejects (e.g. "+01:00" without seconds).
        runCatching {
            return java.time.OffsetDateTime.parse(raw).toInstant()
        }

        // Local date-time with no offset — interpret in the given zone.
        runCatching {
            return java.time.LocalDateTime.parse(raw).atZone(zone).toInstant()
        }

        // Date only.
        runCatching {
            return LocalDate.parse(raw).atStartOfDay(zone).toInstant()
        }

        return null
    }

    /**
     * The local calendar day an instant falls on.
     *
     * Must use the household's timezone, not UTC: 01:30Z is still the previous day in
     * New York, and bucketing in UTC puts events on the wrong day.
     */
    fun localDay(instant: Instant, zone: ZoneId): LocalDate =
        instant.atZone(zone).toLocalDate()

    /**
     * A cached formatter for [pattern] in [zone] and [locale]. Never build these per row.
     *
     * ⚠️ [locale] is part of the cache key deliberately. Caching on pattern+zone alone
     * means whichever caller formats FIRST pins the language for the whole process — so a
     * French device could get English month names purely because of call order.
     */
    fun formatter(
        pattern: String,
        zone: ZoneId,
        locale: Locale = Locale.getDefault(),
    ): DateTimeFormatter =
        formatters.getOrPut("$pattern|${zone.id}|${locale.toLanguageTag()}") {
            DateTimeFormatter.ofPattern(pattern, locale).withZone(zone)
        }

    fun format(
        instant: Instant,
        pattern: String,
        zone: ZoneId,
        locale: Locale = Locale.getDefault(),
    ): String = formatter(pattern, zone, locale).format(instant)

    /**
     * ISO instant for "this date, no particular time".
     *
     * Pinned to **noon** local, not midnight: midnight is one timezone shift away from
     * sliding onto the adjacent day, which is how date-only values drift.
     */
    fun noonIso(date: String, zone: ZoneId): String? {
        val day = runCatching { LocalDate.parse(date.trim()) }.getOrNull() ?: return null
        return day.atTime(LocalTime.NOON).atZone(zone).toInstant().toString()
    }
}
