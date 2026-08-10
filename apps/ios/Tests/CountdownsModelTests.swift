import Testing
@testable import Waffled

private enum CountdownMutationFailure: Error {
    case rejected
}

private actor CountdownDeleteGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }
}

@MainActor
private final class CountdownFeed {
    var items: [WaffledAPI.Countdown]
    var fetchCount = 0
    var createFails = false
    var updateFails = false
    var deleteFails = false
    var deletedIDs: [String] = []
    var deleteGate: CountdownDeleteGate?

    init(items: [WaffledAPI.Countdown]) {
        self.items = items
    }
}

private func countdown(_ id: String, title: String = "Beach trip") -> WaffledAPI.Countdown {
    WaffledAPI.Countdown(
        id: id,
        title: title,
        date: "2026-08-15",
        daysLeft: 21,
        source: "standalone",
        emoji: "sun.max",
        color: nil,
        personId: nil)
}

@MainActor
private func model(_ feed: CountdownFeed) -> CountdownsModel {
    CountdownsModel(
        fetchCountdowns: {
            feed.fetchCount += 1
            return (feed.items, false)
        },
        createCountdown: { _, _, _ in
            if feed.createFails { throw CountdownMutationFailure.rejected }
        },
        updateCountdown: { _, _, _, _ in
            if feed.updateFails { throw CountdownMutationFailure.rejected }
        },
        deleteCountdown: { id in
            feed.deletedIDs.append(id)
            if let gate = feed.deleteGate { await gate.wait() }
            if feed.deleteFails { throw CountdownMutationFailure.rejected }
        })
}

@MainActor
private func expectMutationFailure(_ operation: () async throws -> Void) async {
    do {
        try await operation()
        Issue.record("Expected the mutation to fail")
    } catch is CountdownMutationFailure {
        // Expected.
    } catch {
        Issue.record("Unexpected error: \(error)")
    }
}

@MainActor
@Suite struct CountdownsModelMutationTests {
    @Test func failedDeleteKeepsTheCountdownAndAllowsRetry() async throws {
        let item = countdown("countdown-1")
        let feed = CountdownFeed(items: [item])
        feed.deleteFails = true
        let model = model(feed)
        await model.load()

        await expectMutationFailure { try await model.remove(item) }

        #expect(feed.deletedIDs == ["countdown-1"])
        #expect(model.items.map(\.id) == ["countdown-1"])

        feed.deleteFails = false
        try await model.remove(item)

        #expect(feed.deletedIDs == ["countdown-1", "countdown-1"])
        #expect(model.items.isEmpty)
    }

    @Test func successfulDeleteRemovesTheCountdown() async throws {
        let first = countdown("countdown-1")
        let second = countdown("countdown-2")
        let feed = CountdownFeed(items: [first, second])
        let model = model(feed)
        await model.load()

        try await model.remove(first)

        #expect(feed.deletedIDs == ["countdown-1"])
        #expect(model.items.map(\.id) == ["countdown-2"])
    }

    @Test func concurrentDeletesIssueOneRequest() async throws {
        let item = countdown("countdown-1")
        let feed = CountdownFeed(items: [item])
        let gate = CountdownDeleteGate()
        feed.deleteGate = gate
        let model = model(feed)
        await model.load()

        let firstDelete = Task { try await model.remove(item) }
        while feed.deletedIDs.isEmpty { await Task.yield() }

        try await model.remove(item)
        #expect(feed.deletedIDs == ["countdown-1"])

        await gate.open()
        try await firstDelete.value

        #expect(feed.deletedIDs == ["countdown-1"])
        #expect(model.items.isEmpty)
    }

    @Test func failedCreatePropagatesWithoutRefreshing() async {
        let feed = CountdownFeed(items: [])
        feed.createFails = true
        let model = model(feed)
        await model.load()

        await expectMutationFailure {
            try await model.add(title: "Vacation", date: "2026-09-01", emoji: nil)
        }

        #expect(feed.fetchCount == 1)
        #expect(model.items.isEmpty)
    }

    @Test func failedUpdateKeepsTheExistingCountdown() async {
        let item = countdown("countdown-1", title: "Beach trip")
        let feed = CountdownFeed(items: [item])
        feed.updateFails = true
        let model = model(feed)
        await model.load()

        await expectMutationFailure {
            try await model.update(item, title: "Mountain trip", date: "2026-09-01", emoji: nil)
        }

        #expect(model.items.first?.title == "Beach trip")
        #expect(feed.fetchCount == 1)
    }
}
