import Foundation
import CoreGraphics

/// The iPhone calendar's layout rules — Month → Week → Day — kept out of the view so they
/// can be tested. Rationale for the numbers lives in `docs/product/ios-calendar-redesign.md`.
enum PhoneCalendar {

    /// Picked from the header's view menu. `agenda` sits outside the pinch order; it stays
    /// because it is the only view that carries the AI capture bar.
    enum Mode: String, CaseIterable {
        case month, week, day, agenda

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

        /// The view to open on: a launch override as-is, else the saved view — except Day, which
        /// only an older build could save (Day is now a drill-in), so that reopens on Month.
        static func restored(stored: Mode, override: Mode?) -> Mode {
            if let override { return override }
            return stored == .day ? .month : stored
        }

        var label: String { rawValue.capitalized }
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

    /// Titles per day cell: as many chips as the row height holds, never more than four. One
    /// countdown pill takes a slot; further countdowns, like events that don't fit, count toward
    /// "+N more". Room for that line is always kept.
    /// `reservedSlots` are the row's spanning-bar lanes, drawn over the cells by the grid.
    static func cellChips(eventCount: Int, countdownCount: Int, rowHeight: CGFloat, reservedSlots: Int = 0) -> CellChips {
        let room = rowHeight - cellTopPadding - dayNumberHeight - moreLineHeight - chipGap
        let fit = min(maxCellSlots, max(0, Int((room / (chipHeight + chipGap)).rounded(.down))))
        let slots = max(0, fit - reservedSlots)
        let showsCountdown = countdownCount > 0 && slots > 0
        let shown = min(eventCount, slots - (showsCountdown ? 1 : 0))
        let hiddenCountdowns = countdownCount - (showsCountdown ? 1 : 0)
        return CellChips(shown: shown, more: eventCount - shown + hiddenCountdowns, showsCountdown: showsCountdown)
    }

    struct SpanBar: Equatable {
        let event: SyncedEvent
        let startCol: Int
        let endCol: Int
        let lane: Int
        /// The event started before this row / runs on past it, so that end is square.
        let continuesBefore: Bool
        let continuesAfter: Bool
    }

    struct WeekSpans: Equatable {
        let bars: [SpanBar]
        let lanes: Int
        /// Each day's events that still draw as chips: everything the bars didn't take.
        let chipsByDay: [String: [SyncedEvent]]
    }

    static let maxSpanLanes = 2

    /// Multi-day all-day events in one month row, laid out as bars across their days like Google's
    /// month view: earliest start first, longer first on a tie, each in the first lane free by its
    /// start. Beyond `maxLanes` an event stays a chip in each of its days.
    static func weekSpans(_ days: [String], byDay: [String: [SyncedEvent]], tz: TimeZone,
                          maxLanes: Int = maxSpanLanes) -> WeekSpans {
        guard let firstDay = days.first, let lastDay = days.last else {
            return WeekSpans(bars: [], lanes: 0, chipsByDay: [:])
        }
        struct Candidate { let event: SyncedEvent; let start: Int; let end: Int; let before: Bool; let after: Bool }
        var seen = Set<String>()
        var candidates: [Candidate] = []
        for (col, key) in days.enumerated() {
            for e in byDay[key] ?? [] where e.allDay && !seen.contains(e.id) {
                let keys = Agenda.dayKeys(e, tz)
                guard keys.count > 1, let first = keys.first, let last = keys.last else { continue }
                seen.insert(e.id)
                let end = days.lastIndex { $0 <= last } ?? col
                candidates.append(Candidate(event: e, start: col, end: max(col, end),
                                            before: first < firstDay, after: last > lastDay))
            }
        }
        candidates.sort {
            if $0.start != $1.start { return $0.start < $1.start }
            if $0.end != $1.end { return $0.end > $1.end }
            return $0.event.id < $1.event.id
        }
        var laneEnds: [Int] = []
        var bars: [SpanBar] = []
        for c in candidates {
            let lane = laneEnds.firstIndex { $0 < c.start } ?? laneEnds.count
            guard lane < maxLanes else { continue }
            if lane == laneEnds.count { laneEnds.append(c.end) } else { laneEnds[lane] = c.end }
            bars.append(SpanBar(event: c.event, startCol: c.start, endCol: c.end, lane: lane,
                                continuesBefore: c.before, continuesAfter: c.after))
        }
        let barIds = Set(bars.map(\.event.id))
        var chips: [String: [SyncedEvent]] = [:]
        for key in days { chips[key] = (byDay[key] ?? []).filter { !barIds.contains($0.id) } }
        return WeekSpans(bars: bars, lanes: laneEnds.count, chipsByDay: chips)
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

    /// The day Week should show when you arrive from a month: your selection if it's in that
    /// month, else today if it is, else the 1st.
    static func focusDay(selected: String, inMonthOf anchor: Date, today: String, tz: TimeZone) -> String {
        let month = DateFmt.string(anchor, "yyyy-MM", tz)
        if selected.hasPrefix(month) { return selected }
        if today.hasPrefix(month) { return today }
        return month + "-01"
    }

    /// Width of the leading strip the system back-swipe owns on a pushed screen.
    static let backSwipeEdge: CGFloat = 30

    /// Day paging on a pushed Day: the shared flick thresholds, minus drags that start at the
    /// leading edge — those are the back swipe, and paging too would shift the day on the way out.
    static func daySwipeStep(startX: CGFloat, dx: CGFloat, dy: CGFloat) -> Int? {
        guard startX >= backSwipeEdge else { return nil }
        return HorizontalSwipe.step(dx: dx, dy: dy)
    }

    /// The first day of each of the rail's weeks — the day strip's pages. `railDays` always
    /// starts on a week boundary, so every seventh day opens a week.
    static func railWeeks(_ days: [String]) -> [String] {
        stride(from: 0, to: days.count, by: 7).map { days[$0] }
    }

    /// The week rail's days: whole weeks either side of `key`'s week, so swiping on from the
    /// last day of a week simply scrolls into the next one.
    static func railDays(around key: String, weeksEachSide: Int, tz: TimeZone,
                         firstDay: HouseholdWeekStart) -> [String] {
        guard let first = weekDays(containing: shift(key, byDays: -7 * weeksEachSide, tz: tz),
                                   tz: tz, firstDay: firstDay).first,
              let start = DateFmt.date(first, "yyyy-MM-dd", tz) else { return [] }
        let cal = Cal.gregorian(tz)
        return (0..<((2 * weeksEachSide + 1) * 7))
            .compactMap { cal.date(byAdding: .day, value: $0, to: start) }
            .map { EventTime.dayKey($0, tz) }
    }

    /// Re-centre the rail once the selection is within a week of either end, or off it entirely.
    static func railNeedsRecenter(selected: String, days: [String]) -> Bool {
        guard let i = days.firstIndex(of: selected) else { return true }
        return i < 7 || i >= days.count - 7
    }

    static func shift(_ key: String, byDays n: Int, tz: TimeZone) -> String {
        guard let date = DateFmt.date(key, "yyyy-MM-dd", tz),
              let moved = Cal.gregorian(tz).date(byAdding: .day, value: n, to: date) else { return key }
        return EventTime.dayKey(moved, tz)
    }

    // MARK: Meals

    /// The Meals module mirrors each planned meal (`meal_plan`) and its thaw reminder
    /// (`meal_prep`) into ordinary events; see apps/api/src/modules/meals/meal-events.ts.
    enum EventKind: Equatable {
        case regular, meal, prep

        init(origin: String?) {
            switch origin {
            case "meal_plan": self = .meal
            case "meal_prep": self = .prep
            default: self = .regular
            }
        }
    }

    /// The week card's closing line: tonight's planned dinner, else what to thaw for it.
    /// Reads the server-written titles ("🍽️ Dinner · Salmon", "🧊 Thaw for Dinner · Salmon").
    static func dinnerFooter(_ events: [SyncedEvent]) -> String? {
        func words(_ title: String) -> String { String(title.drop { !$0.isLetter }) }
        if let meal = events.first(where: { EventKind(origin: $0.origin) == .meal && words($0.title).hasPrefix("Dinner") }) {
            return words(meal.title)
        }
        if let prep = events.first(where: { EventKind(origin: $0.origin) == .prep && words($0.title).hasPrefix("Thaw for Dinner") }) {
            let parts = words(prep.title).components(separatedBy: " · ")
            return parts.count > 1 ? "Thaw · " + parts.dropFirst().joined(separator: " · ") : "Thaw for dinner"
        }
        return nil
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
