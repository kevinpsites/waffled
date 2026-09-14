import Foundation
import CoreGraphics

/// The iPhone calendar's layout rules — Month → Week → Day — kept out of the view so they
/// can be tested. Rationale for the numbers lives in `docs/product/ios-calendar-redesign.md`.
enum PhoneCalendar {

    /// `agenda` is not on the cycle: it's reached from the header menu, because it is the
    /// only view that carries the AI capture bar.
    enum Mode: String, CaseIterable {
        case month, week, day, agenda

        var cycled: Mode {
            switch self {
            case .month: return .week
            case .week: return .day
            case .day, .agenda: return .month
            }
        }

        /// Spread (`in`) moves Month → Week → Day; pinch moves back out. Stops at the ends.
        func zoomed(in zoomIn: Bool) -> Mode {
            switch (self, zoomIn) {
            case (.month, true), (.agenda, true): return .week
            case (.week, true), (.day, true): return .day
            case (.day, false): return .week
            case (.week, false): return .month
            case (.month, false), (.agenda, false): return self
            }
        }

        var label: String { rawValue.capitalized }
        var letter: String { String(label.prefix(1)) }
        var icon: String {
            switch self {
            case .agenda: return "list.bullet"
            case .month: return "calendar"
            case .week: return "rectangle.split.3x1"
            case .day: return "calendar.day.timeline.left"
            }
        }
    }

    // MARK: Month

    struct MonthDay: Equatable { let key: String; let day: Int; let inMonth: Bool }
    struct MonthRow: Equatable { let weekNumber: Int; let days: [MonthDay] }

    /// Only the rows the month needs (5 or 6), cut on the household's first day. The gutter
    /// number is the ISO week of the row's Monday, so a Sunday-first row still reads as the
    /// work week everyone calls "week 38".
    static func monthRows(_ anchor: Date, tz: TimeZone, firstDay: HouseholdWeekStart) -> [MonthRow] {
        let cal = Cal.gregorian(tz)
        guard let first = cal.date(from: cal.dateComponents([.year, .month], from: anchor)),
              let length = cal.range(of: .day, in: .month, for: first)?.count else { return [] }
        let month = cal.component(.month, from: first)
        let start = Cal.weekStart(first, tz, firstDay)
        let rowCount = (Cal.monthLeadCells(first, tz, firstDay) + length + 6) / 7
        var iso = Calendar(identifier: .iso8601)
        iso.timeZone = tz
        let mondayOffset = firstDay == .monday ? 0 : 1

        return (0..<rowCount).map { row in
            let days = (0..<7).compactMap { i -> MonthDay? in
                guard let d = cal.date(byAdding: .day, value: row * 7 + i, to: start) else { return nil }
                return MonthDay(key: EventTime.dayKey(d, tz), day: cal.component(.day, from: d),
                                inMonth: cal.component(.month, from: d) == month)
            }
            let monday = cal.date(byAdding: .day, value: row * 7 + mondayOffset, to: start) ?? start
            return MonthRow(weekNumber: iso.component(.weekOfYear, from: monday), days: days)
        }
    }

    static let chipHeight: CGFloat = 16
    static let chipGap: CGFloat = 2
    static let dayNumberHeight: CGFloat = 18
    static let moreLineHeight: CGFloat = 12
    static let cellTopPadding: CGFloat = 3
    static let maxCellSlots = 4

    struct CellChips: Equatable {
        let shown: Int
        let more: Int
        let showsCountdown: Bool
    }

    /// Titles per day cell: as many chips as the row height holds, never more than four, with
    /// a countdown pill taking one of those slots. Room for the "+N more" line is always kept.
    static func cellChips(eventCount: Int, hasCountdown: Bool, rowHeight: CGFloat) -> CellChips {
        let room = rowHeight - cellTopPadding - dayNumberHeight - moreLineHeight - chipGap
        let slots = min(maxCellSlots, max(0, Int((room / (chipHeight + chipGap)).rounded(.down))))
        let showsCountdown = hasCountdown && slots > 0
        let shown = min(eventCount, slots - (showsCountdown ? 1 : 0))
        return CellChips(shown: shown, more: eventCount - shown, showsCountdown: showsCountdown)
    }

    // MARK: Week

    static func weekDays(containing key: String, tz: TimeZone, firstDay: HouseholdWeekStart) -> [String] {
        guard let date = DateFmt.date(key, "yyyy-MM-dd", tz) else { return [] }
        let cal = Cal.gregorian(tz)
        let start = Cal.weekStart(date, tz, firstDay)
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: start) }
            .map { EventTime.dayKey($0, tz) }
    }

    /// "Sep 14 – 20", or "Sep 28 – Oct 4" when the week crosses a month.
    static func weekTitle(_ days: [String], tz: TimeZone) -> String {
        guard let first = days.first.flatMap({ DateFmt.date($0, "yyyy-MM-dd", tz) }),
              let last = days.last.flatMap({ DateFmt.date($0, "yyyy-MM-dd", tz) }) else { return "" }
        let sameMonth = DateFmt.string(first, "yyyyMM", tz) == DateFmt.string(last, "yyyyMM", tz)
        return "\(DateFmt.string(first, "MMM d", tz)) – \(DateFmt.string(last, sameMonth ? "d" : "MMM d", tz))"
    }

    /// "9:30a" / "12p" — the week card's narrow time column.
    static func shortTime(_ date: Date, tz: TimeZone) -> String {
        let c = Cal.gregorian(tz).dateComponents([.hour, .minute], from: date)
        let hour = c.hour ?? 0, minute = c.minute ?? 0
        let h12 = hour % 12 == 0 ? 12 : hour % 12
        return "\(h12)\(minute == 0 ? "" : String(format: ":%02d", minute))\(hour < 12 ? "a" : "p")"
    }

    /// All-day first (birthdays, trips), then timed by start — the order a day cell and a
    /// week card read in. `Agenda.before` is the opposite, for lists that lead with the clock.
    static func displayOrder(_ events: [SyncedEvent]) -> [SyncedEvent] {
        events.filter(\.allDay)
            + events.filter { !$0.allDay }.sorted { ($0.startsAt ?? .distantFuture) < ($1.startsAt ?? .distantFuture) }
    }

    static func shift(_ key: String, byDays n: Int, tz: TimeZone) -> String {
        guard let date = DateFmt.date(key, "yyyy-MM-dd", tz),
              let moved = Cal.gregorian(tz).date(byAdding: .day, value: n, to: date) else { return key }
        return EventTime.dayKey(moved, tz)
    }

    // MARK: Day

    static let defaultDayHours = 7...20

    /// 7 AM–8 PM, widened to take in any timed event outside it — the handoff left
    /// "fixed or auto-fit" open, and a fixed range would hide a 6 AM flight.
    static func dayHours(_ events: [SyncedEvent], tz: TimeZone) -> ClosedRange<Int> {
        let cal = Cal.gregorian(tz)
        var lo = defaultDayHours.lowerBound, hi = defaultDayHours.upperBound
        for e in events where !e.allDay {
            guard let start = e.startsAt else { continue }
            lo = min(lo, cal.component(.hour, from: start))
            let end = TimeLanes.end(of: e)
            if EventTime.dayKey(end, tz) != EventTime.dayKey(start, tz) {
                hi = 24
            } else {
                let c = cal.dateComponents([.hour, .minute], from: end)
                hi = max(hi, (c.hour ?? 0) + ((c.minute ?? 0) > 0 ? 1 : 0))
            }
        }
        return lo...hi
    }

    /// An hour before the first timed event, so its lead-in shows above it; the top of the
    /// grid when nothing is timed.
    static func openingHour(_ events: [SyncedEvent], hours: ClosedRange<Int>, tz: TimeZone) -> Int {
        guard let first = events.filter({ !$0.allDay }).compactMap(\.startsAt).min() else {
            return hours.lowerBound
        }
        let hour = Cal.gregorian(tz).component(.hour, from: first)
        return max(hours.lowerBound, min(hours.upperBound - 1, hour - 1))
    }
}

/// Side-by-side lanes for overlapping timed events (interval partitioning: cluster
/// transitively-overlapping events, then give each the first free lane). Shared by the
/// iPhone day view and the iPad `CalTimeGrid`, so there is one implementation to test.
enum TimeLanes {
    struct Placed { let event: SyncedEvent; let lane: Int; let lanes: Int }

    static func start(of e: SyncedEvent) -> Date { e.startsAt ?? .distantPast }

    /// Open-ended events take an hour; anything shorter than 30 minutes still takes 30, so
    /// its block is tall enough to read and to tap.
    static func end(of e: SyncedEvent) -> Date {
        let s = start(of: e)
        let duration = e.endsAt.map { max(1800, $0.timeIntervalSince(s)) } ?? 3600
        return s.addingTimeInterval(duration)
    }

    static func place(_ events: [SyncedEvent]) -> [Placed] {
        let sorted = events.sorted { start(of: $0) < start(of: $1) }
        var result: [Placed] = []
        var i = 0
        while i < sorted.count {
            var clusterEnd = end(of: sorted[i])
            var j = i + 1
            while j < sorted.count, start(of: sorted[j]) < clusterEnd {
                clusterEnd = max(clusterEnd, end(of: sorted[j])); j += 1
            }
            var laneEnds: [Date] = []
            var assigned: [(SyncedEvent, Int)] = []
            for e in sorted[i..<j] {
                if let li = laneEnds.firstIndex(where: { start(of: e) >= $0 }) {
                    laneEnds[li] = end(of: e); assigned.append((e, li))
                } else {
                    laneEnds.append(end(of: e)); assigned.append((e, laneEnds.count - 1))
                }
            }
            result += assigned.map { Placed(event: $0.0, lane: $0.1, lanes: laneEnds.count) }
            i = j
        }
        return result
    }
}
