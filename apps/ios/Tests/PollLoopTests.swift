import Testing
@testable import Waffled

/// The parent control panel loaded a device once and then never again, so
/// anything the kid did ON the device stayed invisible until a manual pull to
/// refresh. `PollLoop` is the piece that fixes that, extracted from the view so
/// its cadence and cancellation are testable without a live API or a simulator.
@MainActor
private final class Counter {
    var count = 0
}

@Suite("PollLoop")
@MainActor
struct PollLoopTests {
    @Test("repeats the body until the task is cancelled")
    func repeatsUntilCancelled() async throws {
        let counter = Counter()
        let task = Task {
            await PollLoop.run(every: .milliseconds(20)) { counter.count += 1 }
        }
        try await Task.sleep(for: .milliseconds(120))
        task.cancel()
        let seen = counter.count
        #expect(seen >= 2, "expected several ticks in 120ms, saw \(seen)")

        // Nothing more after cancellation — a closed panel must cost nothing.
        try await Task.sleep(for: .milliseconds(80))
        #expect(counter.count == seen)
    }

    @Test("waits before the first extra call, so it never double-loads on open")
    func waitsBeforeFirstTick() async throws {
        let counter = Counter()
        let task = Task {
            await PollLoop.run(every: .milliseconds(200)) { counter.count += 1 }
        }
        // The caller has just done its own initial load; firing immediately
        // would mean two requests the moment the screen opens.
        try await Task.sleep(for: .milliseconds(40))
        #expect(counter.count == 0)
        task.cancel()
    }
}
