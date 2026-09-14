import Foundation
import Testing
@testable import Waffled

// The iPhone Today chores card: whose chores it shows, and ticking them off in place.

private func chore(_ title: String, person: String?, status: String = "pending",
                   dueTime: String? = nil, requiresApproval: Bool = false,
                   photo: Bool = false) -> WaffledAPI.ChoreInstanceDTO {
    var json: [String: Any] = [
        "id": UUID().uuidString, "choreId": UUID().uuidString, "choreTitle": title,
        "status": status, "rewardAmount": 1, "requiresApproval": requiresApproval, "streak": 0,
        "requiresPhoto": photo,
    ]
    if let person { json["personId"] = person }
    if let dueTime { json["dueTime"] = dueTime }
    let data = try! JSONSerialization.data(withJSONObject: json)
    return try! JSONDecoder().decode(WaffledAPI.ChoreInstanceDTO.self, from: data)
}

/// Holds a stubbed write open until the test lets it finish.
private actor WriteGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

private final class ChoreFeed: @unchecked Sendable {
    var instances: [WaffledAPI.ChoreInstanceDTO]? = []
    var failWrites = false
    var writes: [(id: String, complete: Bool)] = []
    var requestedDates: [String] = []
}

@MainActor
private func model(_ feed: ChoreFeed) -> DashboardModel {
    DashboardModel(
        fetchMeals: { _ in [] }, fetchChores: { [] }, fetchGrocery: { [] },
        fetchGoals: { [] }, fetchRecap: { [] }, fetchSuggestions: { [] },
        fetchChoreInstances: { date in
            feed.requestedDates.append(date)
            guard let rows = feed.instances else { throw URLError(.notConnectedToInternet) }
            return rows
        },
        setChoreComplete: { id, complete in
            feed.writes.append((id, complete))
            if feed.failWrites { throw URLError(.notConnectedToInternet) }
        })
}

@Suite struct TodayChorePersonTests {
    let members: Set<String> = ["me", "kid"]

    @Test func defaultsToTheSignedInPerson() {
        #expect(DashboardModel.chorePersonId(stored: "", currentPersonId: "me", fallbackId: "kid", memberIds: members) == "me")
    }

    @Test func fallsBackWhenIdentityIsUnknown() {
        #expect(DashboardModel.chorePersonId(stored: "", currentPersonId: nil, fallbackId: "kid", memberIds: members) == "kid")
    }

    @Test func aRememberedPickWins() {
        #expect(DashboardModel.chorePersonId(stored: "kid", currentPersonId: "me", fallbackId: "me", memberIds: members) == "kid")
    }

    @Test func familyIsAPick() {
        #expect(DashboardModel.chorePersonId(stored: DashboardModel.familyChoresKey, currentPersonId: "me",
                                             fallbackId: "me", memberIds: members) == nil)
    }

    @Test func aPickWhoLeftTheHouseholdFallsBackToMe() {
        #expect(DashboardModel.chorePersonId(stored: "gone", currentPersonId: "me", fallbackId: "kid", memberIds: members) == "me")
    }

    @Test func nobodyToShowIsFamily() {
        #expect(DashboardModel.chorePersonId(stored: "", currentPersonId: nil, fallbackId: nil, memberIds: []) == nil)
    }
}

@MainActor
@Suite struct TodayChoreListTests {
    @Test func showsOnlyThatPersonsChoresPendingFirst() {
        let rows = [
            chore("Dishes", person: "me", status: "done"),
            chore("Walk dog", person: "kid"),
            chore("Laundry", person: "me", dueTime: "18:00"),
            chore("Up for grabs", person: nil),
            chore("Bins", person: "me", dueTime: "08:00"),
        ]
        #expect(DashboardModel.chores(for: "me", in: rows).map(\.choreTitle) == ["Bins", "Laundry", "Dishes"])
    }

    @Test func loadFetchesTodaysInstances() async {
        let feed = ChoreFeed()
        feed.instances = [chore("Bins", person: "me")]
        let m = model(feed)
        await m.load(todayKey: "2026-09-14")
        #expect(feed.requestedDates == ["2026-09-14"])
        #expect(m.choreInstances.map(\.choreTitle) == ["Bins"])
        #expect(m.choreInstancesState.isAuthoritative)
    }

    @Test func tickingCompletesOptimistically() async {
        let feed = ChoreFeed()
        let bins = chore("Bins", person: "me")
        feed.instances = [bins]
        let m = model(feed)
        await m.load(todayKey: "2026-09-14")
        #expect(await m.toggleChore(bins))
        #expect(m.choreInstances.first?.status == "done")
        #expect(feed.writes.map(\.complete) == [true])
    }

    @Test func approvalChoresWaitForAnOK() async {
        let feed = ChoreFeed()
        let room = chore("Clean room", person: "kid", requiresApproval: true)
        feed.instances = [room]
        let m = model(feed)
        await m.load(todayKey: "2026-09-14")
        await m.toggleChore(room)
        #expect(m.choreInstances.first?.status == "awaiting")
    }

    @Test func untickingAnAwaitingChoreUncompletes() async {
        let feed = ChoreFeed()
        let room = chore("Clean room", person: "kid", status: "awaiting", requiresApproval: true)
        feed.instances = [room]
        let m = model(feed)
        await m.load(todayKey: "2026-09-14")
        await m.toggleChore(room)
        #expect(m.choreInstances.first?.status == "pending")
        #expect(feed.writes.map(\.complete) == [false])
    }

    @Test func aSecondTapWhileTheWriteIsInFlightIsIgnored() async {
        let gate = WriteGate()
        let feed = ChoreFeed()
        let bins = chore("Bins", person: "me")
        feed.instances = [bins]
        let m = DashboardModel(
            fetchMeals: { _ in [] }, fetchChores: { [] }, fetchGrocery: { [] },
            fetchGoals: { [] }, fetchRecap: { [] }, fetchSuggestions: { [] },
            fetchChoreInstances: { _ in feed.instances ?? [] },
            setChoreComplete: { id, complete in
                feed.writes.append((id, complete))
                await gate.wait()
            })
        await m.load(todayKey: "2026-09-14")
        async let first = m.toggleChore(bins)
        while feed.writes.isEmpty { await Task.yield() }
        #expect(await m.toggleChore(bins) == false)
        await gate.open()
        #expect(await first)
        #expect(feed.writes.count == 1)
        #expect(m.choreInstances.first?.status == "done")
    }

    @Test func onlyAnOpenPhotoChoreNeedsTheBoard() {
        #expect(ChoresModel.needsPhotoToFinish(chore("Garden", person: "me", photo: true)))
        #expect(!ChoresModel.needsPhotoToFinish(chore("Garden", person: "me", status: "done", photo: true)))
        #expect(!ChoresModel.needsPhotoToFinish(chore("Garden", person: "me", status: "awaiting", photo: true)))
        #expect(!ChoresModel.needsPhotoToFinish(chore("Bins", person: "me")))
    }

    @Test func aFailedWriteRollsBack() async {
        let feed = ChoreFeed()
        let bins = chore("Bins", person: "me")
        feed.instances = [bins]
        feed.failWrites = true
        let m = model(feed)
        await m.load(todayKey: "2026-09-14")
        #expect(await m.toggleChore(bins) == false)
        #expect(m.choreInstances.first?.status == "pending")
    }
}
