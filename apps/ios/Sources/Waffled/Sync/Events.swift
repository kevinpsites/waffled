import Foundation

/// An event as read from the local SQLite mirror, with its owner's color/emoji.
struct SyncedEvent: Identifiable, Sendable, Equatable {
    let id: String
    let title: String
    let startsAtRaw: String?   // the stored timestamp text (mixed formats — see EventTime)
    let startsAt: Date?        // parsed absolute instant (nil for date-only / unparseable)
    let allDay: Bool
    let personId: String?
    let colorHex: String?
    let emoji: String?
    var endsAt: Date? = nil
    /// Waffled-owned "show a countdown" flag; surfaces in `GET /api/countdowns`.
    var isCountdown: Bool = false
    var location: String? = nil
    var participantIds: [String] = []
    /// The master/series row this belongs to. For a single (non-recurring) event
    /// this equals `id`; for a materialized occurrence it's the recurring master's id.
    var seriesId: String? = nil
    /// The occurrence's original start (for a recurring instance); nil for a single
    /// event. Mirrors the web's `occurrenceStart` — used to key per-occurrence state.
    var occurrenceStart: String? = nil
    /// Personal-calendar visibility: 'family' (shared kiosk) or 'personal' (only the
    /// owner sees it). Denormalized from the event's calendar; filtered per-viewer.
    var visibility: String = "family"
    var ownerPersonId: String? = nil
}

/// Timestamp handling that mirrors the web client (`events-local.ts`): server-
/// replicated rows are Postgres text ("YYYY-MM-DD HH:MM:SS+00"); locally-written
/// rows are ISO ("…T…Z"). Bucketing is by the household timezone.
enum EventTime {
    /// Parse an absolute instant from either source format. Returns nil for a
    /// date-only string (all-day) — callers bucket those by the literal date.
    static func parse(_ s: String?) -> Date? {
        guard let raw = s?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        for f in formatters {
            if let d = f.date(from: raw) { return d }
        }
        return nil
    }

    /// The local calendar date (YYYY-MM-DD) an instant falls on, in `tz`.
    static func dayKey(_ date: Date, _ tz: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// A short clock label ("8:30 AM") for a timed event, in `tz`. Routes through
    /// `DateFmt` so it reuses the cached formatter (POSIX renders "h:mm a" identically).
    static func timeLabel(_ date: Date, _ tz: TimeZone) -> String {
        DateFmt.string(date, "h:mm a", tz)
    }

    // Ordered most-specific-first; each carries its own offset so the parsed Date
    // is absolute. POSIX locale so patterns are stable regardless of device locale.
    private static let formatters: [DateFormatter] = {
        let patterns = [
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX",  // 2026-06-16T17:49:00.000Z / +00:00
            "yyyy-MM-dd'T'HH:mm:ssXXXXX",      // 2026-06-16T17:49:00Z / +00:00
            "yyyy-MM-dd HH:mm:ss.SSSSSSX",     // postgres micros: 2026-06-16 17:49:00.123456+00
            "yyyy-MM-dd HH:mm:ss.SSSX",        // 2026-06-16 17:49:00.123+00
            "yyyy-MM-dd HH:mm:ssX",            // 2026-06-16 17:49:00+00
            "yyyy-MM-dd'T'HH:mm:ss",           // naive (assume UTC)
        ]
        return patterns.map { p in
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = p
            return f
        }
    }()
}

/// Pure agenda shaping — filtering, bucketing and ordering. Unit-tested.
enum Agenda {
    /// The household-local day an event belongs to (timed → tz bucket; all-day /
    /// date-only → the literal date prefix).
    static func dayKey(_ e: SyncedEvent, _ tz: TimeZone) -> String {
        if let d = e.startsAt { return EventTime.dayKey(d, tz) }
        if let raw = e.startsAtRaw, raw.count >= 10 { return String(raw.prefix(10)) }
        return ""
    }

    /// Today's key in `tz`.
    static func todayKey(_ tz: TimeZone, now: Date = Date()) -> String {
        EventTime.dayKey(now, tz)
    }

    /// Ordering: timed before all-day, then by start instant (matches the server).
    static func before(_ a: SyncedEvent, _ b: SyncedEvent) -> Bool {
        if a.allDay != b.allDay { return !a.allDay }
        return (a.startsAt ?? .distantFuture) < (b.startsAt ?? .distantFuture)
    }

    /// Events on a single day (YYYY-MM-DD), ordered.
    static func forDay(_ events: [SyncedEvent], day: String, tz: TimeZone) -> [SyncedEvent] {
        events.filter { dayKey($0, tz) == day }.sorted(by: before)
    }

    /// Upcoming events (dayKey ≥ `from`) grouped by day, days ascending and items
    /// ordered within each day.
    static func upcoming(_ events: [SyncedEvent], from: String, tz: TimeZone) -> [(day: String, items: [SyncedEvent])] {
        let future = events
            .map { (key: dayKey($0, tz), event: $0) }
            .filter { !$0.key.isEmpty && $0.key >= from }
        var order: [String] = []
        var byDay: [String: [SyncedEvent]] = [:]
        for item in future {
            if byDay[item.key] == nil { order.append(item.key) }
            byDay[item.key, default: []].append(item.event)
        }
        return order.sorted().map { ($0, (byDay[$0] ?? []).sorted(by: before)) }
    }
}
