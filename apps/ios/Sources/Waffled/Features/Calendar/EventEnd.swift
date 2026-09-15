import Foundation

/// The event editor's Ends field (`EventEditSheet`). An all-day end is EXCLUSIVE — the day after
/// the last day — the same shape Google sends, so `Agenda.dayKeys` spreads an event made here
/// exactly like a synced one.
enum EventEnd {
    /// Noon rather than midnight, like the editor's all-day start, so a zone difference between
    /// the device and the household can't pull it onto the neighbouring day.
    static func allDayExclusiveEnd(lastDay: Date, cal: Calendar) -> Date {
        let next = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: lastDay)) ?? lastDay
        return cal.date(bySettingHour: 12, minute: 0, second: 0, of: next) ?? next
    }

    /// The last day an all-day event covers, for the editor to show. No end, or an end on or
    /// before the start's next day, is a one-day event.
    static func allDayLastDay(start: Date, end: Date?, cal: Calendar) -> Date {
        let first = cal.startOfDay(for: start)
        guard let end else { return first }
        let endDay = cal.startOfDay(for: end)
        guard endDay > first, let last = cal.date(byAdding: .day, value: -1, to: endDay) else { return first }
        return max(first, last)
    }

    /// "Sep 14, 2026" / "5:00 PM" — the editor's own pills, because a compact `DatePicker` chooses
    /// between that and "9/14/26" on its own and two pickers in one card can disagree.
    static func dayLabel(_ date: Date, locale: Locale = .current, tz: TimeZone = .current) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale, timeZone: tz))
    }

    static func timeLabel(_ date: Date, locale: Locale = .current, tz: TimeZone = .current) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: tz))
    }

    /// One instant from a date picker's day and a time picker's clock time, so changing either
    /// keeps the other.
    static func combine(day: Date, time: Date, cal: Calendar) -> Date {
        let d = cal.dateComponents([.year, .month, .day], from: day)
        let t = cal.dateComponents([.hour, .minute], from: time)
        return cal.date(from: DateComponents(year: d.year, month: d.month, day: d.day, hour: t.hour, minute: t.minute)) ?? day
    }

    /// A timed event's length from its Ends picker; minutes stay the source of truth so moving
    /// the start keeps the length.
    static func minutes(from start: Date, to end: Date) -> Int {
        max(15, Int((end.timeIntervalSince(start) / 60).rounded()))
    }
}
