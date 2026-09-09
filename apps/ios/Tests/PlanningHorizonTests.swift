import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 3 "Horizon scan" — the one read, the park bar's three-state tag,
// and the month arithmetic.
//
// The decoding payloads are VERBATIM shapes from
// `apps/api/test/weekly-planning-horizon.integration.test.ts`. The case that matters most
// is the one that test asserts explicitly — with Tasks switched off NO tag carries
// `primary`, and the bar must then open on "No tag" rather than on whatever is first.

private enum HorizonFailure: Error { case refused }

private let horizonSession = "33333333-3333-4333-8333-333333333333"
private let parkedNoteId = "44444444-4444-4444-8444-444444444444"

// MARK: - Decoding

@Suite struct PlanningHorizonDecodingTests {

    @Test func decodesTheTagsAndTheBoard() throws {
        let json = """
        {
          "tags": [
            {"stepKey":"connection","label":"Connection","hint":"It’s time with someone"},
            {"stepKey":"goals","label":"Goals","hint":"Somebody’s working on it"},
            {"stepKey":"meals","label":"Meals","hint":"It changes what we eat"},
            {"stepKey":"tasks","label":"Tasks","hint":"Someone owns it this week","primary":true},
            {"stepKey":"kids","label":"Kids","hint":"It’s about one of the kids"}
          ],
          "parked": [
            {"id":"\(parkedNoteId)","note":"Camping — we need to pack","stepKey":"tasks",
             "stepLabel":"Tasks","createdAt":"2026-09-02T18:04:11.000Z"},
            {"id":"55555555-5555-4555-8555-555555555555","note":"Something is coming up",
             "stepKey":null,"stepLabel":null,"createdAt":"2026-09-02T18:06:02.000Z"}
          ]
        }
        """
        let view = try WaffledAPI.decoder.decode(WaffledAPI.HorizonView.self, from: Data(json.utf8))

        #expect(view.tags.map(\.stepKey) == ["connection", "goals", "meals", "tasks", "kids"])
        // `primary` is OPTIONAL and absent on four of the five.
        #expect(view.tags.filter { $0.primary == true }.map(\.stepKey) == ["tasks"])
        #expect(view.tags[0].primary == nil)
        #expect(view.tags.first { $0.stepKey == "tasks" }?.label == "Tasks")
        #expect(view.parked.count == 2)
        #expect(view.parked[0].stepLabel == "Tasks")
        #expect(view.parked[1].stepKey == nil)
        #expect(view.parked[1].stepLabel == nil)
    }

    @Test func decodesTagsWithNoPrimary() throws {
        let json = """
        {"tags":[
           {"stepKey":"connection","label":"Connection","hint":"It’s time with someone"},
           {"stepKey":"goals","label":"Goals","hint":"Somebody’s working on it"},
           {"stepKey":"kids","label":"Kids","hint":"It’s about one of the kids"}],
         "parked":[]}
        """
        let view = try WaffledAPI.decoder.decode(WaffledAPI.HorizonView.self, from: Data(json.utf8))

        #expect(view.tags.count == 3)
        #expect(view.tags.allSatisfy { $0.primary == nil })
        #expect(view.parked.isEmpty)
    }

    @Test func decodesAViewWithNeitherKey() throws {
        let view = try WaffledAPI.decoder.decode(
            WaffledAPI.HorizonView.self, from: Data("{}".utf8))

        #expect(view.tags.isEmpty)
        #expect(view.parked.isEmpty)
    }
}

// MARK: - The month arithmetic

@Suite struct PlanningMonthTests {

    /// The month is read off the week-start STRING. A device in a negative offset parsing
    /// "2026-09-01" as a local instant gets August back — hence no `Date` anywhere near it.
    @Test func readsTheMonthOffTheWeekStartString() {
        #expect(PlanningMonth.month(of: "2026-09-06")?.year == 2026)
        #expect(PlanningMonth.month(of: "2026-09-06")?.month == 9)
        #expect(PlanningMonth.month(of: "2027-01-01")?.month == 1)
        #expect(PlanningMonth.month(of: "") == nil)
        #expect(PlanningMonth.month(of: "not-a-date") == nil)
        #expect(PlanningMonth.month(of: "2026-13-01") == nil)
    }

    @Test func stepsWholeMonthsAcrossTheYearBoundary() {
        // Compared field by field: a labelled tuple and a bare one are different types.
        let december = PlanningMonth.advance(year: 2026, month: 12, by: 1)
        #expect(december.year == 2027)
        #expect(december.month == 1)
        let fourAhead = PlanningMonth.advance(year: 2026, month: 9, by: 4)
        #expect(fourAhead.year == 2027)
        #expect(fourAhead.month == 1)
        let standingStill = PlanningMonth.advance(year: 2026, month: 1, by: 0)
        #expect(standingStill.year == 2026)
        #expect(standingStill.month == 1)
        let aYear = PlanningMonth.advance(year: 2026, month: 9, by: 12)
        #expect(aYear.year == 2027)
        #expect(aYear.month == 9)
    }

    @Test func labelsTheMonth() {
        #expect(PlanningMonth.label(year: 2026, month: 9) == "September 2026")
        #expect(PlanningMonth.label(year: 2026, month: 1) == "January 2026")
    }

    /// 42 cells, six full weeks, cut on the HOUSEHOLD's first day; days outside the month
    /// are marked so they can be dimmed rather than dropped.
    @Test func buildsFortyTwoCellsCutOnTheHouseholdsFirstDay() {
        let tz = TimeZone(identifier: "America/Chicago")!
        let sunday = PlanningMonth.cells(
            year: 2026, month: 9, tz: tz, firstDay: .sunday,
            eventsByDay: [:], countdownsByDate: [:], palette: EventPalette())
        let monday = PlanningMonth.cells(
            year: 2026, month: 9, tz: tz, firstDay: .monday,
            eventsByDay: [:], countdownsByDate: [:], palette: EventPalette())

        #expect(sunday.count == 42)
        #expect(monday.count == 42)
        // September 2026 starts on a Tuesday: a Sunday-cut grid leads with Aug 30.
        #expect(sunday.first?.key == "2026-08-30")
        #expect(monday.first?.key == "2026-08-31")
        #expect(sunday.first?.inMonth == false)
        #expect(sunday.contains { $0.key == "2026-09-01" && $0.inMonth })
        #expect(sunday.last?.inMonth == false)
        #expect(sunday.filter(\.inMonth).count == 30)
    }

    @Test func resolvesDotsAndTheCountdownBadge() {
        let tz = TimeZone(identifier: "America/Chicago")!
        let day = "2026-09-08"
        let events = [
            event(id: "1", day: day, colorHex: "#2F7FED"),
            event(id: "2", day: day, colorHex: "#2F7FED"),
            event(id: "3", day: day, colorHex: "#E0548B"),
        ]
        let badgeDay = "2026-09-10"
        let countdowns = [
            countdown(id: "c1", date: badgeDay, daysLeft: 5, emoji: "🎂"),
            countdown(id: "c2", date: badgeDay, daysLeft: 5, emoji: nil),
        ]

        let cells = PlanningMonth.cells(
            year: 2026, month: 9, tz: tz, firstDay: .sunday,
            eventsByDay: [day: events], countdownsByDate: [badgeDay: countdowns],
            palette: EventPalette())

        let dotted = cells.first { $0.key == day }
        #expect(dotted?.dotHexes == ["#2F7FED", "#E0548B"])
        #expect(dotted?.countdownEmoji == nil)

        let badged = cells.first { $0.key == badgeDay }
        #expect(badged?.countdownEmoji == "🎂")
        #expect(badged?.countdownLabel == "5d")
        #expect(badged?.extraCountdowns == 1)
        let empty = cells.first { $0.key == "2026-09-09" }
        #expect(empty?.dotHexes.isEmpty == true)
        #expect(empty?.countdownLabel == nil)
    }

    private func event(id: String, day: String, colorHex: String) -> SyncedEvent {
        SyncedEvent(
            id: id, title: "An event", startsAtRaw: "\(day) 17:00:00+00",
            startsAt: nil, allDay: false, personId: "p1", colorHex: colorHex, emoji: nil)
    }

    private func countdown(id: String, date: String, daysLeft: Int, emoji: String?) -> WaffledAPI.Countdown {
        WaffledAPI.Countdown(
            id: id, title: "Something", date: date, daysLeft: daysLeft, source: "standalone",
            emoji: emoji, color: nil, personId: nil)
    }
}

// MARK: - The model

@MainActor
private final class HorizonFeed {
    var snapshot: WaffledAPI.HorizonView
    var fetchFails = false
    var parkFails = false
    var updateFails = false
    var fetchCount = 0
    var parkCalls: [(note: String, stepKey: String?, sessionId: String)] = []
    /// `stepKey` is DOUBLY optional on the way out: absent leaves the tag alone, and
    /// `.some(nil)` is the real answer "No tag".
    var updateCalls: [(id: String, note: String?, stepKey: String??, sessionId: String)] = []

    init(snapshot: WaffledAPI.HorizonView) { self.snapshot = snapshot }
}

private func tag(_ key: String, _ label: String, primary: Bool? = nil) -> WaffledAPI.HorizonTag {
    WaffledAPI.HorizonTag(stepKey: key, label: label, hint: "because", primary: primary)
}

private let fullTags = [
    tag("connection", "Connection"),
    tag("goals", "Goals"),
    tag("meals", "Meals"),
    tag("tasks", "Tasks", primary: true),
    tag("kids", "Kids"),
]

@MainActor
private func model(_ feed: HorizonFeed) -> PlanningHorizonModel {
    PlanningHorizonModel(
        fetchHorizon: { _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw HorizonFailure.refused }
            return feed.snapshot
        },
        parkNote: { note, stepKey, sessionId in
            feed.parkCalls.append((note, stepKey, sessionId))
            if feed.parkFails { throw HorizonFailure.refused }
            return WaffledAPI.PlanningParkedItem(
                id: parkedNoteId, note: note, stepKey: stepKey, status: "open",
                sessionId: sessionId, createdAt: "2026-09-02T18:04:11.000Z")
        },
        updateNote: { id, note, stepKey, sessionId in
            feed.updateCalls.append((id, note, stepKey, sessionId))
            if feed.updateFails { throw HorizonFailure.refused }
            // The row the SERVER wrote: it echoes the whole note back, so an omitted field
            // comes back unchanged rather than nil.
            let existing = feed.snapshot.parked.first { $0.id == id }
            return WaffledAPI.PlanningParkedItem(
                id: id, note: note ?? existing?.note ?? "",
                stepKey: stepKey ?? existing?.stepKey, status: "open",
                sessionId: sessionId, createdAt: existing?.createdAt ?? "2026-09-02T18:04:11.000Z")
        })
}

@MainActor
@Suite struct PlanningHorizonModelTests {

    /// THREE STATES, NOT TWO. `unset` is "nobody has chosen" and resolves to the server's
    /// primary; `noTag` is the deliberate answer. Collapsing them loses the default.
    @Test func theTagStartsOnTheServersPrimary() async {
        let feed = HorizonFeed(snapshot: WaffledAPI.HorizonView(tags: fullTags, parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(m.tagChoice == .unset)
        #expect(m.chosenStepKey == "tasks")
        #expect(m.chosenLabel == "Tasks")

        m.tagChoice = .step("meals")
        #expect(m.chosenStepKey == "meals")
        #expect(m.chosenLabel == "Meals")

        m.tagChoice = .noTag
        #expect(m.chosenStepKey == nil)
        #expect(m.chosenLabel == nil)
    }

    @Test func withNoPrimaryTheBarOpensOnNoTag() async {
        let feed = HorizonFeed(
            snapshot: WaffledAPI.HorizonView(
                tags: [tag("connection", "Connection"), tag("goals", "Goals")], parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(m.chosenStepKey == nil)
        #expect(m.chosenLabel == nil)
    }

    @Test func parksWithATag() async {
        let feed = HorizonFeed(snapshot: WaffledAPI.HorizonView(tags: fullTags, parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)
        m.tagChoice = .step("meals")

        #expect(await m.park("  Camping — we need to pack  ", sessionId: horizonSession))

        #expect(feed.parkCalls.last?.stepKey == "meals")
        #expect(feed.parkCalls.last?.note == "Camping — we need to pack")
        #expect(feed.parkCalls.last?.sessionId == horizonSession)
        #expect(m.parked.count == 1)
        #expect(m.parked[0].id == parkedNoteId)
        #expect(m.parked[0].stepLabel == "Meals")
        #expect(m.parked[0].createdAt == "2026-09-02T18:04:11.000Z")
        // Reset for the next note in the burst — back to the primary, not to "meals".
        #expect(m.tagChoice == .unset)
        #expect(m.chosenStepKey == "tasks")
        #expect(m.decisionData["parked"] == .int(1))
    }

    @Test func parksWithoutATag() async {
        let feed = HorizonFeed(snapshot: WaffledAPI.HorizonView(tags: fullTags, parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)
        m.tagChoice = .noTag

        #expect(await m.park("Something is coming up", sessionId: horizonSession))

        #expect(feed.parkCalls.count == 1)
        #expect(feed.parkCalls[0].stepKey == nil)
        #expect(m.parked[0].stepKey == nil)
        #expect(m.parked[0].stepLabel == nil)
    }

    /// A REFUSED PARK LEAVES THE BOARD ALONE and keeps the server's sentence — the note is
    /// capped at 500 characters, so a refusal is reachable rather than theoretical.
    @Test func aRefusedParkChangesNothing() async {
        let feed = HorizonFeed(
            snapshot: WaffledAPI.HorizonView(
                tags: fullTags,
                parked: [
                    WaffledAPI.HorizonNote(
                        id: parkedNoteId, note: "Already here", stepKey: nil, stepLabel: nil,
                        createdAt: "2026-09-02T17:00:00.000Z")
                ]))
        feed.parkFails = true
        let m = model(feed)
        await m.load(sessionId: horizonSession)
        m.tagChoice = .step("kids")

        #expect(await m.park("Camping", sessionId: horizonSession) == false)

        #expect(m.parked.map(\.note) == ["Already here"])
        #expect(m.errorMessage == LooseEndCopy.writeFailed)
        #expect(m.parking == false)
        #expect(m.tagChoice == .step("kids"))
        #expect(m.decisionData["parked"] == .int(1))
    }

    @Test func anEmptyNoteNeverLeavesTheDevice() async {
        let feed = HorizonFeed(snapshot: WaffledAPI.HorizonView(tags: fullTags, parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(await m.park("   ", sessionId: horizonSession) == false)

        #expect(feed.parkCalls.isEmpty)
        #expect(m.errorMessage == nil)
    }

    /// A failed refresh still counts as loaded — the shared REST loading contract.
    @Test func aFailedRefreshKeepsTheTagsAndTheBoard() async {
        let feed = HorizonFeed(snapshot: WaffledAPI.HorizonView(tags: fullTags, parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)
        feed.fetchFails = true

        await m.load(sessionId: horizonSession)

        #expect(m.loaded)
        #expect(m.tags.count == 5)
        #expect(feed.fetchCount == 2)
    }

    /// The crumb is COUNTS ONLY: the board is read back from the table that owns it.
    @Test func theCrumbIsCountsOnly() async {
        let feed = HorizonFeed(snapshot: WaffledAPI.HorizonView(tags: fullTags, parked: []))
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        m.recordEventAdded()
        m.recordEventAdded()
        #expect(await m.park("A note", sessionId: horizonSession))

        #expect(m.decisionData == ["added": .int(2), "parked": .int(1)])
    }
}

// MARK: - Editing a note that is already parked

@MainActor
@Suite struct PlanningParkedNoteEditTests {

    private func board() -> HorizonFeed {
        HorizonFeed(
            snapshot: WaffledAPI.HorizonView(
                tags: fullTags,
                parked: [
                    WaffledAPI.HorizonNote(
                        id: parkedNoteId, note: "by the poster bored", stepKey: "tasks",
                        stepLabel: "Tasks", createdAt: "2026-09-02T18:04:11.000Z"),
                    WaffledAPI.HorizonNote(
                        id: "55555555-5555-4555-8555-555555555555", note: "Something else",
                        stepKey: nil, stepLabel: nil, createdAt: "2026-09-02T18:06:02.000Z"),
                ]))
    }

    /// Fixing the words sends ONLY the words: `stepKey` absent means "leave the tag alone",
    /// and sending it unchanged would rewrite this note's route entry for nothing.
    @Test func rewritesTheWordsAndSendsNothingElse() async {
        let feed = board()
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(await m.update(
            id: parkedNoteId, note: "buy the poster board", stepKey: nil,
            sessionId: horizonSession))

        #expect(feed.updateCalls.count == 1)
        #expect(feed.updateCalls[0].id == parkedNoteId)
        #expect(feed.updateCalls[0].note == "buy the poster board")
        // Absent, not null: `.none` is "leave it alone".
        #expect(feed.updateCalls[0].stepKey == nil)
        #expect(feed.updateCalls[0].sessionId == horizonSession)

        #expect(m.parked[0].note == "buy the poster board")
        #expect(m.parked[0].stepKey == "tasks")
        #expect(m.parked[0].stepLabel == "Tasks")
        #expect(m.parked.map(\.id) == [parkedNoteId, "55555555-5555-4555-8555-555555555555"])
        #expect(m.errorMessage == nil)
    }

    /// The label is re-joined from the CATALOG, never stored — so retitling a step renames
    /// every badge.
    @Test func movesTheTagAndRelabelsFromTheCatalog() async {
        let feed = board()
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(await m.update(
            id: parkedNoteId, note: nil, stepKey: .some("meals"), sessionId: horizonSession))

        #expect(feed.updateCalls[0].note == nil)
        #expect(feed.updateCalls[0].stepKey == .some(.some("meals")))
        #expect(m.parked[0].stepKey == "meals")
        #expect(m.parked[0].stepLabel == "Meals")
        #expect(m.parked[0].note == "by the poster bored")
    }

    /// "No tag" is an answer an EDIT can give, not only a park: `.some(nil)` sends `null`.
    @Test func takingTheTagOffSendsAnExplicitNull() async {
        let feed = board()
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(await m.update(
            id: parkedNoteId, note: nil, stepKey: .some(nil), sessionId: horizonSession))

        // The distinction the double optional exists for: touched, and set to nothing.
        #expect(feed.updateCalls[0].stepKey != nil)
        #expect(feed.updateCalls[0].stepKey! == nil)
        #expect(m.parked[0].stepKey == nil)
        #expect(m.parked[0].stepLabel == nil)
    }

    /// A REFUSED EDIT LEAVES THE BOARD ALONE and keeps the server's sentence.
    @Test func aRefusedEditChangesNothing() async {
        let feed = board()
        feed.updateFails = true
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(await m.update(
            id: parkedNoteId, note: "something new", stepKey: .some("meals"),
            sessionId: horizonSession) == false)

        #expect(m.parked[0].note == "by the poster bored")
        #expect(m.parked[0].stepKey == "tasks")
        #expect(m.errorMessage == LooseEndCopy.writeFailed)
        #expect(m.parking == false)
    }

    /// An id the board doesn't hold cannot corrupt it — the gold box shows notes that are
    /// not session-scoped, so a stale row is a real possibility.
    @Test func anUnknownIdLeavesTheBoardUntouched() async {
        let feed = board()
        let m = model(feed)
        await m.load(sessionId: horizonSession)

        #expect(await m.update(
            id: "99999999-9999-4999-8999-999999999999", note: "elsewhere", stepKey: nil,
            sessionId: horizonSession))

        #expect(m.parked.map(\.note) == ["by the poster bored", "Something else"])
    }
}
