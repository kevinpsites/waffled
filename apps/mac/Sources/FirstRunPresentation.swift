import Foundation

/// The one window this app has (plan §6): what a household sees the first time Waffled
/// runs, and when a first run fails.
///
/// It is a value for the same reason the menu is: every word, button and tick can then be
/// asserted without a window, a process or a run loop. `FirstRunWindow` renders this and
/// does nothing else.
struct FirstRunPresentation: Equatable {
    enum Step: Equatable {
        /// Waiting for a person. Nothing has been created, and nothing will be until the
        /// button is clicked — which is why the auto-start stands aside for this step.
        case welcome
        /// The server is coming up, service by service.
        case starting
        /// Green, with the browser already opening behind this window.
        case ready
        /// The error sheet §6 allows: what went wrong, and the two ways forward.
        case failed
    }

    /// One service on its way up. `isReady` is the tick.
    struct ServiceRow: Equatable {
        var label: String
        var isReady: Bool
    }

    var step: Step
    var title: String
    var message: String
    /// The plan §5 warning, on the welcome step of a laptop and nowhere else.
    var portableNote: String?
    var services: [ServiceRow]
    var primaryButton: String?
    var secondaryButton: String?
    /// The ready step is a sentence, not a screen — it takes itself away.
    var closesAfter: TimeInterval?
    /// Closing the welcome window means "not on this Mac", and there is nothing on disk
    /// yet to leave behind, so it quits. Every later step is only a window in front of a
    /// server that is already coming up: closing it stops nothing.
    var closeQuitsApp: Bool

    /// The runtime's service names in the words the window uses. A name that is not here
    /// gets no row: the runtime adds services without asking (its Bonjour advertiser is
    /// one), and a progress list is not where a household should meet one.
    static let serviceLabels: [String: String] = [
        "postgres": "Postgres",
        "api": "API",
        "powersync": "Sync",
        "caddy": "Web",
    ]

    /// - Parameters:
    ///   - status: the last document that decoded, or nil before the first poll answers.
    ///   - isFirstRun: what the first poll that answered said about `initialized`. False
    ///     on every launch after the household exists, and then there is no window at all.
    ///   - setupBegun: a person has clicked — on this window, or on `Start Waffled` in the
    ///     menu, which counts the same.
    ///   - failure: an error the model is holding, exactly as the menu shows it.
    ///   - isPortable: this Mac sleeps when a lid closes.
    ///   - busy: a start, stop or backup is in flight. Both of this window's buttons are
    ///     inert while one is (`startServer` refuses a second, and `start` has no timeout),
    ///     so the error step during one is a screen a person cannot leave.
    static func make(
        status: RuntimeStatus?,
        isFirstRun: Bool,
        setupBegun: Bool,
        failure: String? = nil,
        isPortable: Bool = false,
        busy: Bool = false
    ) -> FirstRunPresentation? {
        guard isFirstRun else { return nil }

        if let failure, !busy { return breakdown(message: failure) }

        // The welcome step is for a data directory where nothing exists and nothing is
        // happening. A server already on its way up — this app's click, or a
        // `waffled-runtime start` in Terminal — makes "Set up Waffled" a lie, so the
        // window follows the server rather than only its own button.
        let underWay = setupBegun || (status.map { $0.state != .stopped } ?? false)
        guard underWay else {
            return FirstRunPresentation(
                step: .welcome,
                title: "Welcome to Waffled",
                message: """
                    Waffled sets up your family's server on this Mac: the calendar, chores, \
                    meals and photos your household shares. It all stays here, on your own \
                    hardware and your own network — and nothing is created until you say so.
                    """,
                portableNote: isPortable ? portableWarning : nil,
                services: [],
                primaryButton: "Set up Waffled",
                secondaryButton: nil,
                closesAfter: nil,
                closeQuitsApp: true)
        }

        if status?.state == .running {
            return FirstRunPresentation(
                step: .ready,
                title: "Your server is ready",
                message: "Opening Waffled…",
                portableNote: nil,
                services: [],
                primaryButton: nil,
                secondaryButton: nil,
                closesAfter: 2,
                closeQuitsApp: false)
        }

        return FirstRunPresentation(
            step: .starting,
            title: "Setting up Waffled",
            message: "First start takes about a minute.",
            portableNote: nil,
            services: rows(for: status?.services ?? []),
            primaryButton: nil,
            secondaryButton: nil,
            closesAfter: nil,
            closeQuitsApp: false)
    }

    /// The error step §6 allows, wherever the sentence came from.
    private static func breakdown(message: String) -> FirstRunPresentation {
        FirstRunPresentation(
            step: .failed,
            title: "Waffled could not start",
            message: message,
            portableNote: nil,
            services: [],
            primaryButton: "Try again",
            secondaryButton: "Show logs",
            closesAfter: nil,
            closeQuitsApp: false)
    }

    private static func rows(for services: [RuntimeStatus.Service]) -> [ServiceRow] {
        services.compactMap { service in
            serviceLabels[service.name].map {
                ServiceRow(label: $0, isReady: service.state == .running)
            }
        }
    }

    /// Said once, on the step where a person can still pick a different Mac. It is a
    /// warning and not a refusal — plenty of households will run this on the laptop they
    /// have, and being told why it drops off the network beats discovering it.
    private static let portableWarning = """
        This Mac is a laptop. Closing the lid puts it to sleep, and your server sleeps \
        with it — the kitchen tablet and everyone's phone lose Waffled until you open it \
        again. A Mac mini or a desktop that stays awake is a better home for it. Setting \
        up here works either way.
        """
}
