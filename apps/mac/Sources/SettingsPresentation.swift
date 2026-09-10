import Foundation

/// `Settings…`: the "Where things go" rows again, on a Mac where Waffled already lives.
///
/// A value, for the same reason `FirstRunPresentation` is one — every word, every disabled
/// button and every "this needs a restart" can be asserted without a window or a process.
/// It is a separate type rather than a sixth `Step` because the two answer different
/// questions: the first run asks what a household wants, and this asks what they changed.
/// The controls are shared; only what is done with them differs.
struct SettingsPresentation: Equatable {
    var title: String
    var message: String
    /// Where Waffled's files actually are, as the runtime reports them.
    var dataDirectoryPath: String
    /// `Move…` is a stop, a copy and a start, so it is refused while anything else is in
    /// flight rather than queued behind it.
    var moveEnabled: Bool
    /// Why the folder cannot be moved, when it cannot — nil when it can. A disabled
    /// button with no reason is the thing this branch keeps taking out.
    var moveRefusal: String?
    /// The public port, read-only. `HTTP_PORT` is the first allocation's preference and
    /// nothing after it, so a field here would be a control that did nothing.
    var portValue: String
    var portNote: String
    /// The reasons Apply is off, in the same words the first-run screen uses.
    var problems: [String]
    var applyEnabled: Bool
    /// What the primary button does when it is clicked. Apply going dead the moment it
    /// worked left the only way forward — a restart — in a menu the person was not
    /// looking at, under a note they had to scroll to find.
    var primaryAction: Action

    enum Action: Equatable {
        case apply
        case restart
    }
    /// A change the running server will not notice until it is restarted. Saying so is the
    /// difference between "that did not work" and "that is waiting for you".
    var needsRestart: Bool
    /// What the window says once Apply has worked. The menu bar's own note is invisible
    /// while this window is the thing in front of the person who clicked.
    var confirmation: String?
    var primaryButton: String
    var secondaryButton: String

    /// Every word this screen adds to the ones `FirstRunPresentation.OptionsCopy` already
    /// holds. The shared rows keep their shared strings; only the frame is new.
    enum Copy {
        static let title = "Waffled Settings"
        static let message = """
            Change these whenever you like. Anything that needs the server restarted says \
            so before you apply it.
            """
        static let apply = "Apply"
        static let restart = "Restart Waffled"
        static let close = "Close"
        static let move = "Move…"
        static let restartNote = """
            Phones and tablets that find Waffled on their own are still being handed the old \
            address. Restart when it suits you — nothing is lost by waiting, and anything \
            already pointed at this Mac keeps working.
            """
        static let applied = "Settings applied."
        static let pinnedFolder = """
            WAFFLED_DATA_DIR is set, so this run does not decide where Waffled's files \
            live and cannot move them.
            """ 
        static let movedNote = "Waffled's files are here now. The server was restarted to use them."
        static let portReadOnly = """
            Waffled picked this port at setup and every device in the house points at it, \
            so it is not moved from here. Changing it means stopping the server and \
            editing runtime.json — the docs have the steps.
            """
        /// The folder row's sub-line on an install that exists, replacing the first run's
        /// "moving it is a separate job".
        static let filesHint = """
            Moving this copies everything — the database, your photos and every backup — \
            and restarts the server when it is done.
            """
    }

    /// - Parameters:
    ///   - options: the working copy the controls are bound to.
    ///   - saved: what was applied last, so Apply knows whether anything is different.
    ///   - dataDirectory: where the runtime says the files are, not where they were asked
    ///     to be — a move that failed must not leave the row claiming it worked.
    ///   - status: the last document, for the port actually in use.
    ///   - busy: a start, stop, backup or move is in flight.
    ///   - pinned: `WAFFLED_DATA_DIR` decides where the data lives, so this run may not
    ///     move it — see `ServerModel.dataDirectoryIsPinned`.
    ///   - awaitingRestart: a setting the server only reads at start has been written
    ///     since it started. Held by the model, because once Apply has run the form and
    ///     what was saved agree — and comparing those two was what made the warning
    ///     disappear at the moment it became true.
    ///   - applied: the last Apply succeeded, and this window has not been closed since.
    static func make(
        options: SetupOptions,
        saved: SetupOptions,
        dataDirectory: URL,
        status: RuntimeStatus?,
        busy: Bool = false,
        pinned: Bool = false,
        awaitingRestart: Bool = false,
        applied: Bool = false
    ) -> SettingsPresentation {
        let problems = options.problems
        let changed = !options.commandsForChange(from: saved).isEmpty
        let port = status?.ports.public ?? 0
        // Only the address is read at start. The nightly backup is installed into launchd
        // there and then, and a provider key is read per request by the api.
        let restartPending = (options.publicHost != saved.publicHost || awaitingRestart)
            && status?.state == .running
        // Nothing left to apply, but something left to do: the button becomes that thing
        // rather than greying out and leaving the person to find it in the menu.
        let offerRestart = !changed && restartPending

        return SettingsPresentation(
            title: Copy.title,
            message: Copy.message,
            dataDirectoryPath: dataDirectory.path,
            moveEnabled: !busy && !pinned,
            moveRefusal: pinned ? Copy.pinnedFolder : nil,
            portValue: port > 0 ? String(port) : "—",
            portNote: Copy.portReadOnly,
            problems: problems,
            applyEnabled: (offerRestart || changed) && problems.isEmpty && !busy,
            primaryAction: offerRestart ? .restart : .apply,
            needsRestart: restartPending,
            confirmation: applied ? Copy.applied : nil,
            primaryButton: offerRestart ? Copy.restart : Copy.apply,
            secondaryButton: Copy.close)
    }
}
