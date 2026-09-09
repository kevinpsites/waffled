import Foundation
import Testing
@testable import Waffled

// Weekly Planning · step 5 "Connection" — nothing new is stored: a pairing is a query over
// event participants, and claiming a slot writes an ordinary calendar event. What is
// pinned here are the four ways it could look right and be wrong: the catch-up ladder must
// stop the moment the credit appears and GIVE UP rather than loop; the row names the event
// and exactly one chip ever reads as chosen; "Link a time" writes a pointer only; and the
// event made for a pairing is identified BY DIFFERENCE, never by an id handed to us.

private enum ConnectionFailure: Error { case rejected }

@MainActor
private final class ConnectionFeed {
    var boards: [WaffledAPI.PlanningConnectionBoard]
    var reads = 0
    var throwOnRead: Int?
    var waits: [Duration] = []
    var saved: [[String: String]] = []
    var saveFails = false
    var slotsResult: WaffledAPI.PlanningConnectionSlots?

    init(_ boards: [WaffledAPI.PlanningConnectionBoard]) {
        self.boards = boards
    }

    func next() throws -> WaffledAPI.PlanningConnectionBoard {
        reads += 1
        if let throwOnRead, throwOnRead == reads { throw ConnectionFailure.rejected }
        guard !boards.isEmpty else { throw ConnectionFailure.rejected }
        return boards[min(reads - 1, boards.count - 1)]
    }
}

@MainActor
private func model(_ feed: ConnectionFeed) -> PlanningConnectionModel {
    PlanningConnectionModel(
        fetchBoard: { _ in try feed.next() },
        fetchSlots: { weekStart, ids in
            guard let result = feed.slotsResult else { throw ConnectionFailure.rejected }
            _ = (weekStart, ids)
            return result
        },
        saveLinks: { _, links in
            feed.saved.append(links)
            if feed.saveFails { throw ConnectionFailure.rejected }
        },
        wait: { duration in feed.waits.append(duration) })
}

// MARK: - Fixtures

private func event(
    _ id: String, _ title: String, day: String = "Saturday", minutes: Int? = 120
) -> WaffledAPI.PlanningConnectionEvent {
    WaffledAPI.PlanningConnectionEvent(
        id: id, title: title, startsAt: "2026-09-12T18:00:00.000Z",
        endsAt: "2026-09-12T20:00:00.000Z", allDay: false, minutes: minutes,
        day: day, time: "1:00 PM", when: "\(day) 1:00 PM")
}

private func slot(
    _ date: String, startsAt: String? = nil, kind: String = "open",
    afterTitle: String? = nil, label: String = "Sun · free all day"
) -> WaffledAPI.PlanningConnectionSlot {
    WaffledAPI.PlanningConnectionSlot(
        date: date, startsAt: startsAt, kind: kind, afterTitle: afterTitle, label: label)
}

private func pairing(
    _ ids: [String], who: String,
    already: [WaffledAPI.PlanningConnectionEvent] = [],
    together: [WaffledAPI.PlanningConnectionEvent] = [],
    lastTogetherOn: String? = nil, lastTogetherTitle: String? = nil,
    slots: [WaffledAPI.PlanningConnectionSlot] = []
) -> WaffledAPI.PlanningConnectionPairing {
    WaffledAPI.PlanningConnectionPairing(
        personIds: ids, who: who, lastTogetherOn: lastTogetherOn,
        lastTogetherTitle: lastTogetherTitle, alreadyThisWeek: already,
        togetherThisWeek: together, slots: slots)
}

private func board(
    _ pairings: [WaffledAPI.PlanningConnectionPairing]
) -> WaffledAPI.PlanningConnectionBoard {
    WaffledAPI.PlanningConnectionBoard(weekStart: "2026-09-06", pairings: pairings)
}

private let week = "2026-09-06"
private let session = "session-1"

// MARK: - Decoding

@Suite struct PlanningConnectionDecodingTests {

    /// Verbatim from `apps/api/test/weekly-planning-connection.integration.test.ts`.
    private static let boardJSON = Data(
        """
        {
          "weekStart": "2026-09-06",
          "pairings": [
            {
              "personIds": ["kevin", "wally"],
              "who": "Kevin and Wally",
              "lastTogetherOn": null,
              "lastTogetherTitle": null,
              "alreadyThisWeek": [
                {
                  "id": "evt-yard",
                  "title": "Yard work",
                  "startsAt": "2026-09-12T18:00:00.000Z",
                  "endsAt": "2026-09-12T20:00:00.000Z",
                  "allDay": false,
                  "minutes": 120,
                  "day": "Saturday",
                  "time": "1:00 PM",
                  "when": "Saturday 1:00 PM"
                }
              ],
              "togetherThisWeek": [],
              "slots": [
                {
                  "date": "2026-09-06",
                  "startsAt": null,
                  "kind": "open",
                  "afterTitle": null,
                  "label": "Sun · free all day"
                },
                {
                  "date": "2026-09-09",
                  "startsAt": "2026-09-10T00:30:00.000Z",
                  "kind": "after",
                  "afterTitle": "Scouts",
                  "label": "Wed after Scouts"
                }
              ]
            },
            {
              "personIds": ["kevin", "kelly"],
              "who": "Kevin and Kelly",
              "lastTogetherOn": "2026-07-23",
              "lastTogetherTitle": "Date night",
              "alreadyThisWeek": [],
              "togetherThisWeek": [
                {
                  "id": "evt-hales",
                  "title": "Dinner at the Hales",
                  "startsAt": "2026-09-07T23:00:00.000Z",
                  "endsAt": "2026-09-08T01:30:00.000Z",
                  "allDay": false,
                  "minutes": 150,
                  "day": "Monday",
                  "time": "6:00 PM",
                  "when": "Monday 6:00 PM"
                }
              ],
              "slots": []
            }
          ]
        }
        """.utf8)

    @Test func decodesTheBoardTheServerActuallySends() throws {
        let decoded = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningConnectionBoard.self, from: Self.boardJSON)

        #expect(decoded.weekStart == "2026-09-06")
        #expect(decoded.pairings.count == 2)
        let kw = try #require(decoded.pairings.first)
        #expect(kw.who == "Kevin and Wally")
        #expect(kw.key == "kevin-wally")
        #expect(kw.alreadyThisWeek.map(\.title) == ["Yard work"])
        #expect(kw.alreadyThisWeek.first?.minutes == 120)
        #expect(kw.alreadyThisWeek.first?.day == "Saturday")
        #expect(kw.alreadyThisWeek.first?.time == "1:00 PM")
        #expect(kw.alreadyThisWeek.first?.when == "Saturday 1:00 PM")
        #expect(kw.lastTogetherOn == nil)
    }

    /// `startsAt: null` MEANS THE WHOLE DAY IS FREE — not "unknown", not a malformed row.
    /// The event sheet's own picker decides the hour.
    @Test func aNullSlotStartMeansFreeAllDayRatherThanMissing() throws {
        let decoded = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningConnectionBoard.self, from: Self.boardJSON)
        let slots = try #require(decoded.pairings.first?.slots)

        #expect(slots.count == 2)
        #expect(slots[0].startsAt == nil)
        #expect(slots[0].isFreeAllDay)
        #expect(slots[0].kind == "open")
        #expect(slots[0].label == "Sun · free all day")

        #expect(slots[1].isFreeAllDay == false)
        #expect(slots[1].afterTitle == "Scouts")
        #expect(slots[1].label == "Wed after Scouts")
    }

    /// The instant the server sends carries MILLISECONDS (`luxon`'s `toISO()`), which a bare
    /// `ISO8601DateFormatter` refuses — and nil would fall back to the sheet's 5pm default.
    @Test func theSlotsInstantParsesWithTheAppsOwnTolerantParser() throws {
        let decoded = try WaffledAPI.decoder.decode(
            WaffledAPI.PlanningConnectionBoard.self, from: Self.boardJSON)
        let after = try #require(decoded.pairings.first?.slots.last)

        let parsed = try #require(EventTime.parse(after.startsAt))
        #expect(parsed.timeIntervalSince1970 == 1_789_000_200)  // 2026-09-10T00:30:00Z
        #expect(EventTime.parse(decoded.pairings.first?.slots.first?.startsAt) == nil)
    }

    @Test func decodesTheSlotsReadMakePairingUses() throws {
        let json = Data(
            """
            {
              "weekStart": "2026-09-06",
              "personIds": ["kevin", "wally", "lottie"],
              "who": "Kevin, Wally and Lottie",
              "slots": [
                {"date":"2026-09-09","startsAt":"2026-09-10T00:30:00.000Z","kind":"after","afterTitle":"Scouts","label":"Wed after Scouts"}
              ]
            }
            """.utf8)

        let decoded = try WaffledAPI.decoder.decode(WaffledAPI.PlanningConnectionSlots.self, from: json)

        #expect(decoded.personIds == ["kevin", "wally", "lottie"])
        #expect(decoded.who == "Kevin, Wally and Lottie")
        #expect(decoded.slots.first?.kind == "after")
    }
}

// MARK: - The wording, and which rows exist

@Suite struct PlanningConnectionCopyTests {

    @Test func theRowLeadsWithTimeThatAlreadyExists() {
        let p = pairing(["a", "b"], who: "Kevin and Wally", already: [event("e1", "Yard work")])
        #expect(
            PlanningConnectionCopy.sentence(p, linkedId: nil)
                == "Saturday’s Yard work is the two of you for 2 hours — that may already be it.")
    }

    @Test func aLinkedEventAnswersThePairingWhateverElseTheWeekSays() {
        let p = pairing(
            ["a", "b"], who: "Kevin and Kelly",
            already: [event("e1", "Yard work")],
            together: [event("e2", "Dinner at the Hales", day: "Monday", minutes: 150)])
        #expect(
            PlanningConnectionCopy.sentence(p, linkedId: "e2")
                == "Nothing new — Monday’s Dinner at the Hales already is it, and you said so out loud.")
    }

    @Test func aNearMissIsNamedAndTheStalenessIsDated() {
        let one = pairing(
            ["a", "b"], who: "Kevin and Kelly",
            together: [event("e2", "Dinner at the Hales", day: "Friday", minutes: nil)],
            lastTogetherOn: "2026-08-08")
        #expect(
            PlanningConnectionCopy.sentence(one, linkedId: nil)
                == "Nothing on the calendar with just the two of you since Aug 8."
                + " Friday’s Dinner at the Hales is you both, but it’s not that.")

        let many = pairing(
            ["a", "b"], who: "Kevin and Kelly",
            together: [event("e2", "Dinner"), event("e3", "Church")])
        #expect(
            PlanningConnectionCopy.sentence(many, linkedId: nil)
                == "Nothing on the calendar with just the two of you."
                + " You’re both at 2 things this week, but none of them is that.")

        let never = pairing(["a", "b"], who: "Kevin and Lottie")
        #expect(
            PlanningConnectionCopy.sentence(never, linkedId: nil)
                == "Nothing on the calendar with just the two of you.")
    }

    /// "Aug 8", never "Aug 7": `lastTogetherOn` is a calendar label resolved in the
    /// household's zone, so the parse is UTC.
    @Test func theStalenessDateDoesNotSlipWestOfGreenwich() {
        #expect(PlanningConnectionCopy.monthDay("2026-08-08") == "Aug 8")
        #expect(PlanningConnectionCopy.monthDay("2027-01-01") == "Jan 1")
        #expect(PlanningConnectionCopy.monthDay("garbage") == "garbage")
    }

    @Test func durationWordsReadLikeWords() {
        #expect(PlanningConnectionCopy.durationWords(60) == "1 hour")
        #expect(PlanningConnectionCopy.durationWords(120) == "2 hours")
        #expect(PlanningConnectionCopy.durationWords(45) == "45 minutes")
        #expect(PlanningConnectionCopy.durationWords(150) == "150 minutes")
    }

    @Test func bothOnItIsEveryEventThisWeekWithBothOfThemOnIt() {
        let p = pairing(
            ["a", "b"], who: "Kevin and Kelly",
            already: [event("e1", "Yard work")],
            together: [event("e2", "Dinner")])
        #expect(PlanningConnectionCopy.bothOnIt(p).map(\.id) == ["e1", "e2"])
    }

    /// The ranking reads only history BEFORE the planned week, so a pairing you have just
    /// given time to does not move up — and an invisible row looks like a lost write.
    @Test func creditedPairingsClaimTheirRowsFirst() {
        let pairings = [
            pairing(["a", "b"], who: "A and B"),
            pairing(["c", "d"], who: "C and D"),
            pairing(["e", "f"], who: "E and F"),
            pairing(["g", "h"], who: "G and H", already: [event("e1", "Yard work")]),
        ]

        let shown = PlanningConnectionCopy.visible(pairings)

        #expect(shown.count == 3)
        #expect(shown.map(\.who) == ["A and B", "C and D", "G and H"])
    }

    @Test func theCapGrowsWhenMoreThanThreePairingsHaveTimeOnTheWeek() {
        let credited = (0..<4).map { i in
            pairing(["p\(i)", "q\(i)"], who: "Pair \(i)", already: [event("e\(i)", "Dinner")])
        }
        let guesses = [pairing(["x", "y"], who: "X and Y")]

        let shown = PlanningConnectionCopy.visible(credited + guesses)

        #expect(shown.count == 4)
        #expect(shown.allSatisfy { !$0.alreadyThisWeek.isEmpty })
    }

    /// FILTERED, NOT PARTITIONED: re-grouping would float the credit rows to the top and
    /// throw away the ranking, which is the step's actual argument.
    @Test func theServersOwnOrderSurvivesTheCut() {
        let pairings = [
            pairing(["a", "b"], who: "A and B"),
            pairing(["c", "d"], who: "C and D", already: [event("e1", "Dinner")]),
            pairing(["e", "f"], who: "E and F"),
        ]
        #expect(PlanningConnectionCopy.visible(pairings).map(\.who) == ["A and B", "C and D", "E and F"])
    }

    @Test func creditedCountsTheWholeBoard() {
        #expect(PlanningConnectionCopy.credited(nil) == 0)
        #expect(
            PlanningConnectionCopy.credited(
                board([
                    pairing(["a", "b"], who: "A and B", already: [event("e1", "One"), event("e2", "Two")]),
                    pairing(["c", "d"], who: "C and D", already: [event("e3", "Three")]),
                ])) == 3)
    }
}

// MARK: - The row: exactly one chip reads as chosen

@Suite struct PlanningConnectionRowTests {

    @Test func withSeveralCandidatesAndNoAnswerNoChipStandsForAnything() {
        let p = pairing(
            ["a", "b"], who: "Kevin and Wally",
            already: [event("e1", "Yard work"), event("e2", "Drive to practice")],
            together: [event("e3", "Dinner")])

        let row = PlanningConnectionRow(p, linkedId: nil)

        // With several candidates and nothing picked, there is nothing a single chip can
        // honestly stand for — it would otherwise name a different event than the sentence.
        #expect(row.oneTap == nil)
        #expect(row.oneTapChosen == false)
        #expect(row.showPicker)
        #expect(row.candidates.count == 3)
    }

    @Test func theOneObviousCandidateGetsAChipThatIsNotYetChosen() {
        let p = pairing(["a", "b"], who: "Kevin and Wally", already: [event("e1", "Yard work")])

        let row = PlanningConnectionRow(p, linkedId: nil)

        #expect(row.oneTap?.id == "e1")
        #expect(row.oneTapChosen == false)
        #expect(row.showPicker == false)
    }

    @Test func exactlyOneChipReadsAsChosenAndItNamesTheEvent() {
        let p = pairing(
            ["a", "b"], who: "Kevin and Kelly",
            already: [event("e1", "Yard work"), event("e2", "Drive")],
            together: [event("e3", "Dinner at the Hales", day: "Monday")])

        let row = PlanningConnectionRow(p, linkedId: "e3")

        #expect(row.answer?.id == "e3")
        #expect(row.oneTap?.id == "e3")
        #expect(row.oneTapChosen)
        #expect(row.sentence.contains("Dinner at the Hales"))
        #expect(row.showPicker)
    }

    @Test func aLinkPointingAtNothingOnTheWeekLeavesTheRowUnanswered() {
        let p = pairing(["a", "b"], who: "Kevin and Kelly", already: [event("e1", "Yard work")])

        let row = PlanningConnectionRow(p, linkedId: "gone")

        #expect(row.answer == nil)
        #expect(row.oneTapChosen == false)
        #expect(row.oneTap?.id == "e1")
        #expect(row.sentence.contains("that may already be it"))
    }

    @Test func onlyTwoSlotsFitOnARow() {
        let p = pairing(
            ["a", "b"], who: "A and B",
            slots: [slot("2026-09-06"), slot("2026-09-07"), slot("2026-09-08")])

        #expect(PlanningConnectionRow(p, linkedId: nil).slots.count == 2)
    }
}

// MARK: - The model: the ladder, the link, and the crumb

@MainActor
@Suite struct PlanningConnectionModelTests {

    @Test func aFailedReadKeepsTheBoardAndStillCountsAsLoaded() async {
        let feed = ConnectionFeed([board([pairing(["a", "b"], who: "A and B")])])
        let m = model(feed)
        await m.load(weekStart: week)
        feed.throwOnRead = 2

        await m.load(weekStart: week)

        #expect(m.board?.pairings.count == 1)
        #expect(m.loaded)
        #expect(m.failed)
    }

    /// THE CATCH-UP LADDER stops the moment the credited count goes UP — the board catching
    /// up with a local-first write.
    @Test func theLadderStopsAsSoonAsTheCreditAppears() async {
        let empty = board([pairing(["a", "b"], who: "A and B")])
        let credited = board([
            pairing(["a", "b"], who: "A and B", already: [event("new", "Coffee")]),
        ])
        let feed = ConnectionFeed([empty, empty, empty, credited])
        let m = model(feed)
        await m.load(weekStart: week)

        await m.settleAfterSave(weekStart: week, sessionId: session, participantIds: ["a", "b"])

        #expect(feed.reads == 4)  // one load + three ladder reads
        #expect(feed.waits == [.milliseconds(250), .milliseconds(500)])
        #expect(m.rows.first?.oneTap?.id == "new")
    }

    /// …AND IT GIVES UP RATHER THAN LOOPING FOREVER. Six reads, five widening pauses; past
    /// that the next ordinary read is authoritative anyway.
    @Test func theLadderGivesUpAfterSixReads() async {
        let feed = ConnectionFeed([board([pairing(["a", "b"], who: "A and B")])])
        let m = model(feed)
        await m.load(weekStart: week)

        await m.settleAfterSave(weekStart: week, sessionId: session, participantIds: ["a", "b"])

        #expect(feed.reads == 7)  // one load + six ladder reads
        #expect(
            feed.waits == [
                .milliseconds(250), .milliseconds(500), .seconds(1), .seconds(2), .seconds(3),
            ])
        #expect(m.links.isEmpty)
        #expect(feed.saved.isEmpty)
        // The event still counts as added — it IS on the calendar; only the board is behind.
        #expect(m.decisionData["added"] == .int(1))
    }

    /// A broken read is not "the board hasn't caught up yet": climbing the ladder on it
    /// would hammer a dead endpoint six times.
    @Test func aFailedReadStopsTheLadderRatherThanRetrying() async {
        let feed = ConnectionFeed([board([pairing(["a", "b"], who: "A and B")])])
        let m = model(feed)
        await m.load(weekStart: week)
        feed.throwOnRead = 2

        await m.settleAfterSave(weekStart: week, sessionId: session, participantIds: ["a", "b"])

        #expect(feed.reads == 2)
        #expect(feed.waits.isEmpty)
        #expect(m.failed)
        #expect(m.board?.pairings.count == 1)  // the board we had is still there
    }

    /// WHICH EVENT ANSWERS A PAIRING IS DECIDED BY DIFFERENCE, not by an id handed back from
    /// the sheet: the write is local-first, so the only id certainly on the server is the
    /// one that APPEARED since we looked.
    @Test func theAutoLinkPicksTheEventThatAppeared() async {
        let before = board([
            pairing(["a", "b"], who: "A and B", already: [event("old", "Yard work")]),
        ])
        let after = board([
            pairing(
                ["a", "b"], who: "A and B",
                already: [event("old", "Yard work"), event("fresh", "Coffee")]),
        ])
        let feed = ConnectionFeed([before, after])
        let m = model(feed)
        await m.load(weekStart: week)

        await m.settleAfterSave(weekStart: week, sessionId: session, participantIds: ["a", "b"])

        // NOT "old", which was already credited when we opened the sheet.
        #expect(m.links == ["a-b": "fresh"])
        #expect(feed.saved == [["a-b": "fresh"]])
        #expect(m.rows.first?.answer?.id == "fresh")
        #expect(m.rows.first?.oneTapChosen == true)
    }

    /// A pairing built from scratch may match no row — and then nothing is linked, correctly.
    @Test func anEventForAPairingWithNoRowLinksNothing() async {
        let only = board([pairing(["a", "b"], who: "A and B")])
        let feed = ConnectionFeed([only])
        let m = model(feed)
        await m.load(weekStart: week)

        await m.settleAfterSave(
            weekStart: week, sessionId: session, participantIds: ["a", "b", "c"])

        #expect(m.links.isEmpty)
        #expect(feed.saved.isEmpty)
        #expect(m.decisionData["added"] == .int(1))
    }

    @Test func linkingWritesAPointerAndPickingItAgainUndoesIt() async {
        let feed = ConnectionFeed([
            board([
                pairing(
                    ["a", "b"], who: "A and B",
                    already: [event("e1", "Yard work")], together: [event("e2", "Dinner")]),
            ]),
        ])
        let m = model(feed)
        await m.load(weekStart: week)

        await m.link(key: "a-b", eventId: "e2", sessionId: session)
        #expect(m.links == ["a-b": "e2"])
        #expect(m.rows.first?.answer?.id == "e2")

        await m.link(key: "a-b", eventId: "e2", sessionId: session)
        #expect(m.links.isEmpty)
        #expect(m.rows.first?.answer == nil)
        #expect(feed.saved == [["a-b": "e2"], [:]])
        #expect(feed.reads == 1)
    }

    @Test func aFailedLinkWriteCostsTheMemoryNotTheSitting() async {
        let feed = ConnectionFeed([
            board([pairing(["a", "b"], who: "A and B", already: [event("e1", "Yard work")])]),
        ])
        feed.saveFails = true
        let m = model(feed)
        await m.load(weekStart: week)

        await m.link(key: "a-b", eventId: "e1", sessionId: session)

        #expect(m.links == ["a-b": "e1"])
        #expect(feed.saved.count == 1)
    }

    /// `decideStep` REPLACES the step's data, so `links` — persisted onto the same row by the
    /// mid-step route — has to be written back or answering the step erases it.
    @Test func theCrumbCarriesTheLinksSoAnsweringTheStepDoesNotWipeThem() async {
        let feed = ConnectionFeed([
            board([pairing(["a", "b"], who: "A and B", already: [event("e1", "Yard work")])]),
        ])
        let m = model(feed)
        await m.load(weekStart: week)
        await m.link(key: "a-b", eventId: "e1", sessionId: session)

        #expect(
            m.decisionData == [
                "added": .int(0),
                "alreadyCounted": .int(1),
                "links": .object(["a-b": .string("e1")]),
            ])
    }

    @Test func linksAreSeededFromTheStepsOwnRowBeforeTheReadLands() async {
        let feed = ConnectionFeed([
            board([
                pairing(
                    ["a", "b"], who: "A and B",
                    already: [event("e1", "Yard work"), event("e2", "Drive")]),
            ]),
        ])
        let m = model(feed)

        m.seedLinks(from: .object(["a-b": .string("e2"), "junk": .int(3)]), weekStart: week)
        await m.load(weekStart: week)

        #expect(m.links == ["a-b": "e2"])
        #expect(m.rows.first?.answer?.id == "e2")
        m.seedLinks(from: .object(["a-b": .string("e1")]), weekStart: week)
        #expect(m.links == ["a-b": "e2"])
    }

    /// A DIFFERENT WEEK IS A DIFFERENT SET OF LINKS: link keys are person-id joins that are
    /// identical across weeks, so a model shared between two weeks cross-writes them.
    @Test func steppingToAnotherWeekDoesNotInheritTheFirstWeeksLinks() async {
        let feed = ConnectionFeed([
            board([pairing(["a", "b"], who: "A and B", already: [event("e1", "Yard work")])]),
            board([pairing(["a", "b"], who: "A and B", already: [event("e9", "Museum")])]),
        ])
        let m = model(feed)

        m.seedLinks(from: .object(["a-b": .string("e1")]), weekStart: week)
        await m.load(weekStart: week)
        #expect(m.links == ["a-b": "e1"])

        let nextWeek = "2026-09-13"
        m.seedLinks(from: nil, weekStart: nextWeek)

        #expect(m.links.isEmpty, "week B inherited week A's links: \(m.links)")
        #expect(m.rows.first?.answer == nil)
    }

    @Test func anotherWeekAdoptsItsOwnLinks() async {
        let feed = ConnectionFeed([
            board([pairing(["a", "b"], who: "A and B", already: [event("e1", "Yard work")])]),
            board([pairing(["a", "b"], who: "A and B", already: [event("e9", "Museum")])]),
        ])
        let m = model(feed)

        m.seedLinks(from: .object(["a-b": .string("e1")]), weekStart: week)
        await m.load(weekStart: week)

        let nextWeek = "2026-09-13"
        m.seedLinks(from: .object(["a-b": .string("e9")]), weekStart: nextWeek)
        await m.load(weekStart: nextWeek)

        #expect(m.links == ["a-b": "e9"])
        #expect(m.rows.first?.answer?.id == "e9")
    }

    @Test func theStepDrawsOnlyTheVisibleRows() async {
        let feed = ConnectionFeed([
            board((0..<6).map { i in pairing(["p\(i)", "q\(i)"], who: "Pair \(i)") }),
        ])
        let m = model(feed)

        await m.load(weekStart: week)

        #expect(m.board?.pairings.count == 6)
        #expect(m.rows.count == 3)
        #expect(m.rows.map(\.who) == ["Pair 0", "Pair 1", "Pair 2"])
    }

    @Test func slotsForAnArbitraryPairingComeBackOrCleanlyDoNot() async {
        let feed = ConnectionFeed([board([])])
        let m = model(feed)

        let refused = await m.slots(weekStart: week, personIds: ["a"])
        #expect(refused == nil)

        feed.slotsResult = WaffledAPI.PlanningConnectionSlots(
            weekStart: week, personIds: ["a", "b"], who: "A and B",
            slots: [slot("2026-09-06")])
        let result = await m.slots(weekStart: week, personIds: ["a", "b"])

        #expect(result?.who == "A and B")
        #expect(result?.slots.first?.isFreeAllDay == true)
    }
}
