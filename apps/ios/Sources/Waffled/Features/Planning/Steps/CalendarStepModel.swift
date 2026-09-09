import Foundation
import Observation

// Weekly Planning · step 2 "Calendar" — the week's arithmetic and the little state the step keeps.
// Ported from `apps/web/src/kiosk/planning/steps/CalendarStep.tsx`.
//
// THERE IS NO NETWORK IN THIS STEP. `calendar.routes.ts` deliberately registers nothing: the week
// is the REAL calendar (`SyncManager.eventsByDay`) and adding is `EventEditSheet`. A mirror route
// would be a second door onto the same rows, and the two would drift.
//
// THE SERVER OWNS THE WEEK. Every day is `weekStart` plus 0…6, as STRING arithmetic in UTC — a week
// start is a calendar label, and parsing it in the device's zone slips a day twice a year.

/// One day column of the planned week, resolved once per week rather than per render.
struct PlanningWeekDay: Identifiable, Equatable, Sendable {
    /// `YYYY-MM-DD`, household-local — the key into `SyncManager.eventsByDay`.
    let key: String
    let dow: String
    let full: String
    let date: String
    let isToday: Bool

    var id: String { key }
}

enum PlanningWeekDays {

    /// How many events a day shows before it collapses behind "+N more". BUSY WEEKS STAY ONE SCREEN.
    static let rowMax = 4

    /// The seven days of the planned week. `todayKey` is passed in so nothing here reads a clock.
    static func days(weekStart: String, todayKey: String) -> [PlanningWeekDay] {
        (0..<7).map { i in
            let key = addDays(weekStart, i)
            let weekday = dayOfWeek(key)
            return PlanningWeekDay(
                key: key,
                dow: dowShort[weekday].uppercased(),
                full: PlanningFormat.planningDayName(weekday),
                date: monthDay(key),
                isToday: key == todayKey)
        }
    }

    /// "Sep 6 – 12", and "Sep 27 – Oct 3" when the week straddles a month.
    static func weekRangeLabel(_ weekStart: String) -> String {
        guard let a = isoDay.date(from: weekStart) else { return weekStart }
        let b = a.addingTimeInterval(6 * 24 * 60 * 60)
        let sameMonth = monthOut.string(from: a) == monthOut.string(from: b)
        let left = "\(monthOut.string(from: a)) \(dayOut.string(from: a))"
        let right = sameMonth
            ? dayOut.string(from: b)
            : "\(monthOut.string(from: b)) \(dayOut.string(from: b))"
        return "\(left) – \(right)"
    }

    /// "Sunday, Thursday and Friday" — an Oxford-comma-free list a person would say.
    static func names(_ list: [String]) -> String {
        guard list.count > 1 else { return list.first ?? "" }
        return "\(list.dropLast().joined(separator: ", ")) and \(list[list.count - 1])"
    }

    /// THE OPEN DAYS ARE THE POINT OF THE STEP, so they are named, not counted.
    static func summary(total: Int, openDays: [String]) -> String {
        let count = total == 0 ? "Nothing on the week yet" : (total == 1 ? "1 event" : "\(total) events")
        let open: String
        if openDays.isEmpty {
            open = "every day has something"
        } else if openDays.count == 7 {
            open = "every day is still open"
        } else {
            open = "\(names(openDays)) \(openDays.count == 1 ? "is" : "are") still open"
        }
        return "\(count) · \(open)"
    }

    /// Step a `YYYY-MM-DD` by whole days, in UTC. (`PlanningFormat`'s own formatter is private.)
    static func addDays(_ iso: String, _ n: Int) -> String {
        guard let base = isoDay.date(from: iso) else { return iso }
        return isoDay.string(from: base.addingTimeInterval(Double(n) * 24 * 60 * 60))
    }

    static func dayOfWeek(_ iso: String) -> Int {
        guard let d = isoDay.date(from: iso) else { return 0 }
        return (utcCalendar.component(.weekday, from: d) - 1 + 7) % 7
    }

    static func monthDay(_ iso: String) -> String {
        guard let d = isoDay.date(from: iso) else { return iso }
        return "\(monthOut.string(from: d)) \(dayOut.string(from: d))"
    }

    private static let dowShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    private static let utcCalendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
    private static let isoDay: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    private static let monthOut: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "MMM"
        return f
    }()
    private static let dayOut: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "d"
        return f
    }()
}

@MainActor
@Observable
final class PlanningCalendarModel {

    /// ONLY EVER A COUNT: the recap reads through to the calendar itself.
    private(set) var added = 0
    private(set) var revision = 0

    /// The crumb. `added` matches the web's key exactly, and COUNTS ONLY is safe for this step
    /// specifically: the routes live on step 1's row, so answering this step cannot erase them. (A
    /// step whose own row carries a mid-step write must mirror it back — the affirmative REPLACES.)
    var decisionData: [String: JSONValue] { ["added": .int(added)] }

    func recordEventAdded() {
        added += 1
        revision &+= 1
    }
}
