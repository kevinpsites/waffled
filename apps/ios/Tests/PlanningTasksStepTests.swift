import Foundation
import Testing
import UniformTypeIdentifiers
@testable import Waffled

// Weekly Planning · step 8 (Tasks). Two things here are worth more than the rest:
//
//  1. A reassignment is TWO writes — the chore PATCH plus an assign for EVERY entry in
//     `pendingInstanceIds`. Miss the second half and the move "doesn't stick". The take-back
//     direction must send an EXPLICIT null: a PATCH with the key left out means "change
//     nothing", so `if let personId` would make it a silent no-op.
//  2. The verb this step lends the shell's parked-note banner must report `false` when the
//     composer is cancelled, or the only record that the thing still needs doing is lost.

private enum PlanningTasksFailure: Error { case rejected }

// MARK: - The board, VERBATIM off the wire
// Field-for-field what `getTasksBoard` returns and what
// `apps/api/test/weekly-planning-tasks.integration.test.ts` asserts against.
private let boardJSON = Data("""
{
  "weekStart": "2026-09-06",
  "newTaskDay": "2026-09-06",
  "people": [
    { "id": "p-kevin", "name": "Kevin", "avatarEmoji": null, "colorHex": null,
      "memberType": "adult", "isAdmin": true, "recurringChores": 0, "chores": [] },
    { "id": "p-wally", "name": "Wally", "avatarEmoji": "🐢", "colorHex": "#25A368",
      "memberType": "kid", "isAdmin": false, "recurringChores": 2, "chores": [
        { "id": "c-trash", "title": "Take out the trash", "emoji": "🗑️",
          "rrule": "FREQ=WEEKLY;BYDAY=MO,TH", "cadence": "weekly",
          "days": ["2026-09-07", "2026-09-10"], "dueOn": null, "dueTime": "07:30",
          "carriedOver": false, "rewardAmount": 3, "rewardCurrency": "stars",
          "requiresApproval": true, "requiresPhoto": true,
          "pendingInstanceIds": ["i-trash-mon", "i-trash-thu"] }
      ] },
    { "id": "p-lottie", "name": "Lottie", "avatarEmoji": "🦄", "colorHex": "#7A5AF8",
      "memberType": "kid", "isAdmin": false, "recurringChores": 1, "chores": [
        { "id": "c-library", "title": "Return the library books", "emoji": null,
          "rrule": null, "cadence": "once",
          "days": [], "dueOn": "2026-09-02", "dueTime": null,
          "carriedOver": true, "rewardAmount": 0, "rewardCurrency": null,
          "requiresApproval": false, "requiresPhoto": false,
          "pendingInstanceIds": ["i-library"] }
      ] }
  ],
  "unassigned": [
    { "id": "c-sitter", "title": "Book the sitter", "emoji": null,
      "rrule": null, "cadence": "once",
      "days": [], "dueOn": null, "dueTime": null,
      "carriedOver": false, "rewardAmount": 1.5, "rewardCurrency": null,
      "requiresApproval": false, "requiresPhoto": false,
      "pendingInstanceIds": [] }
  ]
}
""".utf8)

private func decodedBoard() throws -> WaffledAPI.PlanningTasksBoard {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningTasksBoard.self, from: boardJSON)
}

/// One card, decoded — fixtures are built the way the app gets them rather than by a
/// memberwise initializer, so a wire-shape change breaks the test too.
private func chore(_ json: String) throws -> WaffledAPI.PlanningTasksChore {
    try WaffledAPI.decoder.decode(WaffledAPI.PlanningTasksChore.self, from: Data(json.utf8))
}

private func card(id: String = "c-x", cadence: String, days: [String] = [], dueOn: String? = nil,
                  dueTime: String? = nil, carriedOver: Bool = false) throws -> WaffledAPI.PlanningTasksChore {
    let daysJSON = days.map { "\"\($0)\"" }.joined(separator: ",")
    return try chore("""
    { "id": "\(id)", "title": "A task", "emoji": null, "rrule": null,
      "cadence": "\(cadence)", "days": [\(daysJSON)],
      "dueOn": \(dueOn.map { "\"\($0)\"" } ?? "null"),
      "dueTime": \(dueTime.map { "\"\($0)\"" } ?? "null"),
      "carriedOver": \(carriedOver), "rewardAmount": 0, "rewardCurrency": null,
      "requiresApproval": false, "requiresPhoto": false, "pendingInstanceIds": [] }
    """)
}

// MARK: - The feed

@MainActor
private final class TasksBoardFeed {
    var board: WaffledAPI.PlanningTasksBoard
    var fetchFails = false
    var handOutFails = false
    var saveFails = false
    var fetchCount = 0
    var handOuts: [(choreId: String, personId: String?)] = []
    var saves: [(choreId: String?, body: [String: JSONValue])] = []

    init(_ board: WaffledAPI.PlanningTasksBoard) { self.board = board }
}

@MainActor
private func model(_ feed: TasksBoardFeed) -> PlanningTasksModel {
    PlanningTasksModel(
        fetchBoard: { _ in
            feed.fetchCount += 1
            if feed.fetchFails { throw PlanningTasksFailure.rejected }
            return feed.board
        },
        handOut: { chore, personId in
            feed.handOuts.append((chore.id, personId))
            if feed.handOutFails { throw PlanningTasksFailure.rejected }
        },
        saveChore: { choreId, body in
            feed.saves.append((choreId, body))
            if feed.saveFails { throw PlanningTasksFailure.rejected }
        })
}

// MARK: - Tests

@MainActor
@Suite struct PlanningTasksStepTests {

    // ── The two-write hand-out ──────────────────────────────────────────────────

    @Test func handingATaskOverMovesTheDefinitionAndEveryOpenInstance() throws {
        let board = try decodedBoard()
        let trash = try #require(board.people.first { $0.name == "Wally" }?.chores.first)
        let plan = PlanningTasksHandOut.plan(trash, to: "p-lottie")

        #expect(plan.choreId == "c-trash")
        #expect(plan.patch == ["personId": .string("p-lottie")])
        // ALL of them, not just the first. `updateChore` only cascades from today
        // forward, so the days already behind us have to be moved by hand.
        #expect(plan.instanceIds == ["i-trash-mon", "i-trash-thu"])
        #expect(plan.personId == "p-lottie")
    }

    @Test func takingATaskBackSendsAnExplicitNullRatherThanOmittingTheKey() throws {
        let board = try decodedBoard()
        let trash = try #require(board.people.first { $0.name == "Wally" }?.chores.first)
        let plan = PlanningTasksHandOut.plan(trash, to: nil)

        // PRESENCE AGAIN: a PATCH body with `personId` left out means "change nothing",
        // so `if let personId` here would make the take-back a silent no-op.
        #expect(Set(plan.patch.keys) == ["personId"], "the take-back patch sent \(plan.patch.keys.sorted())")
        #expect(plan.patch["personId"] == JSONValue.null)
        // Both DIRECTIONS move the open instances, or the Chores board keeps showing a
        // name this board doesn't.
        #expect(plan.instanceIds == ["i-trash-mon", "i-trash-thu"])
        #expect(plan.personId == nil)
    }

    @Test func aTaskWithNoOpenInstancesIsJustThePatch() throws {
        let board = try decodedBoard()
        let sitter = try #require(board.unassigned.first)
        #expect(PlanningTasksHandOut.plan(sitter, to: "p-kevin").instanceIds.isEmpty)
    }

    // ── The lent verb ───────────────────────────────────────────────────────────

    @Test func theLentVerbReportsFalseWhenTheComposerIsCancelled() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        var reported: Bool?
        model.beginHandoff(note: "book the sitter") { reported = $0 }

        guard case let .add(personId, note)? = model.composer else {
            Issue.record("the handoff didn't open the add composer")
            return
        }
        #expect(personId == nil)
        #expect(note == "book the sitter")
        #expect(reported == nil, "nothing has been decided yet")

        let saved = model.composerDismissed()

        #expect(saved == false)
        // THE POINT: settling the note here would throw away the only record that the
        // thing still needs doing, on the strength of somebody opening a box and closing
        // it again.
        #expect(reported == false)
        #expect(feed.saves.isEmpty)
    }

    @Test func theLentVerbReportsTrueOnlyOnceATaskReallyExists() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        var reported: Bool?
        model.beginHandoff(note: "book the sitter") { reported = $0 }
        let error = await model.saveFromComposer(choreId: nil, body: ["title": .string("Book the sitter")])
        #expect(error == nil)
        #expect(reported == nil, "the sheet is still up — nothing is settled until it closes")

        let saved = model.composerDismissed()

        #expect(saved)
        #expect(reported == true)
        #expect(feed.saves.count == 1)
        #expect(feed.saves.first?.choreId == nil, "a nil chore id creates rather than edits")
    }

    @Test func aFailedSaveKeepsTheSheetUpAndLeavesTheNoteUnsettled() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        feed.saveFails = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        var reported: Bool?
        model.beginHandoff(note: "book the sitter") { reported = $0 }
        let error = await model.saveFromComposer(choreId: nil, body: [:])

        // A message rather than nil, so the sheet stays open and says why instead of
        // dismissing.
        #expect(error != nil)
        #expect(reported == nil)
        #expect(model.composerDismissed() == false)
        #expect(reported == false)
    }

    @Test func abandoningTheStepWithdrawsAnOpenHandoffRatherThanLeavingItWaiting() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        var reported: Bool?
        model.beginHandoff(note: "book the sitter") { reported = $0 }
        model.abandonHandoff()

        #expect(reported == false)
    }

    // ── The loading contract ────────────────────────────────────────────────────

    @Test func aFailedReadKeepsTheBoardThatWasAlreadyOnScreen() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        feed.fetchFails = true

        await model.load(weekStart: "2026-09-06")

        #expect(model.board?.people.count == 3)
        #expect(model.loaded)
    }

    // A FAILED HAND-OUT RE-READS THE BOARD. Handing a chore over is TWO writes (the chore
    // definition, then each pending instance), so a throw from the second leaves the
    // first already applied — "nothing moved" is not a premise this can rely on.
    //
    // The tally still does NOT move: it counts what this session decided, and a
    // half-landed write decided nothing. Only the board is re-read, because only the
    // server knows which half took.
    @Test func aFailedHandOutRereadsTheBoardAndTalliesNothing() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        feed.handOutFails = true
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        let sitter = try #require(model.board?.unassigned.first)

        let ok = await model.give(sitter, to: "p-wally", weekStart: "2026-09-06")

        #expect(!ok)
        #expect(feed.handOuts.count == 1)
        #expect(feed.fetchCount == 2)          // the initial load, then the re-read
        #expect(model.assigned == 0)           // nothing this session decided
        #expect(model.errorMessage != nil)
        // The message may not claim the chore stayed put — it cannot know that.
        #expect(model.errorMessage?.contains("stayed where it was") != true)
    }

    @Test func theTallyUndoesItselfOnATakeBackSoTheRecapCantOverReport() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")
        let sitter = try #require(model.board?.unassigned.first)

        let handedOver = await model.give(sitter, to: "p-wally", weekStart: "2026-09-06")
        #expect(handedOver)
        #expect(model.assigned == 1)
        let takenBack = await model.give(sitter, to: nil, weekStart: "2026-09-06")
        #expect(takenBack)
        #expect(model.assigned == 0)
        // Re-read rather than bookkeeping: a column is the WEEK, and the server owns it.
        #expect(feed.fetchCount == 3)
        #expect(feed.handOuts.map(\.personId) == ["p-wally", nil])
    }

    // ── Decoding ────────────────────────────────────────────────────────────────

    @Test func decodesTheBoardVerbatimOffTheWire() throws {
        let board = try decodedBoard()
        #expect(board.weekStart == "2026-09-06")
        // Server-owned, so "add a task" on a Wednesday while planning next week can't
        // quietly date it to that Wednesday.
        #expect(board.newTaskDay == "2026-09-06")
        #expect(board.people.map(\.name) == ["Kevin", "Wally", "Lottie"])
        #expect(board.people[0].isAdmin)
        #expect(board.people[1].recurringChores == 2)

        let trash = try #require(board.people[1].chores.first)
        #expect(trash.cadence == "weekly")
        #expect(trash.days == ["2026-09-07", "2026-09-10"])
        #expect(trash.dueOn == nil)
        #expect(trash.dueTime == "07:30")
        #expect(trash.rewardAmount == 3)
        // Carried so the editor prefills honestly — a missing flag reads as false, which
        // would switch approval or photo proof off the first time anybody fixed a typo.
        #expect(trash.requiresApproval)
        #expect(trash.requiresPhoto)
        #expect(trash.pendingInstanceIds == ["i-trash-mon", "i-trash-thu"])

        let library = try #require(board.people[2].chores.first)
        #expect(library.carriedOver)
        #expect(library.dueOn == "2026-09-02")

        #expect(board.unassigned.map(\.title) == ["Book the sitter"])
        #expect(board.unassigned[0].rewardAmount == 1.5)
    }

    // ── The chip, which is every fact the server handed us and no guess ──────────

    @Test func theDayChipNamesWhatTheServerSaidAndNothingElse() throws {
        let board = try decodedBoard()
        let trash = try #require(board.people[1].chores.first)
        #expect(PlanningTasksFormat.dayChip(trash) == "Mon, Thu 7:30am")

        let library = try #require(board.people[2].chores.first)
        // Carried over wins over the day it was for: it arrives in the week without
        // belonging to a day in it.
        #expect(PlanningTasksFormat.dayChip(library) == "Carried over")

        #expect(PlanningTasksFormat.dayChip(try card(cadence: "daily", days: [
            "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09",
            "2026-09-10", "2026-09-11", "2026-09-12",
        ])) == "Every day")
        // A one-off dated outside the week still says which day it is for.
        #expect(PlanningTasksFormat.dayChip(try card(cadence: "once", dueOn: "2026-09-21")) == "Sep 21")
        #expect(PlanningTasksFormat.dayChip(try card(cadence: "once")) == "No day set")
        #expect(PlanningTasksFormat.shortTime("00:00") == "12am")
        #expect(PlanningTasksFormat.shortTime("12:05") == "12:05pm")
        #expect(PlanningTasksFormat.shortTime(nil) == "")
    }

    @Test func onlyAOneOffsDayCanBeSetFromTheBoard() throws {
        // A recurring chore's days come from its rrule, which belongs to the chore
        // editor, not to a chip on a board.
        #expect(PlanningTasksFormat.dayIsSettable(try card(cadence: "once")))
        #expect(!PlanningTasksFormat.dayIsSettable(try card(cadence: "weekly", days: ["2026-09-07"])))
        #expect(PlanningTasksFormat.dayIsUnset(try card(cadence: "once")))
        #expect(!PlanningTasksFormat.dayIsUnset(try card(cadence: "once", carriedOver: true)))
    }

    @Test func provenanceOnlyClaimsWhatTheChoresModuleCanSay() throws {
        #expect(PlanningTasksFormat.provenance(try card(cadence: "once")) == "One-off task")
        #expect(PlanningTasksFormat.provenance(try card(cadence: "weekly")) == "Recurring chore")
        #expect(PlanningTasksFormat.provenance(try card(cadence: "once", carriedOver: true))
                == "Left over from before this week")
    }

    @Test func theFairnessLineIsStatedRatherThanScored() {
        #expect(PlanningTasksFormat.carriesLabel(0) == "No recurring chores yet")
        #expect(PlanningTasksFormat.carriesLabel(1) == "Carries 1 recurring chore")
        #expect(PlanningTasksFormat.carriesLabel(4) == "Carries 4 recurring chores")
    }

    // ── Bridging into the app's own chore editor ─────────────────────────────────

    @Test func aCardOpensTheAppsChoreEditorWithoutLosingAnySetting() throws {
        let board = try decodedBoard()
        let trash = try #require(board.people[1].chores.first)
        let instance = try #require(trash.asChoreInstance(owner: "p-wally"))

        #expect(instance.choreId == "c-trash")
        #expect(instance.choreTitle == "Take out the trash")
        // The column IS the assignee — a chore's "Who" is not on the board payload.
        #expect(instance.personId == "p-wally")
        // An INT, because the DTO decodes rewardAmount with `(try? Int.self) ?? 0`: a
        // double would decode as zero, and Save would then wipe the reward.
        #expect(instance.rewardAmount == 3)
        #expect(instance.rewardCurrency == "stars")
        #expect(instance.rrule == "FREQ=WEEKLY;BYDAY=MO,TH")
        #expect(instance.dueTime == "07:30")
        #expect(instance.requiresApproval)
        #expect(instance.requiresPhoto)
    }

    @Test func aCardInTheStripBridgesWithNobodyOnItAndKeepsItsDay() throws {
        let library = try #require(try decodedBoard().people[2].chores.first)
        let instance = try #require(library.asChoreInstance(owner: nil))
        #expect(instance.personId == nil)
        // The day the editor opens on, so tapping the chip lands on the day the card was
        // showing. Omitting it would silently move the chore to today.
        #expect(instance.dueOn == "2026-09-02")
        #expect(instance.rrule == nil)
        #expect(instance.rewardAmount == 0)
    }

    @Test func aFractionalRewardSurvivesTheBridgeAsAWholeNumber() throws {
        let sitter = try #require(try decodedBoard().unassigned.first)
        let instance = try #require(sitter.asChoreInstance(owner: nil))
        // 1.5 stars is not a thing any household has, but it must not decode as 0.
        #expect(instance.rewardAmount == 2)
    }

    // ── The crumb ───────────────────────────────────────────────────────────────

    @Test func theCrumbIsCountsOnly() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        let crumb = model.crumb
        #expect(Set(crumb.keys) == ["assigned", "leftUpForGrabs"])
        #expect(crumb["assigned"] == JSONValue.int(0))
        #expect(crumb["leftUpForGrabs"] == JSONValue.int(1))
        // No titles, no ids, no people — the recap reads those through to chores itself.
    }

    // ── Dragging a card onto a person ───────────────────────────────────────────
    // Drag is an ADDITION to tapping a face, never a replacement, so a drop resolves to
    // the very same hand-out: `give` stays the one path both directions travel, or a drop
    // could do something a tap can't undo.

    @Test func aDropResolvesAgainstTheBoardRatherThanTheGestureThatStartedIt() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        // A CARD'S COLUMN IS A SERVER FACT, not something the drag carries. The payload
        // is only an id, so a board re-read under a half-finished drag can't leave the
        // drop acting on a stale idea of who had it.
        #expect(model.column(ofChore: "c-trash") == .person("p-wally"))
        #expect(model.column(ofChore: "c-library") == .person("p-lottie"))
        #expect(model.column(ofChore: "c-sitter") == .upForGrabs)
        #expect(model.column(ofChore: "c-nowhere") == nil)
    }

    @Test func droppingACardOnSomeoneHandsItOverDownTheSamePathAsTappingAFace() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        let wrote = await model.drop(choreId: "c-sitter", onto: .person("p-wally"),
                                     weekStart: "2026-09-06")

        #expect(wrote)
        #expect(feed.handOuts.map(\.choreId) == ["c-sitter"])
        #expect(feed.handOuts.map(\.personId) == ["p-wally"])
        #expect(model.assigned == 1)
        #expect(feed.fetchCount == 2)
    }

    @Test func droppingSomeonesCardOnTheStripPutsItBackUpForGrabs() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        let wrote = await model.drop(choreId: "c-trash", onto: .upForGrabs,
                                     weekStart: "2026-09-06")

        #expect(wrote)
        // EVERY MOVE IS REVERSIBLE by the same gesture that made it, or drag would be a
        // one-way door.
        #expect(feed.handOuts.map(\.personId) == [String?.none])
        #expect(model.assigned == 0)
    }

    @Test func droppingACardBackWhereItAlreadySitsWritesNothingAndTalliesNothing() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        // Wally's card, dropped on Wally. `give` tallies UNCONDITIONALLY, so letting this
        // through would spend a PATCH *and* inflate `assigned` for a gesture that moved
        // nothing.
        let onOwner = await model.drop(choreId: "c-trash", onto: .person("p-wally"),
                                       weekStart: "2026-09-06")
        let onStrip = await model.drop(choreId: "c-sitter", onto: .upForGrabs,
                                       weekStart: "2026-09-06")

        #expect(!onOwner)
        #expect(!onStrip)
        #expect(feed.handOuts.isEmpty)
        #expect(model.assigned == 0)
        #expect(feed.fetchCount == 1)          // the initial load only
        #expect(model.errorMessage == nil)     // a harmless gesture is not an error
    }

    @Test func aCardThatIsNoLongerOnTheBoardIsRefusedWithoutAWrite() async throws {
        let feed = TasksBoardFeed(try decodedBoard())
        let model = model(feed)
        await model.load(weekStart: "2026-09-06")

        // Somebody deleted it mid-drag, or the payload came from a board this step has
        // since replaced. Either way there is no chore to PATCH, and guessing one would
        // move the wrong task.
        let wrote = await model.drop(choreId: "c-gone", onto: .person("p-wally"),
                                     weekStart: "2026-09-06")

        #expect(!wrote)
        #expect(feed.handOuts.isEmpty)
        #expect(model.assigned == 0)
    }

    @Test func theDragPayloadIsNotTextSoItCannotBePastedIntoAField() throws {
        // A `.draggable(String)` payload is accepted by EVERY TextField in the app.
        // Conforming to public.data means only this step's drop targets take it.
        #expect(UTType.waffledPlanningTask.identifier == "app.waffled.planning-task")
        #expect(!UTType.waffledPlanningTask.conforms(to: .text))

        // It carries an id and NOTHING ELSE — see the resolve-against-the-board test.
        let data = try JSONEncoder().encode(PlanningTaskDrag(choreId: "c-trash"))
        let roundTripped = try JSONDecoder().decode(PlanningTaskDrag.self, from: data)
        #expect(roundTripped.choreId == "c-trash")
        let fields = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(fields.count == 1)
    }
}
