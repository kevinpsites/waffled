import SwiftUI

// The month grid the Horizon scan draws, and the pure arithmetic behind it.
//
// WHY IT EXISTS — the one place this port hand-rolls something. iOS's equivalent
// (`CalendarView.monthCells` / `monthCell`) is `private` to a file this change may not
// edit, so the grid is COPIED, deliberately down to the numbers, and should be EXTRACTED
// into a shared view. The web's chips-and-"+N more" does not port: an iOS cell is a fixed
// 44pt box with a dot row, and tapping a day already lists everything on it in the panel
// underneath.

/// One day cell, fully resolved BEFORE the grid renders. Date maths, day-key formatting
/// and colour resolution happen once per month build rather than 42× per render.
struct PlanningMonthCell: Identifiable, Equatable, Sendable {
    /// `YYYY-MM-DD`, household-local.
    let key: String
    let day: Int
    /// False for the leading/trailing days that belong to the neighbouring months.
    let inMonth: Bool
    /// Distinct event colours on this day, capped at three — a whole-family event
    /// contributes the family colour, so a day everyone is on shows one dot, not three.
    let dotHexes: [String]
    /// The countdown badge, when the day carries one ("🎂 5d").
    let countdownEmoji: String?
    let countdownLabel: String?
    /// How many further countdowns land on the same day ("+2").
    let extraCountdowns: Int

    var id: String { key }
}

/// The month arithmetic — all of it string- and integer-based where it can be.
enum PlanningMonth {
    static let names = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ]

    /// "September 2026". `month` is 1-based, as `DateComponents` counts them.
    static func label(year: Int, month: Int) -> String {
        guard (1...12).contains(month) else { return "\(year)" }
        return "\(names[month - 1]) \(year)"
    }

    /// The month a `YYYY-MM-DD` week start falls in, read off the STRING. Never through a
    /// `Date`: a week start is a calendar label, and parsing it in the device's zone is
    /// how a household in a negative offset gets the previous month back on the 1st.
    static func month(of weekStart: String) -> (year: Int, month: Int)? {
        let parts = weekStart.split(separator: "-")
        guard parts.count >= 2, let y = Int(parts[0]), let m = Int(parts[1]), (1...12).contains(m) else {
            return nil
        }
        return (y, m)
    }

    /// Step whole months, with integer arithmetic rather than calendar addition.
    static func advance(year: Int, month: Int, by months: Int) -> (year: Int, month: Int) {
        let zero = year * 12 + (month - 1) + months
        return (zero / 12, zero % 12 + 1)
    }

    /// The 42 cells of the grid, resolved. `eventsByDay` is `SyncManager`'s prebuilt index
    /// — an O(1) lookup per day rather than 42 scans of the mirror.
    static func cells(
        year: Int,
        month: Int,
        tz: TimeZone,
        firstDay: HouseholdWeekStart,
        eventsByDay: [String: [SyncedEvent]],
        countdownsByDate: [String: [WaffledAPI.Countdown]],
        palette: EventPalette
    ) -> [PlanningMonthCell] {
        let cal = Cal.gregorian(tz)
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        guard let first = cal.date(from: comps) else { return [] }
        let start = Cal.weekStart(first, tz, firstDay)
        return (0..<42).compactMap { i in
            guard let d = cal.date(byAdding: .day, value: i, to: start) else { return nil }
            let key = EventTime.dayKey(d, tz)
            let countdowns = countdownsByDate[key] ?? []
            return PlanningMonthCell(
                key: key,
                day: cal.component(.day, from: d),
                inMonth: cal.component(.month, from: d) == month,
                dotHexes: dots(eventsByDay[key] ?? [], palette: palette),
                countdownEmoji: countdowns.first.map { $0.emoji ?? "⏳" },
                countdownLabel: countdowns.first.map { CountdownFormat.short($0.daysLeft) },
                extraCountdowns: max(0, countdowns.count - 1))
        }
    }

    /// Distinct colours, in the day's own order, capped at three.
    private static func dots(_ events: [SyncedEvent], palette: EventPalette) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for e in events {
            let hex = palette.hex(for: e) ?? "#A6A29B"
            if seen.insert(hex).inserted { out.append(hex) }
            if out.count == 3 { break }
        }
        return out
    }
}

/// The grid itself: weekday headings rotated to the household's first day, then 42 cells.
/// Every cell is a day-select button — the countdown badge is an indicator, not a control.
struct PlanningMonthGrid: View {
    let cells: [PlanningMonthCell]
    let firstDay: HouseholdWeekStart
    let selectedDay: String
    let todayKey: String
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 0) {
                // Indexed by offset, not by the label: "T" and "S" each appear twice, so
                // `id: \.self` would collide.
                ForEach(
                    Array(Cal.rotated(["S", "M", "T", "W", "T", "F", "S"], from: firstDay).enumerated()),
                    id: \.offset
                ) { _, d in
                    Text(d).font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 4) {
                ForEach(cells) { cell in cellView(cell) }
            }
        }
        .padding(12)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func cellView(_ cell: PlanningMonthCell) -> some View {
        let isSelected = cell.key == selectedDay
        let isToday = cell.key == todayKey
        return Button {
            withAnimation { onSelect(cell.key) }
        } label: {
            VStack(spacing: 3) {
                Text("\(cell.day)")
                    .font(.system(size: 14, weight: isToday ? .heavy : .semibold))
                    .foregroundStyle(cell.inMonth ? (isToday ? WF.primary : WF.ink) : WF.ink3.opacity(0.5))
                if let emoji = cell.countdownEmoji, let label = cell.countdownLabel {
                    HStack(spacing: 2) {
                        Text(emoji).font(.system(size: 8))
                        Text(label).font(.system(size: 8, weight: .heavy)).foregroundStyle(WF.warn)
                        if cell.extraCountdowns > 0 {
                            Text("+\(cell.extraCountdowns)")
                                .font(.system(size: 8, weight: .bold)).foregroundStyle(WF.ink3)
                        }
                    }
                    .padding(.horizontal, 3).padding(.vertical, 1)
                    .background(WF.warnT).clipShape(Capsule())
                } else {
                    HStack(spacing: 2) {
                        ForEach(Array(cell.dotHexes.enumerated()), id: \.offset) { _, hex in
                            Circle().fill(Color(hexString: hex) ?? WF.ink3).frame(width: 5, height: 5)
                        }
                    }
                    .frame(height: 5)
                }
            }
            .frame(maxWidth: .infinity).frame(height: 44)
            .background(isSelected ? WF.primary.opacity(0.12) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isSelected ? WF.primary : Color.clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
    }
}
