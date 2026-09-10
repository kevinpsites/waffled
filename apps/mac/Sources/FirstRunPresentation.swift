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
        /// The folder, the backup hour, the address and the keys, all applied before the
        /// first start so the first boot already uses them.
        case options
        /// The server is coming up, service by service.
        case starting
        /// Green, with the address to hand the kitchen tablet.
        case ready
        /// The error sheet §6 allows: what went wrong, and the two ways forward.
        case failed
    }

    /// One of the three things the welcome step promises, split so the lead can be bold.
    struct Promise: Equatable {
        var lead: String
        var rest: String
    }

    /// One thing that is already inside this app, with the version really shipping.
    struct Component: Equatable {
        var name: String
        var role: String
        var version: String
    }

    /// One service on its way up. `isReady` is the tick; `detail` is present-tense while
    /// it is still coming and done-tense once it is there.
    struct ServiceRow: Equatable {
        var label: String
        var detail: String
        var isReady: Bool
    }

    /// What the ready step hands a person.
    struct Address: Equatable {
        /// `host:port`, in whatever form the runtime composed — this Mac's name, its IP,
        /// or the one the household set up.
        var host: String
        /// The IP form, shown only when it is something different to say. The runtime
        /// reports it; nothing here works an address out for itself.
        var alternate: String?
        /// Said once, quietly, when the port in use is not the one that was asked for.
        var portNote: String?
        /// What the QR code encodes — the whole URL, not the host.
        var url: String
    }

    var step: Step
    var title: String
    var message: String
    /// The small line above the title, on the steps that have one.
    var eyebrow: String?
    var promises: [Promise] = []
    var components: [Component] = []
    /// The plan §5 warning, on the welcome step of a laptop and nowhere else.
    var portableNote: String?
    var services: [ServiceRow] = []
    /// Services ready over services known, 0…1. Nil on every step that is not starting.
    var progress: Double?
    /// The last line the runtime wrote, so a long start shows something moving.
    var lastLogLine: String?
    var address: Address?
    var menuBarNote: String?
    var primaryButton: String?
    var secondaryButton: String?
    /// The quiet one on the left: `Choose where things go…`, `Back`, `Show logs`.
    var tertiaryButton: String?
    /// Closing the welcome window means "not on this Mac", and there is nothing on disk
    /// yet to leave behind, so it quits. Every later step is only a window in front of a
    /// server that is already coming up: closing it stops nothing.
    var closeQuitsApp: Bool

    /// The runtime's service names in the words the window uses, with the two-line label
    /// the design asks for. A name that is not here gets no row: the runtime adds
    /// services without asking (its Bonjour advertiser is one), and a progress list is
    /// not where a household should meet one.
    static let serviceLabels: [String: (name: String, coming: String, ready: String)] = [
        "postgres": ("Postgres", "Preparing the database", "Database ready"),
        "api": ("API", "Starting the Waffled server", "Server answering"),
        "powersync": ("Sync", "Getting phones and tablets ready to sync", "Sync ready"),
        "caddy": ("Web", "Opening Waffled on your network", "Reachable on your network"),
    ]

    /// Every word on the options step. It has controls rather than prose, so its strings
    /// live here as a table instead of on a presentation of their own — but they live
    /// here, where they are read without a window like the rest of them.
    enum OptionsCopy {
        static let files = (
            title: "Waffled's files",
            hint: "The database, your photos and every backup live in this folder.",
            change: "Change…",
            reveal: "Reveal in Finder",
            settled: "Waffled is already set up here. You can move it later from Settings… in the menu bar."
        )
        static let backup = (
            title: "Nightly backup",
            detail: "Every night at %@, kept alongside Waffled's files.",
            off: "No backup is scheduled. Waffled can still back up on demand from the menu bar."
        )
        static let address = (
            title: "Address on your network",
            hint: """
                Waffled serves plain HTTP on your network; a certificate and HTTPS are not \
                part of this yet.
                """,
            custom: "A name you've set up yourself",
            customHint: """
                The name has to point at this Mac on your network — a router DNS entry, or \
                a domain aimed at its address.
                """,
            port: "Port",
            portHint: """
                Waffled prefers this port and moves to the next free one if something else \
                on this Mac already answers there. Ports below 1024 need an administrator, \
                so 1024 is the lowest one to choose.
                """
        )
        static let addressModes: [(SetupOptions.AddressMode, String, String)] = [
            (.name, "This Mac's name", "What phones and tablets discover on their own."),
            (.ip, "Its IP address", "For networks where .local names don't resolve."),
            (.custom, "A name I've set up myself", "A domain or router entry aimed at this Mac."),
        ]
        static let provider = (
            title: "Smart suggestions",
            optional: "— optional",
            detail: "Meal ideas and week planning. Add a provider key to turn them on.",
            hint: """
                Stored on this Mac only, in Waffled's own config. Skip it and add it later \
                — nothing else depends on it.
                """,
            placeholder: "sk-…"
        )
        static let login = (
            title: "Start Waffled when this Mac starts up",
            detail: "Recommended — the tablet and phones expect it to be there."
        )
    }

    /// The shortest time the setting-up step stays on screen.
    ///
    /// A first start here took 4.8 seconds. Without a floor the checklist appears and
    /// vanishes inside one animation frame, and a household is left with a window that
    /// flashed — which is how "nothing showed" gets reported about a setup that worked.
    static let minimumStartingDisplay: TimeInterval = 3

    /// - Parameters:
    ///   - status: the last document that decoded, or nil before the first poll answers.
    ///   - isFirstRun: what the first poll that answered said about `initialized`. False
    ///     on every launch after the household exists, and then there is no window at all.
    ///   - setupBegun: a person has clicked — on this window, or on `Start Waffled` in the
    ///     menu, which counts the same.
    ///   - showingOptions: the person asked to see "Where things go" before starting.
    ///   - failure: an error the model is holding, exactly as the menu shows it.
    ///   - isPortable: this Mac sleeps when a lid closes.
    ///   - busy: a start, stop or backup is in flight. Both of this window's buttons are
    ///     inert while one is (`startServer` refuses a second, and `start` has no timeout),
    ///     so the error step during one is a screen a person cannot leave.
    ///   - setupStartedAt: when the click happened, for the floor under the setting-up
    ///     step.
    ///   - preferredPort: the public port that was asked for, so the ready step can say
    ///     when the running one is different.
    static func make(
        status: RuntimeStatus?,
        isFirstRun: Bool,
        setupBegun: Bool,
        showingOptions: Bool = false,
        failure: String? = nil,
        isPortable: Bool = false,
        busy: Bool = false,
        setupStartedAt: Date? = nil,
        now: Date = Date(),
        lastLogLine: String? = nil,
        preferredPort: Int = SetupOptions.defaultPort
    ) -> FirstRunPresentation? {
        guard isFirstRun else { return nil }

        // Neither error step is offered while an operation is in flight: both its buttons
        // would be inert, and the progress list is the honest screen until it finishes.
        if !busy {
            if let failure { return breakdown(message: failure) }
            // A stack that came up and fell over is not still coming up — without this the
            // checklist stays on screen for the rest of the launch while the menu says why.
            if status?.state == .unhealthy {
                return breakdown(message: RuntimeStatus.attentionLine(status))
            }
        }

        // The welcome step is for a data directory where nothing exists and nothing is
        // happening. A server already on its way up — this app's click, or a
        // `waffled-runtime start` in Terminal — makes "Set up Waffled" a lie, so the
        // window follows the server rather than only its own button.
        let underWay = setupBegun || (status.map { $0.state != .stopped } ?? false)
        guard underWay else {
            return showingOptions ? options() : welcome(status: status, isPortable: isPortable)
        }

        let coming = starting(status: status, setupStartedAt: setupStartedAt, now: now,
                              lastLogLine: lastLogLine)
        guard status?.state == .running else { return coming }
        // A start that beat the floor keeps the checklist up, every row ticked, until it
        // is reached. The step is a person's only sight of what was installed, and the
        // rule lives in `Lifecycle` with the app's other timing decisions.
        guard Lifecycle.startingDisplayHasElapsed(since: setupStartedAt, now: now) else {
            return coming
        }
        return ready(status: status, preferredPort: preferredPort)
    }

    // MARK: the steps

    private static func welcome(status: RuntimeStatus?, isPortable: Bool) -> FirstRunPresentation {
        FirstRunPresentation(
            step: .welcome,
            title: "Welcome to Waffled",
            message: """
                Waffled keeps your family's calendar, chores, meals and photos on this \
                Mac — your own hardware, your own network. Nothing runs until you say so.
                """,
            eyebrow: nil,
            promises: [
                Promise(lead: "Nothing leaves the house.",
                        rest: "No account, no cloud, no subscription."),
                Promise(lead: "Everything it needs comes with it.",
                        rest: "The database, the server and the web app are already inside this app."),
                Promise(lead: "One click.",
                        rest: "About a minute the first time, then it starts itself whenever this Mac does."),
            ],
            components: bundledComponents(status),
            portableNote: isPortable ? portableWarning : nil,
            primaryButton: "Set up Waffled",
            secondaryButton: "Not on this Mac",
            tertiaryButton: "Choose where things go…",
            closeQuitsApp: true)
    }

    private static func options() -> FirstRunPresentation {
        FirstRunPresentation(
            step: .options,
            title: "Where things go",
            message: """
                These are already set sensibly. Change them now if you'd rather — you can \
                change the backup time and your keys later from the menu bar.
                """,
            eyebrow: "Before we start",
            primaryButton: "Set up Waffled",
            tertiaryButton: "Back",
            // Nothing has been created here either: the options screen is still a person
            // deciding whether Waffled belongs on this Mac.
            closeQuitsApp: true)
    }

    private static func starting(status: RuntimeStatus?, setupStartedAt: Date?, now: Date,
                                 lastLogLine: String?) -> FirstRunPresentation {
        let rows = self.rows(for: status?.services ?? [])
        let ready = rows.filter(\.isReady).count
        return FirstRunPresentation(
            step: .starting,
            title: "Setting up Waffled",
            message: """
                First start is usually under a minute. You can close this window — it \
                carries on without it.
                """,
            services: rows,
            progress: rows.isEmpty ? 0 : Double(ready) / Double(rows.count),
            lastLogLine: lastLogLine,
            tertiaryButton: "Show logs",
            closeQuitsApp: false)
    }

    private static func ready(status: RuntimeStatus?, preferredPort: Int) -> FirstRunPresentation {
        FirstRunPresentation(
            step: .ready,
            title: "Your server is ready",
            message: """
                Waffled is running on this Mac. Point the kitchen tablet or a phone at the \
                address below — they'll find it on their own after that.
                """,
            address: addressCard(status, preferredPort: preferredPort),
            menuBarNote: """
                Waffled lives in the menu bar now. The waffle iron at the top of your \
                screen is where you check on it, back it up, or stop it. There's no Dock \
                icon and no window to keep open.
                """,
            primaryButton: "Open Waffled",
            secondaryButton: "Copy address",
            closeQuitsApp: false)
    }

    /// The error step §6 allows, wherever the sentence came from.
    private static func breakdown(message: String) -> FirstRunPresentation {
        FirstRunPresentation(
            step: .failed,
            title: "Waffled could not start",
            message: message,
            primaryButton: "Try again",
            tertiaryButton: "Show logs",
            closeQuitsApp: false)
    }

    // MARK: the parts

    /// What the welcome step lists as already inside the app. The versions come from the
    /// bundle's own manifest by way of `status`, which answers with everything stopped —
    /// so they are real on the one screen that is shown before anything has ever run.
    static func bundledComponents(_ status: RuntimeStatus?) -> [Component] {
        let v = status?.versions ?? RuntimeStatus.Versions()
        return [
            Component(name: "Postgres", role: "Your family's records", version: v.postgres),
            Component(name: "Waffled server", role: "Calendar, chores, meals", version: v.api),
            Component(name: "Sync", role: "Phones stay current offline", version: v.powersync),
            Component(name: "Web", role: "The tablet's screen", version: v.web),
        ]
    }

    private static func rows(for services: [RuntimeStatus.Service]) -> [ServiceRow] {
        services.compactMap { service in
            serviceLabels[service.name].map { label in
                let isReady = service.state == .running
                return ServiceRow(label: label.name,
                                  detail: isReady ? label.ready : label.coming,
                                  isReady: isReady)
            }
        }
    }

    /// The address card. `urls.lan` is the address the runtime composed for this
    /// household — whichever form they chose — and `urls.lanIp` is the fallback it
    /// reports beside it. Neither is worked out here.
    static func addressCard(_ status: RuntimeStatus?, preferredPort: Int) -> Address? {
        guard let status, let host = hostAndPort(status.urls.lan) else { return nil }
        var alternate = hostAndPort(status.urls.lanIp)
        if alternate == host { alternate = nil }

        var portNote: String?
        let running = status.ports.public
        if running > 0, preferredPort > 0, running != preferredPort {
            portNote = "Using port \(running) because \(preferredPort) was busy on this Mac."
        }
        return Address(host: host, alternate: alternate, portNote: portNote, url: status.urls.lan)
    }

    private static func hostAndPort(_ raw: String) -> String? {
        guard !raw.isEmpty, let components = URLComponents(string: raw),
              let host = components.host else { return nil }
        guard let port = components.port else { return host }
        return "\(host):\(port)"
    }

    /// Said once, on the step where a person can still pick a different Mac. It is a
    /// warning and not a refusal — plenty of households will run this on the laptop they
    /// have, and being told why it drops off the network beats discovering it.
    private static let portableWarning = """
        This Mac is a laptop. Close the lid and your server sleeps with it — the tablet \
        and phones lose Waffled until you open it again. A Mac that stays awake is a \
        better home; setting up here works either way.
        """
}
