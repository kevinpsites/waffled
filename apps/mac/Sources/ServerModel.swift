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

    /// Where the runtime is and which directories it is handed. Not a `let`: the setup
    /// screen may move the data directory, and every call after that has to carry it.
    private(set) var location: RuntimeLocation?
    /// Injected for the same reason the runner is: the setup click registers one, and no
    /// test may put the test runner into the household's real Login Items.
    let loginItem: LoginItem

    private var client: RuntimeClient?
    /// Kept so the client can be rebuilt around a new data directory without reaching for
    /// a `Process` — the seam every runtime call goes through stays injected.
    private let runner: RuntimeProcessRunning
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
    /// What the "Where things go" screen holds. Bound straight to its controls, and read
    /// once when the button is clicked.
    var setupOptions = SetupOptions()
    private(set) var showingSetupOptions = false
    /// `Settings…` is open. It uses the same window and the same rows as the first run;
    /// only what is done with them differs, so the two can never be up at once.
    private(set) var showingSettings = false
    /// What was applied last, so Settings can show it and work out what changed. Read
    /// from the injected memory, never from config.env — `config set` is write-only.
    private(set) var appliedOptions: SetupOptions
    /// A setting the server only reads at start has been written since it started, so the
    /// running server is still on the old value. Held here rather than derived from the
    /// form: once Apply has run the form and what was saved agree, and comparing those two
    /// made the warning disappear at the very moment it became true.
    private(set) var addressAwaitingRestart = false
    /// The last Apply succeeded and this window has not been closed since — so the window
    /// can say so. The menu's own note is behind it and cannot be read.
    private(set) var settingsApplied = false
    /// When the setup click happened, for the floor under the setting-up step.
    private(set) var setupStartedAt: Date?
    /// Ticked once a second while the window is up, so the log line refreshes and the
    /// step re-decides the moment the floor is reached.
    private(set) var firstRunNow = Date()
    private(set) var lastLogLine: String?
    private var firstRunTicker: Task<Void, Never>?
    /// Something has started this run: a click on the window, a click on `Start Waffled`,
    /// or the one auto-start. Derived from the trigger the start recorded, because the two
    /// were only ever written together.
    var setupBegun: Bool { startTrigger != .notUs }
    private var firstRunDismissed = false
    private let firstRunWindow = FirstRunWindow()
    let isPortable: Bool

    private let memory: UpdateMemory

    /// - Parameter runner: the seam every runtime call goes through, so a test can drive a
    ///   start or a stop that is still running without spawning anything.
    init(environment: [String: String] = ProcessInfo.processInfo.environment,
         resourceURL: URL? = Bundle.main.resourceURL,
         hardware: HardwareProbe = SystemHardware(),
         memory: UpdateMemory = UserDefaults.standard,
         runner: RuntimeProcessRunning = SubprocessRunner(),
         loginItem: LoginItem? = nil) {
        self.memory = memory
        self.runner = runner
        // Built here rather than as a default argument: LoginItem is main-actor isolated,
        // and a default argument is evaluated outside that isolation.
        self.loginItem = loginItem ?? LoginItem()
        // Bound to a local first: reading back the property would be `self` before every
        // stored property has one.
        let applied = Setup.appliedOptions(in: memory)
        appliedOptions = applied
        setupOptions = applied
        // A folder chosen on a previous launch's setup screen. `WAFFLED_DATA_DIR` is not
        // read from here: the environment always wins, so a dev run against a scratch
        // directory can never be overridden by a choice the household made.
        let chosen = memory.string(forKey: Setup.dataDirectoryKey).map { URL(fileURLWithPath: $0) }
        let located = RuntimeLocator.locate(environment: environment, resourceURL: resourceURL,
                                            chosenDataDirectory: chosen)
        location = located
        client = located.map { RuntimeClient(location: $0, runner: runner) }
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
                              windowTaken: firstRunWindowIsUp,
                              canCheckForUpdates: canCheckForUpdates,
                              updatePhase: flow.phase)
    }

    /// Whether the first-run window is really on screen — which is not the same as there
    /// being a first-run presentation. `isFirstRun` is latched for the whole process, so
    /// after setup finishes the presentation goes on describing the ready step forever;
    /// dismissing the window is what ends it.
    var firstRunWindowIsUp: Bool { !firstRunDismissed && firstRunPresentation != nil }

    /// The first-run window's whole content, or nil on every launch that gets no window.
    var firstRunPresentation: FirstRunPresentation? {
        FirstRunPresentation.make(status: status, isFirstRun: isFirstRun,
                                  setupBegun: setupBegun, showingOptions: showingSetupOptions,
                                  failure: heldFailure,
                                  isPortable: isPortable, busy: busy,
                                  setupStartedAt: setupStartedAt, now: firstRunNow,
                                  lastLogLine: lastLogLine,
                                  preferredPort: SetupOptions.portNumber(setupOptions.port)
                                      ?? SetupOptions.defaultPort)
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

    /// `WAFFLED_DATA_DIR` decides where the data lives, so nothing here may move it.
    /// `chooseDataDirectory` deliberately refuses to repoint an environment-pinned
    /// location — the environment always wins — which means a move would copy the
    /// household, delete the original, and leave this app pointing at the folder it
    /// just deleted.
    var dataDirectoryIsPinned: Bool { location?.dataDirIsFromEnvironment ?? false }

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
        stopFirstRunTicker()
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
                                          alreadyOpened: alreadyOpenedBrowser) else { return }
        alreadyOpenedBrowser = true
        openWebApp(fresh)
    }

    // MARK: the first-run window

    /// The window follows the presentation: it appears when there is one, goes away when
    /// there is not, and never comes back once it has been dismissed — closing it during
    /// the start is a person saying "I will watch the menu bar", not "start again".
    private func syncFirstRunWindow() {
        guard let content = windowPresentation else {
            stopFirstRunTicker()
            firstRunWindow.close()
            return
        }
        firstRunWindow.show(model: self)
        // Only the setting-up step has anything that moves. The welcome step is waiting for
        // a person, the ready step is finished, and the settings screen is a form — a timer
        // re-rendering any of them once a second for as long as it sits open is work nobody
        // asked for.
        guard case let .firstRun(presentation) = content, presentation.step == .starting else {
            stopFirstRunTicker()
            return
        }
        startFirstRunTicker()
    }

    /// One second, two jobs: the last log line refreshes, and the setting-up step
    /// re-decides itself the moment its minimum display is up. The poll loop cannot do
    /// either — it is two seconds apart and reads a process.
    private func startFirstRunTicker() {
        guard firstRunTicker == nil else { return }
        firstRunTicker = Task { [weak self] in
            while !Task.isCancelled {
                self?.tickFirstRun()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func stopFirstRunTicker() {
        firstRunTicker?.cancel()
        firstRunTicker = nil
    }

    /// The tick that moves the clock is also the one that can end the step, so it stops
    /// itself rather than waiting up to a poll for `syncFirstRunWindow` to notice.
    private func tickFirstRun() {
        firstRunNow = Date()
        guard case .firstRun(let presentation) = windowPresentation,
              presentation.step == .starting else {
            lastLogLine = nil
            stopFirstRunTicker()
            return
        }
        lastLogLine = LogTail.lastLine(of: logsDirectory.appendingPathComponent("runtime.log"))
    }

    /// The close button, whichever screen is in the window. Settings is simply closed —
    /// it is reopened from the menu — while a first run is dismissed for the rest of the
    /// launch: closing that one is a person saying "I will watch the menu bar".
    #if DEBUG
    /// Puts the model in the state a finished first run leaves it in, for the tests that
    /// are about what happens AFTER one.
    ///
    /// Behind `#if DEBUG` so it is not in the app a household installs: a Release build
    /// carries no way to fake its own state, which is the same rule the supervisor's
    /// health prober follows — a test hook shipped to households is a test hook a
    /// household can hit.
    func pretendFirstRunForTesting(_ status: RuntimeStatus) {
        isFirstRun = true
        firstRunDecided = true
        self.status = status
        startTrigger = .setup
        setupStartedAt = .distantPast
    }
    #endif

    func dismissFirstRunWindow() {
        showingSettings = false
        firstRunDismissed = true
        stopFirstRunTicker()
        firstRunWindow.close()
    }

    // MARK: the setup screen

    func showSetupOptions() {
        showingSetupOptions = true
        syncFirstRunWindow()
    }

    func hideSetupOptions() {
        showingSetupOptions = false
        syncFirstRunWindow()
    }

    /// The setup click. Everything the screen collected is applied BEFORE the start, so
    /// the first boot already uses the chosen folder, port and name — and a `config set`
    /// that refuses stops the start rather than being started around.
    func beginSetup() {
        guard let client, operationTask == nil else { return }
        let options = setupOptions
        guard options.problems.isEmpty else { return }

        let devMode = isDevMode
        let clicked = Date()
        setupStartedAt = clicked
        firstRunNow = clicked
        showingSetupOptions = false

        startTrigger = .setup
        autoStartDecided = true
        failure = nil
        pollFailure = nil
        stopFailure = nil
        syncFirstRunWindow()
        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            do {
                for command in options.commandsBeforeFirstStart(isDevMode: devMode) {
                    try await client.apply(command)
                }
                // After the config writes and before the start, so a screen that could not
                // be applied does not leave a login item registered for a Waffled that was
                // never set up — the one thing here that `Try again` would not redo. Never
                // in dev mode: that would register whichever build is running to start the
                // household's Mac at every login.
                if !devMode {
                    self?.loginItem.setEnabled(options.startAtLogin)
                }
                // What Settings compares against from here on. Written after the config
                // succeeded and before the start, which is the point at which these are
                // really what is on disk.
                self?.rememberApplied(options)
                try await client.start()
            } catch {
                self?.recordFailure(Self.describe(error))
            }
            await self?.refresh()
        }
    }

    /// The ready step's two buttons. `Open Waffled` is the click a first run waits for —
    /// nothing opens a browser on its own at the end of one.
    func openWaffledFromSetup() {
        alreadyOpenedBrowser = true
        openWebApp()
        dismissFirstRunWindow()
    }

    /// The whole URL, which is what the QR code beside it encodes and what a person
    /// pastes into a browser. `host:port` on its own is what a browser turns into a
    /// search.
    func copySetupAddress() {
        guard let address = firstRunPresentation?.address else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address.url, forType: .string)
        note("Copied \(address.host)")
    }

    /// The folder picker's answer. Remembered, and carried as `--data` on every runtime
    /// call from here on — including the `config set`s the setup click is about to make,
    /// which is why the client is rebuilt now rather than at the start.
    ///
    /// `WAFFLED_DATA_DIR` in the environment still wins: a dev run against a scratch
    /// directory is never overridden by a choice made here.
    func chooseDataDirectory(_ url: URL?) {
        setupOptions.dataDirectory = url
        guard var location, !location.dataDirIsFromEnvironment else { return }
        // Remembered only when it is ours to remember. Written before this guard, a folder
        // picked during a run pinned by WAFFLED_DATA_DIR outlived that run and pointed the
        // next unpinned launch somewhere nobody chose — the environment wins while it is
        // set, and it does not get to leave anything behind when it is not.
        memory.set(url?.path, forKey: Setup.dataDirectoryKey)
        location.dataDir = url
        self.location = location
        client = RuntimeClient(location: location, runner: runner)
    }

    // MARK: the settings screen

    /// The one window's content. A first run owns it outright — it is the only launch
    /// that gets one, and `Settings…` is refused while it is up — so this is a preference
    /// order rather than a choice.
    var windowPresentation: WindowContent? {
        // Only while it has not been dismissed: a finished first run must not go on
        // claiming the window for the rest of the launch, or Settings can never have it.
        if !firstRunDismissed, let firstRun = firstRunPresentation { return .firstRun(firstRun) }
        guard showingSettings else { return nil }
        return .settings(SettingsPresentation.make(options: setupOptions, saved: appliedOptions,
                                                   dataDirectory: dataDirectory,
                                                   status: status, busy: busy,
                                                   pinned: dataDirectoryIsPinned,
                                                   awaitingRestart: addressAwaitingRestart,
                                                   applied: settingsApplied))
    }

    /// Which of the two screens the window is showing.
    enum WindowContent: Equatable {
        case firstRun(FirstRunPresentation)
        case settings(SettingsPresentation)
    }

    /// The menu item. The working copy starts from what was applied, with the provider key
    /// blank: it is never read back out of config.env, and a blank field reads as "I did
    /// not change it" rather than as a deletion.
    func openSettings() {
        // Refused only while the first-run window is actually up. A first run that has
        // finished and been dismissed is over, whatever the latched flag still says.
        guard !firstRunWindowIsUp else { return }
        setupOptions = appliedOptions
        setupOptions.providerKey = ""
        settingsApplied = false
        showingSettings = true
        syncFirstRunWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func closeSettings() {
        showingSettings = false
        syncFirstRunWindow()
    }

    /// Apply. Only what changed is sent — see `commandsForChange` — and the login item is
    /// this app's own business rather than the runtime's, so it is set separately.
    func applySettings() {
        guard let client, operationTask == nil, showingSettings else { return }
        let options = setupOptions
        guard options.problems.isEmpty else { return }
        let previous = appliedOptions
        let devMode = isDevMode

        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            do {
                for command in options.commandsForChange(from: previous, isDevMode: devMode) {
                    try await client.apply(command)
                }
                if !devMode, options.startAtLogin != previous.startAtLogin {
                    self?.loginItem.setEnabled(options.startAtLogin)
                }
                self?.rememberApplied(options)
                // The address is the one setting a running server will not pick up, so
                // this is what keeps the restart note on screen after the form settles.
                if options.publicHost != previous.publicHost, self?.status?.state == .running {
                    self?.addressAwaitingRestart = true
                }
                self?.settingsApplied = true
                self?.note("Settings applied")
            } catch {
                self?.recordFailure(Self.describe(error))
            }
            await self?.refresh()
        }
    }

    /// Moving Waffled's files. Three steps, in this order and no other: the runtime
    /// refuses to move a running cluster, the `--data` the move is told about is the OLD
    /// folder, and the start afterwards has to be pointed at the new one.
    ///
    /// The old folder is only removed by the runtime once the copy has arrived, so a
    /// failure at any point here leaves the household where it was — and the app keeps
    /// pointing at the folder the runtime last reported rather than the one it asked for.
    func moveDataDirectory(to destination: URL) {
        guard let client, operationTask == nil, showingSettings else { return }
        // Refused rather than half-done: the copy would work, the original would go, and
        // this app would keep pointing at the deleted folder.
        guard !dataDirectoryIsPinned else {
            recordFailure(SettingsPresentation.Copy.pinnedFolder)
            return
        }
        if let refusal = Setup.refusal(for: destination) {
            recordFailure(refusal)
            return
        }
        // The runtime refuses a destination inside the folder being moved, and it refuses
        // it AFTER this app has stopped the server. Asked here, the server stays up.
        let from = dataDirectory.standardizedFileURL.path
        if destination.standardizedFileURL.path == from
            || destination.standardizedFileURL.path.hasPrefix(from + "/") {
            recordFailure(SettingsPresentation.Copy.folderInsideItself)
            return
        }
        let wasRunning = status?.state == .running

        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            do {
                if wasRunning { try await client.stop() }
                try await client.apply(.move(to: destination))
                self?.chooseDataDirectory(destination)
                if wasRunning {
                    try await self?.client?.start()
                    self?.serverStarted()
                }
                self?.note("Waffled's files are in \(destination.lastPathComponent) now")
            } catch {
                self?.recordFailure(Self.describe(error))
                // A move that refused leaves the household in the old folder, whole — but
                // the stop that came first really happened. Bring the server back, or a
                // full disk costs a household their server as well as their move.
                if wasRunning { await self?.restartAfterFailedMove() }
            }
            await self?.refresh()
        }
    }

    /// `Restart Waffled`: a stop and a start, so a setting the server only reads at start
    /// takes effect without quitting the app — which would stop the server and leave the
    /// household with nothing until somebody opened it again.
    func restartServer() {
        guard let client, operationTask == nil, status?.state == .running else { return }
        startTrigger = .restart
        failure = nil
        pollFailure = nil
        stopFailure = nil

        operationTask = Task { [weak self] in
            defer { self?.finishOperation() }
            do {
                try await client.stop()
                try await client.start()
                self?.serverStarted()
                self?.note("Waffled restarted")
            } catch {
                self?.recordFailure(Self.describe(error))
            }
            await self?.refresh()
        }
    }

    /// Putting back what the move took down. `client` is read again rather than captured,
    /// because a move that got as far as the data directory has already rebuilt it — and
    /// the failure being reported is the move's, so a start that also fails must not
    /// replace the sentence explaining why.
    private func restartAfterFailedMove() async {
        guard let client else { return }
        if (try? await client.start()) != nil {
            serverStarted()
        }
    }

    /// A server that has just started has read whatever config.env says now, so nothing
    /// is waiting on a restart any more. Called from every start this app makes rather
    /// than from one of them: the flag is about the running server, not about which
    /// button was pressed.
    private func serverStarted() {
        addressAwaitingRestart = false
    }

    private func rememberApplied(_ options: SetupOptions) {
        appliedOptions = options
        Setup.remember(options, in: memory)
    }

    /// Where the data directory is, for the row that shows it. The runtime's own answer
    /// once it has given one, then the resolved location, then the documented default.
    var dataDirectory: URL {
        if let dataDir = status?.dataDir, !dataDir.isEmpty {
            return URL(fileURLWithPath: dataDir)
        }
        if let dataDir = location?.dataDir { return dataDir }
        return Setup.defaultDataDirectory
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

    /// The address as a QR code, in an `NSAlert` — an `LSUIElement` app has one window
    /// and the first run owns it, so a second one is not available to borrow. The alert is
    /// enough: this is a thing to hold a phone up to and then dismiss.
    func showAddressCode() {
        guard let url = MenuPresentation.shareURL(status) else { return }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Point a phone at this"
        alert.informativeText = url
        alert.accessoryView = QRCode.accessoryView(for: url, side: 220)
        alert.addButton(withTitle: "Done")
        alert.addButton(withTitle: "Copy address")
        if alert.runModal() == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
            note("Copied \(url)")
        }
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
            // Before the event, because a restart the flow queues next is decided on the
            // server's state and the stop just made the last status wrong.
            await refresh()
            switch outcome {
            case .proceed: send(.stopSucceeded)
            case let .refused(message): send(.stopFailed(message))
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
            // A stop of ours makes every status read before it wrong, and a restart is
            // decided on that state: forget it rather than decide on it.
            self?.status = nil
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
