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
    /// A `start` that refused. It outlives the status document that caused it: the refusal
    /// left nothing running, so the next poll says `stopped`, which on its own would look
    /// like a server nobody had tried to start.
    private(set) var failure: String?
    /// A poll that could not reach the runtime, held apart from `failure` so that the next
    /// poll to answer can drop it without erasing a refusal a person is still reading.
    private(set) var pollFailure: String?
    /// The one sentence the menu, the icon and the window all show.
    var heldFailure: String? {
        Lifecycle.HeldFailures(start: failure, poll: pollFailure).message
    }
    private(set) var transient: String?
    /// A `stop` that refused. Kept apart from `failure` because the server it describes
    /// is still running, so the next successful poll must not wipe it.
    private(set) var stopFailure: String?

    /// Everything the app does about an update, in one state machine (`UpdateFlow`). The
    /// model holds the phase, runs the effects, and decides none of it.
    private var flow = UpdateFlow()
    var updatePhase: UpdateFlow.Phase { flow.phase }

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

    /// Who asked for the start that is in flight — what decides whether reaching `running`
    /// opens a browser.
    private var startTrigger = Lifecycle.StartTrigger.notUs
    private var alreadyOpenedBrowser = false
    /// Whether the one auto-start this process is allowed has been spent (or stood down).
    private var autoStartDecided = false
    private var animationFrame = 0

    /// What the first poll that answered said about the data directory, latched: the rest
    /// of the launch behaves the same way even after `initialized` flips to true halfway
    /// through the first start.
    private(set) var isFirstRun = false
    private var firstRunDecided = false
    /// Something has started this run: a click on the window, a click on `Start Waffled`,
    /// or the one auto-start. Derived from the trigger the start recorded, because the two
    /// were only ever written together.
    var setupBegun: Bool { startTrigger != .notUs }
    private var firstRunDismissed = false
    private var firstRunCloseTask: Task<Void, Never>?
    private let firstRunWindow = FirstRunWindow()
    let isPortable: Bool

    private let memory: UpdateMemory

    /// - Parameter runner: the seam every runtime call goes through, so a test can drive a
    ///   start or a stop that is still running without spawning anything.
    init(environment: [String: String] = ProcessInfo.processInfo.environment,
         resourceURL: URL? = Bundle.main.resourceURL,
         hardware: HardwareProbe = SystemHardware(),
         memory: UpdateMemory = UserDefaults.standard,
         runner: RuntimeProcessRunning = SubprocessRunner()) {
        self.memory = memory
        location = RuntimeLocator.locate(environment: environment, resourceURL: resourceURL)
        client = location.map { RuntimeClient(location: $0, runner: runner) }
        // Read once: neither the model of this Mac nor its battery changes while the app
        // is running, and the answer is only ever asked for one paragraph.
        isPortable = Hardware.isPortable(hardware)
        if location == nil {
            failure = "No Waffled runtime is bundled with this build — see apps/mac/README.md"
        }
    }

    // MARK: what the menu bar draws

    var iconState: RuntimeState {
        Lifecycle.iconState(reported: status?.state, failure: heldFailure, stopFailure: stopFailure)
    }

    var icon: IconAppearance { IconAppearance.forState(iconState) }

    /// The frame to draw right now, at the menu bar's own 18 pt — the same drawing every
    /// time unless this state animates, in which case the frames cycle on the animation
    /// timer. The images are cached per state, frame and size, so this is a dictionary
    /// lookup on every poll.
    var currentImage: NSImage { image(pointSize: 18) }

    /// - Parameter canCheckForUpdates: the updater's own answer. The menu is a function of
    ///   this model and of Sparkle, and Sparkle is owned by the app rather than by here.
    func presentation(canCheckForUpdates: Bool) -> MenuPresentation {
        MenuPresentation.make(status: status, failure: heldFailure, transient: transient,
                              busy: busy, runtimeAvailable: client != nil,
                              stopFailure: stopFailure, awaitingSetup: awaitingSetup,
                              canCheckForUpdates: canCheckForUpdates,
                              updatePhase: flow.phase)
    }

    /// The first-run window's whole content, or nil on every launch that gets no window.
    var firstRunPresentation: FirstRunPresentation? {
        FirstRunPresentation.make(status: status, isFirstRun: isFirstRun,
                                  setupBegun: setupBegun, failure: heldFailure,
                                  isPortable: isPortable, busy: busy)
    }

    /// A first run whose welcome step is still waiting for a person. It holds the
    /// auto-start open and changes the menu's status line.
    var awaitingSetup: Bool { isFirstRun && !setupBegun }

    /// The mark at whatever size the window wants it, on the animation frame the menu bar
    /// is drawing — so the iron cooks at the same cadence in both places.
    func image(pointSize: CGFloat) -> NSImage {
        WaffleIronIcon.image(state: iconState, fillCount: icon.fillCount(frame: animationFrame),
                             pointSize: pointSize)
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
        // Before the cancellations: a cancelled operation still runs `finishOperation`,
        // and a restart the flow owes there would start a server on the way out of the
        // app. An update stop that had already succeeded loses its hand-off with it, which
        // is right — quitting mid-update is exactly when Sparkle must not be let go.
        flow = UpdateFlow()
        pollTask?.cancel()
        animationTask?.cancel()
        operationTask?.cancel()
        transientTask?.cancel()
        firstRunCloseTask?.cancel()
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
            hold(Lifecycle.failuresAfterPoll(reported: fresh.state, startFailure: failure,
                                             transportError: nil))
            // The opposite rule for a failed stop: it describes a server that is still
            // up, and is forgotten the moment a poll says it no longer is.
            if !Lifecycle.stopFailureStillApplies(reported: fresh.state) { stopFailure = nil }
            noteAnyVersionCrossing(fresh)
            openBrowserIfAnyoneIsWaiting(fresh)
        } catch {
            status = nil
            hold(Lifecycle.failuresAfterPoll(reported: nil, startFailure: failure,
                                             transportError: Self.describe(error)))
        }
        // After the catch, so a poll that threw arrives here as nil and decides nothing:
        // `status` failing is the ordinary cold start, since the runtime verifies its
        // bundle before it can reply.
        decideFirstRun(initialized: status?.initialized)
        syncFirstRunWindow()
    }

    private func considerAutoStart() {
        switch Lifecycle.autoStartDecision(state: status?.state, alreadyDecided: autoStartDecided,
                                           awaitingSetup: awaitingSetup) {
        case .keepWaiting:
            return
        case .standDown:
            autoStartDecided = true
        case .start:
            startServer(trigger: .app)
        }
    }

    /// Latched by the first poll that answered, and never revisited: `initialized` flips
    /// to true halfway through the first start, and the rest of the launch has to keep
    /// behaving like the first run it is.
    private func decideFirstRun(initialized: Bool?) {
        guard !firstRunDecided else { return }
        switch Lifecycle.firstRunDecision(initialized: initialized) {
        case .keepWaiting:
            return
        case .firstRun:
            firstRunDecided = true
            isFirstRun = true
        case .established:
            firstRunDecided = true
        }
    }

    /// "Updated to 0.15.0" / "Rolled back to 0.14.3", once per crossing.
    ///
    /// `bundle.previousVersion` records the last crossing this data went through and stays
    /// there for good — it is a fact about the directory, not an event — so what stops a
    /// poll every two seconds, and every launch after this one, from repeating the note is
    /// the moment of the crossing, written down here once it has been said.
    private func noteAnyVersionCrossing(_ fresh: RuntimeStatus) {
        let changedAt = fresh.bundle.versionChangedAt
        guard let line = Lifecycle.updateNote(
            previous: fresh.bundle.previousVersion, current: fresh.bundle.version,
            changedAt: changedAt,
            lastNoted: memory.string(forKey: Updates.lastNotedCrossingKey)) else { return }
        memory.set(changedAt, forKey: Updates.lastNotedCrossingKey)
        note(line)
    }

    private func openBrowserIfAnyoneIsWaiting(_ fresh: RuntimeStatus) {
        guard Lifecycle.shouldOpenBrowser(newState: fresh.state, trigger: startTrigger,
                                          isFirstRun: isFirstRun,
                                          alreadyOpened: alreadyOpenedBrowser) else { return }
        alreadyOpenedBrowser = true
        openWebApp(fresh)
    }

    // MARK: the first-run window

    /// The window follows the presentation: it appears when there is one, goes away when
    /// there is not, and never comes back once it has been dismissed — closing it during
    /// the start is a person saying "I will watch the menu bar", not "start again".
    private func syncFirstRunWindow() {
        guard let presentation = firstRunPresentation, !firstRunDismissed else {
            cancelReadyClose()
            firstRunWindow.close()
            return
        }
        firstRunWindow.show(model: self)
        // Disarmed the moment the window says something else. Polls carry on during those
        // two seconds, and the step they arrive at can be one with a button on it.
        guard Lifecycle.readyCloseStillApplies(step: presentation.step),
              let closesAfter = presentation.closesAfter else {
            cancelReadyClose()
            return
        }
        guard firstRunCloseTask == nil else { return }
        firstRunCloseTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(closesAfter))
            guard !Task.isCancelled else { return }
            self?.closeTheReadyWindow()
        }
    }

    /// The timer's whole decision, asked again at the moment it fires: cancellation and the
    /// step can both have moved on while it slept.
    private func closeTheReadyWindow() {
        guard Lifecycle.readyCloseStillApplies(step: firstRunPresentation?.step) else { return }
        dismissFirstRunWindow()
    }

    private func cancelReadyClose() {
        firstRunCloseTask?.cancel()
        firstRunCloseTask = nil
    }

    func dismissFirstRunWindow() {
        firstRunDismissed = true
        firstRunWindow.close()
    }

    // MARK: actions

    /// Never called on a timer and never in a loop: the runtime supervises its own
    /// children, and a second supervisor retrying behind it is the failure mode plan §7
    /// rules out.
    /// - Parameter trigger: `.person` by default, because every call site but the
    ///   auto-start is a click — including the first-run window's button, which is why
    ///   the click also spends the one auto-start attempt.
    func startServer(trigger: Lifecycle.StartTrigger = .person) {
        guard let client, operationTask == nil else { return }
        // A person putting the server back is the flow's restart, already done.
        if trigger == .person { send(.startClicked) }
        startTrigger = trigger
        autoStartDecided = true
        failure = nil
        pollFailure = nil
        stopFailure = nil
        syncFirstRunWindow()
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
        // The flow answers the two update-shaped cases — refusing while an installer is
        // armed, leaving without stopping when the menu item has already asked the second
        // question. No effects means the ordinary quit.
        guard send(.quitRequested(stopHasFailed: stopFailure != nil)).isEmpty else { return }
        // Order matters: an operation already in flight means no alert at all, rather than
        // an alert whose "Quit and Stop the Server" quietly does nothing.
        guard operationTask == nil, askToQuit() else { return }
        stopThenQuit()
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

    /// The menu's `Install the update now`: the same stop again, with the block Sparkle
    /// gave us the first time.
    func installPendingUpdate() {
        send(.installerArmed(handler: flow.phase.installHandler, canStopNow: operationTask == nil))
    }

    /// Sparkle has extracted and validated an update. It says nothing about when — or
    /// whether — anyone will click install: from this moment `Autoupdate` completes the
    /// swap on any termination, which is what the flow latches (`UpdateFlow`).
    func updateInstallerPrepared() {
        send(.installerArmed(handler: nil, canStopNow: operationTask == nil))
    }

    /// Sparkle is ready to swap this app — runtime bundle and all — and hands over the
    /// block that finishes it. The server has to be down first, and if it will not go down
    /// the relaunch is held (why: `docs/product/native-mac-plan.md`, Phase 3 item 6).
    ///
    /// The relaunched app's ordinary auto-start is what runs the new runtime against the
    /// existing data, which is where the snapshot, the migrations and the health gate
    /// happen. Nothing here knows about any of that, deliberately.
    func stopBeforeUpdate(then install: @escaping () -> Void) {
        send(.installerArmed(handler: InstallHandler(install), canStopNow: operationTask == nil))
    }

    /// Sparkle's update cycle ended without replacing anything — an abort, `Install on
    /// Quit`, or the ordinary check that found nothing.
    func updateCycleEnded(error: String?) {
        send(.cycleEnded(error: error))
    }

    /// The update's stop. Its outcome is an event, not a decision made here.
    private func stopForUpdate() {
        stop(noting: "Stopping for the update…") { [weak self] outcome in
            guard let self else { return }
            switch outcome {
            case .proceed:
                // Before the event, because a restart the flow queues next is decided on
                // the server's state and the stop just made the last status wrong. Not
                // before a hand-off, which owes no restart and whose `status` would spawn
                // the binary Sparkle is about to replace.
                if case .stoppingForInstall(nil) = flow.phase { await refresh() }
                send(.stopSucceeded)
            case let .refused(message):
                send(.stopFailed(message))
                await refresh()
            }
        }
    }

    private func stopThenQuit() {
        stop(noting: "Stopping…") { [weak self] outcome in
            switch outcome {
            case .proceed:
                NSApp.terminate(nil)
            case let .refused(message):
                self?.recordStopFailure(message)
                await self?.refresh()
            }
        }
    }

    /// The one stop this app knows how to do. Quitting and updating differ in the line the
    /// menu shows while it runs and in what they make of the outcome; the stop itself, and
    /// the rule for reading a refusal (`Lifecycle.outcomeAfterStop`), are the same.
    ///
    /// `stop` can take up to two and a half minutes (a graceful shutdown, then SIGKILL),
    /// so the note stays up and the actions stay disabled throughout.
    private func stop(noting line: String,
                      thenOnceDown finish: @escaping (Lifecycle.StopOutcome) async -> Void) {
        stopFailure = nil
        note(line, clearAfter: nil)
        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            var stopError: String?
            do {
                // `stop` is synchronous by contract: when it returns, the stack is down.
                try await self?.client?.stop()
            } catch {
                stopError = Self.describe(error)
            }
            await finish(Lifecycle.outcomeAfterStop(error: stopError))
        }
    }

    // MARK: the update flow

    /// One event, then the effects it asks for — plus the one question nothing else asks:
    /// a restart the flow owes waits for the operation slot, and a slot that was free all
    /// along would otherwise never announce itself.
    @discardableResult
    private func send(_ event: UpdateFlow.Event) -> [UpdateFlow.Effect] {
        let effects = flow.send(event)
        apply(effects)
        if flow.phase.owesRestart, operationTask == nil {
            apply(flow.send(.operationSlotFreed(serverState: status?.state)))
        }
        return effects
    }

    private func apply(_ effects: [UpdateFlow.Effect]) {
        for effect in effects {
            switch effect {
            case .stopServer:
                stopForUpdate()
            case let .invoke(handler):
                handler()
            case .restartServer:
                // Not a second supervisor: this is the server this app stopped a moment ago.
                startServer(trigger: .app)
            case let .note(message):
                note(message)
            case let .recordStopFailure(message):
                recordStopFailure(message)
            case let .refuseQuit(message):
                // The item is disabled, so this is only reachable if the installer landed
                // between the menu being drawn and the click.
                note(message)
            case .terminate:
                NSApp.terminate(nil)
            }
        }
    }

    // MARK: -

    /// The window's step depends on `busy`, so it is re-read here rather than waiting up to
    /// a poll for the error a start just reported to be offered with a working button.
    private func finishOperation() {
        operationTask = nil
        syncFirstRunWindow()
        send(.operationSlotFreed(serverState: status?.state))
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

    private func hold(_ failures: Lifecycle.HeldFailures) {
        failure = failures.start
        pollFailure = failures.poll
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
