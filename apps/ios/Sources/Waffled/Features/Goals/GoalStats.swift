import Foundation

// Shared derived-stats layer for the goal-detail data views (Week/Month/Pace/Year/
// By-person/Year-ring/Collection/Consistency). Mirrors apps/web/src/lib/goalStats.ts
// 1:1 so the two platforms agree — see GoalStatsTests.swift for the mirrored suite.
// Pure value types only — no networking; compute once per goal (e.g. as a `let` on
// the detail model after `goalActivity` loads) and reuse across view switches.
//
// Every day is keyed by a normalized LOCAL date string 'YYYY-MM-DD', never a
// timestamp — see GoalDateKey. All date math manipulates calendar fields via
// `Calendar`, which is DST-safe for `.day` components (unlike raw epoch-seconds
// arithmetic), so a day always lands on the intended wall-clock date.

struct DayEntry: Sendable, Equatable {
    let dateKey: String
    let total: Double
    let perMember: [String: Double]
}

enum GoalDateKey {
    // Gregorian + the device's current time zone — local, not UTC — so a day key
    // always matches what the person actually experienced as "today".
    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        return c
    }

    static func today(_ now: Date = Date()) -> String { toKey(now) }

    static func toKey(_ date: Date) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    static func parse(_ key: String) -> Date {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        var c = DateComponents()
        c.year = parts[0]; c.month = parts[1]; c.day = parts[2]
        return calendar.date(from: c)!
    }

    static func addDays(_ key: String, _ n: Int) -> String {
        toKey(calendar.date(byAdding: .day, value: n, to: parse(key))!)
    }

    static func diffDays(_ a: String, _ b: String) -> Int {
        calendar.dateComponents([.day], from: parse(b), to: parse(a)).day!
    }
}

enum GoalTimeframe: Sendable, Equatable {
    case short, long, openEnded
}

enum GoalViewKey: String, Sendable, Equatable, CaseIterable {
    case week, month, pace, year, byPerson, yearRing, collection, consistency
}

enum GoalStats {
    // MARK: Heat ramp — pale (233,245,236) -> deep (18,99,61). t=0 (no activity)
    // should use the panel token instead of heat(0) at the call site.
    static func heat(_ t: Double) -> (Int, Int, Int) {
        let c = max(0, min(1, t))
        let lo = (233.0, 245.0, 236.0)
        let hi = (18.0, 99.0, 61.0)
        return (
            Int((lo.0 + (hi.0 - lo.0) * c).rounded()),
            Int((lo.1 + (hi.1 - lo.1) * c).rounded()),
            Int((lo.2 + (hi.2 - lo.2) * c).rounded())
        )
    }

    static let heatDarkThreshold = 0.55

    // MARK: Timeframe classification + goal-type -> view mapping

    private static let shortWindowDays = 31 // "< ~1 month" — never hard-code 365 elsewhere

    static func classifyTimeframe(startDate: String, endDate: String?) -> GoalTimeframe {
        guard let endDate else { return .openEnded }
        let totalDuration = GoalDateKey.diffDays(endDate, startDate)
        return totalDuration < shortWindowDays ? .short : .long
    }

    private static let typeViews: [String: [GoalViewKey]] = [
        "total": [.pace, .year, .byPerson, .month, .week, .yearRing],
        "count": [.collection, .pace, .month],
        "habit": [.consistency, .week],
        "checklist": [],
    ]

    private static let signatureView: [String: GoalViewKey] = [
        "total": .pace,
        "count": .collection,
        "habit": .consistency,
    ]

    private static let dropsForShortWindow: Set<GoalViewKey> = [.year, .month, .yearRing, .consistency]

    static func availableViews(goalType: String, timeframe: GoalTimeframe) -> [GoalViewKey] {
        let base = typeViews[goalType] ?? []
        guard timeframe == .short else { return base }
        return base.filter { !dropsForShortWindow.contains($0) }
    }

    private static let fallbackOrder: [GoalViewKey] = [.year, .month, .consistency, .pace, .byPerson, .collection, .week, .yearRing]

    static func defaultView(goalType: String, timeframe: GoalTimeframe) -> GoalViewKey? {
        let offered = availableViews(goalType: goalType, timeframe: timeframe)
        guard !offered.isEmpty else { return nil }
        if let signature = signatureView[goalType], offered.contains(signature) { return signature }
        for v in fallbackOrder where offered.contains(v) { return v }
        return offered.first
    }
}

struct GoalPace: Sendable, Equatable {
    let paceValue: Double
    let delta: Double
    let endLabel: String
}

struct GoalStatsResult: Sendable {
    let today: String
    let startDate: String
    let endDate: String?
    let byDay: [String: DayEntry]
    let byMonth: [Double] // 12 entries, index 0 = Jan, for `today`'s calendar year
    let byMonthPerMember: [[String: Double]] // 12 entries
    let byPerson: [String: Double] // lifetime total per person
    let total: Double
    let currentStreak: Int
    let longestStreak: Int
    let activeDays: Int
    let bestDay: DayEntry?
    let weekMax: Double
    let monthMax: Double
    let yearMax: Double
    let pace: GoalPace?
    let projectedFinish: String?

    // Zero-filled — never nil at the call site; a missing day renders quiet, not empty.
    func dayEntry(_ dateKey: String) -> DayEntry {
        byDay[dateKey] ?? DayEntry(dateKey: dateKey, total: 0, perMember: [:])
    }
}

extension GoalStats {
    static func compute(today: String, startDate: String, endDate: String?, target: Double?, days: [DayEntry]) -> GoalStatsResult {
        var byDay: [String: DayEntry] = [:]
        for d in days { byDay[d.dateKey] = d }

        var total = 0.0
        var byPerson: [String: Double] = [:]
        var bestDay: DayEntry?
        for d in days {
            total += d.total
            if bestDay == nil || d.total > bestDay!.total { bestDay = d }
            for (person, amount) in d.perMember {
                byPerson[person, default: 0] += amount
            }
        }

        // Active-day set for streak math — a day counts as "active" if it has any
        // logged total (habit's daily total is 1/0, so this doubles as hit/miss).
        let activeDates = Set(days.filter { $0.total > 0 }.map(\.dateKey))
        let activeDays = activeDates.count

        // currentStreak: consecutive active days ending today, matching the
        // server's goalStreak rule — only counts if the latest active day is
        // today or yesterday (both bucketed by the same household-timezone
        // expression server-side).
        var currentStreak = 0
        let sortedDesc = activeDates.sorted(by: >)
        if let latest = sortedDesc.first, GoalDateKey.diffDays(today, latest) <= 1 {
            var cursor = latest
            for dateKey in sortedDesc {
                if dateKey == cursor {
                    currentStreak += 1
                    cursor = GoalDateKey.addDays(cursor, -1)
                } else {
                    break
                }
            }
        }

        // longestStreak: longest run of consecutive active days anywhere in the log.
        var longestStreak = 0
        var run = 0
        var prev: String?
        for dateKey in activeDates.sorted() {
            run = (prev != nil && GoalDateKey.addDays(prev!, 1) == dateKey) ? run + 1 : 1
            longestStreak = max(longestStreak, run)
            prev = dateKey
        }

        let last7 = Set((0..<7).map { GoalDateKey.addDays(today, -$0) })
        let weekMax = days.filter { last7.contains($0.dateKey) }.map(\.total).max() ?? 0

        let todayDate = GoalDateKey.parse(today)
        let todayComps = GoalDateKey.calendar.dateComponents([.year, .month], from: todayDate)
        let monthMax = days.filter {
            let c = GoalDateKey.calendar.dateComponents([.year, .month], from: GoalDateKey.parse($0.dateKey))
            return c.year == todayComps.year && c.month == todayComps.month
        }.map(\.total).max() ?? 0
        let yearMax = days.filter {
            GoalDateKey.calendar.component(.year, from: GoalDateKey.parse($0.dateKey)) == todayComps.year
        }.map(\.total).max() ?? 0

        var byMonth = [Double](repeating: 0, count: 12)
        var byMonthPerMember = [[String: Double]](repeating: [:], count: 12)
        for d in days {
            let dt = GoalDateKey.parse(d.dateKey)
            let c = GoalDateKey.calendar.dateComponents([.year, .month], from: dt)
            guard c.year == todayComps.year, let month = c.month else { continue }
            byMonth[month - 1] += d.total
            for (person, amount) in d.perMember {
                byMonthPerMember[month - 1][person, default: 0] += amount
            }
        }

        // Pace: target * elapsed/totalDuration, derived from the goal's OWN
        // start/end — never a hard-coded 365. nil for an open-ended goal (no
        // deadline to pace against) or a goal with no numeric target.
        var pace: GoalPace?
        if let endDate, let target {
            let totalDuration = max(1, GoalDateKey.diffDays(endDate, startDate))
            let elapsed = max(0, min(totalDuration, GoalDateKey.diffDays(today, startDate)))
            let paceValue = (target * Double(elapsed) / Double(totalDuration)).rounded()
            pace = GoalPace(paceValue: paceValue, delta: ((total - paceValue) * 100).rounded() / 100, endLabel: endDate)
        }

        // projectedFinish: extend the trailing-14-day rolling rate from today.
        // nil when the rate is ~0 (nothing recent to extrapolate from) or the
        // target's already met (in which case it's just today).
        var projectedFinish: String?
        if let target {
            let remaining = target - total
            if remaining <= 0 {
                projectedFinish = today
            } else {
                let windowStart = GoalDateKey.addDays(today, -13)
                let recent = days.filter { $0.dateKey >= windowStart && $0.dateKey <= today }.reduce(0) { $0 + $1.total }
                let spanDays = max(1, min(14, GoalDateKey.diffDays(today, startDate) + 1))
                let rate = recent / Double(spanDays)
                if rate > 0.001 {
                    projectedFinish = GoalDateKey.addDays(today, Int((remaining / rate).rounded(.up)))
                }
            }
        }

        return GoalStatsResult(
            today: today,
            startDate: startDate,
            endDate: endDate,
            byDay: byDay,
            byMonth: byMonth,
            byMonthPerMember: byMonthPerMember,
            byPerson: byPerson,
            total: (total * 100).rounded() / 100,
            currentStreak: currentStreak,
            longestStreak: longestStreak,
            activeDays: activeDays,
            bestDay: bestDay,
            weekMax: weekMax,
            monthMax: monthMax,
            yearMax: yearMax,
            pace: pace,
            projectedFinish: projectedFinish
        )
    }
}
