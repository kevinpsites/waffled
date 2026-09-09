import Foundation

/// Sparkle's prepared-install block, boxed.
///
/// A box rather than a bare closure so the flow's phases and effects can be compared: the
/// only thing a test needs to know about a handler is *which* one it is, and closures have
/// no identity to compare.
final class InstallHandler: Equatable {
    private let run: () -> Void

    init(_ run: @escaping () -> Void) { self.run = run }

    func callAsFunction() { run() }

    static func == (lhs: InstallHandler, rhs: InstallHandler) -> Bool { lhs === rhs }
}

/// The whole of what this app does about an update, as one state machine.
///
/// **The invariant: `armed` is irreversible from this side.** Once Sparkle has extracted
/// and validated the new app, `Autoupdate` has performed stage 1 and is listening for this
/// process to exit; it then completes the swap on *any* termination — an abort reported to
/// the delegate, `Install on Quit`, a crash, a force quit (`Autoupdate/AppInstaller.m`,
/// and `SPUUpdaterDelegate.h`: "In either case Sparkle will always attempt to install the
/// update when the app terminates"). So the app latches the first news of a prepared
/// installer and never unlatches it for an ending cycle, an abort or an error. It clears
/// in one place only: `handedOff`, where our stop succeeded and we invoked the block, and
/// the swap is Sparkle's to finish.
///
/// The alternative — keying the Quit gate on the install block we happen to be holding —
/// is the bug this replaces: `Install on Quit` and an abort after stage 1 both leave the
/// app holding nothing while Sparkle is still armed, and `Quit anyway (server keeps
/// running)` then swaps the app and its runtime under a running server.
struct UpdateFlow {
    /// - `armed`: Sparkle holds a prepared installer. The handler is the block that can
    ///   drive it — the postpone block, or the immediate-install block from
    ///   `willInstallUpdateOnQuit` — or none, when all we have seen is the extraction.
    /// - `stoppingForInstall`: we asked the server to stop so we can hand off. A nil
    ///   handler here means Sparkle ended the cycle while the stop was still running, so
    ///   the stop has nothing left to invoke when it comes back.
    /// - `handedOff`: the stop succeeded and we invoked the block.
    /// - `restartQueued`: we stopped the server for a swap that is not coming, and owe it
    ///   a start as soon as the one operation slot is free. It exists only while an
    ///   operation holds that slot: `ServerModel.send` discharges it the moment it is free.
    ///
    /// There is no cycle token because there is one operation slot: at most one stop can
    /// be in flight, so the phase alone says which stop a completion belongs to. An app
    /// that grew a second concurrent operation would need one.
    enum Phase: Equatable {
        case idle
        case armed(handler: InstallHandler?)
        case stoppingForInstall(handler: InstallHandler?)
        case handedOff
        case restartQueued(handler: InstallHandler?)
    }

    enum Event {
        /// Sparkle has a prepared installer. Sent for `didExtractUpdate` (no block, the
        /// earliest and most reliable signal), for `shouldPostponeRelaunchForUpdate` and
        /// `willInstallUpdateOnQuit` (the block), and for the menu's own retry.
        /// - Parameter canStopNow: the one operation slot is free.
        case installerArmed(handler: InstallHandler?, canStopNow: Bool)
        case stopSucceeded
        case stopFailed(String)
        /// Sparkle's cycle ended without installing anything — an abort, a check that
        /// found nothing, or `Install on Quit`.
        case cycleEnded(error: String?)
        /// - Parameter serverState: what the last status said, read after the stop.
        case operationSlotFreed(serverState: RuntimeState?)
        case quitRequested(stopHasFailed: Bool)
    }

    /// What the model does, verbatim. Nothing here decides anything.
    enum Effect: Equatable {
        case stopServer
        case invoke(InstallHandler)
        case restartServer
        case note(String)
        case recordStopFailure(String)
        case refuseQuit(String)
        case terminate
    }

    static let busyNote = "Waffled is busy — try the update again in a moment"
    static let refusedQuitNote = "Stop the server first — an update will install on quit"

    private(set) var phase: Phase = .idle

    mutating func send(_ event: Event) -> [Effect] {
        let (next, effects) = Self.step(phase, event)
        phase = next
        return effects
    }

    static func step(_ phase: Phase, _ event: Event) -> (Phase, [Effect]) {
        switch event {
        case let .installerArmed(handler, canStopNow):
            return arming(phase, handler: handler, canStopNow: canStopNow)

        case .stopSucceeded:
            switch phase {
            case let .stoppingForInstall(handler?):
                return (.handedOff, [.invoke(handler)])
            case .stoppingForInstall(nil):
                // The cycle ended while this stop was running, so there is nothing to hand
                // off to: the server goes back, and the abort is explained now that the
                // "Stopping for the update…" line has done its job.
                return (.restartQueued(handler: nil), [.note(abortNote(nil))])
            default:
                return (phase, [])
            }

        case let .stopFailed(message):
            // The block is kept: having postponed the relaunch, Sparkle's session stays in
            // progress and a fresh `checkForUpdates` does nothing, so it is the only way on.
            guard case let .stoppingForInstall(handler) = phase else {
                return (phase, [.recordStopFailure(message)])
            }
            return (.armed(handler: handler), [.recordStopFailure(message)])

        case let .cycleEnded(error):
            return ended(phase, error: error)

        case let .operationSlotFreed(serverState):
            guard case let .restartQueued(handler) = phase else { return (phase, []) }
            return (.armed(handler: handler), restart(ifServerIs: serverState))

        case let .quitRequested(stopHasFailed):
            switch Lifecycle.quitAction(stopHasFailed: stopHasFailed, phase: phase) {
            case .confirmThenStop: return (phase, [])
            case .quitWithoutStopping: return (phase, [.terminate])
            case .stopTheServerFirst: return (phase, [.refuseQuit(refusedQuitNote)])
            }
        }
    }

    /// The one line the menu shows when an abort leaves the household with neither a server
    /// nor an update.
    static func abortNote(_ error: String?) -> String {
        guard let why = error?.firstLine else { return "Update not installed" }
        return "Update not installed: \(why)"
    }

    private static func arming(_ phase: Phase, handler new: InstallHandler?,
                               canStopNow: Bool) -> (Phase, [Effect]) {
        // News without a block — `didExtractUpdate` — only latches. It is what makes the
        // swap inevitable, but there is nothing of ours to run and nothing to stop the
        // server for; the postpone hook, moments later, is what can act on it.
        guard let handler = new else { return (phase.armedAtLeast, []) }

        switch phase {
        case .handedOff:
            return (phase, [])
        case .stoppingForInstall:
            // One operation slot means one stop; the one already running is the one that
            // will hand off.
            return (.stoppingForInstall(handler: handler), [])
        case .idle, .armed, .restartQueued:
            guard canStopNow else { return (phase.holding(handler), [.note(busyNote)]) }
            return (.stoppingForInstall(handler: handler), [.stopServer])
        }
    }

    private static func ended(_ phase: Phase, error: String?) -> (Phase, [Effect]) {
        switch phase {
        case .idle:
            return (.idle, [])
        case .armed:
            // The block's driver is gone, so the menu goes back to an ordinary check —
            // which works again, because the session that was blocking it ended too. What
            // does *not* go away is `armed`.
            return (.armed(handler: nil), [])
        case .stoppingForInstall:
            // Only the stop's completion can put the server back, and it is where this is
            // said: a note here would clear itself over the persistent "Stopping for the
            // update…" line and leave the menu disabled and unexplained until the stop
            // returns, which can be two and a half minutes.
            return (.stoppingForInstall(handler: nil), [])
        case .handedOff:
            return (.restartQueued(handler: nil), [.note(abortNote(error))])
        case .restartQueued:
            return (.restartQueued(handler: nil), [])
        }
    }

    /// Only a server that is actually down. Starting a second one on top of a running or
    /// half-started stack is the supervisor fight the plan forbids; a status that would not
    /// answer is not evidence the server came back, and we know we stopped this one.
    private static func restart(ifServerIs state: RuntimeState?) -> [Effect] {
        switch state {
        case .stopped, nil: return [.restartServer]
        case .running, .starting, .unhealthy: return []
        }
    }
}

extension UpdateFlow.Phase {
    /// Sparkle holds an installer that will complete on any termination.
    var installerArmed: Bool {
        switch self {
        case .idle, .handedOff: return false
        case .armed, .stoppingForInstall, .restartQueued: return true
        }
    }

    /// The block this app can run itself, when Sparkle has given us one.
    var installHandler: InstallHandler? {
        switch self {
        case let .armed(handler), let .stoppingForInstall(handler), let .restartQueued(handler):
            return handler
        case .idle, .handedOff:
            return nil
        }
    }

    /// A server this app stopped and has not put back.
    var owesRestart: Bool {
        if case .restartQueued = self { return true }
        return false
    }

    /// Latching, and nothing else: a phase already past `idle` says everything this does.
    fileprivate var armedAtLeast: UpdateFlow.Phase {
        if case .idle = self { return .armed(handler: nil) }
        return self
    }

    fileprivate func holding(_ handler: InstallHandler) -> UpdateFlow.Phase {
        switch self {
        case .idle, .armed: return .armed(handler: handler)
        case .stoppingForInstall: return .stoppingForInstall(handler: handler)
        case .restartQueued: return .restartQueued(handler: handler)
        case .handedOff: return self
        }
    }
}
