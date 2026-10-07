package app.waffled.feature.rhythms

import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

internal val UTC: ZoneId = ZoneOffset.UTC

/** "2026-08-18T12:00:00" read as UTC — the Swift suite's `at(_:)`. */
internal fun at(text: String): Instant = LocalDateTime.parse(text).toInstant(ZoneOffset.UTC)

internal fun day(text: String): LocalDate = LocalDate.parse(text)

internal fun rhythm(
    id: String = "r1",
    title: String = "Air filter",
    emoji: String? = null,
    notes: String? = null,
    personId: String? = null,
    satisfiedBy: RhythmShape = RhythmShape.Completion,
    every: String = "3 mons",
    startsOn: String? = null,
    autoSchedule: Boolean = false,
    rrule: String? = null,
    leadTime: String = "14 days",
    lastCompletedAt: String? = null,
    nextDueAt: String? = null,
    isActive: Boolean = true,
    bookWithin: String? = null,
    currentPeriodStart: String? = null,
    currentPeriodEnd: String? = null,
    currentWindowEnd: String? = null,
    satisfied: Boolean? = null,
    hasSeries: Boolean? = null,
    bookedAt: String? = null,
    bookedAllDay: Boolean? = null,
) = RhythmsApi.Rhythm(
    id = id, title = title, emoji = emoji, notes = notes, personId = personId,
    satisfiedBy = satisfiedBy.wire, every = every, startsOn = startsOn,
    autoSchedule = autoSchedule, rrule = rrule, bookWithin = bookWithin, leadTime = leadTime,
    lastCompletedAt = lastCompletedAt, nextDueAt = nextDueAt, isActive = isActive,
    currentPeriodStart = currentPeriodStart, currentPeriodEnd = currentPeriodEnd,
    // Without a window the server sends these as the same date.
    currentWindowEnd = currentWindowEnd ?: currentPeriodEnd,
    satisfied = satisfied, hasSeries = hasSeries, bookedAt = bookedAt, bookedAllDay = bookedAllDay,
)

internal fun due(r: RhythmsApi.Rhythm, at: String, overdue: Boolean) = RhythmsApi.AttentionItem(
    rawKind = "due", rhythm = r, dueAt = at, overdue = overdue,
)

internal fun unscheduled(
    r: RhythmsApi.Rhythm,
    start: String,
    end: String,
    windowEnd: String? = null,
    hasSeries: Boolean? = null,
) = RhythmsApi.AttentionItem(
    rawKind = "unscheduled", rhythm = r, periodStart = start, periodEnd = end,
    windowEnd = windowEnd ?: end, hasSeries = hasSeries,
)
