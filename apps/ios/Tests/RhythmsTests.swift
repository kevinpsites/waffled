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
    satisfied: Bool? = nil
) -> WaffledAPI.Rhythm {
    WaffledAPI.Rhythm(
        id: id, title: title, emoji: emoji, notes: nil, personId: nil,
        satisfiedBy: satisfiedBy, every: every, startsOn: startsOn,
        autoSchedule: autoSchedule, rrule: rrule, leadTime: leadTime,
        lastCompletedAt: lastCompletedAt, nextDueAt: nextDueAt, isActive: isActive,
        currentPeriodStart: currentPeriodStart, currentPeriodEnd: currentPeriodEnd,
        satisfied: satisfied)
}

private func due(_ r: WaffledAPI.Rhythm, at dueAt: String, overdue: Bool) -> WaffledAPI.RhythmAttentionItem {
    WaffledAPI.RhythmAttentionItem(kind: .due, rhythm: r, dueAt: dueAt, overdue: overdue,
                                  periodStart: nil, periodEnd: nil)
}

private func unscheduled(_ r: WaffledAPI.Rhythm, start: String, end: String) -> WaffledAPI.RhythmAttentionItem {
    WaffledAPI.RhythmAttentionItem(kind: .unscheduled, rhythm: r, dueAt: nil, overdue: nil,
                                  periodStart: start, periodEnd: end)
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
        #expect(RhythmFormat.dueLabel("2026-08-23T09:00:00Z", overdue: false, now: now, calendar: utcCal) == "due in 5 days")
        #expect(RhythmFormat.dueLabel("2026-08-15T09:00:00Z", overdue: true, now: now, calendar: utcCal) == "3 days overdue")
        // Overdue by a fraction of a day still reads as a day late, never "0 days".
        #expect(RhythmFormat.dueLabel("2026-08-18T09:00:00Z", overdue: true, now: now, calendar: utcCal) == "1 day overdue")
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
    var skipped: [(id: String, periodStart: String)] = []
    var booked: [(id: String, startsAt: String, allDay: Bool)] = []
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
            complete: { id in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.completed.append(id)
            },
            skip: { id, periodStart in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.skipped.append((id, periodStart))
            },
            book: { id, startsAt, allDay in
                if self.mutationFails { throw RhythmFeedError.rejected }
                self.booked.append((id, startsAt, allDay))
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
        #expect(model.statusLines["a"] == "3 days overdue")
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
        try? await model.book(id: "b", startsAt: at("2026-08-20T18:00:00"), allDay: false)

        #expect(feed.booked.count == 1)
        #expect(feed.booked[0].id == "b")
        #expect(feed.booked[0].allDay == false)
        // An ISO instant, not a local wall-clock string — the server decides the period.
        #expect(feed.booked[0].startsAt.hasSuffix("Z"))
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

    @Test("The register splits by shape and precomputes each row's detail line")
    func listGroupsByShape() async {
        let feed = RhythmFeed(all: [
            rhythm(id: "a", title: "Air filter", satisfiedBy: .completion,
                   lastCompletedAt: "2026-05-20T09:00:00Z", nextDueAt: "2026-08-20T09:00:00Z"),
            rhythm(id: "b", title: "Temple visit", satisfiedBy: .scheduling, startsOn: "2026-01-01",
                   currentPeriodStart: "2026-07-01", currentPeriodEnd: "2026-10-01", satisfied: true),
        ])
        let model = feed.model()
        await model.loadAll()

        #expect(model.scheduling.map(\.id) == ["b"])
        #expect(model.completion.map(\.id) == ["a"])
        // The completion row says when it was last done; the scheduling row NEVER does —
        // whether it happened is deliberately not tracked.
        #expect(model.detailLines["a"]?.contains("Last done") == true)
        #expect(model.detailLines["b"]?.contains("Last done") == false)
        #expect(model.detailLines["b"]?.contains("On the calendar") == true)
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

    @Test("A blank title can't be submitted")
    func requiresTitle() {
        var form = RhythmForm()
        #expect(!form.isValid)
        form.title = "   "
        #expect(!form.isValid)
        form.title = "Trash"
        #expect(form.isValid)
    }
}
