import Foundation
import Testing
@testable import Waffled

/// Rhythms — the things that should keep happening. These lock the two rules the
/// feature turns on:
///
/// 1. **Copy.** A `scheduling` rhythm is satisfied by a calendar event existing for the
///    period; we never ask whether it happened. So its lines talk about *booking*, never
///    about streaks / completion / being "on track" — that language belongs to goals.
/// 2. **Precomputation.** Every status line is derived ONCE per load in the model
///    (`statusLines` / `detailLines`), not recomputed in a view body — the repeated
///    date-math-in-render trap called out in apps/ios/CLAUDE.md.

// MARK: - fixtures

private let utc = TimeZone(identifier: "UTC")!
private var utcCal: Calendar { Cal.gregorian(utc) }

private func at(_ text: String) -> Date {
    DateFmt.date(text, "yyyy-MM-dd'T'HH:mm:ss", utc)!
}

private func rhythm(
    id: String = "r1",
    title: String = "Air filter",
    emoji: String? = nil,
    notes: String? = nil,
    personId: String? = nil,
    satisfiedBy: WaffledAPI.RhythmShape = .completion,
    every: String = "3 mons",
    startsOn: String? = nil,
    autoSchedule: Bool = false,
    rrule: String? = nil,
    leadTime: String = "14 days",
    lastCompletedAt: String? = nil,
    nextDueAt: String? = nil,
    isActive: Bool = true,
    currentPeriodStart: String? = nil,
    currentPeriodEnd: String? = nil,
    satisfied: Bool? = nil,
    hasSeries: Bool? = nil,
    bookedAt: String? = nil
) -> WaffledAPI.Rhythm {
    WaffledAPI.Rhythm(
        id: id, title: title, emoji: emoji, notes: notes, personId: personId,
        satisfiedBy: satisfiedBy, every: every, startsOn: startsOn,
        autoSchedule: autoSchedule, rrule: rrule, leadTime: leadTime,
        lastCompletedAt: lastCompletedAt, nextDueAt: nextDueAt, isActive: isActive,
        currentPeriodStart: currentPeriodStart, currentPeriodEnd: currentPeriodEnd,
        satisfied: satisfied, hasSeries: hasSeries, bookedAt: bookedAt)
}

private func due(_ r: WaffledAPI.Rhythm, at dueAt: String, overdue: Bool) -> WaffledAPI.RhythmAttentionItem {
    WaffledAPI.RhythmAttentionItem(kind: .due, rhythm: r, dueAt: dueAt, overdue: overdue,
                                  periodStart: nil, periodEnd: nil, hasSeries: nil)
}

private func unscheduled(_ r: WaffledAPI.Rhythm, start: String, end: String,
                         hasSeries: Bool? = nil) -> WaffledAPI.RhythmAttentionItem {
    WaffledAPI.RhythmAttentionItem(kind: .unscheduled, rhythm: r, dueAt: nil, overdue: nil,
                                  periodStart: start, periodEnd: end, hasSeries: hasSeries)
}

// MARK: - interval rendering

@Suite("Rhythm interval formatting")
struct RhythmIntervalTests {
    @Test("Postgres interval shorthand becomes plain English")
    func formatsShorthand() {
        #expect(RhythmFormat.formatInterval("3 mons") == "3 months")
        #expect(RhythmFormat.formatInterval("1 mon") == "1 month")
        #expect(RhythmFormat.formatInterval("1 year") == "1 year")
        // Whole weeks read better than "14 days"; a remainder stays in days.
        #expect(RhythmFormat.formatInterval("7 days") == "1 week")
        #expect(RhythmFormat.formatInterval("14 days") == "2 weeks")
        #expect(RhythmFormat.formatInterval("10 days") == "10 days")
        #expect(RhythmFormat.formatInterval("") == "")
    }

    @Test("The HH:MM:SS tail Postgres appends for a clamped runway is rendered too")
    func formatsClockTail() {
        // A 14-day runway on a weekly rhythm comes back clamped to '3 days 12:00:00'.
        #expect(RhythmFormat.formatInterval("3 days 12:00:00") == "3 days 12 hours")
        #expect(RhythmFormat.formatInterval("12:00:00") == "12 hours")
    }

    @Test("A single unit reads as 'every week', not 'every 1 week'")
    func cadenceReadsNaturally() {
        #expect(RhythmFormat.cadenceLabel("7 days") == "every week")
        #expect(RhythmFormat.cadenceLabel("3 mons") == "every 3 months")
        #expect(RhythmFormat.cadenceLabel("1 mon") == "every month")
        #expect(RhythmFormat.cadenceLabel("") == "")
    }
}

// MARK: - status lines

@Suite("Rhythm status lines")
struct RhythmStatusLineTests {
    private let now = at("2026-08-18T12:00:00")

    @Test("The completion shape states its due date plainly — no scorecard language")
    func dueLines() {
        #expect(RhythmFormat.dueLabel("2026-08-18T09:00:00Z", overdue: false, now: now, calendar: utcCal) == "due today")
        #expect(RhythmFormat.dueLabel("2026-08-19T09:00:00Z", overdue: false, now: now, calendar: utcCal) == "due tomorrow")
        #expect(RhythmFormat.dueLabel("2026-08-23T09:00:00Z", overdue: false, now: now, calendar: utcCal) == "in 5 days")
        #expect(RhythmFormat.dueLabel("2026-08-15T09:00:00Z", overdue: true, now: now, calendar: utcCal) == "3 days late")
        // Late by a fraction of a day still reads as a day late, never "0 days".
        #expect(RhythmFormat.dueLabel("2026-08-18T09:00:00Z", overdue: true, now: now, calendar: utcCal) == "1 day late")
    }

    @Test("The scheduling shape talks about the booking window, never follow-through")
    func periodLines() {
        #expect(RhythmFormat.periodLabel("2026-08-25", now: now, calendar: utcCal) == "7 days left to book it")
        #expect(RhythmFormat.periodLabel("2026-08-18", now: now, calendar: utcCal) == "this period ends today")
        #expect(RhythmFormat.periodLabel("2026-08-10", now: now, calendar: utcCal) == "this period has ended")

        // The line between a rhythm and a goal, asserted as a copy rule.
        let banned = ["streak", "completed", "on track", "missed", "failed"]
        for text in ["2026-08-25", "2026-08-18", "2026-08-10"].map({ RhythmFormat.periodLabel($0, now: now, calendar: utcCal) }) {
            for word in banned { #expect(!text.lowercased().contains(word)) }
        }
    }

    @Test("The last day a booking still lands inside the period is the day before periodEnd")
    func lastBookableDay() {
        // periodEnd is the exclusive next boundary — booking on it satisfies the NEXT period.
        #expect(RhythmFormat.lastDayOfPeriod("2026-09-01", calendar: utcCal) == "2026-08-31")
        #expect(RhythmFormat.lastDayOfPeriod("2026-01-01", calendar: utcCal) == "2025-12-31")
    }
}

// MARK: - attention ordering

@Suite("Rhythm attention ordering")
struct RhythmAttentionSortTests {
    @Test("Overdue first, then merely due, then the things that need booking")
    func sortsByUrgency() {
        let items = [
            unscheduled(rhythm(id: "b", title: "Temple visit", satisfiedBy: .scheduling), start: "2026-08-01", end: "2026-09-01"),
            due(rhythm(id: "c", title: "Smoke alarm"), at: "2026-08-22T09:00:00Z", overdue: false),
            due(rhythm(id: "a", title: "Air filter"), at: "2026-08-15T09:00:00Z", overdue: true),
            unscheduled(rhythm(id: "d", title: "A self-care day", satisfiedBy: .scheduling), start: "2026-08-01", end: "2026-09-01"),
        ]
        // …and inside the booking rank, alphabetically: "A self-care day" before "Temple visit".
        #expect(RhythmAttention.sorted(items).map(\.rhythm.id) == ["a", "c", "d", "b"])
    }

    @Test("Ties inside a rank break alphabetically so the order is stable across loads")
    func breaksTiesByTitle() {
        let items = [
            due(rhythm(id: "z", title: "Zed"), at: "2026-08-22T09:00:00Z", overdue: false),
            due(rhythm(id: "a", title: "Apple"), at: "2026-08-22T09:00:00Z", overdue: false),
        ]
        #expect(RhythmAttention.sorted(items).map(\.rhythm.id) == ["a", "z"])
    }
}

// MARK: - decoding (the server contract, verbatim)

@Suite("Rhythm decoding")
struct RhythmDecodingTests {
    private func decode<T: Decodable>(_ json: String, as: T.Type) throws -> T {
        try WaffledAPI.decoder.decode(T.self, from: Data(json.utf8))
    }

    @Test("An attention payload decodes both kinds off the one route")
    func decodesAttention() throws {
        let json = """
        { "items": [
          { "kind": "due",
            "rhythm": { "id": "r1", "title": "Air filter", "emoji": null, "notes": null,
                        "personId": null, "satisfiedBy": "completion", "every": "3 mons",
                        "startsOn": null, "autoSchedule": false, "rrule": null,
                        "leadTime": "14 days", "lastCompletedAt": null,
                        "nextDueAt": "2026-08-20T09:00:00.000Z", "isActive": true },
            "dueAt": "2026-08-20T09:00:00.000Z", "overdue": false },
          { "kind": "unscheduled",
            "rhythm": { "id": "r2", "title": "Temple visit", "emoji": "🛕", "notes": "Bring flowers",
                        "personId": "p1", "satisfiedBy": "scheduling", "every": "3 mons",
                        "startsOn": "2026-01-01", "autoSchedule": false, "rrule": null,
                        "leadTime": "14 days", "lastCompletedAt": null, "nextDueAt": null,
                        "isActive": true },
            "periodStart": "2026-07-01", "periodEnd": "2026-10-01" }
        ] }
        """
        struct Resp: Decodable { let items: [WaffledAPI.RhythmAttentionItem] }
        let items = try decode(json, as: Resp.self).items
        #expect(items.count == 2)
        #expect(items[0].kind == .due)
        #expect(items[0].overdue == false)
        #expect(items[1].kind == .unscheduled)
        #expect(items[1].periodEnd == "2026-10-01")
        #expect(items[1].rhythm.emoji == "🛕")
    }

    @Test("The list route's per-period extras decode, and their absence elsewhere doesn't fail")
    func decodesPeriodExtras() throws {
        struct Resp: Decodable { let rhythms: [WaffledAPI.Rhythm] }
        let json = """
        { "rhythms": [
          { "id": "r2", "title": "Temple visit", "emoji": null, "notes": null, "personId": null,
            "satisfiedBy": "scheduling", "every": "3 mons", "startsOn": "2026-01-01",
            "autoSchedule": false, "rrule": null, "leadTime": "14 days",
            "lastCompletedAt": null, "nextDueAt": null, "isActive": true,
            "currentPeriodStart": "2026-07-01", "currentPeriodEnd": "2026-10-01", "satisfied": true }
        ] }
        """
        let list = try decode(json, as: Resp.self).rhythms
        #expect(list[0].currentPeriodEnd == "2026-10-01")
        #expect(list[0].satisfied == true)

        // A single-row read (POST/PATCH) omits them entirely — a strict decode here is
        // exactly how the kiosk-claim bug shipped, so it's pinned.
        struct One: Decodable { let rhythm: WaffledAPI.Rhythm }
        let single = """
        { "rhythm": { "id": "r1", "title": "Air filter", "emoji": null, "notes": null,
                      "personId": null, "satisfiedBy": "completion", "every": "3 mons",
                      "startsOn": null, "autoSchedule": false, "rrule": null,
                      "leadTime": "14 days", "lastCompletedAt": null, "nextDueAt": null,
                      "isActive": true } }
        """
        #expect(try decode(single, as: One.self).rhythm.satisfied == nil)
    }
}

// MARK: - the model

private enum RhythmFeedError: Error { case rejected }

@MainActor
private final class RhythmFeed {
    var attention: [WaffledAPI.RhythmAttentionItem]
    var all: [WaffledAPI.Rhythm]
    var attentionFails = false
    var mutationFails = false
    var attentionLoads = 0
    var listLoads = 0
    var completed: [String] = []
    /// nil = "now, server-stamped"; a string = a backdated completion.
    var completedAt: [String?] = []
    var skipped: [(id: String, periodStart: String)] = []
    var booked: [(id: String, startsAt: String, allDay: Bool, periodStart: String?)] = []
    var deleted: [String] = []
    var saved: [(id: String?, body: [String: JSONValue])] = []

    init(attention: [WaffledAPI.RhythmAttentionItem] = [], all: [WaffledAPI.Rhythm] = []) {
        self.attention = attention
        self.all = all
    }

    func model(now: Date = at("2026-08-18T12:00:00")) -> RhythmsModel {
        RhythmsModel(
            fetchAttention: { _, _ in
                self.attentionLoads += 1
                if self.attentionFails { throw RhythmFeedError.rejected }
                return self.attention
            },
            fetchRhythms: {
                self.listLoads += 1
                if self.attentionFails { throw RhythmFeedError.rejected }
                return self.all
            },
            complete: { id, completedAt in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.completed.append(id)
                self.completedAt.append(completedAt)
            },
            skip: { id, periodStart in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.skipped.append((id, periodStart))
            },
            book: { id, startsAt, allDay, periodStart in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.booked.append((id, startsAt, allDay, periodStart))
            },
            save: { id, body in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.saved.append((id, body))
            },
            remove: { id in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.deleted.append(id)
            },
            now: { now })
    }
}

@Suite("Rhythms model")
@MainActor
struct RhythmsModelTests {
    @Test("Attention loads sorted, and every row's status line is precomputed on load")
    func precomputesStatusLines() async {
        let feed = RhythmFeed(attention: [
            unscheduled(rhythm(id: "b", title: "Temple visit", satisfiedBy: .scheduling),
                        start: "2026-07-01", end: "2026-08-25"),
            due(rhythm(id: "a", title: "Air filter"), at: "2026-08-15T09:00:00Z", overdue: true),
        ])
        let model = feed.model()
        await model.loadAttention()

        #expect(model.loaded)
        #expect(model.attention.map(\.rhythm.id) == ["a", "b"])
        // Precomputed once per load — a view body must never redo this date math.
        #expect(model.statusLines["a"] == "3 days late")
        #expect(model.statusLines["b"] == "7 days left to book it")
    }

    @Test("A failed refresh keeps what was on screen but still counts as loaded")
    func failureKeepsPriorItems() async {
        let feed = RhythmFeed(attention: [due(rhythm(id: "a"), at: "2026-08-15T09:00:00Z", overdue: true)])
        let model = feed.model()
        await model.loadAttention()
        feed.attentionFails = true
        await model.loadAttention()

        #expect(model.loaded)
        #expect(model.attention.map(\.rhythm.id) == ["a"])
    }

    @Test("Marking a due rhythm done posts the completion, then refetches")
    func completeRefetches() async {
        let feed = RhythmFeed(attention: [due(rhythm(id: "a"), at: "2026-08-15T09:00:00Z", overdue: true)])
        let model = feed.model()
        await model.loadAttention()
        feed.attention = []
        try? await model.markDone("a")

        #expect(feed.completed == ["a"])
        #expect(feed.attentionLoads == 2)
        #expect(model.attention.isEmpty)
    }

    @Test("Skipping a period sends the period start it was surfaced with")
    func skipSendsPeriodStart() async {
        let item = unscheduled(rhythm(id: "b", satisfiedBy: .scheduling), start: "2026-07-01", end: "2026-10-01")
        let feed = RhythmFeed(attention: [item])
        let model = feed.model()
        await model.loadAttention()
        try? await model.skipPeriod(item)

        #expect(feed.skipped.count == 1)
        #expect(feed.skipped[0].id == "b")
        #expect(feed.skipped[0].periodStart == "2026-07-01")
    }

    @Test("Booking a period hands the server an instant and refetches")
    func bookRefetches() async {
        let feed = RhythmFeed(attention: [
            unscheduled(rhythm(id: "b", satisfiedBy: .scheduling), start: "2026-07-01", end: "2026-10-01"),
        ])
        let model = feed.model()
        await model.loadAttention()
        try? await model.book(id: "b", startsAt: at("2026-08-20T18:00:00"), allDay: false, periodStart: "2026-07-01")

        #expect(feed.booked.count == 1)
        #expect(feed.booked[0].id == "b")
        #expect(feed.booked[0].allDay == false)
        // An ISO instant, not a local wall-clock string — the server decides the period.
        #expect(feed.booked[0].startsAt.hasSuffix("Z"))
        // And the period we were SHOWING travels with it, so the server can refuse a
        // booking that would land somewhere else and leave this one still asking.
        #expect(feed.booked[0].periodStart == "2026-07-01")
        #expect(feed.attentionLoads == 2)
    }

    @Test("A mutation that fails throws and leaves the list untouched")
    func mutationFailurePropagates() async {
        let feed = RhythmFeed(attention: [due(rhythm(id: "a"), at: "2026-08-15T09:00:00Z", overdue: true)])
        let model = feed.model()
        await model.loadAttention()
        feed.mutationFails = true

        await #expect(throws: (any Error).self) { try await model.markDone("a") }
        #expect(model.attention.map(\.rhythm.id) == ["a"])
    }

    @Test("The register bands by when, not by kind, and precomputes each row's detail line")
    func listBandsByUrgency() async {
        let feed = RhythmFeed(all: [
            rhythm(id: "a", title: "Air filter", satisfiedBy: .completion,
                   lastCompletedAt: "2026-05-20T09:00:00Z", nextDueAt: "2026-08-20T09:00:00Z"),
            // Settled by a BOOKING, so it carries the booking's time — only a skip settles
            // a period without one, and the row now has to tell those two apart.
            rhythm(id: "b", title: "Temple visit", satisfiedBy: .scheduling, startsOn: "2026-01-01",
                   currentPeriodStart: "2026-07-01", currentPeriodEnd: "2026-10-01", satisfied: true,
                   bookedAt: "2026-08-19T18:00:00Z"),
        ])
        let model = feed.model()
        await model.loadAll()

        // Two shapes, and the grouping ignores that entirely: the filter is due in two
        // days so it is on the horizon, and the temple visit is booked so there is
        // nothing to do about it. Which of them is a booking rhythm decides neither.
        #expect(model.bands.map(\.title) == ["Coming up", "Steady"])
        #expect(model.bands.first?.rhythms.map(\.id) == ["a"])
        #expect(model.bands.last?.rhythms.map(\.id) == ["b"])
        #expect(model.countdowns["b"]?.number == "Booked")

        // Grouping by urgency quietens most rows, so the capabilities that used to hang
        // off a visible row have to survive the quietening rather than disappear with it.
        // The one /attention structurally cannot report is an unbooked period whose
        // runway has not opened — it answers "what needs attention by today?".
        let quiet = rhythm(id: "c", title: "Self-care day", satisfiedBy: .scheduling,
                           startsOn: "2026-07-01", currentPeriodStart: "2026-10-01",
                           currentPeriodEnd: "2027-01-01", satisfied: false)
        #expect(RhythmFormat.urgency(quiet, attention: nil, now: at("2026-08-18T12:00:00")) == .steady)
        // The completion row says when it was last done; the scheduling row NEVER does —
        // whether it happened is deliberately not tracked.
        #expect(model.detailLines["a"]?.contains("last done") == true)
        #expect(model.detailLines["b"]?.contains("last done") == false)
        #expect(model.detailLines["b"]?.contains("on the calendar for this one") == true)
    }

    @Test("Pausing a rhythm is a PATCH of isActive, not a delete")
    func pauseIsAPatch() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        await model.loadAll()
        try? await model.setActive(id: "a", isActive: false)

        #expect(feed.deleted.isEmpty)
        #expect(feed.saved.count == 1)
        #expect(feed.saved[0].id == "a")
        #expect(feed.saved[0].body["isActive"] == .bool(false))
        #expect(feed.listLoads == 2)
    }

    @Test("Deleting removes it for good and refetches the register")
    func deleteRefetches() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        await model.loadAll()
        feed.all = []
        try? await model.delete(id: "a")

        #expect(feed.deleted == ["a"])
        #expect(model.rhythms.isEmpty)
    }
}

// MARK: - the create/edit form

@Suite("Rhythm editor")
@MainActor
struct RhythmEditorTests {
    @Test("A completion rhythm sends a first due date and no period anchor")
    func completionBody() {
        var form = RhythmForm()
        form.shape = .completion
        form.title = "  Air filter  "
        form.count = 3
        form.unit = .months
        form.leadDays = 14
        form.nextDue = at("2026-09-01T00:00:00")

        let body = form.createBody(calendar: utcCal)
        #expect(body["title"] == .string("Air filter"))
        #expect(body["satisfiedBy"] == .string("completion"))
        #expect(body["every"] == .string("3 months"))
        #expect(body["leadTime"] == .string("14 days"))
        #expect(body["nextDueAt"] != nil)
        // The server's shape constraint rejects a row carrying both anchors.
        #expect(body["startsOn"] == nil)
        #expect(body["rrule"] == nil)
    }

    @Test("A booking rhythm sends the period anchor and, only when automatic, a rule")
    func schedulingBody() {
        var form = RhythmForm()
        form.shape = .scheduling
        form.title = "Temple visit"
        form.count = 1
        form.unit = .months
        form.startsOn = at("2026-01-01T00:00:00")
        form.autoSchedule = false

        var body = form.createBody(calendar: utcCal)
        #expect(body["satisfiedBy"] == .string("scheduling"))
        #expect(body["startsOn"] == .string("2026-01-01"))
        #expect(body["autoSchedule"] == .bool(false))
        #expect(body["nextDueAt"] == nil)
        #expect(body["rrule"] == .null)

        form.autoSchedule = true
        body = form.createBody(calendar: utcCal)
        // Derived from the cadence — a rule that disagreed with `every` would put the
        // generated event outside the period it is supposed to satisfy.
        #expect(body["rrule"] == .string("FREQ=MONTHLY"))
    }

    @Test("Editing covers only the fields the server allows to change in place")
    func patchBodyIsNarrow() {
        var form = RhythmForm(editing: rhythm(id: "a", title: "Air filter", satisfiedBy: .completion,
                                              every: "3 mons", nextDueAt: "2026-08-20T09:00:00Z"))
        form.title = "Furnace filter"
        form.count = 6
        form.unit = .months

        let body = form.patchBody()
        #expect(body["title"] == .string("Furnace filter"))
        #expect(body["every"] == .string("6 months"))
        // Re-anchoring a live rhythm would re-interpret its skips and bookings, so the
        // shape and the anchor are not editable — retire it and make a new one.
        #expect(body["satisfiedBy"] == nil)
        #expect(body["startsOn"] == nil)
        #expect(body["autoSchedule"] == nil)
        #expect(body["rrule"] == nil)
    }

    @Test("An existing rhythm seeds the form from its stored cadence")
    func seedsFromExisting() {
        let form = RhythmForm(editing: rhythm(id: "a", title: "Trash", satisfiedBy: .scheduling,
                                              every: "7 days", startsOn: "2026-01-01",
                                              leadTime: "3 days 12:00:00"))
        #expect(form.title == "Trash")
        #expect(form.count == 1)
        #expect(form.unit == .weeks)
        #expect(form.shape == .scheduling)
        // The clamped runway rounds back to whole days rather than showing "3.5".
        #expect(form.leadDays == 3)
    }

    @Test("An hours-only runway seeds as whole days, not zero")
    func seedsHoursOnlyRunway() {
        // Two definitions of "interval -> whole days" lived in this file and only one
        // carried the HH:MM:SS tail into days. Nothing the server writes today puts 24h+
        // in that tail, so they agreed by luck rather than by rule. Pin the boundary so a
        // clamp that does emit one can't silently seed a 0-day runway.
        let form = RhythmForm(editing: rhythm(id: "a", title: "Trash", satisfiedBy: .scheduling,
                                              every: "7 days", startsOn: "2026-01-01",
                                              leadTime: "36:00:00"))
        #expect(form.leadDays == 1)
    }

    @Test("A blank title can't be submitted")
    func requiresTitle() {
        var form = RhythmForm()
        #expect(!form.isValid)
        form.title = "   "
        #expect(!form.isValid)
        form.title = "Trash"
        #expect(form.isValid)
    }

    @Test("An untouched form asks for a runway the cadence can actually hold")
    func leadFollowsTheCadence() {
        // A fixed 14-day default is wrong for most cadences. The server keeps
        // least(leadTime, every / 2), so a weekly rhythm asked for 14 days' notice
        // quietly got 3 — an untouched form opened already promising a nudge on a day
        // nothing happens, and explaining a clamp nobody had asked for.
        var form = RhythmForm()
        form.shape = .scheduling
        form.title = "Trash"
        form.count = 1
        form.unit = .weeks
        #expect(form.effectiveLeadDays == 3)
        #expect(form.createBody(calendar: utcCal)["leadTime"] == .string("3 days"))
        #expect(!RhythmFormat.nudgePlan(every: form.every, leadDays: form.effectiveLeadDays).capped)

        // A cadence long enough to hold it gets the full fortnight, which is the ceiling.
        form.count = 3
        form.unit = .months
        #expect(form.effectiveLeadDays == 14)

        // A typed number still wins, clamp and all — the field is an escape hatch, not a
        // suggestion, and the copy next to it says what the server will do with it.
        form.leadDays = 30
        #expect(form.effectiveLeadDays == 30)
    }

    @Test("A brand-new rhythm is due one cadence out, not today")
    func firstDueFollowsTheCadence() {
        // Anchoring at today makes "every 3 months" mean "and the first one is overdue
        // right now", so every rhythm anyone creates arrives already shouting from
        // Needs you now.
        var form = RhythmForm()
        form.shape = .completion
        form.title = "Air filter"
        form.count = 3
        form.unit = .months
        let now = at("2026-08-26T15:00:00")
        #expect(RhythmFormat.ymd(form.firstDue(now: now, calendar: utcCal), calendar: utcCal) == "2026-11-26")

        // At 09:00 rather than at the current instant: a due date is a day, and the hour
        // it carries shouldn't be whatever o'clock the sheet happened to be opened.
        #expect(form.createBody(now: now, calendar: utcCal)["nextDueAt"] == .string("2026-11-26T09:00:00Z"))

        // Still an open field under More options — adding something you are already
        // behind on is a real case.
        form.nextDue = at("2026-09-01T00:00:00")
        #expect(RhythmFormat.ymd(form.firstDue(now: now, calendar: utcCal), calendar: utcCal) == "2026-09-01")
    }

    @Test("A blank sentence opens on the shape most rhythms actually are")
    func defaultsToCompletion() {
        // Web has always opened on "I mark it done" and iOS opened on "it's on the
        // calendar", so the same blank form made two different rhythms depending on which
        // one you happened to be holding. Completion is also the gentler default: it needs
        // no calendar, and getting it wrong costs a tap rather than a stray event.
        #expect(RhythmForm().shape == .completion)
    }

    @Test("Pushing a rhythm out buys a week from today when it is already late")
    func pushOutFromTheLaterOfTheTwo() {
        let now = at("2026-08-20T09:00:00")
        // From TODAY, not from the date it already sailed past: an oil change six days
        // overdue, pushed "a week" from its own due date, would come back tomorrow. A
        // control that reads as a week and delivers a day is worse than no control.
        let late = RhythmFormat.pushOut("2026-08-14T09:00:00Z", now: now, calendar: utcCal)
        #expect(RhythmFormat.ymd(late!, calendar: utcCal) == "2026-08-27")

        // From the due date when it hasn't arrived: something due in three days moves to
        // ten days out rather than resetting to seven, so the rhythm keeps the shape of
        // its own schedule instead of being re-anchored to whenever a button was pressed.
        let soon = RhythmFormat.pushOut("2026-08-23T09:00:00Z", now: now, calendar: utcCal)
        #expect(RhythmFormat.ymd(soon!, calendar: utcCal) == "2026-08-30")

        // A scheduling rhythm has no due date at all — its periods are its anchor, and
        // the server refuses to give it one.
        #expect(RhythmFormat.pushOut(nil, now: now, calendar: utcCal) == nil)
    }

    @Test("The clamp is admitted in the sentence's own terms, or not at all")
    func capNoteNamesTheCadence() {
        // Said next to the promise it modifies, in days rather than as "half the cycle":
        // the whole failure was a form that showed 14 and delivered 3 without either
        // number ever appearing together.
        let note = RhythmFormat.capNote(every: "7 days", leadDays: 14)
        #expect(note?.contains("14 days") == true)
        #expect(note?.contains("a week") == true)
        #expect(note?.contains("trimmed to 3") == true)

        // Nothing to admit when nothing was trimmed — a form explaining a clamp that
        // didn't happen is how the default came to teach the wrong thing.
        #expect(RhythmFormat.capNote(every: "3 mons", leadDays: 14) == nil)
        #expect(RhythmFormat.capNote(every: "7 days", leadDays: 3) == nil)
    }

    @Test("The consequence block promises the dates the server will actually use")
    func consequenceUsesTheClampedRunway() {
        let now = at("2026-08-26T00:00:00")
        // Built through nudgePlan, never from the typed runway: a weekly rhythm asked for
        // 14 days' notice keeps 3, so a promise built from 14 would name a day nothing is
        // ever going to happen on.
        let booking = RhythmFormat.consequence(shape: .scheduling, every: "1 weeks", leadDays: 14,
                                               anchor: now, calendar: utcCal)
        #expect(RhythmFormat.ymd(booking!.landsOn, calendar: utcCal) == "2026-09-02")
        #expect(RhythmFormat.ymd(booking!.nudgeFrom, calendar: utcCal) == "2026-08-30")
        #expect(booking!.capped)

        // A completion rhythm's anchor IS the due date — the cadence has already been
        // added to reach it, so adding it again would promise a date a cycle too far out.
        let doing = RhythmFormat.consequence(shape: .completion, every: "3 mons", leadDays: 14,
                                             anchor: at("2026-11-26T00:00:00"), calendar: utcCal)
        #expect(RhythmFormat.ymd(doing!.landsOn, calendar: utcCal) == "2026-11-26")
        #expect(RhythmFormat.ymd(doing!.nudgeFrom, calendar: utcCal) == "2026-11-12")
        #expect(!doing!.capped)
    }

    @Test("Adding a cadence to a month-end date lands inside the next month")
    func addCadenceClampsShortMonths() {
        // Jan 31 + 1 month is Feb 28, not Mar 3. Rolling the month over on a date whose
        // day is still 31 spills into the month after the one the period belongs to.
        let jan31 = at("2026-01-31T00:00:00")
        #expect(RhythmFormat.ymd(RhythmFormat.addCadence(from: jan31, every: "1 months", calendar: utcCal),
                                 calendar: utcCal) == "2026-02-28")
        #expect(RhythmFormat.ymd(RhythmFormat.addCadence(from: jan31, every: "2 weeks", calendar: utcCal),
                                 calendar: utcCal) == "2026-02-14")
        #expect(RhythmFormat.ymd(RhythmFormat.addCadence(from: jan31, every: "1 years", calendar: utcCal),
                                 calendar: utcCal) == "2027-01-31")
    }
}

// MARK: - module registration

/// The module is `defaultOn: false` server-side (apps/api/src/platform/modules.ts). If this
/// hand-mirrored catalog disagreed, every household would get a Rhythms card and a rail
/// tile for a feature they never turned on — the same class of bug the mirrored catalogs
/// exist to make visible.
@Suite("Rhythms module registration")
struct RhythmsModuleTests {
    @Test("Rhythms is available but opt-in")
    func optIn() {
        #expect(WaffledModule.rhythms.isAvailable)
        #expect(!WaffledModule.rhythms.defaultOn)
        // …and the modules that were already opt-in stay that way.
        #expect(!WaffledModule.pantry.defaultOn)
        #expect(WaffledModule.chores.defaultOn)
    }

    @Test("The iPad rail can pin it, and More lights up while it's unpinned")
    func reachableOnTheWallDisplay() {
        #expect(KioskRail.choosable.contains(.rhythms))
        #expect(KioskRail.parse("rhythms") == [.rhythms])
        #expect(KioskRail.isHighlighted(.more, selection: .rhythms, pinned: [.meals, .family]))
    }
}

/// "Nothing here yet" is a CLAIM, and a failed request is not evidence for it.
///
/// `loadAll` only ever set `listFailed` on the very first load, so any failure after one
/// success was indistinguishable from an empty register — which is what turned "the
/// Rhythms module was switched off, so these requests now 403" into the confident and
/// wrong "A rhythm is a standing intention with a cadence…" onboarding copy. The same
/// principle the attention loader already follows: keep what was on screen, but never
/// invent a fact about the household from a dropped connection.
@MainActor
@Suite("Register load failures")
struct RhythmRegisterFailureTests {
    @Test("A failure after a good load is still reported as a failure")
    func failureAfterSuccessIsReported() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        await model.loadAll()
        #expect(!model.listFailed)

        feed.attentionFails = true
        await model.loadAll()
        #expect(model.listFailed)
    }

    @Test("…and the rows that were already on screen stay there")
    func failureKeepsTheRows() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        await model.loadAll()
        feed.attentionFails = true
        await model.loadAll()

        #expect(model.rhythms.map(\.id) == ["a"])
    }

    /// A rhythm anchored in the future has no current period yet, because the server tiles
    /// the grid from `startsOn` up to now. The row used to fall through to "Not on the
    /// calendar yet" — which, once creating an auto-scheduled rhythm books its series
    /// immediately, is a statement the calendar flatly contradicts.
    @Test("A rhythm whose periods haven't started says so, rather than 'not on the calendar'")
    func notYetStarted() {
        let future = rhythm(id: "f", satisfiedBy: .scheduling, startsOn: "2027-03-01",
                            autoSchedule: true, rrule: "FREQ=WEEKLY;BYDAY=MO",
                            currentPeriodStart: nil, currentPeriodEnd: nil, satisfied: false)
        let lines = RhythmsModel.detailLines(for: [future], now: at("2026-08-19T12:00:00"), calendar: utcCal)
        #expect(lines["f"] == "Every 3 months · periods start Mar 1, 2027")
        #expect(!(lines["f"] ?? "").contains("not on the calendar"))
    }

    @Test("A register row leads with the cadence and never restates its own countdown")
    func metaLeadsWithTheCadence() {
        // The row's right edge already carries "1 day left" at the size you read from
        // across a room. Saying it again in the subtitle spent the one line that could
        // have carried the thing the countdown can't: how often this is meant to happen.
        let now = at("2026-08-26T12:00:00")
        let booking = rhythm(id: "t", title: "Trash", personId: "p1", satisfiedBy: .scheduling,
                             every: "7 days", startsOn: "2026-08-19",
                             currentPeriodStart: "2026-08-19", currentPeriodEnd: "2026-08-27",
                             satisfied: false)
        let lines = RhythmsModel.detailLines(for: [booking], names: ["p1": "Jerry"],
                                             now: now, calendar: utcCal)
        #expect(lines["t"] == "Every week · not on the calendar yet · Jerry")
        #expect(!(lines["t"] ?? "").contains("left to book"))

        // A booked period is settled, and says so in the same slot.
        let booked = rhythm(id: "u", title: "Temple visit", satisfiedBy: .scheduling, every: "7 days",
                            currentPeriodStart: "2026-08-19", currentPeriodEnd: "2026-08-27",
                            satisfied: true, bookedAt: "2026-08-20T18:00:00Z")
        #expect(RhythmsModel.detailLines(for: [booked], now: now, calendar: utcCal)["u"]
                == "Every week · on the calendar for this one")
    }

    @Test("A settled period says whether it was booked or skipped, never both")
    func skippedIsNotBooked() {
        // Skipping sends a period quiet WITHOUT inventing a calendar entry for something
        // that isn't going to happen. The server settles a period either way and marks the
        // difference with `bookedAt` — a skip has no time and never will — so a row reading
        // only `satisfied` announces the very entry the action was chosen to avoid.
        let skipped = rhythm(satisfiedBy: .scheduling, startsOn: "2026-08-17",
                             currentPeriodStart: "2026-08-17", currentPeriodEnd: "2026-08-24",
                             satisfied: true, bookedAt: nil)
        #expect(RhythmFormat.countdown(skipped, urgency: .steady)?.number == "Skipped")
        #expect(RhythmsModel.detailLines(for: [skipped], now: at("2026-08-20T09:00:00"),
                                        calendar: utcCal)["r1"]?.contains("skipped this one") == true)

        let booked = rhythm(satisfiedBy: .scheduling, startsOn: "2026-08-17",
                            currentPeriodStart: "2026-08-17", currentPeriodEnd: "2026-08-24",
                            satisfied: true, bookedAt: "2026-08-19T18:00:00Z")
        #expect(RhythmFormat.countdown(booked, urgency: .steady)?.number == "Booked")
        #expect(RhythmsModel.detailLines(for: [booked], now: at("2026-08-20T09:00:00"),
                                        calendar: utcCal)["r1"]?.contains("on the calendar for this one") == true)
    }

    @Test("A self-booking row separates one empty period from a series that is gone")
    func metaForAnAutoScheduledRhythm() {
        // Two rows both reading "Every week · not on the calendar yet" sprouted two
        // different buttons — "Put it back" on one and "Book a time" on the other — and
        // the row never mentioned the fact that decides which: one of them books itself.
        //
        // But "the series needs putting back" is only true when there ISN'T one. Said of
        // a live series with a single empty period it sent people to a button that built
        // a SECOND weekly series beside the first, doubling every future occurrence.
        let now = at("2026-08-26T12:00:00")
        let alive = rhythm(id: "a", title: "Temple Visit", personId: "p1", satisfiedBy: .scheduling,
                           every: "7 days", startsOn: "2026-08-19", autoSchedule: true,
                           rrule: "FREQ=WEEKLY;BYDAY=WE",
                           currentPeriodStart: "2026-08-26", currentPeriodEnd: "2026-09-02",
                           satisfied: false, hasSeries: true)
        let lines = RhythmsModel.detailLines(for: [alive], names: ["p1": "Jerry"],
                                             now: now, calendar: utcCal)
        #expect(lines["a"] == "Every week · nothing on the calendar this time · Jerry")
        // Not "yet": nobody was ever going to book this by hand, so "yet" blamed the
        // reader for a slot the rhythm had promised to fill itself.
        #expect(!(lines["a"] ?? "").contains("not on the calendar yet"))
        #expect(!(lines["a"] ?? "").contains("putting back"))

        // With no recurrence left, the series really is what went missing.
        let gone = rhythm(id: "g", title: "Temple Visit", satisfiedBy: .scheduling,
                          every: "7 days", startsOn: "2026-08-19", autoSchedule: true,
                          rrule: "FREQ=WEEKLY;BYDAY=WE",
                          currentPeriodStart: "2026-08-26", currentPeriodEnd: "2026-09-02",
                          satisfied: false, hasSeries: false)
        #expect(RhythmsModel.detailLines(for: [gone], now: now, calendar: utcCal)["g"]
                == "Every week · the series needs putting back")

        // While the series is doing its job there is no anomaly to report, and no button
        // either — the healthy row reads exactly like a hand-booked one that is settled.
        let healthy = rhythm(id: "b", title: "Temple Visit", satisfiedBy: .scheduling,
                             every: "7 days", startsOn: "2026-08-19", autoSchedule: true,
                             currentPeriodStart: "2026-08-26", currentPeriodEnd: "2026-09-02",
                             satisfied: true, hasSeries: true, bookedAt: "2026-08-26T18:00:00Z")
        #expect(RhythmsModel.detailLines(for: [healthy], now: now, calendar: utcCal)["b"]
                == "Every week · on the calendar for this one")
    }

    @Test("A completion row says when it last happened, and admits when it never has")
    func metaForCompletion() {
        let now = at("2026-08-26T12:00:00")
        let done = rhythm(id: "a", title: "Air filter", notes: "Furnace, 20x25x1",
                          satisfiedBy: .completion, every: "3 mons",
                          lastCompletedAt: "2026-05-24T09:00:00Z")
        #expect(RhythmsModel.detailLines(for: [done], now: now, calendar: utcCal)["a"]
                == "Every 3 months · last done May 24, 2026 · Furnace, 20x25x1")

        // "Last done —" was a row saying nothing with a punctuation mark. A rhythm that
        // has never happened is a real and useful state, so it gets words.
        let never = rhythm(id: "b", title: "Gutters", satisfiedBy: .completion, every: "1 year",
                           lastCompletedAt: nil)
        #expect(RhythmsModel.detailLines(for: [never], now: now, calendar: utcCal)["b"]
                == "Every year · never done")
    }

    @Test("The countdown's tone comes from the band, not from the word 'late'")
    func countdownCarriesItsTone() {
        // It used to be read back off the unit string, so a rhythm whose booking window
        // closes tomorrow — the whole reason it is in Needs you now — rendered in plain
        // ink, because "1 day left" doesn't contain the word "late". Web painted the same
        // row red. The band already knows the answer; carry it rather than re-derive it
        // from copy that was never meant to be parsed.
        let now = at("2026-08-26T12:00:00")
        let closing = rhythm(id: "t", title: "Trash", satisfiedBy: .scheduling, every: "7 days",
                             currentPeriodStart: "2026-08-21", currentPeriodEnd: "2026-08-27",
                             satisfied: false)
        let cd = RhythmFormat.countdown(closing, urgency: .now, now: now, calendar: utcCal)
        #expect(cd?.unit == "day left")
        #expect(cd?.tone == .late)

        // Coming up is neither shouting nor greyed out.
        #expect(RhythmFormat.countdown(rhythm(id: "a", nextDueAt: "2026-09-02T09:00:00Z"),
                                       urgency: .soon, now: now, calendar: utcCal)?.tone == .near)
        // Steady recedes.
        #expect(RhythmFormat.countdown(rhythm(id: "b", nextDueAt: "2026-11-25T09:00:00Z"),
                                       urgency: .steady, now: now, calendar: utcCal)?.tone == .soft)
        // A booked period is settled, whatever band it was filed under.
        let booked = rhythm(id: "c", satisfiedBy: .scheduling, every: "7 days",
                            currentPeriodStart: "2026-08-21", currentPeriodEnd: "2026-08-27",
                            satisfied: true)
        #expect(RhythmFormat.countdown(booked, urgency: .steady, now: now, calendar: utcCal)?.tone == .done)
    }

    @Test("A paused row says only that it is paused")
    func metaForPaused() {
        // Its period state is still computed, but nothing nudges about it and nothing can
        // be done with it — so "not on the calendar yet" would be a complaint about a
        // situation we have deliberately stopped caring about.
        let off = rhythm(id: "p", title: "Trash", satisfiedBy: .scheduling, every: "7 days",
                         isActive: false,
                         currentPeriodStart: "2026-08-19", currentPeriodEnd: "2026-08-27",
                         satisfied: false)
        #expect(RhythmsModel.detailLines(for: [off], now: at("2026-08-26T12:00:00"), calendar: utcCal)["p"]
                == "Every week · paused")
    }

    @Test("A recovered load clears the failure")
    func recoveryClearsIt() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        feed.attentionFails = true
        await model.loadAll()
        #expect(model.listFailed)

        feed.attentionFails = false
        await model.loadAll()
        #expect(!model.listFailed)
        #expect(model.rhythms.map(\.id) == ["a"])
    }
}

/// Being late has to be sayable.
///
/// The completion shape re-anchors its clock to when the thing was ACTUALLY done — that's
/// what makes running late shift the next one instead of stacking misses. But every control
/// meant "now", so logging Tuesday's filter change on Friday silently moved the next three
/// months to Friday, and the register's one useful fact — "the filter last changed on…" —
/// became a guess. The server already accepted a date; nothing sent one.
@MainActor
@Suite("Backdating a completion")
struct RhythmBackdateTests {
    @Test("Marking done now sends no date, leaving the stamp to the server")
    func nowSendsNothing() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        try? await model.markDone("a")
        #expect(feed.completedAt == [nil])
    }

    @Test("Marking done for an earlier day sends that day")
    func backdatedSendsTheDate() async {
        let feed = RhythmFeed(all: [rhythm(id: "a")])
        let model = feed.model()
        try? await model.markDone("a", on: at("2026-08-14T12:00:00"))

        #expect(feed.completed == ["a"])
        #expect(feed.completedAt.count == 1)
        // An explicit instant, not a wall-clock date — leaving the timezone to the server
        // is how a completion lands on the wrong day.
        #expect((feed.completedAt.first ?? nil)?.contains("2026-08-14") == true)
    }
}

/// The nudge runway has to name the window it counts back from, and admit the clamp.
///
/// "Start nudging me this many days before the period ends" was fairly answered with "what
/// period? I'm scheduling it to happen every week". And because the server stores
/// `least(leadTime, every/2)`, a weekly rhythm asking for 14 days' notice silently gets 3 —
/// so "I set 1 day and nothing appeared on Today" looked like a bug when it was the design.
@Suite("Nudge runway copy")
struct RhythmNudgeCopyTests {
    @Test("The runway stands when the cadence has room for it")
    func uncapped() {
        let plan = RhythmFormat.nudgePlan(every: "3 mons", leadDays: 14)
        #expect(plan.effectiveDays == 14)
        #expect(!plan.capped)
    }

    @Test("A runway longer than half the cycle is reported clamped, not as typed")
    func capped() {
        let plan = RhythmFormat.nudgePlan(every: "7 days", leadDays: 14)
        #expect(plan.effectiveDays == 3)
        #expect(plan.capped)
    }

    @Test("It names the cadence rather than 'the period'")
    func namesTheWindow() {
        let text = RhythmFormat.nudgeExplainer(every: "7 days", leadDays: 1)
        #expect(text.contains("every week"))
        #expect(!text.contains("the period ends"))
    }

    @Test("It states what the clamp actually did")
    func statesTheClamp() {
        #expect(RhythmFormat.nudgeExplainer(every: "7 days", leadDays: 14).contains("last 3 days"))
    }

    @Test("A zero runway nudges only on the final day")
    func zeroRunway() {
        #expect(RhythmFormat.nudgeExplainer(every: "7 days", leadDays: 0).contains("last day"))
    }

    /// Same wording rule as everywhere else in rhythms: no scoreboard language.
    @Test("The explanation never turns into follow-through talk")
    func staysOffTheScorecard() {
        let text = RhythmFormat.nudgeExplainer(every: "3 mons", leadDays: 14).lowercased()
        for word in ["streak", "on track", "missed", "completed"] {
            #expect(!text.contains(word))
        }
    }
}

/// A paused rhythm must not be offered period actions.
///
/// The server filters paused rhythms out of /attention, so normally there is nothing to
/// offer. But the register holds the last attention list it fetched, and pausing is a local
/// action — so between the pause and the refetch the row could still find its old item and
/// draw "Book a time" on something deliberately switched off. The server would accept that
/// booking quite happily, which is exactly why the control must not be there. The web
/// register already guards this; iOS looked the rhythm up without checking.
@MainActor
@Suite("Paused rhythms offer no period actions")
struct RhythmPausedActionTests {
    @Test("An active rhythm still finds its attention item")
    func activeKeepsIt() async {
        let r = rhythm(id: "a", satisfiedBy: .scheduling)
        let feed = RhythmFeed(attention: [unscheduled(r, start: "2026-08-01", end: "2026-09-01")], all: [r])
        let model = feed.model()
        await model.loadAttention()
        #expect(model.attentionItem(for: r) != nil)
    }

    @Test("A paused one does not, even while the stale item is still in hand")
    func pausedDropsIt() async {
        let active = rhythm(id: "a", satisfiedBy: .scheduling)
        let feed = RhythmFeed(attention: [unscheduled(active, start: "2026-08-01", end: "2026-09-01")], all: [active])
        let model = feed.model()
        await model.loadAttention()
        // Same rhythm, now paused — precisely the window between pausing and refetching.
        let paused = rhythm(id: "a", satisfiedBy: .scheduling, isActive: false)
        #expect(model.attentionItem(for: paused) == nil)
    }
}

/// A completion tap has to be visible on the row it happened on.
///
/// The register's detail line is "Last done <date> · Next due <date>". Complete a rhythm
/// that was already completed today and both halves recompute to the SAME string — so the
/// row is byte-identical before and after, the button reads as dead, and it gets pressed
/// again. The demo database ended up with four rows for one air-filter change that way.
/// The label is the only thing that can carry the acknowledgement, so it has to change.
@Suite("Completion acknowledgement")
struct RhythmCompletionAckTests {
    private let now = at("2026-08-19T15:00:00")

    @Test("A rhythm completed earlier today counts as done today")
    func doneToday() {
        #expect(RhythmFormat.wasCompletedToday("2026-08-19T09:00:00Z", now: now, calendar: utcCal))
    }

    @Test("Yesterday's completion does not")
    func notYesterday() {
        #expect(!RhythmFormat.wasCompletedToday("2026-08-18T23:30:00Z", now: now, calendar: utcCal))
    }

    @Test("Never completed does not")
    func neverCompleted() {
        #expect(!RhythmFormat.wasCompletedToday(nil, now: now, calendar: utcCal))
    }

    /// The whole point: the three states must not share a label, or the tap is invisible.
    @Test("The label states which of the three states the row is in")
    func labelsDiffer() {
        let fresh = RhythmFormat.completionAction(doneToday: false, due: false)
        let nagged = RhythmFormat.completionAction(doneToday: false, due: true)
        let settled = RhythmFormat.completionAction(doneToday: true, due: false)
        #expect(fresh == "I did it today")
        #expect(nagged == "I did it")
        #expect(settled == "Done today ✓")
        #expect(Set([fresh, nagged, settled]).count == 3)
    }

    /// Rhythms never keep score, so the acknowledgement must not smuggle in goal language.
    @Test("Acknowledging never turns the register into a scorecard")
    func staysOffTheScorecard() {
        let settled = RhythmFormat.completionAction(doneToday: true, due: false).lowercased()
        for word in ["streak", "on track", "missed", "kept up", "complete rate"] {
            #expect(!settled.contains(word))
        }
    }
}


// MARK: - banding the register by when, not by kind

/// The register used to be two sections named after the two shapes, which sorts a
/// household's rhythms by a distinction only the schema cares about. Asked "what do I owe
/// this week", you had to read both and do the merge yourself.
///
/// These are the same rules the web register runs on, ported so the two surfaces cannot
/// answer the question differently. "Needs you now" is EXACTLY the server's own
/// `/attention` list — never a second opinion computed here — because the Today card reads
/// that list too, and two surfaces disagreeing about one rhythm is worse than either being
/// slightly conservative.
@Suite("Rhythm urgency banding")
struct RhythmUrgencyTests {
    private let now = at("2026-08-20T12:00:00")

    @Test("A rhythm the server is nudging about is 'needs you now', whatever its dates say")
    func attentionWins() {
        let r = rhythm(nextDueAt: "2026-11-01T09:00:00Z", satisfied: true)
        let item = due(r, at: "2026-11-01T09:00:00Z", overdue: false)
        #expect(RhythmFormat.urgency(r, attention: item, now: now, calendar: utcCal) == .now)
    }

    @Test("Overdue still reads as urgent when the attention call has not come back")
    func overdueWithoutAttention() {
        // `satisfied` is `next_due_at > now()`, so an overdue rhythm is genuinely
        // unsatisfied. The row must not go quiet just because a second request is in
        // flight or failed.
        let r = rhythm(nextDueAt: "2026-08-14T09:00:00Z", satisfied: false)
        #expect(RhythmFormat.urgency(r, attention: nil, now: now, calendar: utcCal) == .now)
    }

    @Test("A fortnight is the horizon for 'coming up', flat rather than per-rhythm")
    func comingUp() {
        // Deliberately not derived from each rhythm's own runway: the runway governs
        // NUDGING, which /attention already answers. This band answers "what is on the
        // horizon" for someone who opened the page on purpose.
        #expect(RhythmFormat.urgency(rhythm(nextDueAt: "2026-08-30T09:00:00Z"),
                                     attention: nil, now: now, calendar: utcCal) == .soon)
        #expect(RhythmFormat.urgency(rhythm(nextDueAt: "2026-09-20T09:00:00Z"),
                                     attention: nil, now: now, calendar: utcCal) == .steady)
    }

    @Test("A booked period is steady, because booking it was the whole outcome")
    func bookedIsSteady() {
        let r = rhythm(satisfiedBy: .scheduling, every: "7 days",
                       currentPeriodStart: "2026-08-17", currentPeriodEnd: "2026-08-24",
                       satisfied: true)
        #expect(RhythmFormat.urgency(r, attention: nil, now: now, calendar: utcCal) == .steady)
    }

    @Test("A paused rhythm is off, not merely quiet")
    func pausedIsItsOwnBand() {
        // Sorting a paused rhythm by how overdue it is would be sorting by a number that
        // stopped meaning anything the moment it was switched off.
        let r = rhythm(nextDueAt: "2026-08-01T09:00:00Z", isActive: false)
        #expect(RhythmFormat.urgency(r, attention: nil, now: now, calendar: utcCal) == .paused)
    }
}

@Suite("Rhythm countdown")
struct RhythmCountdownTests {
    private let now = at("2026-08-20T12:00:00")

    @Test("Days late count up, so the worst row reads loudest")
    func late() {
        let r = rhythm(nextDueAt: "2026-08-14T09:00:00Z")
        let cd = RhythmFormat.countdown(r, urgency: .now, now: now, calendar: utcCal)
        #expect(cd?.number == "6")
        #expect(cd?.unit == "days late")
    }

    @Test("Distant dates collapse into weeks and then months, so a row stays readable")
    func collapses() {
        // "97 days" is a number nobody converts in their head on the way past a kiosk.
        let weeks = RhythmFormat.countdown(rhythm(nextDueAt: "2026-09-20T09:00:00Z"),
                                           urgency: .steady, now: now, calendar: utcCal)
        #expect(weeks?.number == "4")
        #expect(weeks?.unit == "weeks")
        let months = RhythmFormat.countdown(rhythm(nextDueAt: "2026-11-25T09:00:00Z"),
                                            urgency: .steady, now: now, calendar: utcCal)
        #expect(months?.unit == "months")
    }

    @Test("A settled booking reads 'Booked', never a follow-through claim")
    func booked() {
        let r = rhythm(satisfiedBy: .scheduling, every: "7 days",
                       currentPeriodStart: "2026-08-17", currentPeriodEnd: "2026-08-24",
                       satisfied: true, bookedAt: "2026-08-19T18:00:00Z")
        let cd = RhythmFormat.countdown(r, urgency: .steady, now: now, calendar: utcCal)
        #expect(cd?.number == "Booked")
        #expect(cd?.unit == "this period")
    }

    @Test("An unbooked period counts down to the day the window closes")
    func windowClosing() {
        let r = rhythm(satisfiedBy: .scheduling, every: "7 days",
                       currentPeriodStart: "2026-08-17", currentPeriodEnd: "2026-08-24",
                       satisfied: false)
        let cd = RhythmFormat.countdown(r, urgency: .soon, now: now, calendar: utcCal)
        #expect(cd?.number == "4")
        #expect(cd?.unit == "days left")
    }
}

@Suite("Rhythm period progress")
struct RhythmProgressTests {
    private let now = at("2026-08-20T12:00:00")

    @Test("The bar measures the real period for a booking rhythm")
    func realPeriod() {
        let r = rhythm(satisfiedBy: .scheduling, every: "7 days",
                       currentPeriodStart: "2026-08-18", currentPeriodEnd: "2026-08-22",
                       satisfied: false)
        // Aug 18 00:00 to Aug 22 00:00 is 96 hours; the clock above is 60 hours into it.
        // (The web's equivalent test reads 50 because its fixture clock is midnight.)
        #expect(RhythmFormat.periodProgress(r, now: now, calendar: utcCal) == 63)
    }

    @Test("It stops at full instead of overflowing its track when overdue")
    func clamped() {
        let r = rhythm(every: "7 days", lastCompletedAt: "2026-08-01T09:00:00Z",
                       nextDueAt: "2026-08-08T09:00:00Z")
        #expect(RhythmFormat.periodProgress(r, now: now, calendar: utcCal) == 100)
    }

    @Test("It declines to draw a bar it cannot measure")
    func unmeasurable() {
        // A backdated completion later than the next due date inverts the window, and a
        // missing due date has no window at all. Both would render as a full bar or an
        // invisible one, and both would be a lie.
        #expect(RhythmFormat.periodProgress(rhythm(nextDueAt: nil), now: now, calendar: utcCal) == nil)
        #expect(RhythmFormat.periodProgress(
            rhythm(lastCompletedAt: "2026-09-01T09:00:00Z", nextDueAt: "2026-08-25T09:00:00Z"),
            now: now, calendar: utcCal) == nil)
    }
}
