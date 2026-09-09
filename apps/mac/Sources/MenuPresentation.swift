import Foundation

/// What the menu-bar icon draws for a given state.
///
/// The mark is the closed waffle iron from the Waffled logo, drawn in `WaffleIronIcon`.
/// A menu-bar image is an 18 pt monochrome template — it has shape and nothing else — so
/// the state is the shape: outlined while nothing is running, cooking hole by hole while
/// it starts, solid when it is up, slashed when it needs a person.
struct IconAppearance: Equatable {
    /// More than one frame means "cycle these on the animation timer" — the only motion
    /// in the icon.
    var frameCount: Int
    var accessibilityLabel: String

    var isAnimated: Bool { frameCount > 1 }

    /// How many of the iron's six holes have cooked in this frame. Zero for every state
    /// that does not animate: an iron that is not heating has no half-made waffle in it.
    func fillCount(frame: Int) -> Int {
        guard isAnimated else { return 0 }
        // 1…6 rather than 0…5: an empty pan is the *stopped* drawing, and showing it in
        // the middle of a start would read as the server having given up.
        return frame % frameCount + 1
    }

    static func forState(_ state: RuntimeState) -> IconAppearance {
        switch state {
        case .stopped:
            return IconAppearance(frameCount: 1,
                                  accessibilityLabel: "Waffled is stopped")
        case .starting:
            // The waffle cooks: one more hole filled on every tick, then round again.
            return IconAppearance(frameCount: WaffleIronIcon.holeCount,
                                  accessibilityLabel: "Waffled is starting")
        case .running:
            return IconAppearance(frameCount: 1,
                                  accessibilityLabel: "Waffled is running")
        case .unhealthy:
            return IconAppearance(frameCount: 1,
                                  accessibilityLabel: "Waffled needs attention")
        }
    }
}

/// The colour of the status line's dot.
///
/// Colour lives here rather than in the icon on purpose: macOS renders a menu-bar image as
/// a template, recolouring it for light, dark, and the menu's own highlight, so a coloured
/// icon is either ignored or wrong. The menu is ordinary content and can be as green as
/// it likes.
enum StatusTint: Equatable {
    case running, starting, idle, fault

    static func forState(_ state: RuntimeState) -> StatusTint {
        switch state {
        case .running: return .running
        case .starting: return .starting
        case .stopped: return .idle
        case .unhealthy: return .fault
        }
    }
}

/// Everything the menu shows, as a value. The menu itself only renders this, so the whole
/// enabled/disabled table is testable without a menu, a process, or a run loop.
struct MenuPresentation: Equatable {
    var statusLine: String
    var statusTint: StatusTint
    var openEnabled: Bool
    var addressLine: String
    var addressEnabled: Bool
    var backupEnabled: Bool
    /// A way back. Auto-start is one attempt per launch, so a stopped server — or a start
    /// that refused — has to be startable by hand.
    var showStart: Bool
    var startEnabled: Bool
    /// Appears only when there is something in `logs/` worth reading.
    var showLogs: Bool
    /// The updater's item. The label carries the reason it is off, because a
    /// `.menu`-style `MenuBarExtra` renders no tooltip on an item.
    var checkForUpdatesLabel: String
    var checkForUpdatesEnabled: Bool
    /// "Quit anyway (server keeps running)" once a stop has refused — the second question
    /// the alert cannot ask, because by then the app is no longer on its way out.
    var quitTitle: String

    /// - Parameters:
    ///   - status: the last document that decoded, or nil before the first poll returns.
    ///   - failure: an error the app itself is holding — a `start` that refused, or a
    ///     runtime we could not run. It outlives the status document that caused it,
    ///     because a failed `start` leaves nothing running and `state` reads `stopped`.
    ///   - transient: "Backed up …", "Copied" — a few seconds of answer in the status line.
    ///   - busy: a start, stop or backup is in flight.
    ///   - runtimeAvailable: false when no `waffled-runtime` could be located at all, in
    ///     which case there is nothing for `Start Waffled` to run.
    ///   - stopFailure: a `stop` that refused while quitting. Held apart from `failure`
    ///     because the server it describes is still *running* — so a successful poll must
    ///     not clear it — and because it is what changes the quit item.
    ///   - awaitingSetup: a first run whose welcome window is still waiting for a click.
    ///   - canCheckForUpdates: Sparkle's own answer, observed on the updater.
    static func make(
        status: RuntimeStatus?,
        failure: String? = nil,
        transient: String? = nil,
        busy: Bool = false,
        runtimeAvailable: Bool = true,
        stopFailure: String? = nil,
        awaitingSetup: Bool = false,
        canCheckForUpdates: Bool = false
    ) -> MenuPresentation {
        let state = status?.state
        let address = status?.serverAddress
        let running = state == .running

        // A fault is a fault whether the runtime reported it or we caught it ourselves,
        // and either way `logs/` is the next place to look.
        let hasFailure = failure != nil
        let faulted = hasFailure || stopFailure != nil || state == .unhealthy
        // Something to start: a stack that is down, or one whose start refused — which
        // leaves the document reading `stopped` with the reason held here. A stop that
        // refused is the opposite situation: the server is still up.
        let startable = runtimeAvailable && (state == .stopped || (hasFailure && state != .running))

        let baseLine: String
        let tint: StatusTint
        switch (hasFailure || stopFailure != nil, state) {
        case (true, _) where stopFailure != nil:
            // The most recent thing that happened, and what the quit item is now about.
            baseLine = "Could not stop Waffled: "
                + (stopFailure?.firstLine ?? "the runtime refused")
            tint = .fault
        case (true, _):
            baseLine = failure?.firstLine ?? "Waffled could not start"
            tint = .fault
        case (_, .running):
            baseLine = "Waffled is running"
            tint = .running
        case (_, .starting):
            baseLine = "Waffled is starting…"
            tint = .starting
        case (_, .stopped):
            // A data directory nobody has set up yet is stopped too, but "stopped" reads
            // as something a person switched off.
            baseLine = awaitingSetup ? "Waffled is not set up yet" : "Waffled is stopped"
            tint = .idle
        case (_, .unhealthy):
            baseLine = RuntimeStatus.attentionLine(status)
            tint = .fault
        case (_, nil):
            baseLine = "Checking…"
            tint = .idle
        }

        return MenuPresentation(
            statusLine: transient ?? baseLine,
            statusTint: tint,
            openEnabled: running && !(status?.urls.local.isEmpty ?? true),
            addressLine: "Server address: \(address ?? "—")",
            addressEnabled: running && address != nil,
            // Enabled while stopped on purpose: `backup` starts Postgres for itself, and
            // "am I protected?" is asked exactly when nothing is up.
            backupEnabled: status != nil && !busy,
            showStart: startable,
            startEnabled: startable && !busy,
            showLogs: faulted,
            // Sparkle takes `canCheckForUpdates` away while a check or an install is in
            // flight (and before its updater has started at all, which it reports itself
            // with an alert of its own), so the disabled item names the ordinary reason.
            checkForUpdatesLabel: canCheckForUpdates
                ? "Check for updates…" : "Checking for updates…",
            checkForUpdatesEnabled: canCheckForUpdates,
            quitTitle: stopFailure == nil
                ? "Quit Waffled" : "Quit anyway (server keeps running)")
    }

    /// The line the menu shows once after an update installed itself and relaunched the
    /// app — or after someone re-installed an older build, which is the supported way back
    /// and reads the same way round.
    ///
    /// Nil when there is nothing to report, which is every ordinary launch.
    static func updateNote(previous: String, current: String) -> String? {
        switch VersionChange.describe(previous: previous, current: current) {
        case .unchanged: return nil
        case .upgraded: return "Updated to \(current)"
        case .downgraded: return "Rolled back to \(current)"
        }
    }
}

/// The two rules that decide what the app does without being asked, plus how often it asks.
enum Lifecycle {
    /// What to do about starting the server, asked after every poll and answered once.
    enum AutoStartDecision: Equatable {
        /// Nothing has answered yet — `status` itself can fail before the runtime is
        /// ready, and a poll that threw must not spend the single attempt.
        case keepWaiting
        /// The attempt, spent here.
        case start
        /// Spent, or never ours to make. The app does not start a server again for the
        /// life of the process.
        case standDown
    }

    /// The app gets exactly one auto-start per launch, and the first poll that actually
    /// answers decides it.
    ///
    /// The alternative — re-checking forever — turns the menu bar into a second
    /// supervisor: someone who runs `waffled-runtime stop` in Terminal would watch the
    /// app start it straight back up. Deciding once means "I found it stopped when I
    /// arrived", which is the only claim this app can honestly make.
    ///
    /// - Parameter awaitingSetup: a first run whose welcome window is on screen. The
    ///   attempt is held open rather than spent: the button is what starts a first run,
    ///   and a server that came up while the window was still asking would have answered
    ///   the question for the person reading it.
    static func autoStartDecision(state: RuntimeState?, alreadyDecided: Bool,
                                  awaitingSetup: Bool = false) -> AutoStartDecision {
        guard !alreadyDecided else { return .standDown }
        guard !awaitingSetup else { return .keepWaiting }
        guard let state else { return .keepWaiting }
        return shouldAutoStart(state) ? .start : .standDown
    }

    /// What the first status that answers says about the data directory.
    enum FirstRunDecision: Equatable {
        /// Nothing has answered yet. `status` can fail before the runtime is ready, and
        /// that is the ordinary cold start — latching on it would either show the welcome
        /// window to a household that has run for a year, or never show it at all.
        case keepWaiting
        /// Never set up: the one launch that gets a window.
        case firstRun
        /// A household already lives here. The app stays out of the way.
        case established
    }

    /// Asked once, on each poll until it answers; the model latches what comes back.
    static func firstRunDecision(initialized: Bool?) -> FirstRunDecision {
        guard let initialized else { return .keepWaiting }
        return initialized ? .established : .firstRun
    }

    /// Who asked for the server that is now running — the input the browser rule turns on.
    enum StartTrigger: Equatable {
        /// Nothing this process did: it was already up, or Terminal started it.
        case notUs
        /// The one auto-start per launch, which at login happens with nobody watching.
        case app
        /// A click: `Set up Waffled` on the first-run window, or `Start Waffled` in the menu.
        case person
    }

    /// Auto-start from `stopped` and from nowhere else.
    ///
    /// `unhealthy` is the case worth being explicit about: the runtime supervises its own
    /// children and restarts what it can, so an app that also starts on `unhealthy` is a
    /// second supervisor fighting the first — the restart loop plan §7 forbids. A stack
    /// that has fallen over says so in the menu and waits for a person.
    static func shouldAutoStart(_ state: RuntimeState) -> Bool {
        state == .stopped
    }

    /// Open the web app once per process, and only when somebody is waiting for it: the
    /// end of a first run (plan §2 step 3), or a click on `Start Waffled`.
    ///
    /// "Any start this app made" is not enough. The login item makes one of those at every
    /// boot, and a browser window that opens itself every time the Mac starts is the quiet
    /// relaunch (plan §2 step 6) getting loud. A server that was already running when the
    /// menu appeared belongs to whoever started it.
    static func shouldOpenBrowser(
        newState: RuntimeState, trigger: StartTrigger, isFirstRun: Bool, alreadyOpened: Bool
    ) -> Bool {
        guard newState == .running, !alreadyOpened else { return false }
        return isFirstRun || trigger == .person
    }

    /// What a click on the quit item means. The first click asks the alert and stops the
    /// server; if that stop refused, the item itself has become the second question
    /// ("Quit anyway — the server keeps running") and the next click is its answer.
    enum QuitAction: Equatable {
        case confirmThenStop
        case quitWithoutStopping
    }

    static func quitAction(stopHasFailed: Bool) -> QuitAction {
        stopHasFailed ? .quitWithoutStopping : .confirmThenStop
    }

    /// What the icon draws. A held failure outranks the document — a start that refused
    /// or a stop that refused are both faults a person has to see without opening the
    /// menu, even though the stack behind them is, technically, merely stopped or merely
    /// running.
    static func iconState(reported: RuntimeState?, failure: String?, stopFailure: String?) -> RuntimeState {
        if failure != nil || stopFailure != nil { return .unhealthy }
        return reported ?? .stopped
    }

    /// A failed stop describes a server that is still up. The moment a poll says it is
    /// not — stopped from Terminal, fallen over and restarted — the refusal is stale, and
    /// holding it would put "Start Waffled" beside "Could not stop Waffled".
    static func stopFailureStillApplies(reported: RuntimeState) -> Bool {
        reported == .running || reported == .unhealthy
    }

    /// What to do when `stop` comes back. The alert promised the server would stop, so a
    /// refusal cannot end in a silent exit that leaves it running with no icon left to
    /// say so.
    enum StopOutcome: Equatable {
        case terminate
        case report(String)
    }

    static func outcomeAfterStop(error: String?) -> StopOutcome {
        error.map { StopOutcome.report($0) } ?? .terminate
    }

    /// What to do when `stop` comes back during an **update**. Shaped like
    /// `outcomeAfterStop` and deliberately not folded into it: the success branch is the
    /// opposite of quitting — the app hands control back to Sparkle to swap and relaunch it.
    enum RelaunchDecision: Equatable {
        /// Nothing of ours is running any more: let Sparkle install and relaunch.
        case relaunch
        /// The server is still up, so the swap would land on top of it. Held, with the
        /// runtime's reason, exactly as a failed stop during quit is held.
        case hold(String)
    }

    /// The version note, or nil when there is nothing to say.
    ///
    /// - Parameters:
    ///   - changedAt: the moment the runtime recorded this crossing. It names the crossing,
    ///     which is why it is what gets remembered: `previousVersion` stays where it is
    ///     until the *next* update, so a latch that only lived as long as the process would
    ///     announce one update on every launch for the life of the data directory.
    ///   - lastNoted: the `changedAt` this app has already announced, or nil for a Mac that
    ///     has never announced one.
    ///
    /// The remembering happens on the note rather than on the poll, because the two halves
    /// of a crossing arrive on different polls: `bundle.version` comes from the manifest and
    /// is there before anything starts, while `previousVersion` is written when the runtime
    /// starts against the existing data — the auto-start, several polls later.
    static func updateNote(previous: String, current: String,
                           changedAt: String, lastNoted: String?) -> String? {
        guard changedAt != lastNoted else { return nil }
        return MenuPresentation.updateNote(previous: previous, current: current)
    }

    /// A Sparkle update replaces `Waffled.app` — the runtime bundle inside it included —
    /// and relaunches. macOS keeps a running process's mapped binaries alive after the
    /// files under them are replaced, so a swap over a *running* server leaves the
    /// household on the old runtime; the relaunched app then finds it `running`, stands
    /// its one auto-start down, and the update never reaches the data at all. The stop is
    /// what makes the relaunch's ordinary auto-start the update (plan §6).
    static func relaunchDecision(afterStop error: String?) -> RelaunchDecision {
        error.map { RelaunchDecision.hold($0) } ?? .relaunch
    }

    /// The failures the app is holding on to between polls, kept apart because they are
    /// forgotten on opposite rules.
    struct HeldFailures: Equatable {
        /// A `start` that refused. It outlives the document that followed it: the refusal
        /// left nothing running, so the next poll says `stopped`, which on its own looks
        /// like a server nobody had tried to start.
        var start: String?
        /// A poll that could not reach the runtime at all. It describes that poll and
        /// nothing else, so the next one to answer replaces it.
        var poll: String?

        /// The one sentence the menu and the window show: the refusal a person provoked
        /// beats the transport error underneath it.
        var message: String? { start ?? poll }
    }

    /// What is still held once a poll comes back.
    ///
    /// - Parameters:
    ///   - reported: the state the poll answered with, or nil when the poll itself threw.
    ///   - transportError: nil when `status` answered, however grim the answer was.
    static func failuresAfterPoll(reported: RuntimeState?, startFailure: String?,
                                  transportError: String?) -> HeldFailures {
        HeldFailures(start: reported == .running ? nil : startFailure, poll: transportError)
    }

    /// Whether the ready step's self-close still means anything when its timer fires. The
    /// window it was armed on can have been replaced in the meantime — a poll during those
    /// two seconds can report a stack that fell over — and closing is permanent, so a timer
    /// that fired blind would shut the `Try again` button away for the rest of the process.
    static func readyCloseStillApplies(step: FirstRunPresentation.Step?) -> Bool {
        step == .ready
    }

    /// Polling spawns a process, so it is deliberately unhurried once the answer has
    /// settled — and quicker while it is still changing, which is the only time anyone is
    /// watching the icon.
    static func pollInterval(for state: RuntimeState?) -> TimeInterval {
        state == .starting ? 1 : 2
    }
}
