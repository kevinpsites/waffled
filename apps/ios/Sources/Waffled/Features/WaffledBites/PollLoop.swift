import Foundation

/// Repeats `body` on a fixed interval until the surrounding task is cancelled.
///
/// Exists so a screen can keep itself in step with something changing on the
/// other side of the network — specifically the Waffled-Bite panel, which
/// otherwise loaded once and never noticed anything the kid did on the device
/// itself.
///
/// Pulled out of the view rather than written inline so the cadence and the
/// cancellation behaviour are unit-testable without a live API or a simulator
/// (see `Tests/PollLoopTests.swift`). Pair it with SwiftUI's `.task(id:)`,
/// which cancels on disappear and restarts when the id changes — that's what
/// makes "stop polling in the background" fall out for free rather than
/// needing its own bookkeeping.
///
/// Sleeps BEFORE the first call: the caller has normally just done its own
/// initial load, and firing immediately would double-request on open.
@MainActor
enum PollLoop {
    static func run(every interval: Duration, _ body: @escaping () async -> Void) async {
        while !Task.isCancelled {
            // Throws on cancellation; the guard below is what actually exits.
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await body()
        }
    }
}
