import Foundation

// On-device heuristic parser for the "Add anything…" capture bar — the offline /
// no-provider fallback. Zero network: turns free text into a `CaptureIntent` the app
// can commit to the right domain (event / grocery / task / meal / list).
//
// ⚠️ KEEP IN SYNC — this is a port of the web parser at
//   apps/web/src/lib/capture/parse.ts
// (tests: apps/ios/Tests/CaptureHeuristicTests.swift ↔ that file's parse.test.ts).
// If you change a parsing RULE there, port the same change here and update BOTH test
// suites so they stay byte-for-byte equivalent.
//
// Routing priority: a date/time → event; otherwise a grocery signal → grocery;
// otherwise a task signal → task; bare nouns fall back to grocery. `now`/`cal` are
// injected so the logic is deterministic in tests.
enum CaptureHeuristic {

    // MARK: regex helpers (NSString/UTF-16 indices, to mirror JS string semantics)

    private struct Span { var start: Int; var end: Int }
    private typealias Hit = (range: NSRange, groups: [String?])

    private static func firstMatch(_ pattern: String, _ s: NSString, ci: Bool = true) -> Hit? {
        let opts: NSRegularExpression.Options = ci ? [.caseInsensitive] : []
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts),
              let m = re.firstMatch(in: s as String, range: NSRange(location: 0, length: s.length)) else { return nil }
        var groups: [String?] = []
        for i in 0..<m.numberOfRanges {
            let r = m.range(at: i)
            groups.append(r.location == NSNotFound ? nil : s.substring(with: r))
        }
        return (m.range, groups)
    }

    private static func allMatches(_ pattern: String, _ s: NSString, ci: Bool = true) -> [Hit] {
        let opts: NSRegularExpression.Options = ci ? [.caseInsensitive] : []
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else { return [] }
        return re.matches(in: s as String, range: NSRange(location: 0, length: s.length)).map { m in
            var g: [String?] = []
            for i in 0..<m.numberOfRanges {
                let r = m.range(at: i)
                g.append(r.location == NSNotFound ? nil : s.substring(with: r))
            }
            return (m.range, g)
        }
    }

    private static func test(_ pattern: String, _ s: NSString) -> Bool { firstMatch(pattern, s) != nil }

    private static func replaceAll(_ pattern: String, _ s: NSString, _ with: String) -> NSString {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return s }
        return re.stringByReplacingMatches(in: s as String, range: NSRange(location: 0, length: s.length),
                                           withTemplate: with) as NSString
    }

    private static func replaceFirst(_ pattern: String, _ s: NSString, _ with: String) -> NSString {
        guard let m = firstMatch(pattern, s) else { return s }
        let before = s.substring(to: m.range.location)
        let after = s.substring(from: min(m.range.location + m.range.length, s.length))
        return (before + with + after) as NSString
    }

    private static func span(_ h: Hit) -> Span { Span(start: h.range.location, end: h.range.location + h.range.length) }

    // MARK: date helpers (deterministic via injected `cal`)

    private static func weekday0(_ d: Date, _ cal: Calendar) -> Int { cal.component(.weekday, from: d) - 1 }
    private static func startOfDay(_ d: Date, _ cal: Calendar) -> Date { cal.startOfDay(for: d) }
    private static func addDays(_ d: Date, _ n: Int, _ cal: Calendar) -> Date { cal.date(byAdding: .day, value: n, to: d)! }
    private static func ymd(_ y: Int, _ mo0: Int, _ d: Int, h: Int? = nil, min: Int? = nil, _ cal: Calendar) -> Date {
        cal.date(from: DateComponents(year: y, month: mo0 + 1, day: d, hour: h, minute: min)) ?? Date()
    }
    private static func fmt(_ d: Date, _ pattern: String, _ cal: Calendar) -> String {
        DateFmt.string(d, pattern, cal.timeZone)
    }
    private static func isoUTC(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    // MARK: constants

    private static let weekdays: [String: Int] = [
        "sun": 0, "sunday": 0, "mon": 1, "monday": 1, "tue": 2, "tues": 2, "tuesday": 2,
        "wed": 3, "weds": 3, "wednesday": 3, "thu": 4, "thur": 4, "thurs": 4, "thursday": 4,
        "fri": 5, "friday": 5, "sat": 6, "saturday": 6,
    ]
    private static let byday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    private static let dayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months: [String: Int] = [
        "jan": 0, "january": 0, "feb": 1, "february": 1, "mar": 2, "march": 2, "apr": 3, "april": 3,
        "may": 4, "jun": 5, "june": 5, "jul": 6, "july": 6, "aug": 7, "august": 7, "sep": 8, "sept": 8,
        "september": 8, "oct": 9, "october": 9, "nov": 10, "november": 10, "dec": 11, "december": 11,
    ]
    private static let mealTypes: Set<String> = ["breakfast", "lunch", "dinner", "snack"]

    private static func mealTypeFrom(_ word: String?) -> String {
        let w = (word ?? "").lowercased()
        if w == "supper" { return "dinner" }
        if w == "brunch" { return "lunch" }
        return mealTypes.contains(w) ? w : "dinner"
    }
    private static func cap(_ s: String) -> String { s.isEmpty ? s : s.prefix(1).uppercased() + s.dropFirst() }
    private static func titleCase(_ s: String) -> String { cap(s) }

    private struct DayHit { var y: Int; var mo: Int; var d: Int; var label: String; var span: Span; var eveningHint: Bool }
    private struct TimeHit { var h: Int; var m: Int; var label: String; var span: Span }

    // MARK: findDay

    private static func findDay(_ text: NSString, _ now: Date, _ cal: Calendar) -> DayHit? {
        let base = startOfDay(now, cal)
        func make(_ d: Date, _ label: String, _ sp: Span, _ evening: Bool = false) -> DayHit {
            DayHit(y: cal.component(.year, from: d), mo: cal.component(.month, from: d) - 1,
                   d: cal.component(.day, from: d), label: label, span: sp, eveningHint: evening)
        }

        if let m = firstMatch(#"\b(today|tonight|tomorrow|this evening)\b"#, text) {
            let word = (m.groups[1] ?? "").lowercased()
            let evening = word == "tonight" || word == "this evening"
            let d = word == "tomorrow" ? addDays(base, 1, cal) : base
            let label = word == "tomorrow" ? "Tomorrow" : (evening ? "Tonight" : "Today")
            return make(d, label, span(m), evening)
        }

        if let m = firstMatch(#"\b(next\s+)?(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)\b"#, text) {
            let wd = weekdays[(m.groups[2] ?? "").lowercased()] ?? 0
            var delta = (wd - weekday0(base, cal) + 7) % 7
            if m.groups[1] != nil { delta += (delta == 0 ? 7 : 7) }   // "next" pushes a full week out
            let d = addDays(base, delta, cal)
            let label = fmt(d, "EEEE", cal)
            return make(d, m.groups[1] != nil ? "Next \(label)" : label, span(m))
        }

        if let m = firstMatch(#"\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b"#, text) {
            let mo = months[(m.groups[1] ?? "").lowercased()] ?? 0
            let day = Int(m.groups[2] ?? "") ?? 1
            var year = cal.component(.year, from: now)
            let nowMo = cal.component(.month, from: now) - 1
            let nowDay = cal.component(.day, from: now)
            if mo < nowMo || (mo == nowMo && day < nowDay) { year += 1 }
            let d = ymd(year, mo, day, cal)
            return make(d, fmt(d, "MMM d", cal), span(m))
        }

        if let m = firstMatch(#"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b"#, text) {
            let mo = (Int(m.groups[1] ?? "") ?? 1) - 1
            let day = Int(m.groups[2] ?? "") ?? 0
            if mo >= 0 && mo <= 11 && day >= 1 && day <= 31 {
                var year = cal.component(.year, from: now)
                let nowMo = cal.component(.month, from: now) - 1
                let nowDay = cal.component(.day, from: now)
                if let y3 = m.groups[3] {
                    year = Int(y3.count == 2 ? "20\(y3)" : y3) ?? year
                } else if mo < nowMo || (mo == nowMo && day < nowDay) {
                    year += 1
                }
                let d = ymd(year, mo, day, cal)
                return make(d, fmt(d, "MMM d", cal), span(m))
            }
        }
        return nil
    }

    // MARK: weekday lists / recurrence

    private static func findAllWeekdays(_ text: NSString) -> (codes: [String], spans: [Span], labels: [String]) {
        var codes: [String] = []; var labels: [String] = []; var spans: [Span] = []
        var seen = Set<String>()
        for m in allMatches(#"\b(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)\b"#, text) {
            let dow = weekdays[(m.groups[1] ?? "").lowercased()] ?? 0
            spans.append(span(m))
            let code = byday[dow]
            if !seen.contains(code) { seen.insert(code); codes.append(code); labels.append(dayShort[dow]) }
        }
        return (codes, spans, labels)
    }

    private static func detectEventRecurrence(_ text: NSString, _ startWeekday: Int) -> (rrule: String?, spans: [Span]) {
        var spans: [Span] = []
        func add(_ h: Hit?) { if let h { spans.append(span(h)) } }

        if let m = firstMatch(#"\b(every\s*day|everyday|daily|each\s*day)\b"#, text) { add(m); return ("FREQ=DAILY", spans) }
        if let m = firstMatch(#"\b(every\s+)?weekdays?\b"#, text), test(#"\bevery\b"#, (m.groups[0] ?? "") as NSString) {
            add(m); return ("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", spans)
        }

        var interval = 1
        if let other = firstMatch(#"\b(every other|bi-?weekly|fortnightly)\b"#, text) { interval = 2; add(other) }
        let everyN = firstMatch(#"\bevery\s+(\d{1,2})\s+(day|week|month|year)s?\b"#, text)
        if let everyN { interval = max(1, Int(everyN.groups[1] ?? "") ?? 1); add(everyN) }
        let unit = everyN.flatMap { ($0.groups[2] ?? "").lowercased() }
        let iv = interval > 1 ? ";INTERVAL=\(interval)" : ""

        if unit == "year" || test(#"\b(yearly|annually|every year)\b"#, text) {
            add(firstMatch(#"\b(yearly|annually|every year)\b"#, text)); return ("FREQ=YEARLY\(iv)", spans)
        }
        if unit == "month" || test(#"\b(monthly|every month)\b"#, text) {
            add(firstMatch(#"\b(monthly|every month)\b"#, text)); return ("FREQ=MONTHLY\(iv)", spans)
        }

        let recurringCtx = firstMatch(#"\b(every other|bi-?weekly|fortnightly)\b"#, text) != nil
            || everyN != nil || test(#"\bevery\b"#, text) || test(#"\bweekly\b"#, text)
        var days: [String] = []; var seen = Set<String>()
        for w in allMatches(#"\b(sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday)(s)?\b"#, text) {
            let plural = w.groups[2] != nil
            if !recurringCtx && !plural { continue }   // a lone weekday is a date (findDay)
            let code = byday[weekdays[(w.groups[1] ?? "").lowercased()] ?? 0]
            spans.append(span(w))
            if !seen.contains(code) { seen.insert(code); days.append(code) }
        }
        if !days.isEmpty { return ("FREQ=WEEKLY\(iv);BYDAY=\(days.joined(separator: ","))", spans) }

        if unit == "week" || test(#"\b(weekly|every week)\b"#, text) {
            add(firstMatch(#"\b(weekly|every week)\b"#, text))
            return ("FREQ=WEEKLY\(iv);BYDAY=\(byday[startWeekday])", spans)
        }
        return (nil, spans)
    }

    // MARK: time

    private static func findTime(_ text: NSString) -> TimeHit? {
        if let m = firstMatch(#"\b(noon|midnight)\b"#, text) {
            let noon = (m.groups[1] ?? "").lowercased() == "noon"
            return TimeHit(h: noon ? 12 : 0, m: 0, label: noon ? "12:00 PM" : "12:00 AM", span: span(m))
        }
        if let m = firstMatch(#"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b"#, text) {
            var h = (Int(m.groups[1] ?? "") ?? 0) % 12
            if (m.groups[3] ?? "").lowercased() == "pm" { h += 12 }
            let min = Int(m.groups[2] ?? "") ?? 0
            return TimeHit(h: h, m: min, label: fmtTime(h, min), span: span(m))
        }
        if let m = firstMatch(#"\bat\s+(\d{1,2})(?::(\d{2}))?\b"#, text) {
            var h = Int(m.groups[1] ?? "") ?? 0
            let min = Int(m.groups[2] ?? "") ?? 0
            if h < 7 && m.groups[2] == nil { h += 12 }   // "at 4" almost always the afternoon
            if h > 23 || min > 59 { return nil }
            return TimeHit(h: h, m: min, label: fmtTime(h, min), span: span(m))
        }
        return nil
    }

    private static func fmtTime(_ h: Int, _ m: Int) -> String {
        let ap = h < 12 ? "AM" : "PM"
        let h12 = h % 12 == 0 ? 12 : h % 12
        return "\(h12):\(String(format: "%02d", m)) \(ap)"
    }

    // MARK: person

    private static func findPerson(_ text: NSString, _ persons: [String]) -> (name: String, span: Span)? {
        for p in persons {
            let esc = NSRegularExpression.escapedPattern(for: p)
            if let m = firstMatch("\\bfor\\s+\(esc)\\b", text) { return (p, span(m)) }
        }
        for p in persons {
            let esc = NSRegularExpression.escapedPattern(for: p)
            if let m = firstMatch("\\b\(esc)(?:['\u{2019}]s)?\\b", text) { return (p, span(m)) }
        }
        return nil
    }

    // MARK: cut / tidy

    private static func cut(_ text: NSString, _ spans: [Span]) -> NSString {
        let sorted = spans.sorted { $0.start > $1.start }
        var out = text
        for s in sorted {
            guard s.start <= out.length else { continue }
            let before = out.substring(to: min(s.start, out.length))
            let after = out.substring(from: min(s.end, out.length))
            out = (before + " " + after) as NSString
        }
        return out
    }

    private static func tidy(_ s: NSString) -> String {
        var out = s
        out = replaceFirst(#"^\s*(?:\b(?:at|on|for|the|a|an|to)\b\s*)+"#, out, "")
        out = replaceAll(#"\s{2,}"#, out, " ")
        out = replaceAll(#"^[\s,.–-]+|[\s,.!?–-]+$"#, out, "")
        return (out as String).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: grocery / list patterns

    private static let groceryVerb = #"^\s*(add|buy|get|grab|need|pick up|picking up|purchase)\b"#
    private static let groceryToList = #"\bto\s+(the\s+)?(grocery\s+|shopping\s+)?list\b"#
    private static let groceryUnit = #"\b\d+\s?(lb|lbs|oz|ozs|g|kg|gal|gallon|gallons|dozen|bunch|bunches|can|cans|box|boxes|bag|bags|bottle|bottles|pack|packs|jar|jars|loaf|loaves|carton|cartons)\b"#
    private static let taskSignal = #"^\s*(remind|remember to|todo|to-do|task)\b"#
    private static let choreWord = #"\bchore\b"#

    private static func splitQuantity(_ s: String) -> (quantity: String?, name: String) {
        let ns = s as NSString
        if let m = firstMatch(#"^\s*(\d+(?:\.\d+)?\s?(?:lb|lbs|oz|ozs|g|kg|gal|gallon|gallons|dozen|bunch|bunches|can|cans|box|boxes|bag|bags|bottle|bottles|pack|packs|jar|jars|loaf|loaves|carton|cartons)?|a\s+dozen|a\s+couple)\b"#, ns) {
            let rest = ns.substring(from: min(m.range.location + m.range.length, ns.length))
            let name = replaceFirst(#"^\s*(of\s+)?"#, rest as NSString, "") as String
            let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedName.isEmpty {
                let q = (m.groups[1] ?? "").trimmingCharacters(in: .whitespaces)
                let qClean = replaceFirst(#"^a\s+"#, q as NSString, "") as String
                return (qClean, trimmedName)
            }
        }
        return (nil, s.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private static func matchKnownList(_ text: NSString, _ lists: [String]) -> String? {
        func norm(_ s: String) -> String {
            var out = s.lowercased() as NSString
            out = replaceAll(#"[^a-z0-9 ]"#, out, " ")
            out = replaceAll(#"\b(the|a|an|my|our|list|to|for)\b"#, out, " ")
            out = replaceAll(#"\s+"#, out, " ")
            return (out as String).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let ttoks = Set(norm(text as String).split(separator: " ").map(String.init))
        var best: (name: String, score: Double)?
        for l in lists {
            let ltoks = norm(l).split(separator: " ").map(String.init)
            if ltoks.isEmpty { continue }
            let inter = ltoks.filter { ttoks.contains($0) }.count
            let score = Double(inter) / Double(ltoks.count)
            if score >= 0.6 && (best == nil || score > best!.score) { best = (l, score) }
        }
        return best?.name
    }

    // MARK: countdown

    // A future day to count down to, with NO clock time. Triggers: "N days until X",
    // "X in N days", "countdown to X [on <date>]", "N sleeps until X". A clock time
    // means it's a scheduled event, so we bail then. Mirrors `detectCountdown` in parse.ts.
    private static func ymdLocal(_ d: Date, _ cal: Calendar) -> String {
        String(format: "%04d-%02d-%02d", cal.component(.year, from: d), cal.component(.month, from: d), cal.component(.day, from: d))
    }
    private static func countdownWhen(_ target: Date, _ now: Date, _ cal: Calendar) -> String {
        let days = Int((startOfDay(target, cal).timeIntervalSince(startOfDay(now, cal)) / 86_400).rounded())
        let rel = days <= 0 ? "Today" : (days == 1 ? "Tomorrow" : "\(days) days")
        return "\(fmt(target, "EEE, MMM d", cal)) · \(rel)"
    }

    // MARK: holidays

    // Resolve a known holiday name to its NEXT occurrence on/after startOfDay(now).
    // KEEP IN SYNC with the web `findHoliday` and the server `resolveDayFromText`.
    private struct HolidayHit { var date: Date; var label: String; var span: Span }

    private static func nthWeekdayOfMonth(_ year: Int, _ month: Int, _ targetDow: Int, _ n: Int, _ cal: Calendar) -> Date {
        let first = ymd(year, month - 1, 1, cal)
        let firstDow = weekday0(first, cal)
        let offset = (targetDow - firstDow + 7) % 7
        return ymd(year, month - 1, 1 + offset + (n - 1) * 7, cal)
    }
    private static func lastWeekdayOfMonth(_ year: Int, _ month: Int, _ targetDow: Int, _ cal: Calendar) -> Date {
        // Day 0 of the next month = the last day of this one.
        let last = ymd(year, month, 0, cal)
        let lastDow = weekday0(last, cal)
        let lastDay = cal.component(.day, from: last)
        let offset = (lastDow - targetDow + 7) % 7
        return ymd(year, month - 1, lastDay - offset, cal)
    }
    private static func easterSunday(_ year: Int, _ cal: Calendar) -> Date {
        // Anonymous Gregorian algorithm (Computus).
        let a = year % 19
        let b = year / 100
        let c = year % 100
        let d = b / 4
        let e = b % 4
        let f = (b + 8) / 25
        let g = (b - f + 1) / 3
        let h = (19 * a + b - d - g + 15) % 30
        let i = c / 4
        let k = c % 4
        let l = (32 + 2 * e + 2 * i - h - k) % 7
        let m = (a + 11 * h + 22 * l) / 451
        let month = (h + l - 7 * m + 114) / 31 // 3=Mar, 4=Apr
        let day = ((h + l - 7 * m + 114) % 31) + 1
        return ymd(year, month - 1, day, cal)
    }

    private struct HolidayDef { let re: String; let label: String; let calc: (Int, Calendar) -> Date }
    private static let holidays: [HolidayDef] = [
        HolidayDef(re: #"\bnew\s+year'?s?\s+eve\b"#, label: "New Year's Eve") { y, c in ymd(y, 11, 31, c) },
        HolidayDef(re: #"\bnew\s+year'?s?(?:\s+day)?\b"#, label: "New Year's Day") { y, c in ymd(y, 0, 1, c) },
        HolidayDef(re: #"\bvalentine'?s?(?:\s+day)?\b"#, label: "Valentine's Day") { y, c in ymd(y, 1, 14, c) },
        HolidayDef(re: #"\bst\.?\s+patrick'?s?(?:\s+day)?\b"#, label: "St. Patrick's Day") { y, c in ymd(y, 2, 17, c) },
        HolidayDef(re: #"\bcinco\s+de\s+mayo\b"#, label: "Cinco de Mayo") { y, c in ymd(y, 4, 5, c) },
        HolidayDef(re: #"\bjuneteenth\b"#, label: "Juneteenth") { y, c in ymd(y, 5, 19, c) },
        HolidayDef(re: #"\b(?:independence\s+day|july\s+4th|july\s+4|4th\s+of\s+july|fourth\s+of\s+july)\b"#, label: "Independence Day") { y, c in ymd(y, 6, 4, c) },
        HolidayDef(re: #"\bhalloween\b"#, label: "Halloween") { y, c in ymd(y, 9, 31, c) },
        HolidayDef(re: #"\bveterans'?\s+day\b"#, label: "Veterans Day") { y, c in ymd(y, 10, 11, c) },
        HolidayDef(re: #"\bchristmas\s+eve\b"#, label: "Christmas Eve") { y, c in ymd(y, 11, 24, c) },
        HolidayDef(re: #"\b(?:christmas|xmas)\b"#, label: "Christmas") { y, c in ymd(y, 11, 25, c) },
        HolidayDef(re: #"\bmlk(?:\s+day)?\b|\bmartin\s+luther\s+king(?:\s+jr\.?)?(?:\s+day)?\b"#, label: "MLK Day") { y, c in nthWeekdayOfMonth(y, 1, 1, 3, c) },
        HolidayDef(re: #"\bpresidents'?\s+day\b"#, label: "Presidents' Day") { y, c in nthWeekdayOfMonth(y, 2, 1, 3, c) },
        HolidayDef(re: #"\bmother'?s?\s+day\b"#, label: "Mother's Day") { y, c in nthWeekdayOfMonth(y, 5, 0, 2, c) },
        HolidayDef(re: #"\bmemorial\s+day\b"#, label: "Memorial Day") { y, c in lastWeekdayOfMonth(y, 5, 1, c) },
        HolidayDef(re: #"\bfather'?s?\s+day\b"#, label: "Father's Day") { y, c in nthWeekdayOfMonth(y, 6, 0, 3, c) },
        HolidayDef(re: #"\blabor\s+day\b"#, label: "Labor Day") { y, c in nthWeekdayOfMonth(y, 9, 1, 1, c) },
        HolidayDef(re: #"\bthanksgiving\b"#, label: "Thanksgiving") { y, c in nthWeekdayOfMonth(y, 11, 4, 4, c) },
        HolidayDef(re: #"\bgood\s+friday\b"#, label: "Good Friday") { y, c in addDays(easterSunday(y, c), -2, c) },
        HolidayDef(re: #"\beaster\b"#, label: "Easter") { y, c in easterSunday(y, c) },
    ]

    private static func findHoliday(_ text: NSString, _ now: Date, _ cal: Calendar) -> HolidayHit? {
        let base = startOfDay(now, cal)
        let nowYear = cal.component(.year, from: now)
        var best: HolidayHit?
        for h in holidays {
            guard let m = firstMatch(h.re, text) else { continue }
            var date = h.calc(nowYear, cal)
            if startOfDay(date, cal) < base { date = h.calc(nowYear + 1, cal) }
            let sp = span(m)
            // Earliest match in the text wins (and, at equal starts, the earlier
            // list entry — so "Christmas Eve" beats "Christmas").
            if best == nil || sp.start < best!.span.start {
                best = HolidayHit(date: date, label: h.label, span: sp)
            }
        }
        return best
    }
    private static func detectCountdown(_ text: NSString, _ now: Date, _ cal: Calendar) -> CaptureIntent? {
        if findTime(text) != nil { return nil }   // a clock time → schedule an event instead
        var titleRaw: String?
        var target: Date?

        if let m = firstMatch(#"^\s*(\d{1,3})\s+(?:days?|sleeps?)\s+(?:until|til|till|to|before)\s+(.+)$"#, text) {
            target = addDays(startOfDay(now, cal), Int(m.groups[1] ?? "") ?? 0, cal); titleRaw = m.groups[2]
        }
        if titleRaw == nil, let m = firstMatch(#"^(.+?)\s+in\s+(\d{1,3})\s+(?:days?|sleeps?)\s*$"#, text) {
            target = addDays(startOfDay(now, cal), Int(m.groups[2] ?? "") ?? 0, cal); titleRaw = m.groups[1]
        }
        if titleRaw == nil, let m = firstMatch(#"\bcountdown\s+(?:to|until|til|till|for)\s+(.+)$"#, text) {
            titleRaw = m.groups[1]
            // "countdown to X on <date>" — pull an explicit day out of the tail.
            if let raw = titleRaw, let dh = findDay(raw as NSString, now, cal) {
                target = ymd(dh.y, dh.mo, dh.d, cal)
                let stripped = cut(raw as NSString, [dh.span])
                titleRaw = replaceFirst(#"\b(?:on|to)\s*$"#, stripped, "") as String
            } else if let raw = titleRaw, let hh = findHoliday(raw as NSString, now, cal) {
                // No explicit day — try a holiday name ("countdown for thanksgiving").
                target = hh.date
                let remaining = tidy(cut(raw as NSString, [hh.span]))
                titleRaw = remaining.isEmpty ? hh.label : remaining
            }
        }
        guard let tRaw = titleRaw, let t = target else { return nil }
        let title = titleCase(tidy(tRaw as NSString))
        return .countdown(title: title.isEmpty ? "Countdown" : title, date: ymdLocal(t, cal),
                          emoji: nil, whenLabel: countdownWhen(t, now, cal))
    }

    // MARK: person

    // Add a new household member. Triggers: "add my son/daughter/… <name>", "add a
    // family member <name>", "create a profile for <name>". MINIMAL heuristic (plan §5):
    // name + memberType + safe defaults; the LLM upgrade fills avatarEmoji/birthday/isAdmin.
    // Mirrors `detectPerson` in parse.ts.
    private static let relKid = "son|daughter|kid|child|boy|girl|baby"
    private static let relTeen = "teenager|teen"
    private static let relAdult = "husband|wife|spouse|partner|mom|mum|mommy|mother|dad|daddy|father|parent|adult|grandma|grandpa|grandmother|grandfather"

    private static func memberTypeForRel(_ word: String) -> String {
        let w = word.lowercased() as NSString
        if test("^(?:\(relKid))$", w) { return "kid" }
        if test("^(?:\(relTeen))$", w) { return "teen" }
        return "adult"
    }
    // Drop a trailing ", age 8" / "aged 8" (age maps to nothing today — no birthday).
    private static func cleanPersonName(_ raw: String) -> String {
        let noAge = replaceFirst(#"[\s,]+(?:who\s+is\s+|aged?\s+)\d{1,3}\b.*$"#, raw as NSString, "")
        return titleCase(tidy(noAge))
    }
    private static func detectPerson(_ text: NSString) -> CaptureIntent? {
        if findTime(text) != nil { return nil }   // a clock time → scheduling, not a profile
        let relPat = "\\b(?:add|create|make|register)\\s+(?:my|our|a|an|the)?\\s*(?:new\\s+)?(\(relKid)|\(relTeen)|\(relAdult))\\b[\\s,:-]*(?:named\\s+|called\\s+)?(.+)$"
        if let m = firstMatch(relPat, text) {
            let name = cleanPersonName(m.groups[2] ?? "")
            if !name.isEmpty {
                return .person(name: name, memberType: memberTypeForRel(m.groups[1] ?? ""),
                               avatarEmoji: nil, birthday: nil, isAdmin: false)
            }
        }
        let memPat = "\\b(?:add|create|make|register)\\s+(?:a\\s+|an\\s+|the\\s+|my\\s+|our\\s+)?(?:new\\s+)?(?:family\\s+member|household\\s+member|family\\s+profile|profile|person|member)\\b\\s*(?:for\\s+|named\\s+|called\\s+|[:-]\\s*)?(.+)$"
        if let m = firstMatch(memPat, text) {
            let name = cleanPersonName(m.groups[1] ?? "")
            if !name.isEmpty {
                return .person(name: name, memberType: "adult", avatarEmoji: nil, birthday: nil, isAdmin: false)
            }
        }
        return nil
    }

    // MARK: parse

    static func parse(_ raw: String, persons: [String] = [], now: Date = Date(),
                      cal: Calendar = .current, lists: [String] = []) -> CaptureIntent? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let text = trimmed as NSString

        let person = findPerson(text, persons)

        // PERSON — "add my son Max" / "add a family member Jane". A specific create phrase,
        // so it wins over the generic grocery/event fallbacks. Minimal: name + memberType.
        if let personIntent = detectPerson(text) { return personIntent }

        // TASK / CHORE — an explicit keyword wins over the date heuristics.
        if test(taskSignal, text) || test(choreWord, text) {
            let quote = firstMatch("[\"\u{201C}]([^\"\u{201D}]+)[\"\u{201D}]", text)
            let rest: NSString
            if let q = quote {
                rest = (text.substring(to: q.range.location) + " " + text.substring(from: q.range.location + q.range.length)) as NSString
            } else { rest = text }

            let wd = findAllWeekdays(rest)
            let dailyRe = #"\b(every\s*day|everyday|daily|each\s*day)\b"#
            var rrule: String?
            var scheduleLabel = ""
            if test(dailyRe, rest) {
                rrule = "FREQ=DAILY"; scheduleLabel = "Every day"
            } else if !wd.codes.isEmpty {
                rrule = "FREQ=WEEKLY;BYDAY=\(wd.codes.joined(separator: ","))"
                scheduleLabel = wd.labels.joined(separator: " & ")
            }
            let starM = firstMatch(#"\b(\d{1,2})\s*stars?\b"#, rest)
            let stars = starM.flatMap { Int($0.groups[1] ?? "") }
            let personHit = findPerson(rest, persons)

            let title: String
            if let q = quote {
                let inner = replaceAll(#"\s{2,}"#, replaceFirst(#"\s+as\s+an?\s+(chores?|tasks?)\b"#, (q.groups[1] ?? "") as NSString, ""), " ")
                title = titleCase((inner as String).trimmingCharacters(in: .whitespacesAndNewlines))
                let finalTitle = title.isEmpty ? "Task" : title
                return .task(title: finalTitle, personName: personHit?.name, stars: stars, rrule: rrule, scheduleLabel: scheduleLabel)
            } else {
                var spans: [Span] = []
                if let p = personHit { spans.append(p.span) }
                spans.append(contentsOf: wd.spans)
                if let sm = starM { spans.append(span(sm)) }
                var t = cut(rest, spans)
                t = replaceFirst(#"\bto\s+(?:the\s+)?(?:chores?|tasks?|grocery|shopping|to-?do)?\s*lists?\b.*$"#, t, "")
                t = replaceFirst(#"^\s*(?:please\s+|kindly\s+)?(?:add|make|create|set\s*up|give|new|put|remind\w*|remember\s+to)\b"#, t, "")
                t = replaceFirst(#"^\s*(?:an?\s+)?(?:chores?|tasks?)\b[:\s]+(?:to\s+|for\s+)?"#, t, "")
                t = replaceFirst(#"^\s*to\s+"#, t, "")
                t = replaceFirst(dailyRe, t, "")
                t = replaceAll(#"\b(night|nights|evening|evenings|morning|mornings|tonight)\b"#, t, "")
                t = replaceAll(#"\b(?:every|each|worth|and)\b"#, t, "")
                t = replaceAll(#"\s*,\s*"#, t, " ")
                t = replaceAll(#"\b(?:for|on|to|with)\s+(?=\s|$)"#, t, " ")
                t = replaceFirst(#"\b(?:for|on|to|with)\s*$"#, t, "")
                let tt = titleCase(tidy(t))
                return .task(title: tt.isEmpty ? "Task" : tt, personName: personHit?.name, stars: stars, rrule: rrule, scheduleLabel: scheduleLabel)
            }
        }

        // MEAL — "meal plan" phrasing, or "<dish> for dinner/lunch" (no clock time).
        let mealPhrase = test(#"\b(meal\s*plan|on the menu|dinner menu)\b"#, text)
        let forMeal = firstMatch(#"\bfor\s+(dinner|lunch|breakfast|supper|brunch)\b"#, text)
        let eatOut = test(#"\b(eat|eating|dining|going)\s*out\b|\btake\s*-?out\b|\border(?:ing)?\s+in\b|\bdelivery\b|\btakeaway\b"#, text)
        if mealPhrase || ((forMeal != nil || eatOut) && findTime(text) == nil) {
            let mealType = mealTypeFrom(forMeal?.groups[1])
            let mDay = findDay(text, now, cal)
            let date = mDay.map { String(format: "%04d-%02d-%02d", $0.y, $0.mo + 1, $0.d) }
            if eatOut {
                return .meal(title: "Eating out", date: date, mealType: mealType,
                             whenLabel: "\(mDay?.label ?? "Today") · \(cap(mealType))")
            }
            var spans: [Span] = []
            if let md = mDay { spans.append(md.span) }
            if let fm = forMeal { spans.append(span(fm)) }
            var t = cut(text, spans)
            t = replaceAll(#"\b(?:on|to|onto|in)\s+(?:the\s+)?(?:meal\s*plan|menu|dinner menu)\b"#, t, "")
            t = replaceAll(#"\b(?:meal\s*plan|on the menu|dinner menu)\b"#, t, "")
            t = replaceFirst(#"^\s*(?:please\s+|kindly\s+|let'?s?\s+|can we\s+|i\s+want\s+(?:to\s+)?)?(?:put|add|plan|make|do|have|cook|throw|schedule)\b"#, t, "")
            t = replaceAll(#"\b(?:please|kindly)\b"#, t, "")
            let title = titleCase(tidy(t))
            return .meal(title: title.isEmpty ? "Meal" : title, date: date, mealType: mealType,
                         whenLabel: "\(mDay?.label ?? "Today") · \(cap(mealType))")
        }

        // LIST — a non-grocery named list.
        var listName = matchKnownList(text, lists)
        if listName == nil, let g = firstMatch(#"\b(?:to|on|onto|in)\s+(?:the\s+|my\s+|our\s+)?([a-z0-9][a-z0-9 ]*?)\s+list\b"#, text) {
            let name = (g.groups[1] ?? "").trimmingCharacters(in: .whitespaces)
            if !test(#"^(grocery|shopping|to-?do)\s*$"#, name as NSString) { listName = titleCase(name) }
        }
        if let listName {
            let im = firstMatch(#"^\s*(?:please\s+|kindly\s+|can you\s+)?(?:add|put|throw|toss|drop|need|get|grab)?\s*(.+?)\s+(?:to|on|onto|in)\s+(?:the\s+|my\s+|our\s+)?"#, text)
            let basis = tidy((im?.groups[1] ?? (text as String)) as NSString)
            let (quantity, name) = splitQuantity(basis)
            let itemName = titleCase(name)
            if !itemName.isEmpty { return .list(itemName: itemName, listName: listName, quantity: quantity) }
        }

        // COUNTDOWN — a day marker ("12 days until Disney"). Before the event branch so
        // an explicit "countdown to X on <date>" isn't swallowed as a plain dated event.
        if let countdown = detectCountdown(text, now, cal) { return countdown }

        let day = findDay(text, now, cal)
        let time = findTime(text)
        let startWeekday = day.map { weekday0(ymd($0.y, $0.mo, $0.d, cal), cal) } ?? weekday0(now, cal)
        let rec = detectEventRecurrence(text, startWeekday)

        // EVENT — a concrete day/time, or a recurrence cue.
        if day != nil || time != nil || rec.rrule != nil {
            var target: Date
            if let d = day { target = ymd(d.y, d.mo, d.d, cal) }
            else if let rrule = rec.rrule {
                let base = startOfDay(now, cal)
                if let bd = firstMatch(#"FREQ=WEEKLY.*BYDAY=([A-Z]{2})"#, rrule as NSString, ci: false) {
                    let idx = byday.firstIndex(of: bd.groups[1] ?? "") ?? 0
                    let delta = (idx - weekday0(base, cal) + 7) % 7
                    target = addDays(base, delta, cal)
                } else { target = base }
            } else { target = startOfDay(now, cal) }

            var allDay = true
            if let t = time {
                target = ymd(cal.component(.year, from: target), cal.component(.month, from: target) - 1,
                             cal.component(.day, from: target), h: t.h, min: t.m, cal)
                allDay = false
            } else if day?.eveningHint == true {
                target = ymd(cal.component(.year, from: target), cal.component(.month, from: target) - 1,
                             cal.component(.day, from: target), h: 18, min: 0, cal)
                allDay = false
            }

            var spans: [Span] = []
            if let d = day { spans.append(d.span) }
            if let t = time { spans.append(t.span) }
            if let p = person { spans.append(p.span) }
            spans.append(contentsOf: rec.spans)
            var titleRaw = cut(text, spans)
            if rec.rrule != nil { titleRaw = replaceAll(#"\b(every|each|other|and|on)\b"#, titleRaw, " ") }
            titleRaw = replaceFirst(#"^\s*(?:please\s+|kindly\s+)?(?:add|create|schedule|set\s*up|put|new|make)\b"#, titleRaw, "")
            titleRaw = replaceAll(#"\b(?:to|on|in)\s+(?:the\s+|my\s+|our\s+)?calendar\b"#, titleRaw, "")
            let title = titleCase(tidy(titleRaw))
            let dayLabel = day?.label ?? fmt(target, "EEE, MMM d", cal)
            let timePart = allDay ? "All day" : (time?.label ?? (day?.eveningHint == true ? "6:00 PM" : ""))
            let whenLabel = [dayLabel, timePart].filter { !$0.isEmpty }.joined(separator: " · ")
            let scheduleLabel = rec.rrule != nil ? Recurrence.describeRrule(rec.rrule, start: target, cal) : ""
            return .event(title: title.isEmpty ? "Event" : title, startsAt: isoUTC(target), allDay: allDay,
                          personName: person?.name, rrule: rec.rrule, scheduleLabel: scheduleLabel, whenLabel: whenLabel)
        }

        // GROCERY — verbs, "to the list", units, or the bare-noun fallback.
        var stripped = cut(text, person.map { [$0.span] } ?? [])
        stripped = replaceFirst(groceryVerb, stripped, "")
        stripped = replaceFirst(groceryToList, stripped, "")
        let (quantity, name) = splitQuantity((stripped as String).trimmingCharacters(in: .whitespacesAndNewlines))
        let finalName = titleCase(replaceAll(#"^[\s,]+|[\s,]+$"#, name as NSString, "") as String)
        if finalName.isEmpty { return nil }
        return .grocery(name: finalName, quantity: quantity)
    }

    /// Whether the on-device guess is strong enough to show. Every kind requires an
    /// explicit signal EXCEPT the bare-noun grocery fallback (a last resort).
    static func looksConfident(_ intent: CaptureIntent?, text: String) -> Bool {
        guard let intent else { return false }
        if case .grocery = intent {
            let ns = text as NSString
            return test(#"\b(buy|grab|pick(?:ing)?\s*up|purchase)\b"#, ns)
                || test(groceryToList, ns) || test(groceryUnit, ns)
        }
        return true
    }
}
