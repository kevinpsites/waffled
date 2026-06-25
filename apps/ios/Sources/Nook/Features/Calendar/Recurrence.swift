import Foundation

/// Pure helpers for the event editor's "Repeats" picker — a Swift port of the web's
/// `apps/web/src/kiosk/components/recurrence.ts`. Turn the picker state into an
/// RFC5545 RRULE string, parse an existing rule back into picker state, and describe a
/// rule in plain English. The same shapes round-trip on both clients, so an event made
/// recurring on one surface stays editable on the other.
///
/// "Custom…" is a friendly builder ("repeat every N days/weeks/months/years", with
/// weekday chips for weekly and a day-of-month / nth-weekday choice for monthly) — no
/// one types an RRULE. A raw RRULE is kept as an advanced escape hatch (and to preserve
/// an imported rule the builder can't represent).

enum RepeatFreq: String, CaseIterable, Hashable {
    case none, daily, weekdays, weekly, monthly, custom
}
enum CustomUnit: String, CaseIterable, Hashable { case day, week, month, year }
enum MonthlyMode: String, Hashable { case day, weekday, lastWeekday } // day-of-month / Nth weekday / last weekday

/// The picker state. `custom` (an advanced raw RRULE) overrides the builder when set.
struct RepeatState: Equatable {
    var freq: RepeatFreq = .none
    var byday: [String] = []        // weekly + custom-weekly days, e.g. ["MO","WE"]
    var interval: Int = 1           // custom: "every N" (>= 1)
    var unit: CustomUnit = .week    // custom: the unit N counts
    var monthlyMode: MonthlyMode = .day
    var custom: String = ""         // advanced raw RRULE — overrides the builder

    static let none = RepeatState()
}

enum Recurrence {
    static let weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    static let weekdaySet = "MO,TU,WE,TH,FR"
    private static let plainDay: Set<String> = Set(weekdays)
    private static let dayName: [String: String] = ["SU": "Sun", "MO": "Mon", "TU": "Tue", "WE": "Wed", "TH": "Thu", "FR": "Fri", "SA": "Sat"]
    private static let fullDay: [String: String] = ["SU": "Sunday", "MO": "Monday", "TU": "Tuesday", "WE": "Wednesday", "TH": "Thursday", "FR": "Friday", "SA": "Saturday"]
    private static let ordinals = ["", "first", "second", "third", "fourth", "fifth"]

    /// The RRULE weekday code for a date's local weekday (Calendar: 1=Sun…7=Sat).
    static func weekdayCode(_ d: Date, _ cal: Calendar = .current) -> String {
        weekdays[cal.component(.weekday, from: d) - 1]
    }

    /// Which occurrence of its weekday a date is within its month (1 = first, …).
    static func nthWeekdayOfMonth(_ d: Date, _ cal: Calendar = .current) -> Int {
        (cal.component(.day, from: d) - 1) / 7 + 1
    }

    /// Build the RRULE for the picker state. `start` is the event's start (used for the
    /// default weekly day and the monthly nth-weekday ordinal). Returns nil for `.none`
    /// (or an empty custom rule) — i.e. a non-recurring event.
    static func buildRrule(_ r: RepeatState, start: Date, _ cal: Calendar = .current) -> String? {
        let weekday = weekdayCode(start, cal)
        switch r.freq {
        case .none:
            return nil
        case .daily:
            return "FREQ=DAILY"
        case .weekdays:
            return "FREQ=WEEKLY;BYDAY=\(weekdaySet)"
        case .weekly:
            let days = r.byday.isEmpty ? [weekday] : r.byday
            return "FREQ=WEEKLY;BYDAY=\(days.joined(separator: ","))"
        case .monthly:
            // No BYMONTHDAY → repeats on the start date's day-of-month.
            return "FREQ=MONTHLY"
        case .custom:
            let raw = stripPrefix(r.custom)
            if !raw.isEmpty { return raw } // advanced override
            let n = max(1, r.interval)
            let iv = n > 1 ? ";INTERVAL=\(n)" : ""
            switch r.unit {
            case .day:
                return "FREQ=DAILY\(iv)"
            case .week:
                let days = r.byday.isEmpty ? [weekday] : r.byday
                return "FREQ=WEEKLY\(iv);BYDAY=\(days.joined(separator: ","))"
            case .month:
                if r.monthlyMode == .weekday { return "FREQ=MONTHLY\(iv);BYDAY=\(nthWeekdayOfMonth(start, cal))\(weekday)" }
                if r.monthlyMode == .lastWeekday { return "FREQ=MONTHLY\(iv);BYDAY=-1\(weekday)" }
                return "FREQ=MONTHLY\(iv)"
            case .year:
                return "FREQ=YEARLY\(iv)"
            }
        }
    }

    /// Parse an existing RRULE back into picker state (best-effort). Common interval /
    /// yearly / monthly-nth-weekday rules map onto the friendly custom builder; anything
    /// it can't represent (COUNT, UNTIL, multi-clause BY…) is preserved verbatim as an
    /// advanced custom rule so it stays editable and round-trips.
    static func parseRepeat(_ rrule: String?) -> RepeatState {
        guard let rrule, !rrule.isEmpty else { return .none }
        let raw = stripPrefix(rrule)
        let parts = ruleParts(raw)
        let freq = parts["FREQ"] ?? ""
        let byday = parts["BYDAY"].map { $0.split(separator: ",").map(String.init) } ?? []
        let plainByday = byday.filter { plainDay.contains($0) }
        let interval = parts["INTERVAL"].flatMap { Int($0) }.map { max(1, $0) } ?? 1
        let bounded = parts["COUNT"] != nil || parts["UNTIL"] != nil

        // Simple presets — interval 1, no COUNT/UNTIL.
        if !bounded && interval == 1 {
            if freq == "DAILY" && parts["BYDAY"] == nil { return RepeatState(freq: .daily) }
            if freq == "WEEKLY" {
                if byday.joined(separator: ",") == weekdaySet { return RepeatState(freq: .weekdays) }
                if !byday.isEmpty && byday.allSatisfy({ plainDay.contains($0) }) { return RepeatState(freq: .weekly, byday: byday) }
            }
            if freq == "MONTHLY" && parts["BYDAY"] == nil && parts["BYMONTHDAY"] == nil { return RepeatState(freq: .monthly) }
        }

        // Friendly custom builder — interval > 1, yearly, or monthly-by-weekday; still
        // no COUNT/UNTIL (those need the advanced rule).
        if !bounded {
            if freq == "DAILY" && parts["BYDAY"] == nil { return RepeatState(freq: .custom, interval: interval, unit: .day) }
            if freq == "WEEKLY" && (parts["BYDAY"] == nil || plainByday.count == byday.count) {
                return RepeatState(freq: .custom, byday: plainByday, interval: interval, unit: .week)
            }
            if freq == "MONTHLY" && parts["BYDAY"] == nil && parts["BYMONTHDAY"] == nil {
                return RepeatState(freq: .custom, interval: interval, unit: .month, monthlyMode: .day)
            }
            if freq == "MONTHLY", let bd = parts["BYDAY"], bd.range(of: "^-?\\d+[A-Z]{2}$", options: .regularExpression) != nil {
                return RepeatState(freq: .custom, interval: interval, unit: .month, monthlyMode: bd.hasPrefix("-") ? .lastWeekday : .weekday)
            }
            if freq == "YEARLY" { return RepeatState(freq: .custom, interval: interval, unit: .year) }
        }

        // Anything else → preserve the raw rule in the advanced field.
        return RepeatState(freq: .custom, custom: raw)
    }

    /// Plain-English description of a rule (the picker's live summary). `start` gives the
    /// monthly nth-weekday phrasing a weekday name. Falls back to the raw rule for shapes
    /// it doesn't recognise, so the summary is never empty for a real rule.
    static func describeRrule(_ rule: String?, start: Date, _ cal: Calendar = .current) -> String {
        guard let rule, !rule.isEmpty else { return "Does not repeat" }
        let parts = ruleParts(stripPrefix(rule))
        let freq = parts["FREQ"] ?? ""
        let n = parts["INTERVAL"].flatMap { Int($0) }.map { max(1, $0) } ?? 1
        let byday = parts["BYDAY"].map { $0.split(separator: ",").map(String.init) } ?? []
        let every = { (unit: String) in n == 1 ? "Every \(unit)" : "Every \(n) \(unit)s" }
        var base: String?

        if freq == "DAILY" && parts["BYDAY"] == nil {
            base = every("day")
        } else if freq == "WEEKLY" {
            if byday.joined(separator: ",") == weekdaySet {
                base = n == 1 ? "Every weekday (Mon–Fri)" : "Every \(n) weeks on Mon–Fri"
            } else if !byday.isEmpty && byday.allSatisfy({ plainDay.contains($0) }) {
                base = "\(every("week")) on \(dayList(byday))"
            } else if parts["BYDAY"] == nil {
                base = "\(every("week")) on \(dayName[weekdayCode(start, cal)] ?? "")"
            }
        } else if freq == "MONTHLY" {
            if let bd = parts["BYDAY"], let m = bd.range(of: "^(-?\\d+)([A-Z]{2})$", options: .regularExpression) {
                let token = String(bd[m])
                let num = Int(token.prefix(token.count - 2)) ?? 1
                let code = String(token.suffix(2))
                let ord = num == -1 ? "last" : (ordinals.indices.contains(num) ? ordinals[num] : "\(num)th")
                base = "\(every("month")) on the \(ord) \(fullDay[code] ?? code)"
            } else if parts["BYMONTHDAY"] == nil {
                base = every("month")
            }
        } else if freq == "YEARLY" {
            base = every("year")
        }

        guard var result = base else { return rule } // unrecognised — show the raw rule
        if let count = parts["COUNT"] { result += ", \(count) times" }
        return result
    }

    // MARK: helpers

    /// Strip a leading "RRULE:" (case-insensitive) and surrounding whitespace.
    private static func stripPrefix(_ s: String) -> String {
        var raw = s.trimmingCharacters(in: .whitespaces)
        if let r = raw.range(of: "^RRULE:", options: [.regularExpression, .caseInsensitive]) {
            raw.removeSubrange(r)
        }
        return raw.trimmingCharacters(in: .whitespaces)
    }

    private static func ruleParts(_ raw: String) -> [String: String] {
        var parts: [String: String] = [:]
        for seg in raw.uppercased().split(separator: ";") {
            let kv = seg.split(separator: "=", maxSplits: 1)
            if kv.count == 2 { parts[String(kv[0])] = String(kv[1]) }
        }
        return parts
    }

    private static func dayList(_ codes: [String]) -> String {
        codes.map { dayName[$0] ?? $0 }.joined(separator: ", ")
    }
}
