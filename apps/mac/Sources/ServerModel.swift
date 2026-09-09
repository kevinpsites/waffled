import AppKit
import Foundation
import Observation

/// The app's one piece of state: what the runtime last said, what we are in the middle of
/// doing to it, and the two things we do without being asked.
///
/// Every runtime call happens off the main thread inside `RuntimeClient`; this type is
/// `@MainActor` so the menu never reads a half-written value.
@MainActor
@Observable
final class ServerModel {
    /// One app, one server manager. The instance is shared so the delegate (which starts
    /// the polling) and the menu (which renders it) cannot end up looking at two.
    static let shared = ServerModel()

    private(set) var status: RuntimeStatus?
    /// An error the app is holding on to. It outlives the status document that caused it:
    /// a `start` that refused leaves nothing running, so the next poll says `stopped`,
    /// which on its own would look like a server nobody had tried to start.
    private(set) var failure: String?
    private(set) var transient: String?
    /// A `stop` that refused. Kept apart from `failure` because the server it describes
    /// is still running, so the next successful poll must not wipe it.
    private(set) var stopFailure: String?

    /// A start, stop or backup is in flight. Derived rather than stored: the two were
    /// set in lockstep at four call sites, which is four chances for a menu stuck at
    /// "busy" forever, or never busy at all.
    var busy: Bool { operationTask != nil }

    let location: RuntimeLocation?
    let loginItem = LoginItem()

    private let client: RuntimeClient?
    private var pollTask: Task<Void, Never>?
    private var animationTask: Task<Void, Never>?
    private var operationTask: Task<Void, Never>?
    private var transientTask: Task<Void, Never>?

    /// Set when *this* process asked for a start, which is what makes opening the browser
    /// correct rather than intrusive.
    private var startWasAppInitiated = false
    private var alreadyOpenedBrowser = false
    /// Whether the one auto-start this process is allowed has been spent (or stood down).
    private var autoStartDecided = false
    private var animationFrame = 0

    init(environment: [String: String] = ProcessInfo.processInfo.environment,
         resourceURL: URL? = Bundle.main.resourceURL) {
        location = RuntimeLocator.locate(environment: environment, resourceURL: resourceURL)
        client = location.map { RuntimeClient(location: $0, runner: SubprocessRunner()) }
        if location == nil {
            failure = "No Waffled runtime is bundled with this build — see apps/mac/README.md"
        }
    }

    // MARK: what the menu bar draws

    var iconState: RuntimeState {
        Lifecycle.iconState(reported: status?.state, failure: failure, stopFailure: stopFailure)
    }

    var icon: IconAppearance { IconAppearance.forState(iconState) }

    /// The frame to draw right now — the same drawing every time unless this state
    /// animates, in which case the frames cycle on the animation timer. The images are
    /// cached per state and frame, so this is a dictionary lookup on every poll.
    var currentImage: NSImage {
        WaffleIronIcon.image(state: iconState,
                             fillCount: icon.fillCount(frame: animationFrame))
    }

    var presentation: MenuPresentation {
        MenuPresentation.make(status: status, failure: failure, transient: transient,
                              busy: busy, runtimeAvailable: client != nil,
                              stopFailure: stopFailure)
    }

    var isDevMode: Bool { location?.isDevMode ?? false }

    /// Where `Show logs` reveals. `status` knows best, but the whole point of that item is
    /// that something went wrong — possibly before any status came back — so the resolved
    /// location and then the documented default stand in.
    var logsDirectory: URL {
        if let dataDir = status?.dataDir, !dataDir.isEmpty {
            return URL(fileURLWithPath: dataDir).appendingPathComponent("logs")
        }
        if let dataDir = location?.dataDir {
            return dataDir.appendingPathComponent("logs")
        }
        return FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Waffled/logs")
    }

    // MARK: lifecycle

    /// Poll once, start the server if nothing is running, then keep polling.
    ///
    /// The auto-start question is asked after *every* poll rather than only the first,
    /// because the first `status` can fail — `supervisor.New` verifies the bundle
    /// manifest and settles ports before it can answer — and a launch whose first poll
    /// threw used to mean a server that was never started at all. `Lifecycle` still
    /// allows only one attempt: the first poll that answers spends it, whatever it says.
    func begin() {
        loginItem.refresh()
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.refresh()
            self?.considerAutoStart()
            while !Task.isCancelled {
                let interval = self?.pollInterval ?? 2
                try? await Task.sleep(for: .seconds(interval))
                await self?.refresh()
                self?.considerAutoStart()
                // The login item is not ours alone to change — someone can switch Waffled
                // off in System Settings while this menu sits here claiming otherwise —
                // so its status is re-read on the same timer as everything else.
                self?.loginItem.refresh()
            }
        }
        animationTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(600))
                self?.advanceAnimation()
            }
        }
    }

    func end() {
        pollTask?.cancel()
        animationTask?.cancel()
        operationTask?.cancel()
        transientTask?.cancel()
    }

    private var pollInterval: TimeInterval { Lifecycle.pollInterval(for: status?.state) }

    private func advanceAnimation() {
        guard icon.isAnimated else {
            animationFrame = 0
            return
        }
        animationFrame &+= 1
    }

    /// One poll. The loop awaits this, so a slow `status` delays the next tick rather than
    /// queueing another process behind it.
    private func refresh() async {
        guard let client else { return }
        do {
            let fresh = try await client.status()
            status = fresh
            // A server that came up is the only thing that clears a start failure —
            // clearing it on any successful poll would erase the message a moment after
            // it appeared, since `status` keeps answering fine when `start` refuses.
            if fresh.state == .running { failure = nil }
            // The opposite rule for a failed stop: it describes a server that is still
            // up, and is forgotten the moment a poll says it no longer is.
            if !Lifecycle.stopFailureStillApplies(reported: fresh.state) { stopFailure = nil }
            openBrowserIfThisAppStartedIt(fresh)
        } catch {
            status = nil
            failure = Self.describe(error)
        }
    }

    private func considerAutoStart() {
        switch Lifecycle.autoStartDecision(state: status?.state, alreadyDecided: autoStartDecided) {
        case .keepWaiting:
            return
        case .standDown:
            autoStartDecided = true
        case .start:
            autoStartDecided = true
            startServer()
        }
    }

    private func openBrowserIfThisAppStartedIt(_ fresh: RuntimeStatus) {
        guard Lifecycle.shouldOpenBrowser(newState: fresh.state,
                                          startWasAppInitiated: startWasAppInitiated,
                                          alreadyOpened: alreadyOpenedBrowser) else { return }
        alreadyOpenedBrowser = true
        openWebApp(fresh)
    }

    // MARK: actions

    /// Never called on a timer and never in a loop: the runtime supervises its own
    /// children, and a second supervisor retrying behind it is the failure mode plan §7
    /// rules out.
    func startServer() {
        guard let client, operationTask == nil else { return }
        startWasAppInitiated = true
        failure = nil
        stopFailure = nil
        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            do {
                try await client.start()
            } catch {
                self?.recordFailure(Self.describe(error))
            }
            await self?.refresh()
        }
    }

    func openWebApp(_ status: RuntimeStatus? = nil) {
        guard let local = (status ?? self.status)?.urls.local,
              let url = URL(string: local) else { return }
        NSWorkspace.shared.open(url)
    }

    func copyServerAddress() {
        guard let address = status?.serverAddress else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address, forType: .string)
        note("Copied \(address)")
    }

    func backUpNow() {
        guard let client, operationTask == nil else { return }
        note("Backing up…", clearAfter: nil)
        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            do {
                let path = try await client.backup()
                let name = (path as NSString).lastPathComponent
                self?.note(name.isEmpty ? "Backed up" : "Backed up to \(name)")
            } catch {
                self?.note("Backup failed: \(Self.describe(error))")
            }
        }
    }

    func revealLogs() {
        let logs = logsDirectory
        // `selectFile: nil` reveals the directory itself, and opening the parent when it
        // does not exist yet is friendlier than doing nothing at all.
        let target = FileManager.default.fileExists(atPath: logs.path)
            ? logs : logs.deletingLastPathComponent()
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: target.path)
    }

    /// Quitting the menu-bar app stops the household's server, which is not what "quit"
    /// usually means — so it is asked, plainly, before anything happens.
    ///
    /// An `LSUIElement` app has no window to hang a sheet on, so this is an `NSAlert`
    /// run modally after activating; a `.confirmationDialog` inside a `.menu`-style
    /// `MenuBarExtra` has nothing to present from and never appears.
    func confirmAndQuit() {
        switch Lifecycle.quitAction(stopHasFailed: stopFailure != nil) {
        case .quitWithoutStopping:
            // The menu item is already the second question — "Quit anyway (server keeps
            // running)" — and this click is its answer. Nothing is asked twice.
            NSApp.terminate(nil)
        case .confirmThenStop:
            // Order matters: an operation already in flight means no alert at all, rather
            // than an alert whose "Quit and Stop the Server" quietly does nothing.
            guard operationTask == nil, askToQuit() else { return }
            stopThenQuit()
        }
    }

    private func askToQuit() -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Quit Waffled?"
        alert.informativeText = """
            Your Waffled server will stop. Phones, tablets and browsers on your network \
            will not be able to reach it until you open Waffled again.
            """
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit and Stop the Server")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    /// `stop` can take up to two and a half minutes (a graceful shutdown, then SIGKILL),
    /// so the menu says `Stopping…` and disables the actions throughout — and if it
    /// refuses, the app stays where it is and says so. Exiting anyway would leave the
    /// household's server running with no icon left to explain it.
    private func stopThenQuit() {
        stopFailure = nil
        note("Stopping…", clearAfter: nil)
        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            var stopError: String?
            do {
                // `stop` is synchronous by contract: when it returns, the stack is down.
                try await self?.client?.stop()
            } catch {
                stopError = Self.describe(error)
            }

            switch Lifecycle.outcomeAfterStop(error: stopError) {
            case .terminate:
                NSApp.terminate(nil)
            case let .report(message):
                self?.recordStopFailure(message)
                await self?.refresh()
            }
        }
    }

    // MARK: -

    private func finishOperation() {
        operationTask = nil
    }

    /// One line for the menu, whatever went wrong. The runtime's own sentence when it
    /// gave us one, Foundation's otherwise — the choice was made identically in four
    /// places, which is four places for the wording to drift apart.
    private static func describe(_ error: Error) -> String {
        (error as? RuntimeClientError)?.firstLine ?? error.localizedDescription
    }

    private func recordFailure(_ message: String) {
        failure = message
    }

    /// The `Stopping…` note has to go with it: `transient` outranks everything in the
    /// status line, and this one was left up deliberately until something replaced it.
    private func recordStopFailure(_ message: String) {
        transientTask?.cancel()
        transient = nil
        stopFailure = message
    }

    /// A few seconds of answer in the status line. `clearAfter: nil` leaves it up until
    /// something else replaces it — what "Backing up…" wants.
    private func note(_ message: String, clearAfter seconds: TimeInterval? = 4) {
        transientTask?.cancel()
        transient = message
        guard let seconds else { return }
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.transient = nil }
        }
    }
}
