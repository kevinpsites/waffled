import Testing
@testable import Waffled

private enum FamilyNightMutationFailure: Error {
    case rejected
}

@MainActor
private final class FamilyNightFeed {
    var snapshot: WaffledAPI.FamilyNightView
    var fetchFails = false
    var saveFails = false
    var fetchCount = 0
    var saves: [(date: String, partId: String, personId: String?)] = []

    init(snapshot: WaffledAPI.FamilyNightView) {
        self.snapshot = snapshot
    }
}

private func familyNight(personId: String? = "person-1", personName: String? = "Avery") -> WaffledAPI.FamilyNightView {
    let part = WaffledAPI.FamilyNightPart(id: "activity", label: "Activity", emoji: "gamecontroller", rotates: true)
    let config = WaffledAPI.FamilyNightConfig(
        parts: [part], dayOfWeek: 5, time: "19:00", rotationOrder: nil, eventId: nil)
    let members = [
        WaffledAPI.FamilyNightMember(id: "person-1", name: "Avery", color: nil, emoji: nil),
        WaffledAPI.FamilyNightMember(id: "person-2", name: "Jordan", color: nil, emoji: nil),
    ]
    let assignment = WaffledAPI.FamilyNightAssignment(
        partId: part.id,
        label: part.label,
        emoji: part.emoji,
        personId: personId,
        personName: personName,
        suggested: false)
    let next = WaffledAPI.FamilyNightNext(
        date: "2026-07-31",
        occurrenceId: "occurrence-1",
        theme: nil,
        notes: nil,
        status: "planned",
        assignments: [assignment])
    return WaffledAPI.FamilyNightView(config: config, members: members, next: next)
}

@MainActor
private func model(_ feed: FamilyNightFeed) -> FamilyNightModel {
    FamilyNightModel(
        fetchFamilyNight: {
            feed.fetchCount += 1
            if feed.fetchFails { throw FamilyNightMutationFailure.rejected }
            return feed.snapshot
        },
        saveAssignment: { date, partId, personId in
            feed.saves.append((date, partId, personId))
            if feed.saveFails { throw FamilyNightMutationFailure.rejected }
            let name = feed.snapshot.members.first(where: { $0.id == personId })?.name
            feed.snapshot = familyNight(personId: personId, personName: name)
        })
}

@MainActor
private func expectFamilyNightFailure(_ operation: () async throws -> Void) async {
    do {
        try await operation()
        Issue.record("Expected the assignment to fail")
    } catch is FamilyNightMutationFailure {
        // Expected.
    } catch {
        Issue.record("Unexpected error: \(error)")
    }
}

@MainActor
@Suite struct FamilyNightModelTests {
    @Test func failedRefreshKeepsTheLastConfirmedSchedule() async {
        let feed = FamilyNightFeed(snapshot: familyNight())
        let model = model(feed)
        await model.load()
        feed.fetchFails = true

        await model.load()

        #expect(model.view?.next.assignments.first?.personName == "Avery")
        #expect(model.loaded)
    }

    @Test func failedAssignmentKeepsSnapshotAndDoesNotRefetch() async {
        let feed = FamilyNightFeed(snapshot: familyNight())
        feed.saveFails = true
        let model = model(feed)
        await model.load()

        await expectFamilyNightFailure {
            try await model.assign(partId: "activity", personId: "person-2")
        }

        #expect(feed.saves.count == 1)
        #expect(feed.fetchCount == 1)
        #expect(model.view?.next.assignments.first?.personName == "Avery")
    }

    @Test func successfulAssignmentReloadsTheConfirmedSchedule() async throws {
        let feed = FamilyNightFeed(snapshot: familyNight())
        let model = model(feed)
        await model.load()

        try await model.assign(partId: "activity", personId: "person-2")

        #expect(feed.saves.first?.date == "2026-07-31")
        #expect(feed.saves.first?.partId == "activity")
        #expect(feed.saves.first?.personId == "person-2")
        #expect(feed.fetchCount == 2)
        #expect(model.view?.next.assignments.first?.personName == "Jordan")
    }
}
