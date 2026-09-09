import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 4 (Family night).
//
// THE PRESENCE TESTS ARE THE POINT OF THIS FILE. The occurrence endpoint reads whether a
// KEY WAS SENT, not its value, so "clear the theme" and "leave the theme alone" are two
// different bodies — and a detail-only write carrying `personId` un-assigns whoever had
// that part. `assertKeys` asserts the exact key SET, so a later tidy-up that adds
// `personId: null` "for symmetry" fails here.

private enum PlanningFamilyNightFailure: Error { case rejected }

// MARK: - Reading a body

/// The object inside `assignments[i]`, EMPTY when the body isn't shaped that way, so every
/// lookup is a SINGLE optional: with `[String: JSONValue]?`, `fields?["personId"] == nil`
/// compares the OUTER optional and the presence test passes for the wrong reason.
private func assignment(_ body: [String: JSONValue], _ index: Int = 0) -> [String: JSONValue] {
    guard case let .array(items)? = body["assignments"], index < items.count,
          case let .object(fields) = items[index] else { return [:] }
    return fields
}

private func assertKeys(_ fields: [String: JSONValue], _ expected: Set<String>,
                        _ what: String, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(Set(fields.keys) == expected, "\(what) sent \(Set(fields.keys).sorted())",
            sourceLocation: sourceLocation)
}

// MARK: - The board, VERBATIM off the wire
//
// Field-for-field what `getFamilyNightBoard` returns and what
// `apps/api/test/weekly-planning-familyNight.integration.test.ts` asserts against.
private let boardJSON = Data("""
{
  "weekStart": "2026-09-06",
  "date": "2026-09-09",
  "dayOfWeek": 3,
  "time": "17:00",
  "occurrenceId": "5c1f0a2e-0000-4000-8000-000000000001",
  "theme": "pizza and the new Lego set",
  "status": "planned",
  "onCalendar": true,
  "eventId": "5c1f0a2e-0000-4000-8000-000000000002",
  "eventTitle": "Family Night",
  "eventWhen": "Wednesday 5:00 PM",
  "members": [
    { "id": "p-kevin", "name": "Kevin", "avatarEmoji": null, "colorHex": null },
    { "id": "p-kelly", "name": "Kelly", "avatarEmoji": "🦊", "colorHex": "#E0653F" },
    { "id": "p-wally", "name": "Wally", "avatarEmoji": "🐢", "colorHex": "#25A368" },
    { "id": "p-lottie", "name": "Lottie", "avatarEmoji": "🦄", "colorHex": "#7A5AF8" }
  ],
  "parts": [
    { "partId": "activity", "label": "Activity", "emoji": "🎲", "rotates": true,
      "detail": null, "personId": "p-kevin", "personName": "Kevin", "pinned": false },
    { "partId": "treat", "label": "Treat", "emoji": "🍨", "rotates": true,
      "detail": "the good ice cream", "personId": "p-lottie", "personName": "Lottie", "pinned": true },
    { "partId": "checkin", "label": "Check-in", "emoji": "💬", "rotates": false,
      "detail": null, "personId": null, "personName": null, "pinned": false }
  ]
}
""".utf8)

private func decodedBoard() throws -> WaffledAPI.PlanningFamilyNightBoard {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningFamilyNightBoard.self, from: boardJSON)
}

// MARK: - The feed

@MainActor
private final class FamilyNightBoardFeed {
    var board: WaffledAPI.PlanningFamilyNightBoard
    var fetchFails = false
    var saveFails = false
    var fetchCount = 0
    var bodies: [[String: JSONValue]] = []

    init(_ board: WaffledAPI.PlanningFamilyNightBoard) { self.board = board }
}

@MainActor
private func model(_ feed: FamilyNightBoardFeed) -> PlanningFamilyNightModel {
    PlanningFamilyNightModel(
        fetchBoard: { _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw PlanningFamilyNightFailure.rejected }
            return feed.board
        },
        saveOccurrence: { body in
            feed.bodies.append(body)
            if feed.saveFails { throw PlanningFamilyNightFailure.rejected }
        },
        fetchWeekEvents: { _, _ in [] })
}

// MARK: - Tests

@MainActor
@Suite struct PlanningFamilyNightStepTests {


    @Test func detailWriteCarriesNoPersonKey() {
        let body = PlanningFamilyNightBody.setDetail(date: "2026-09-09", partId: "treat",
                                                     detail: "the good ice cream")
        assertKeys(body, ["date", "assignments"], "the detail body")
        // The server reads presence, so `personId: null` would mean "and nobody has the
        // treat". It must not be in the dictionary AT ALL.
        assertKeys(assignment(body), ["partId", "detail"], "the detail assignment")
        #expect(!assignment(body).keys.contains("personId"),
                "personId must not be in a detail body AT ALL — not even as null")
        #expect(assignment(body)["detail"] == JSONValue.string("the good ice cream"))
    }

    @Test func detailWriteClearsWithAnEmptyStringRatherThanAMissingKey() {
        let body = PlanningFamilyNightBody.setDetail(date: "2026-09-09", partId: "treat", detail: "")
        // '' CLEARS; an absent `detail` key means "leave whatever is there".
        assertKeys(assignment(body), ["partId", "detail"], "the cleared detail assignment")
        #expect(assignment(body)["detail"] == JSONValue.string(""))
    }

    @Test func pinAlwaysCarriesAPersonKey() {
        let body = PlanningFamilyNightBody.pin(date: "2026-09-09", partId: "treat", personId: "p-wally")
        assertKeys(assignment(body), ["partId", "personId"], "the pin assignment")
        #expect(assignment(body)["personId"] == JSONValue.string("p-wally"))
        #expect(!assignment(body).keys.contains("detail"))
    }

    @Test func pinningNobodyWritesARealNobodyYetRatherThanOmittingTheKey() {
        let body = PlanningFamilyNightBody.pin(date: "2026-09-09", partId: "treat", personId: nil)
        assertKeys(assignment(body), ["partId", "personId"], "the nobody-yet assignment")
        // The module's upsert can write an assignment but never delete one, so this is
        // "nobody yet", not "back on rotation".
        #expect(assignment(body)["personId"] == JSONValue.null)
    }

    @Test func themeClearsWithAnEmptyStringAndNeverWithAMissingKey() {
        assertKeys(PlanningFamilyNightBody.setTheme(date: "2026-09-09", theme: ""),
                   ["date", "theme"], "the cleared theme body")
        #expect(PlanningFamilyNightBody.setTheme(date: "2026-09-09", theme: "")["theme"] == JSONValue.string(""))
        #expect(PlanningFamilyNightBody.setTheme(date: "2026-09-09", theme: "movie night")["theme"]
                == JSONValue.string("movie night"))
    }

    @Test func statusBodyIsUndoableBothWays() {
        for status in ["skipped", "planned"] {
            let body = PlanningFamilyNightBody.setStatus(date: "2026-09-09", status: status)
            assertKeys(body, ["date", "status"], "the \(status) body")
            #expect(body["status"] == JSONValue.string(status))
        }
    }

    @Test func unlinkingSendsAnExplicitNullSoTheEventItselfSurvives() {
        let body = PlanningFamilyNightBody.linkEvent(date: "2026-09-09", eventId: nil)
        assertKeys(body, ["date", "eventId"], "the unlink body")
        // An absent key means "leave the link alone", so `null` is the only way to say
        // "this isn't family night after all" — and it never deletes Friday.
        #expect(body["eventId"] == JSONValue.null)
    }

    @Test func addToCalendarAsksTheSERVERToMakeTheEvent() {
        let body = PlanningFamilyNightBody.addEvent(date: "2026-09-09")
        // Not create-then-adopt: a client-made event may have no server id yet.
        assertKeys(body, ["date", "createEvent"], "the add-to-calendar body")
        #expect(body["createEvent"] == JSONValue.bool(true))
        #expect(body["eventId"] == nil)
    }


    @Test func decodesTheBoardVerbatimOffTheWire() throws {
        let board = try decodedBoard()
        #expect(board.weekStart == "2026-09-06")
        #expect(board.date == "2026-09-09")
        #expect(board.dayOfWeek == 3)
        #expect(board.time == "17:00")
        #expect(board.status == "planned")
        #expect(!board.isSkipped)
        #expect(board.onCalendar)
        #expect(board.eventTitle == "Family Night")
        #expect(board.eventWhen == "Wednesday 5:00 PM")
        #expect(board.members.count == 4)
        #expect(board.members[0].avatarEmoji == nil)
        #expect(board.members[1].colorHex == "#E0653F")
        #expect(board.parts.map(\.partId) == ["activity", "treat", "checkin"])
        #expect(board.parts[0].pinned == false)
        #expect(board.parts[1].pinned == true)
        #expect(board.parts[1].detail == "the good ice cream")
        #expect(board.parts[2].rotates == false)
        #expect(board.parts[2].personName == nil)
    }


    @Test func theSublineTellsASuggestionApartFromADecision() throws {
        let board = try decodedBoard()
        #expect(PlanningFamilyNightFormat.suggestion(board.parts[0])
                == "suggested · Kevin, next in the rotation")
        #expect(PlanningFamilyNightFormat.suggestion(board.parts[1])
                == "pinned for this week · Lottie")
        #expect(PlanningFamilyNightFormat.suggestion(board.parts[2]) == "nobody yet")
    }

    @Test func detailHintsFallBackToThePartsOwnLabel() throws {
        let board = try decodedBoard()
        #expect(PlanningFamilyNightFormat.detailHint(board.parts[0]).contains("charades"))
        #expect(PlanningFamilyNightFormat.detailHint(board.parts[1]).contains("good ice cream"))
        #expect(PlanningFamilyNightFormat.detailHint(board.parts[2]).contains("how was school"))

        // A part this build has never heard of gets a question built from its OWN label.
        // Must NOT be asserted against a stock part — the fallback never reaches those.
        let custom = try #require(try? WaffledAPI.decoder.decode(
            WaffledAPI.PlanningFamilyNightPart.self,
            from: Data(#"{"partId":"service","label":"Service","emoji":"🤝","rotates":true,"detail":null,"personId":null,"personName":null,"pinned":false}"#.utf8)))
        #expect(PlanningFamilyNightFormat.detailHint(custom) == "optional — what's the service?")
    }

    @Test func theEventPickersWeekIsSteppedInWholeDaysOffTheServersBoundary() {
        #expect(PlanningFamilyNightFormat.plusDays("2026-09-06", 6) == "2026-09-12")
        #expect(PlanningFamilyNightFormat.plusDays("2026-10-29", 6) == "2026-11-04")
    }


    @Test func aFailedReadKeepsTheBoardThatWasAlreadyOnScreen() async throws {
        let feed = FamilyNightBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        feed.fetchFails = true

        await model.load(weekStart: "2026-09-06")

        #expect(model.board?.theme == "pizza and the new Lego set")
        #expect(model.loaded)
    }

    @Test func aFailedWriteNeitherRefetchesNorMutates() async throws {
        let feed = FamilyNightBoardFeed(try decodedBoard())
        feed.saveFails = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        let revBefore = model.rev

        let ok = await model.write(
            PlanningFamilyNightBody.setStatus(date: "2026-09-09", status: "skipped"),
            weekStart: "2026-09-06")

        #expect(!ok)
        #expect(feed.bodies.count == 1)
        #expect(feed.fetchCount == 1)          // the initial load only
        #expect(model.rev == revBefore)
        #expect(model.board?.status == "planned")
        #expect(model.errorMessage != nil)
    }

    @Test func aWriteThatLandsRereadsRatherThanPatchingLocally() async throws {
        let feed = FamilyNightBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        let ok = await model.write(
            PlanningFamilyNightBody.pin(date: "2026-09-09", partId: "activity", personId: "p-wally"),
            weekStart: "2026-09-06")

        #expect(ok)
        #expect(feed.fetchCount == 2)
        #expect(feed.bodies.count == 1)
        #expect(model.rows.count == 3)
        #expect(model.recurrence == "every Wednesday")
    }


    @Test func theCrumbRecordsWhatWasDecidedAndNotACopyOfTheModule() throws {
        let crumb = PlanningFamilyNightDecision.crumb(try decodedBoard())
        #expect(Set(crumb.keys) == ["pinned", "skipped"])
        #expect(crumb["pinned"] == JSONValue.array([.string("treat")]))
        #expect(crumb["skipped"] == JSONValue.bool(false))
    }

    @Test func theCrumbIsEmptyButWellFormedBeforeAnythingIsRead() {
        let crumb = PlanningFamilyNightDecision.crumb(nil)
        #expect(crumb["pinned"] == JSONValue.array([]))
        #expect(crumb["skipped"] == JSONValue.bool(false))
    }
}
