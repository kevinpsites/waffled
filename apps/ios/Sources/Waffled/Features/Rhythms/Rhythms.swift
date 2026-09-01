import Foundation
import Observation

/// Rhythms — the things that should keep happening, and the one place to confirm they
/// actually will. See `docs/product/rhythms-plan.md`.
///
/// Two shapes, and the difference is what closes out a period:
///
///   `.completion` — you did the thing. The clock restarts from when you ACTUALLY did it,
///                   so being late shifts the next one instead of stacking misses.
///   `.scheduling` — a calendar event exists for the period. We never ask whether it
///                   happened; getting the opportunity onto the calendar IS the outcome.
///
/// That second sentence is the whole line between a rhythm and a goal, and it is a **copy
/// rule** as much as a data one: nothing here says "streak", "completed" or "on track" for
/// a scheduling rhythm. The question is "did this get scheduled?", not "did you do it?".
///
/// Everything is REST (`WaffledAPI.rhythms*`) — the table is deliberately off PowerSync in
/// v1; the events a booking creates sync as usual. Mirrors the web
/// `apps/web/src/lib/api/rhythms.ts` + `Rhythms.tsx`.

// MARK: - Rendering Postgres intervals & status lines

/// `interval::text` comes back in Postgres shorthand ("3 mons", "3 days 12:00:00"), which
/// is not something to put in front of a person. Pure + `nonisolated` so the model can
/// precompute every line once per load — per `apps/ios/CLAUDE.md`, date math must never
/// live in a view body.
/// One band of the register, and the order they appear in.
struct RhythmBand: Identifiable {
    let urgency: RhythmFormat.Urgency
    let title: String
    let hint: String
    let rhythms: [WaffledAPI.Rhythm]
    var id: String { title }

    static let order: [(urgency: RhythmFormat.Urgency, title: String, hint: String)] = [
        (.now, "Needs you now", "late, or the window is closing"),
        (.soon, "Coming up", "the next two weeks"),
        (.steady, "Steady", "nothing to do yet"),
    ]
}

enum RhythmFormat {
    struct Parts: Equatable {
        var year = 0, month = 0, week = 0, day = 0, hour = 0, minute = 0
    }

    /// Tokenize Postgres interval text. Hand-rolled rather than regex-driven: the input is
    /// a short, fixed vocabulary and this runs per row on every load.
    static func parts(_ text: String) -> Parts {
        var p = Parts()
        var pending: Int?
        for raw in text.split(whereSeparator: { $0 == " " || $0 == "\t" }) {
            let token = String(raw)
            // The HH:MM:SS tail Postgres appends for a sub-day remainder ("3 days 12:00:00",
            // which is what a 14-day runway on a weekly rhythm gets clamped to).
            if token.contains(":") {
                let clock = token.split(separator: ":")
                if clock.count >= 2, let h = Int(clock[0]), let m = Int(clock[1]) {
                    p.hour += h
                    p.minute += m
                }
                continue
            }
            if let n = Int(token) { pending = n; continue }
            guard let n = pending else { continue }
            let unit = token.lowercased()
            if unit.hasPrefix("year") || unit.hasPrefix("yr") { p.year += n }
            else if unit.hasPrefix("mon") { p.month += n }
            else if unit.hasPrefix("week") { p.week += n }
            else if unit.hasPrefix("day") { p.day += n }
            else if unit.hasPrefix("hour") || unit.hasPrefix("hr") { p.hour += n }
            else if unit.hasPrefix("min") { p.minute += n }
            pending = nil
        }
        return p
    }

    static func plural(_ n: Int, _ unit: String) -> String {
        "\(n) \(unit)\(abs(n) == 1 ? "" : "s")"
    }

    /// "3 mons" → "3 months"; "7 days" → "1 week"; "3 days 12:00:00" → "3 days 12 hours".
    static func formatInterval(_ text: String) -> String {
        let p = parts(text)
        var out: [String] = []
        if p.year != 0 { out.append(plural(p.year, "year")) }
        if p.month != 0 { out.append(plural(p.month, "month")) }
        // Whole weeks read better than "14 days"; a remainder stays in days.
        var weeks = p.week
        var days = p.day
        if days != 0, days % 7 == 0 {
            weeks += days / 7
            days = 0
        }
        if weeks != 0 { out.append(plural(weeks, "week")) }
        if days != 0 { out.append(plural(days, "day")) }
        if p.hour != 0 { out.append(plural(p.hour, "hour")) }
        if p.minute != 0 { out.append(plural(p.minute, "minute")) }
        return out.joined(separator: " ")
    }

    /// "7 days" → "every week"; "3 mons" → "every 3 months".
    static func cadenceLabel(_ every: String) -> String {
        let text = formatInterval(every)
        if text.isEmpty { return "" }
        // A single "1 <unit>" reads as "every week", not "every 1 week".
        let words = text.split(separator: " ")
        if words.count == 2, words[0] == "1" { return "every \(words[1])" }
        return "every \(text)"
    }

    /// Whole calendar days between two moments, on the viewer's clock.
    static func dayDiff(_ target: Date, _ now: Date, _ calendar: Calendar) -> Int {
        calendar.dateComponents([.day], from: calendar.startOfDay(for: now),
                                to: calendar.startOfDay(for: target)).day ?? 0
    }

    /// The completion shape's status line. Overdue is stated plainly — this is a register,
    /// not a scorecard, so there is no "missed" and no "broken".
    static func dueLabel(_ dueAt: String, overdue: Bool, now: Date = Date(),
                         calendar: Calendar = Cal.current) -> String {
        guard let target = EventTime.parse(dueAt) else { return overdue ? "overdue" : "due" }
        let days = dayDiff(target, now, calendar)
        // "late", matching the register's countdown, rather than "overdue" — the two
        // surfaces describe the same rhythm and should not use two words for it.
        if overdue || days < 0 { return "\(plural(max(1, -days), "day")) late" }
        if days == 0 { return "due today" }
        if days == 1 { return "due tomorrow" }
        return "in \(plural(days, "day"))"
    }

    /// The scheduling shape's status line. Deliberately about the booking window closing —
    /// never about following through, which is the question a rhythm does not ask.
    static func periodLabel(_ periodEnd: String, now: Date = Date(),
                            calendar: Calendar = Cal.current) -> String {
        guard let target = DateFmt.date(periodEnd, "yyyy-MM-dd", calendar.timeZone) else { return "" }
        let days = dayDiff(target, now, calendar)
        if days < 0 { return "this period has ended" }
        if days == 0 { return "this period ends today" }
        return "\(plural(days, "day")) left to book it"
    }

    /// The last day a booking still lands inside the period. `periodEnd` is the exclusive
    /// next boundary, so a booking on that date satisfies the NEXT period.
    static func lastDayOfPeriod(_ periodEnd: String, calendar: Calendar = Cal.current) -> String {
        guard let end = DateFmt.date(periodEnd, "yyyy-MM-dd", calendar.timeZone),
              let last = calendar.date(byAdding: .day, value: -1, to: end) else { return periodEnd }
        return DateFmt.string(last, "yyyy-MM-dd", calendar.timeZone)
    }

    /// Whether a completion rhythm was already done today, on the VIEWER's clock.
    ///
    /// This is what lets a row acknowledge a tap. Completing something already completed
    /// today recomputes "Last done <date> · Next due <date>" to the byte-identical string,
    /// so without this the button is indistinguishable from a dead one — which is exactly
    /// how it was read, and how one air-filter change came to be logged four times.
    static func wasCompletedToday(_ iso: String?, now: Date = Date(),
                                  calendar: Calendar = Cal.current) -> Bool {
        guard let iso, let done = EventTime.parse(iso) else { return false }
        return calendar.isDate(done, inSameDayAs: now)
    }

    /// The completion row's action label. Three states, three labels — sharing one is what
    /// made the tap invisible. Note there is still no scoreboard language here: "done
    /// today" is a statement about this row right now, not a record being kept.
    static func completionAction(doneToday: Bool, due: Bool) -> String {
        if doneToday { return "Done today ✓" }
        // First person throughout, matching the sentence the rhythm was made with
        // ("counted when I mark it done") and the web register's own verb. "Mark done"
        // was the system telling you to do something; these are you telling it.
        return due ? "I did it" : "I did it today"
    }

    /// What the nudge runway will ACTUALLY be, once the server has had it.
    ///
    /// It is stored as `least(leadTime, every / 2)` — a warning window longer than the
    /// cycle never closes, so the item would nag forever and get learned as noise. The
    /// form showed the number that was typed, so a weekly rhythm asked for 14 days'
    /// notice, quietly got 3, and nothing on screen explained the difference.
    static func nudgePlan(every: String, leadDays: Int) -> (effectiveDays: Int, capped: Bool) {
        let asked = max(0, leadDays)
        let half = days(fromInterval: every) / 2
        // An unreadable cadence gives no cap to apply — echoing the request beats
        // inventing a clamp out of a number we couldn't parse.
        guard half > 0 else { return (asked, false) }
        return (min(asked, half), asked > half)
    }

    /// One cadence on from `from`, through `Calendar` rather than by hand: adding a month
    /// to January 31 has to land on February 28, and rolling the month over on a date whose
    /// day is still 31 spills into March instead — a monthly rhythm whose first period
    /// begins in the month after the one it belongs to.
    static func addCadence(from: Date, every: String, calendar: Calendar = Cal.current) -> Date {
        let p = parts(every)
        var move = DateComponents()
        move.year = p.year
        move.month = p.month
        move.day = p.week * 7 + p.day
        // A cadence we couldn't read moves nothing, rather than inventing a date from a
        // string we failed to parse.
        guard p.year != 0 || p.month != 0 || p.week != 0 || p.day != 0 else { return from }
        return calendar.date(byAdding: move, to: from) ?? from
    }

    /// What a sentence will actually do, in the two dates that are the whole promise.
    struct Consequence {
        /// The day the first period comes due.
        let landsOn: Date
        /// The first day it starts asking — `landsOn` minus the runway the server will keep.
        let nudgeFrom: Date
        /// Whether that runway is shorter than the one that was asked for.
        let capped: Bool
    }

    /// Both dates go through `nudgePlan`, never through the typed runway. The server stores
    /// `least(leadTime, every / 2)`, so a weekly rhythm asked for 14 days' notice would
    /// otherwise be promised a nudge on a day nothing is ever going to happen.
    static func consequence(shape: WaffledAPI.RhythmShape, every: String, leadDays: Int,
                            anchor: Date, calendar: Calendar = Cal.current) -> Consequence? {
        let plan = nudgePlan(every: every, leadDays: leadDays)
        // A booking rhythm's anchor is where the period grid STARTS, so its first window
        // closes one cadence later. A completion rhythm's anchor is the due date itself —
        // the cadence has already been added to reach it, and adding it twice would
        // promise a day a whole cycle too far out.
        let landsOn = shape == .scheduling
            ? addCadence(from: anchor, every: every, calendar: calendar)
            : anchor
        guard let nudgeFrom = calendar.date(byAdding: .day, value: -plan.effectiveDays, to: landsOn)
        else { return nil }
        return Consequence(landsOn: landsOn, nudgeFrom: nudgeFrom, capped: plan.capped)
    }

    /// How far "push it out" moves a due date. A week — long enough to be worth pressing.
    static let pushDays = 7

    /// The new due date for "push it out a week", or nil when there is nothing to push.
    ///
    /// Counted from **today or the due date, whichever is later**, and both halves matter:
    ///
    ///  - From today when it is late. An oil change six days overdue, pushed "a week" from
    ///    its own due date, would come back tomorrow — a control that reads as a week and
    ///    delivers a day is worse than no control at all.
    ///  - From the due date when it has not arrived. Something due in three days should
    ///    move to ten days out rather than resetting to seven, so the rhythm keeps the
    ///    shape of its own schedule instead of being re-anchored to whenever a button
    ///    happened to be pressed.
    ///
    /// One period's reprieve either way: marking it done re-anchors the clock from when
    /// you actually did it, so the push is forgotten rather than compounding.
    static func pushOut(_ nextDueAt: String?, now: Date = Date(),
                        calendar: Calendar = Cal.current) -> Date? {
        guard let nextDueAt, let due = moment(nextDueAt, calendar) else { return nil }
        return calendar.date(byAdding: .day, value: pushDays, to: max(due, now))
    }

    /// The clamp, admitted next to the promise it modifies — or nil when nothing was
    /// trimmed, because a form explaining a clamp that didn't happen is how the old
    /// default came to teach the wrong thing.
    ///
    /// Both numbers appear together on purpose: the whole failure was a field showing 14
    /// and a server delivering 3, with the two never once in the same sentence.
    static func capNote(every: String, leadDays: Int) -> String? {
        let plan = nudgePlan(every: every, leadDays: leadDays)
        guard plan.capped else { return nil }
        let window = cadenceLabel(every).replacingOccurrences(of: "every ", with: "a ")
        return "\(plural(max(0, leadDays), "day"))’ notice won’t fit in \(window), so it’s trimmed"
            + " to \(plan.effectiveDays) — a runway longer than the cycle never goes quiet."
    }

    /// "November 19" — inside a sentence, where the year is noise.
    static func dayMonth(_ date: Date, calendar: Calendar = Cal.current) -> String {
        DateFmt.localizedString(date, "MMMM d", calendar.timeZone)
    }

    /// The runway in a sentence, naming the window it counts back from. "…before the
    /// period ends" assumed you knew what the period was, which was fairly answered with
    /// "what period? I'm scheduling it every week". For a scheduling rhythm the period IS
    /// one cadence: each is a fresh window to get it booked, and the runway is its tail.
    static func nudgeExplainer(every: String, leadDays: Int) -> String {
        let plan = nudgePlan(every: every, leadDays: leadDays)
        let window = cadenceLabel(every).isEmpty ? "every period" : cadenceLabel(every)
        let tail = plan.effectiveDays <= 0
            ? "on its last day"
            : "for the last \(plural(plan.effectiveDays, "day")) of it"
        var line = "A fresh window to book it opens \(window). You’ll be nudged \(tail), and only while nothing’s on the calendar for it"
        if plan.capped {
            line += " (\(plural(max(0, leadDays), "day")) won’t fit in \(window.replacingOccurrences(of: "every ", with: "a ")), so it’s trimmed to half the cycle — a runway longer than the cycle never goes quiet)"
        }
        return line + "."
    }

    // MARK: - banding by when, not by kind

    /// How far ahead "Coming up" looks, in days.
    ///
    /// A flat fortnight, deliberately, rather than something derived from each rhythm's own
    /// runway. The runway governs *nudging* — when a rhythm has earned the right to
    /// interrupt you — and that is exactly what "Needs you now" already reads. This band
    /// answers a different question, asked by someone who deliberately opened the page:
    /// what is on the horizon. Deriving it per-rhythm would file a quarterly rhythm's
    /// 45-day warning and a weekly one's 3-day warning under one heading and call both
    /// "coming up", which is not a horizon anyone could read.
    static let comingUpDays = 14

    enum Urgency: Hashable { case now, soon, steady, paused }

    /// A calendar date (`yyyy-MM-dd`) reads as local midnight; an instant stands as it is.
    static func moment(_ value: String, _ calendar: Calendar) -> Date? {
        value.count == 10 ? DateFmt.date(value, "yyyy-MM-dd", calendar.timeZone) : EventTime.parse(value)
    }

    /// Whole days until the thing this rhythm is counting towards — its due date, or the
    /// day its booking window closes. Negative means it has already gone past.
    static func daysToGo(_ r: WaffledAPI.Rhythm, now: Date = Date(),
                         calendar: Calendar = Cal.current) -> Int? {
        let target = r.satisfiedBy == .scheduling ? r.currentPeriodEnd : r.nextDueAt
        guard let target, let date = moment(target, calendar) else { return nil }
        return dayDiff(date, now, calendar)
    }

    /// Which band a rhythm belongs in.
    ///
    /// "Needs you now" is the server's own `/attention` list and nothing else — never a
    /// second opinion computed here. The Today card reads that same list, so the two
    /// surfaces cannot disagree about one rhythm. The single local addition is an overdue
    /// date: `satisfied` is `next_due_at > now()`, so a late rhythm is genuinely
    /// unsatisfied and must not go quiet merely because a second request is in flight.
    static func urgency(_ r: WaffledAPI.Rhythm, attention: WaffledAPI.RhythmAttentionItem?,
                        now: Date = Date(), calendar: Calendar = Cal.current) -> Urgency {
        if !r.isActive { return .paused }
        if attention != nil { return .now }
        if r.satisfiedBy == .scheduling, r.satisfied == true { return .steady }
        guard let days = daysToGo(r, now: now, calendar: calendar) else { return .steady }
        if days < 0 { return .now }
        return days <= comingUpDays ? .soon : .steady
    }

    struct Countdown: Equatable {
        /// How the countdown is painted. Carried rather than re-derived from `unit`: that
        /// read "late" out of the copy, so a booking window closing tomorrow — the entire
        /// reason it is in Needs you now — came out in plain ink because "1 day left" has
        /// no such word in it. Its band already knows.
        enum Tone: Equatable { case late, near, soft, done }
        let number: String
        let unit: String
        let tone: Tone
    }

    /// When the booking is, for the line under "Booked".
    ///
    /// The point of carrying `bookedAt` at all — it was used only to tell a booking from a
    /// skip, so a settled row said "Booked · this period" and you had to open the calendar
    /// to find out when. An all-day booking is stored at local midnight, so printing its
    /// time would show "12:00 AM", an hour nobody chose; `bookedAllDay` is what says to
    /// stop at the date. An unparseable instant falls back to the old wording rather than
    /// printing something broken.
    static func bookedWhen(_ bookedAt: String, allDay: Bool, calendar: Calendar) -> String {
        guard let d = EventTime.parse(bookedAt) else { return "this period" }
        // Month and day, no year: a booking sits inside the current period, so the year is
        // noise on a line meant to be read from across a room. (shortDate carries it,
        // which is right where it is used — for a last-done date that may be years back.)
        let date = DateFmt.localizedString(d, "MMM d", calendar.timeZone)
        return allDay ? date : "\(date), \(EventTime.timeLabel(d, calendar.timeZone))"
    }

    /// The row's anchor — the one thing worth reading from across a kitchen.
    ///
    /// Days collapse into weeks and then months past a fortnight: "97 days" is a number
    /// nobody converts on the way past a kiosk, and the point of this line is the size of
    /// the wait rather than its exact length.
    static func countdown(_ r: WaffledAPI.Rhythm, urgency: Urgency, now: Date = Date(),
                          calendar: Calendar = Cal.current) -> Countdown? {
        if r.satisfiedBy == .scheduling, r.satisfied == true {
            // Settled, but not necessarily booked: a skip settles a period and has no
            // time, so saying "Booked" there claims the very calendar entry that skipping
            // exists to avoid inventing.
            guard let at = r.bookedAt else {
                return Countdown(number: "Skipped", unit: "this period", tone: .done)
            }
            return Countdown(number: "Booked",
                             unit: bookedWhen(at, allDay: r.bookedAllDay ?? false, calendar: calendar),
                             tone: .done)
        }
        guard let days = daysToGo(r, now: now, calendar: calendar) else { return nil }
        let tone: Countdown.Tone = urgency == .now ? .late : (urgency == .soon ? .near : .soft)
        if r.satisfiedBy == .scheduling {
            if days <= 0 { return Countdown(number: "Today", unit: "last day", tone: tone) }
            return Countdown(number: "\(days)", unit: days == 1 ? "day left" : "days left", tone: tone)
        }
        if days < 0 {
            let late = -days
            return Countdown(number: "\(late)", unit: late == 1 ? "day late" : "days late", tone: tone)
        }
        if days == 0 { return Countdown(number: "Today", unit: "due", tone: tone) }
        if days <= 13 { return Countdown(number: "\(days)", unit: days == 1 ? "day" : "days", tone: tone) }
        if days < 60 {
            let weeks = Int((Double(days) / 7).rounded())
            return Countdown(number: "\(weeks)", unit: weeks == 1 ? "week" : "weeks", tone: tone)
        }
        let months = Int((Double(days) / 30).rounded())
        return Countdown(number: "\(months)", unit: months == 1 ? "month" : "months", tone: tone)
    }

    /// How much of the current cycle is already spent, 0–100, or nil when there is no
    /// window to measure. A backdated completion later than the next due date inverts the
    /// window, and a rhythm with no due date has none at all; drawing either as a full or
    /// an empty bar would be inventing a fact.
    static func periodProgress(_ r: WaffledAPI.Rhythm, now: Date = Date(),
                               calendar: Calendar = Cal.current) -> Int? {
        var start: Date
        var end: Date
        if r.satisfiedBy == .scheduling {
            guard let s = r.currentPeriodStart, let e = r.currentPeriodEnd,
                  let sd = moment(s, calendar), let ed = moment(e, calendar) else { return nil }
            start = sd
            end = ed
        } else {
            guard let due = r.nextDueAt, let ed = moment(due, calendar) else { return nil }
            end = ed
            if let last = r.lastCompletedAt, let ld = moment(last, calendar) {
                start = ld
            } else {
                // No completion yet, so assume one whole cadence behind the due date. The
                // approximation is invisible at three points of bar height.
                start = ed.addingTimeInterval(-Double(days(fromInterval: r.every)) * 86400)
            }
        }
        let total = end.timeIntervalSince(start)
        guard total > 0 else { return nil }
        let spent = now.timeIntervalSince(start) / total * 100
        return max(0, min(100, Int(spent.rounded())))
    }

    /// Whole days in a Postgres interval — the cadence's length for the clamp above, and
    /// the runway the editor seeds its day field from. One definition on purpose: there
    /// were two, and only this one carried the `HH:MM:SS` tail into days, so a 24h+ tail
    /// seeded a 0-day runway. They agreed on everything the server writes today, which is
    /// the kind of agreement that stops being true quietly.
    static func days(fromInterval text: String) -> Int {
        let p = parts(text)
        return p.year * 365 + p.month * 30 + p.week * 7 + p.day + p.hour / 24
    }

    /// A friendly "May 20, 2026" for a stored instant or date, "—" when there isn't one.
    static func shortDate(_ iso: String?, calendar: Calendar = Cal.current) -> String {
        guard let iso, !iso.isEmpty else { return "—" }
        let date = iso.count == 10
            ? DateFmt.date(iso, "yyyy-MM-dd", calendar.timeZone)
            : EventTime.parse(iso)
        guard let date else { return "—" }
        return DateFmt.localizedString(date, "MMM d, yyyy", calendar.timeZone)
    }

    static func ymd(_ date: Date, calendar: Calendar = Cal.current) -> String {
        DateFmt.string(date, "yyyy-MM-dd", calendar.timeZone)
    }

    /// "every 3 months" → "Every 3 months". Only the first character; the rest of the line
    /// keeps its own casing.
    static func sentence(_ text: String) -> String {
        guard let first = text.first else { return text }
        return String(first).uppercased() + text.dropFirst()
    }

    /// One shared ISO8601 formatter — `ISO8601DateFormatter` is expensive to build, and an
    /// explicit instant is what every write here sends (never a local wall-clock string).
    private static let iso = ISO8601DateFormatter()
    static func isoInstant(_ date: Date) -> String { iso.string(from: date) }
}

// MARK: - Attention ordering

enum RhythmAttention {
    /// Overdue first — it's the only thing here that's already slipped — then the merely
    /// due, then the things that need booking. Ties break by title so the order is stable
    /// across loads rather than reshuffling on every refresh.
    static func rank(_ item: WaffledAPI.RhythmAttentionItem) -> Int {
        switch item.kind {
        case .due: return (item.overdue ?? false) ? 0 : 1
        case .unscheduled: return 2
        // Never reached — loadAttention drops these — but a total switch is what keeps a
        // future third kind a compile error here rather than a crash there.
        case .unknown: return 3
        }
    }

    static func sorted(_ items: [WaffledAPI.RhythmAttentionItem]) -> [WaffledAPI.RhythmAttentionItem] {
        items.sorted { a, b in
            let (ra, rb) = (rank(a), rank(b))
            if ra != rb { return ra < rb }
            return a.rhythm.title.localizedCaseInsensitiveCompare(b.rhythm.title) == .orderedAscending
        }
    }
}

// MARK: - The model

/// The one model behind both rhythm surfaces: the Today card (`loadAttention`) and the
/// register (`loadAll`). Dependencies are injected closures so the logic is testable
/// without a server — the same shape `FamilyNightModel` uses.
@MainActor
@Observable
final class RhythmsModel {
    typealias FetchAttention = (_ from: String, _ to: String) async throws -> [WaffledAPI.RhythmAttentionItem]
    typealias FetchRhythms = () async throws -> [WaffledAPI.Rhythm]
    /// `completedAt` is nil for "now" — the server stamps it — and an explicit instant
    /// when a completion is being logged for a day that has already passed.
    typealias Complete = (_ id: String, _ completedAt: String?) async throws -> Void
    typealias Skip = (_ id: String, _ periodStart: String) async throws -> Void
    typealias Book = (_ id: String, _ startsAt: String, _ allDay: Bool, _ periodStart: String?) async throws -> Void
    /// Create when `id` is nil, otherwise PATCH.
    typealias Save = (_ id: String?, _ body: [String: JSONValue]) async throws -> Void
    typealias Remove = (_ id: String) async throws -> Void

    private(set) var attention: [WaffledAPI.RhythmAttentionItem] = []
    private(set) var rhythms: [WaffledAPI.Rhythm] = []
    /// True once an attention fetch has completed — a failed one keeps the prior rows
    /// (never blank a card that had data) but still counts, so nothing sits on "Loading…".
    private(set) var loaded = false
    private(set) var listLoaded = false
    private(set) var listFailed = false
    /// Precomputed per load, keyed by rhythm id: the attention row's one-line status.
    private(set) var statusLines: [String: String] = [:]
    /// Precomputed per load: the register row's "where this stands" line.
    private(set) var detailLines: [String: String] = [:]
    /// The register grouped by when rather than by kind, precomputed for the same reason
    /// the lines above are: this is date math, and a view body is not where it belongs.
    private(set) var bands: [RhythmBand] = []
    private(set) var paused: [WaffledAPI.Rhythm] = []
    private(set) var countdowns: [String: RhythmFormat.Countdown] = [:]
    private(set) var progress: [String: Int] = [:]
    /// Person id → name, supplied by the view from the household it already has. The
    /// register's subtitle names whose rhythm it is, and that name lives outside this
    /// endpoint's payload.
    var personNames: [String: String] = [:] { didSet { if listLoaded { regroup() } } }

    private let fetchAttention: FetchAttention
    private let fetchRhythms: FetchRhythms
    private let complete: Complete
    private let skip: Skip
    private let book: Book
    private let save: Save
    private let remove: Remove
    private let now: () -> Date

    init(
        fetchAttention: @escaping FetchAttention = { from, to in
            try await WaffledAPI().rhythmAttention(from: from, to: to)
        },
        fetchRhythms: @escaping FetchRhythms = { try await WaffledAPI().rhythms() },
        complete: @escaping Complete = { id, completedAt in
            _ = try await WaffledAPI().completeRhythm(id: id, completedAt: completedAt)
        },
        skip: @escaping Skip = { id, periodStart in
            try await WaffledAPI().skipRhythmPeriod(id: id, periodStart: periodStart)
        },
        book: @escaping Book = { id, startsAt, allDay, periodStart in
            _ = try await WaffledAPI().scheduleRhythm(id: id, startsAt: startsAt, allDay: allDay,
                                                      periodStart: periodStart)
        },
        save: @escaping Save = { id, body in
            if let id { _ = try await WaffledAPI().updateRhythm(id: id, body) }
            else { _ = try await WaffledAPI().createRhythm(body) }
        },
        remove: @escaping Remove = { id in try await WaffledAPI().deleteRhythm(id: id) },
        now: @escaping () -> Date = { Date() }
    ) {
        self.fetchAttention = fetchAttention
        self.fetchRhythms = fetchRhythms
        self.complete = complete
        self.skip = skip
        self.book = book
        self.save = save
        self.remove = remove
        self.now = now
    }

    // MARK: loads

    /// What needs attention today. The window is deliberately ONE day on every surface:
    /// `to` doubles as the date that decides which period a scheduling rhythm reports on,
    /// so a wider window would answer about a later period.
    func loadAttention() async {
        let today = RhythmFormat.ymd(now())
        if let items = try? await fetchAttention(today, today) {
            // A kind this build has no words for is dropped rather than drawn: every
            // switch downstream would need a placeholder branch that says nothing useful,
            // and a row with no verb is worse than a row that isn't there. Dropping ONE is
            // the whole point — a strict enum used to throw away the entire response.
            attention = RhythmAttention.sorted(items.filter { $0.kind != .unknown })
            statusLines = Self.statusLines(for: attention, now: now())
        }
        loaded = true
        // Banding reads BOTH lists — "Needs you now" is the attention list itself — so it
        // has to be redone whenever either arrives, in whichever order they do.
        regroup()
    }

    /// Reload the register. A failure keeps whatever was already on screen — a dropped
    /// connection is not a reason to blank rows that are still true — but it is ALWAYS
    /// reported, including after an earlier success.
    ///
    /// It used to only be reported on the very first load, which made every later failure
    /// indistinguishable from an empty household: switch the Rhythms module off and the
    /// next fetch 403s, so a register full of rhythms redrew itself as the "Nothing here
    /// yet" onboarding copy. "You have no rhythms" is a claim about the household, and a
    /// failed request is no evidence for it.
    func loadAll() async {
        do {
            rhythms = try await fetchRhythms()
            listFailed = false
        } catch {
            listFailed = true
        }
        listLoaded = true
        regroup()
    }

    /// Reload whichever surfaces are actually on screen — a Today card that never listed
    /// the register shouldn't fetch it, and vice versa.
    private func refresh() async {
        if loaded { await loadAttention() }
        if listLoaded { await loadAll() }
    }

    // MARK: grouping — by WHEN, not by kind
    //
    // The register used to be two sections named after the two shapes, which sorts a
    // household's rhythms by a distinction only the schema cares about. Asked "what do I
    // owe this week", you had to read both and merge them yourself. The shapes don't
    // disappear — they survive in each row's own words ("last done Aug 19" vs "not on the
    // calendar yet") and in its verb, which is where the difference bears on what you do.

    private func regroup() {
        let clock = now()
        // Derived here rather than in `loadAll` so it is rebuilt whenever anything it
        // reads changes — including the member names, which arrive from the view on their
        // own schedule and after the rhythms as often as before them.
        detailLines = Self.detailLines(for: rhythms, names: personNames, now: clock)
        var grouped: [RhythmFormat.Urgency: [WaffledAPI.Rhythm]] = [:]
        var cds: [String: RhythmFormat.Countdown] = [:]
        var bars: [String: Int] = [:]
        for r in rhythms {
            let band = RhythmFormat.urgency(r, attention: attentionItem(for: r), now: clock)
            grouped[band, default: []].append(r)
            if let cd = RhythmFormat.countdown(r, urgency: band, now: clock) { cds[r.id] = cd }
            if let bar = RhythmFormat.periodProgress(r, now: clock) { bars[r.id] = bar }
        }
        // Soonest first inside each band, so the top of the page is always the thing most
        // worth the next minute. A rhythm with no date sorts last rather than first.
        for key in grouped.keys {
            grouped[key]?.sort {
                (RhythmFormat.daysToGo($0, now: clock) ?? Int.max)
                    < (RhythmFormat.daysToGo($1, now: clock) ?? Int.max)
            }
        }
        bands = RhythmBand.order.compactMap { spec in
            guard let rows = grouped[spec.urgency], !rows.isEmpty else { return nil }
            return RhythmBand(urgency: spec.urgency, title: spec.title, hint: spec.hint, rhythms: rows)
        }
        // Paused rhythms are NAMED rather than counted — "2 paused" alone makes you open
        // it to find out which, every single time.
        paused = (grouped[.paused] ?? []).sorted { $0.title < $1.title }
        countdowns = cds
        progress = bars
    }

    /// The attention row for a rhythm, when it has one — lets the register show the same
    /// "book it / skip it" affordances the Today card does.
    ///
    /// Takes the rhythm rather than its id so it can check `isActive`. A paused rhythm is
    /// already absent from /attention, but pausing happens locally and the register keeps
    /// the last list it fetched — so in the window before the refetch, a paused row could
    /// still find its old item and offer to book it. The server would accept that booking,
    /// which is exactly why the control must not be there. The web register guards the
    /// same way.
    func attentionItem(for rhythm: WaffledAPI.Rhythm) -> WaffledAPI.RhythmAttentionItem? {
        guard rhythm.isActive else { return nil }
        return attention.first { $0.rhythm.id == rhythm.id }
    }

    // MARK: mutations (each throws so the caller can surface a failure in place)

    /// Mark it done. `on` backdates the completion — the completion shape's clock restarts
    /// from when you ACTUALLY did it, so "I changed the filter last Tuesday" has to be
    /// sayable or being late silently re-anchors everything to today and the register's
    /// one useful fact ("last changed on…") becomes a guess.
    func markDone(_ id: String, on date: Date? = nil) async throws {
        try await complete(id, date.map(RhythmFormat.isoInstant))
        await refresh()
    }

    func skipPeriod(_ item: WaffledAPI.RhythmAttentionItem) async throws {
        guard let periodStart = item.periodStart else { return }
        try await skip(item.rhythm.id, periodStart)
        await refresh()
    }

    func book(id: String, startsAt: Date, allDay: Bool, periodStart: String? = nil) async throws {
        // An explicit instant. Handing a local wall-clock string through would leave the
        // timezone to the server and could put a boundary booking in the wrong period.
        try await book(id, RhythmFormat.isoInstant(startsAt), allDay, periodStart)
        await refresh()
    }

    /// Pause / resume. Reversible, unlike `delete` — a paused rhythm stops surfacing but
    /// keeps its history and can be switched back on.
    func setActive(id: String, isActive: Bool) async throws {
        try await save(id, ["isActive": .bool(isActive)])
        await refresh()
    }

    /// "It's asking and I can't do it today." Moves the clock without claiming the thing
    /// was done — a completion would restart the cadence from today and quietly erase the
    /// fact that it is still outstanding.
    func pushOut(_ rhythm: WaffledAPI.Rhythm) async throws {
        guard let moved = RhythmFormat.pushOut(rhythm.nextDueAt, now: now()) else { return }
        try await save(rhythm.id, ["nextDueAt": .string(RhythmFormat.isoInstant(moved))])
        await refresh()
    }

    func save(_ form: RhythmForm) async throws {
        try await save(form.editingId, form.editingId == nil ? form.createBody() : form.patchBody())
        await refresh()
    }

    func delete(id: String) async throws {
        try await remove(id)
        await refresh()
    }

    // MARK: precomputation

    static func statusLines(for items: [WaffledAPI.RhythmAttentionItem], now: Date,
                            calendar: Calendar = Cal.current) -> [String: String] {
        var out: [String: String] = [:]
        for item in items {
            switch item.kind {
            case .due:
                out[item.rhythm.id] = RhythmFormat.dueLabel(item.dueAt ?? "", overdue: item.overdue ?? false,
                                                            now: now, calendar: calendar)
            case .unscheduled:
                out[item.rhythm.id] = RhythmFormat.periodLabel(item.periodEnd ?? "", now: now, calendar: calendar)
            case .unknown:
                continue
            }
        }
        return out
    }

    /// The register row's subtitle: **the cadence first**, then where this one stands.
    ///
    /// It used to lead with the state and end with the window — "Not on the calendar yet ·
    /// 1 day left to book it" — which spent the row's one spare line restating the
    /// countdown already sitting at its right edge in the largest type on screen. The
    /// cadence is the thing that countdown cannot say, and the thing that makes a row a
    /// rhythm rather than a task, so it goes first and the deadline is left where it
    /// already reads.
    ///
    /// `names` maps person id → name; an id with no name simply doesn't appear, which is
    /// the right answer while the member list is still loading.
    static func detailLines(for rhythms: [WaffledAPI.Rhythm], names: [String: String] = [:],
                            now: Date, calendar: Calendar = Cal.current) -> [String: String] {
        var out: [String: String] = [:]
        for r in rhythms {
            var parts = [RhythmFormat.sentence(RhythmFormat.cadenceLabel(r.every))]
            if !r.isActive {
                // A paused rhythm says only that it is paused. Its period state is still
                // computed, but nothing nudges about it and nothing can be done with it —
                // so "not on the calendar yet" would be a complaint about a situation we
                // have deliberately stopped caring about.
                parts.append("paused")
            } else {
                switch r.satisfiedBy {
                // A shape this build has no words for: say the cadence and stop, rather
                // than guessing at a sentence for something we don't understand.
                case .unknown:
                    break
                case .completion:
                    // "Last done —" was a row saying nothing with a punctuation mark.
                    parts.append(r.lastCompletedAt == nil
                                 ? "never done"
                                 : "last done \(RhythmFormat.shortDate(r.lastCompletedAt, calendar: calendar))")
                case .scheduling:
                    // Never "last done" — whether it happened is deliberately not tracked.
                    // The only question is whether this period has something booked.
                    //
                    // No current period means the grid hasn't started: the server tiles
                    // periods from `startsOn` up to now, so a rhythm anchored in the future
                    // has none yet. "Not on the calendar yet" there was flatly wrong for an
                    // auto-scheduled rhythm whose series was booked the moment it was made.
                    if r.currentPeriodStart == nil, let start = r.startsOn {
                        parts.append("periods start \(RhythmFormat.shortDate(start, calendar: calendar))")
                    } else if r.satisfied ?? false {
                        // Two ways to be settled, and only one of them is the calendar.
                        if let at = r.bookedAt {
                            parts.append("on the calendar for "
                                         + RhythmFormat.bookedWhen(at, allDay: r.bookedAllDay ?? false, calendar: calendar))
                        } else {
                            parts.append("skipped this one")
                        }
                    } else if r.autoSchedule {
                        // Two ways a self-booking rhythm comes up empty, and they are not
                        // the same problem. A live series missing ONE period is missing one
                        // event, exactly like a hand-booked row is — so it gets the same
                        // offer, and only the sentence differs, because "yet" would blame
                        // the reader for a slot the rhythm had promised to fill itself. A
                        // series that is GONE is missing the recurrence, and saying so of a
                        // series that is alive sent people to a button that built a SECOND
                        // one beside it, doubling every future occurrence.
                        parts.append(r.hasSeries == true ? "nothing on the calendar this time"
                                                         : "the series needs putting back")
                    } else {
                        parts.append("not on the calendar yet")
                    }
                }
            }
            if let id = r.personId, let name = names[id] { parts.append(name) }
            let notes = (r.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !notes.isEmpty { parts.append(notes) }
            out[r.id] = parts.joined(separator: " · ")
        }
        return out
    }
}

// MARK: - The create / edit form

/// The state behind the new-rhythm sheet, as a plain value so the request bodies it builds
/// are testable without a view. The first thing it asks is the only thing that really
/// matters — what closes out a period — and both branches below follow from that answer.
struct RhythmForm {
    enum Unit: String, CaseIterable, Identifiable, Hashable {
        case days, weeks, months, years
        var id: String { rawValue }
        var label: String { rawValue }
        /// The `CustomUnit` the shared recurrence builder speaks.
        var recurrenceUnit: CustomUnit {
            switch self {
            case .days: return .day
            case .weeks: return .week
            case .months: return .month
            case .years: return .year
            }
        }
    }

    /// nil when creating; the rhythm's id when editing.
    let editingId: String?
    /// Fixed at creation — the server refuses to change a live rhythm's shape.
    ///
    /// Completion, matching web: the same blank form used to make two different rhythms
    /// depending on which surface you were holding. It is also the gentler default — it
    /// needs no calendar, and getting it wrong costs a tap rather than a stray event.
    var shape: WaffledAPI.RhythmShape = .completion
    var title = ""
    var emoji = ""
    var notes = ""
    var personId: String?
    var count = 1
    var unit: Unit = .weeks
    /// nil means "still following the cadence" — see `effectiveLeadDays`.
    var leadDays: Int?
    /// nil means "still following the cadence" — see `firstDue(now:calendar:)`.
    var nextDue: Date?
    var startsOn = Date()
    var autoSchedule = false
    var monthlyMode: MonthlyMode = .dayOfMonth
    /// Which weekday a weekly rhythm lands on. Empty means "follow the anchor", which is
    /// the sane default and was previously the ONLY option — so a rhythm you wanted on
    /// Wednesdays had to be anchored on a Wednesday.
    var byday: [String] = []
    /// For "the Nth <weekday> of the month": 1…5, or -1 for last. Only read when
    /// `monthlyMode == .nthWeekday`.
    var monthlyOrdinal = 1
    var customRule = ""

    init() { editingId = nil }

    /// Seed from an existing rhythm. The cadence round-trips through the same interval
    /// parser the labels use, so "7 days" comes back as "every 1 week" rather than 7 days.
    init(editing r: WaffledAPI.Rhythm, calendar: Calendar = Cal.current) {
        editingId = r.id
        shape = r.satisfiedBy
        title = r.title
        emoji = r.emoji ?? ""
        notes = r.notes ?? ""
        personId = r.personId
        (count, unit) = Self.cadence(from: r.every)
        // Whole days: a clamped "3 days 12:00:00" reads as 3 rather than "3.5" — the field
        // is a day count and the server re-clamps on every write. Shared with the nudge
        // copy's cap rather than defined twice; the two spellings differed on a 24h+ tail.
        leadDays = RhythmFormat.days(fromInterval: r.leadTime)
        autoSchedule = r.autoSchedule
        customRule = r.rrule ?? ""
        if let due = r.nextDueAt, let d = EventTime.parse(due) { nextDue = d }
        if let start = r.startsOn, let d = DateFmt.date(start, "yyyy-MM-dd", calendar.timeZone) { startsOn = d }
    }

    var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    var isValid: Bool { !trimmedTitle.isEmpty }
    var every: String { "\(max(1, count)) \(unit.rawValue)" }

    /// The runway to actually send, in days.
    ///
    /// A flat 14 is wrong for most cadences: the server keeps `least(leadTime, every / 2)`,
    /// so on anything up to a fortnight it trims what it was given. An untouched form
    /// therefore opened already promising a nudge on a day nothing happens, and explaining
    /// a clamp nobody had asked for. Follow the cadence until a number is actually typed —
    /// and then send that one, clamp and all, because the field is an escape hatch and the
    /// copy beside it says what the server will do with it.
    var effectiveLeadDays: Int {
        if let leadDays { return max(0, leadDays) }
        return min(14, RhythmFormat.days(fromInterval: every) / 2)
    }

    /// The day the first period comes due.
    ///
    /// One full cadence out, not today. Anchoring a new rhythm at today makes "every 3
    /// months" mean "and the first one is overdue right now", so everything anyone creates
    /// arrives already shouting from Needs you now. Still an open field under More options:
    /// adding something you are already behind on is a real case.
    func firstDue(now: Date = Date(), calendar: Calendar = Cal.current) -> Date {
        nextDue ?? RhythmFormat.addCadence(from: now, every: every, calendar: calendar)
    }

    /// The rule is DERIVED from the cadence rather than asked for again: an rrule that
    /// disagreed with `every` would put the generated event outside the period it is
    /// supposed to satisfy. `customRule` is the escape hatch, not the normal path.
    func rrule(calendar: Calendar = Cal.current) -> String? {
        Recurrence.buildRrule(
            RepeatState(freq: .custom, byday: byday, interval: max(1, count),
                        unit: unit.recurrenceUnit, monthlyMode: monthlyMode,
                        monthlyOrdinal: monthlyOrdinal, custom: customRule),
            start: startsOn, calendar)
    }

    func createBody(now: Date = Date(), calendar: Calendar = Cal.current) -> [String: JSONValue] {
        var body: [String: JSONValue] = [
            "title": .string(trimmedTitle),
            "emoji": emoji.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(emoji.trimmingCharacters(in: .whitespaces)),
            "notes": notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string(notes.trimmingCharacters(in: .whitespacesAndNewlines)),
            "personId": personId.map(JSONValue.string) ?? .null,
            "satisfiedBy": .string(shape.rawValue),
            "every": .string(every),
            "leadTime": .string("\(effectiveLeadDays) days"),
        ]
        // A completion rhythm has no period grid and a scheduling one has no due date; the
        // server's shape constraint rejects a row carrying both.
        switch shape {
        case .completion:
            // 09:00 on the day, not the instant the sheet happened to be open. A due date
            // is a day; the hour it carries shouldn't be whatever o'clock someone tapped +.
            let day = calendar.startOfDay(for: firstDue(now: now, calendar: calendar))
            body["nextDueAt"] = .string(RhythmFormat.isoInstant(
                calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day))
        case .scheduling:
            body["startsOn"] = .string(RhythmFormat.ymd(startsOn, calendar: calendar))
            body["autoSchedule"] = .bool(autoSchedule)
            body["rrule"] = autoSchedule ? (rrule(calendar: calendar).map(JSONValue.string) ?? .null) : .null
        // Not reachable: `shape` is chosen in this form, never decoded from the server.
        // Total anyway, so a third shape has to be handled here rather than compiling.
        case .unknown:
            break
        }
        return body
    }

    /// Only the fields the server allows to change in place. `satisfiedBy`, `startsOn`,
    /// `autoSchedule` and `rrule` are deliberately absent — re-anchoring a live rhythm
    /// would silently re-interpret its existing skips and point its bookings at periods
    /// that no longer exist. Retire it and make a new one.
    func patchBody() -> [String: JSONValue] {
        [
            "title": .string(trimmedTitle),
            "emoji": emoji.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(emoji.trimmingCharacters(in: .whitespaces)),
            "notes": notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .null : .string(notes.trimmingCharacters(in: .whitespacesAndNewlines)),
            "personId": personId.map(JSONValue.string) ?? .null,
            "every": .string(every),
            "leadTime": .string("\(effectiveLeadDays) days"),
        ]
    }

    /// "7 days" → (1, .weeks); "3 mons" → (3, .months).
    static func cadence(from every: String) -> (Int, Unit) {
        let p = RhythmFormat.parts(every)
        if p.year > 0 { return (p.year, .years) }
        if p.month > 0 { return (p.month, .months) }
        if p.week > 0 { return (p.week, .weeks) }
        if p.day > 0 { return p.day % 7 == 0 ? (p.day / 7, .weeks) : (p.day, .days) }
        return (1, .weeks)
    }
}
