import Foundation
import Observation
import PowerSync

struct SyncedMember: Identifiable, Sendable {
    let id: String
    let name: String
    let colorHex: String?
    let emoji: String?
    let memberType: String?
}

/// Serializes connection lifecycle work while letting an account exit supersede an
/// in-flight reconnect: a preempting operation advances the epoch immediately, so the
/// predecessor stops at its next suspension point before the shared database is touched.
@MainActor
final class ConnectionTransitionQueue {
    typealias Epoch = UInt64

    private(set) var currentEpoch: Epoch = 0
    private var tail: Task<Void, Never>?

    func isCurrent(_ epoch: Epoch) -> Bool { currentEpoch == epoch }

    func run<Result: Sendable>(
        preempting: Bool,
        busyResult: Result,
        supersededResult: Result,
        prepare: (@MainActor () -> Void)? = nil,
        operation: @escaping @MainActor (Epoch) async -> Result
    ) async -> Result {
        if !preempting, tail != nil { return busyResult }

        currentEpoch &+= 1
        let epoch = currentEpoch
        prepare?()
        let predecessor = tail
        let task = Task { @MainActor in
            if let predecessor { await predecessor.value }
            guard self.isCurrent(epoch) else { return supersededResult }
            return await operation(epoch)
        }
        tail = Task { @MainActor in _ = await task.value }

        let result = await task.value
        // A newer preempting task owns `tail`; an obsolete predecessor must never
        // clear that task's busy marker when it finally unwinds.
        if isCurrent(epoch) { tail = nil }
        return result
    }
}

/// Narrow lifecycle seam for the transition-race tests, which suspend teardown without
/// mocking PowerSync's large protocol surface.
struct SyncConnectionLifecycle: Sendable {
    let stop: @MainActor @Sendable (_ clearLocal: Bool) async -> Bool
    let start: @MainActor @Sendable () async -> Bool
    let applyConfiguration: @MainActor @Sendable (
        _ rawBaseURL: String?, _ rawDevToken: String?
    ) -> Void
}

/// Owns the PowerSync database lifecycle and surfaces live state to SwiftUI.
@MainActor
@Observable
final class SyncManager {
    enum Status: String { case idle, connecting, connected, offline }
    enum ConnectionUpdateResult: Equatable, Sendable {
        case updated
        case invalidURL
        case pendingUploads(Int)
        case transitionInProgress
        case teardownFailed
    }

    private(set) var status: Status = .idle
    /// Changes synchronously whenever credentials are torn down. REST cache keys include it
    /// (plus the server origin), so data survives a refresh but never a principal boundary.
    private(set) var restDataScope = RestDataScope()
    var restDataScopeKey: RestDataScopeKey {
        .init(scope: restDataScope, apiBaseURL: AppConfig.apiBaseURL)
    }
    private(set) var members: [SyncedMember] = [] { didSet { rebuildEventPalette() } }

    // MARK: event coloring (settings.display)

    /// Chip painting + the whole-family color, from `households.settings.display`. Views read
    /// `eventPalette`, rebuilt on change rather than per render — grids ask once per event.
    private(set) var eventStyle: EventStyle = .solid { didSet { rebuildEventPalette() } }
    private(set) var familyColorHex = EventPalette.defaultFamilyHex { didSet { rebuildEventPalette() } }
    private(set) var eventPalette = EventPalette()

    private func rebuildEventPalette() {
        eventPalette = EventPalette(memberIds: Set(members.map(\.id)),
                                    familyHex: familyColorHex, style: eventStyle)
    }

    /// Every synced event. The visible slice and day index are rebuilt in `didSet`, NOT per
    /// read: the calendar/Today views read them several times per render.
    private(set) var allEvents: [SyncedEvent] = [] { didSet { rebuildEventIndex() } }
    /// Family events plus the viewer's own personal ones; someone else's are hidden here.
    private(set) var events: [SyncedEvent] = []
    private(set) var eventsByDay: [String: [SyncedEvent]] = [:]

    /// The per-viewer filter as a pure function; an unowned personal event is hidden.
    nonisolated static func visibleEvents(_ all: [SyncedEvent], me: String?) -> [SyncedEvent] {
        all.filter { $0.visibility != "personal" || ($0.ownerPersonId != nil && $0.ownerPersonId == me) }
    }

    /// Re-derived from the `didSet`s of its three inputs, so no mutation site can forget it.
    private func rebuildEventIndex() {
        events = Self.visibleEvents(allEvents, me: currentPersonId)
        eventsByDay = Agenda.byDay(events, householdTz)
    }
    private(set) var householdTz: TimeZone = .current { didSet { rebuildEventIndex() } }
    /// The household's first-day-of-week (`households.week_start`) off the synced row — NOT
    /// the device's region setting, which routinely disagrees. The grocery list is keyed by it.
    ///
    /// A cold launch starts from the value the last run persisted (`HouseholdWeekStartStore`),
    /// since the synced row only reads from the first tick. nil means genuinely unknown and is
    /// deliberately NOT collapsed to `.sunday`: a caller grouping grocery weeks must tell
    /// "starts on Sunday" from "no idea yet", or a monday household gets a week left unbuilt.
    private(set) var householdWeekStart: HouseholdWeekStart? = HouseholdWeekStartStore.load()
    private(set) var personCount = 0
    private(set) var eventCount = 0
    private(set) var pendingUploads = 0
    private(set) var lastSyncedAt: Date?
    private(set) var lastError: String?

    /// Bumped after a REST capture commit so screens on those (non-synced) domains reload.
    private(set) var choresRev = 0
    private(set) var groceryRev = 0
    private(set) var mealsRev = 0
    private(set) var listsRev = 0
    private(set) var rewardsRev = 0
    /// Bumped after a goal-calendar review action so the review card and Goals reload.
    private(set) var goalsRev = 0

    func touchGoals() { goalsRev += 1 }

    /// Bumped when something that FEEDS a countdown changes — today, a rhythm. Both cards
    /// share a screen, so without this the chip beside a completed rhythm counts to the old date.
    private(set) var countdownsRev = 0

    func touchCountdowns() { countdownsRev &+= 1 }

    /// The logged-in person — id plus role & capabilities, so management controls only show
    /// where the server would allow the action.
    private(set) var currentPerson: WaffledAPI.CurrentPerson? { didSet { rebuildEventIndex() } }
    /// Tracked separately: a canceled task may already have installed `currentPerson`, and
    /// its replacement must still finish the module read.
    private var identityModulesScope: RestDataScopeKey?
    /// Reject an older same-scope module response when a newer refresh finishes first.
    private var moduleLoadGeneration = 0
    private var appliedModuleLoadGeneration = 0
    var currentPersonId: String? { currentPerson?.id }
    func loadIdentity() async {
        let api = api
        await loadIdentity(
            fetchCurrentPerson: { try await api.currentPerson() },
            fetchModules: { try await api.householdModules() }
        )
    }

    /// Injectable overload keeps the principal-boundary race deterministic in tests; both
    /// responses must belong to the scope that initiated the request.
    func loadIdentity(
        fetchCurrentPerson: @escaping @Sendable () async throws -> WaffledAPI.CurrentPerson?,
        fetchModules: @escaping @Sendable () async throws -> WaffledAPI.HouseholdModules
    ) async {
        let requestedScope = restDataScopeKey
        if currentPerson == nil {
            let person = try? await fetchCurrentPerson()
            guard !Task.isCancelled, requestedScope == restDataScopeKey else { return }
            currentPerson = person
        }
        guard identityModulesScope != requestedScope else { return }
        await reloadModules(requestedScope: requestedScope, fetch: fetchModules)
    }

    // MARK: optional modules

    /// The household's module flags + the rewards sub-toggle; mirrors platform/modules.ts.
    /// Until loaded, `module(_:)` returns the catalog defaults, so the default surface shows.
    private(set) var moduleFlags: [String: Bool] = [:]
    private(set) var rewardsSubEnabled = true
    /// Bumped after a module toggle so nav rails / Today re-evaluate live.
    private(set) var modulesRev = 0

    /// Bumped when the person explicitly asks for fresh data — a pull-to-refresh, or a return
    /// to the foreground. Several Today cards own their own REST fetch and a bare `.task { … }`
    /// runs once per appearance, so a pull-down left them on what they read at launch. Cards
    /// key their load on this (`.task(id: sync.refreshRev)`), so one signal wakes all of them.
    private(set) var refreshRev = 0

    /// Everything a deliberate refresh must cover that isn't a synced table. Awaited, so the
    /// spinner is held by a real round-trip.
    func refreshRestSurfaces() async {
        // Bump first, so the cards reload while the module read is still in flight.
        refreshRev &+= 1
        await reloadModules()
    }

    /// Mirrors the server's `moduleEnabled()`: the setting with the catalog default, and
    /// planned modules always off.
    func module(_ key: WaffledModule) -> Bool {
        guard key.isAvailable else { return false }
        return moduleFlags[key.rawValue] ?? key.defaultOn
    }

    /// Rewards is the spend half of chores — on only when chores is on AND the sub-flag is.
    var rewardsOn: Bool { module(.chores) && rewardsSubEnabled }

    /// (Re)load the module flags, at identity load and after a Settings → Modules toggle.
    func reloadModules() async {
        let api = api
        await reloadModules(
            requestedScope: restDataScopeKey,
            fetch: { try await api.householdModules() }
        )
    }

    private func reloadModules(
        requestedScope: RestDataScopeKey,
        fetch: @escaping @Sendable () async throws -> WaffledAPI.HouseholdModules
    ) async {
        moduleLoadGeneration &+= 1
        let generation = moduleLoadGeneration
        guard let m = try? await fetch(),
              !Task.isCancelled,
              requestedScope == restDataScopeKey,
              generation > appliedModuleLoadGeneration else { return }
        appliedModuleLoadGeneration = generation
        moduleFlags = m.modules
        rewardsSubEnabled = m.rewards
        // The same `/api/household` read carries settings.display, so the calendar's event
        // style refreshes with the module flags — which restyles open surfaces after a save.
        eventStyle = EventStyle.resolve(m.eventStyle)
        familyColorHex = EventPalette.normalizedFamilyHex(m.familyColorHex)
        identityModulesScope = requestedScope
        modulesRev += 1
    }

    /// Whether the signed-in person holds a capability — mirrors the web `can()`: admins
    /// implicitly have everything. "chore.manage"/"chore.approve"/"reward.manage"/"reward.approve".
    func can(_ capability: String) -> Bool {
        guard let p = currentPerson else { return false }
        return p.isAdmin || p.capabilities.contains(capability)
    }

    /// Whether the person can act on ANY approval queue — gates the badge/banner/queue.
    /// Per-item buttons stay gated by the specific capability.
    var canApprove: Bool { can("chore.approve") || can("reward.approve") }

    /// The household's reward currencies, loaded once (for chore/goal reward symbols).
    private(set) var currencies: [WaffledAPI.Currency] = []
    private var currencyLoadGeneration = 0
    private var appliedCurrencyLoadGeneration = 0
    /// The symbol for a currency key (defaults to ⭐ / the household default).
    func currencySymbol(_ key: String?) -> String {
        if let key, let c = currencies.first(where: { $0.key == key }) { return c.symbol }
        return currencies.first(where: { $0.isDefault })?.symbol ?? "⭐"
    }
    func currencyColor(_ key: String?) -> String? {
        currencies.first(where: { $0.key == key })?.color
    }
    func loadCurrencies() async {
        let api = api
        await loadCurrencies(fetch: { try await api.currencies() })
    }
    func loadCurrencies(
        fetch: @escaping @Sendable () async throws -> [WaffledAPI.Currency]
    ) async {
        guard currencies.isEmpty else { return }
        await replaceCurrencies(fetch: fetch)
    }
    /// Re-fetch the currency catalog (after an edit), ignoring the once-only guard.
    func refreshCurrencies() async {
        let api = api
        await replaceCurrencies(fetch: { try await api.currencies() })
    }

    private func replaceCurrencies(
        fetch: @escaping @Sendable () async throws -> [WaffledAPI.Currency]
    ) async {
        currencyLoadGeneration &+= 1
        let generation = currencyLoadGeneration
        let requestedScope = restDataScopeKey
        guard let fresh = try? await fetch(),
              !Task.isCancelled,
              requestedScope == restDataScopeKey,
              generation > appliedCurrencyLoadGeneration else { return }
        appliedCurrencyLoadGeneration = generation
        currencies = fresh
    }

    private let db: PowerSyncDatabaseProtocol
    private let connector = WaffledConnector()
    private let api = WaffledAPI()
    static let iso8601 = ISO8601DateFormatter()
    private var started = false
    private var watchTask: Task<Void, Never>?
    private var eventsTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?
    private let connectionTransitions = ConnectionTransitionQueue()
    private let testConnectionLifecycle: SyncConnectionLifecycle?

    init(testConnectionLifecycle: SyncConnectionLifecycle? = nil, initialMembers: [SyncedMember] = []) {
        self.testConnectionLifecycle = testConnectionLifecycle
        self.members = initialMembers
        db = PowerSyncDatabase(schema: SyncSchema.schema, dbFilename: "waffled.sqlite")
    }

    /// Stand up watchers once, then connect. Safe to call on every app launch.
    func start() async {
        await connectionTransitions.run(
            preempting: false,
            busyResult: (),
            supersededResult: ()
        ) { [weak self] epoch in
            await self?.performStart(epoch: epoch)
        }
    }

    private func performStart(epoch: ConnectionTransitionQueue.Epoch) async {
        guard connectionTransitions.isCurrent(epoch) else { return }
        guard !started else { return }
        started = true

        if let testConnectionLifecycle {
            let didStart = await testConnectionLifecycle.start()
            guard connectionTransitions.isCurrent(epoch), started else { return }
            if !didStart {
                status = .offline
                lastError = "Couldn’t start the sync connection."
                started = false
            }
            return
        }

        let openError = await openDatabase()   // serialize before concurrent access
        guard connectionTransitions.isCurrent(epoch), started else { return }
        lastError = openError
        watchMembers()
        watchEvents()
        observeStatus()
        await connect(epoch: epoch)
    }

    /// Force a single, serialized database open before any watches or the sync connection.
    /// PowerSync sets WAL journal mode on first access, needing a brief exclusive lock, and
    /// opening both connections concurrently races it into SQLITE_BUSY. Retried.
    private func openDatabase() async -> String? {
        let failure = await Retry.run(attempts: 6, delay: 400_000_000) { [db] in
            _ = try await db.getOptional(
                sql: "SELECT 1 AS n", parameters: [],
                mapper: { try $0.getInt(name: "n") }
            )
        }
        return failure.map { "Couldn't open the local database: \($0)" }
    }

    /// Reconnect transport without changing credentials; config changes go through
    /// `updateConnection`, which stops the old connection first.
    @discardableResult
    func reconnect() async -> Bool {
        await connectionTransitions.run(
            preempting: false,
            busyResult: false,
            supersededResult: false
        ) { [weak self] epoch in
            guard let self else { return false }
            guard self.pendingUploads == 0 else {
                let n = self.pendingUploads
                self.lastError = "Wait for \(n) pending change\(n == 1 ? "" : "s") to sync before reconnecting."
                return false
            }
            guard await self.stopSync(clearLocal: false, epoch: epoch),
                  self.connectionTransitions.isCurrent(epoch) else { return false }
            await self.performStart(epoch: epoch)
            return self.connectionTransitions.isCurrent(epoch)
        }
    }

    /// Atomically move the live client to a new server and/or developer token: the old
    /// connection stops before AppConfig changes, and only a real principal/server boundary
    /// clears the mirror and rotates REST state.
    func updateConnection(
        apiBaseURL rawBaseURL: String? = nil,
        devToken rawDevToken: String? = nil
    ) async -> ConnectionUpdateResult {
        await connectionTransitions.run(
            preempting: false,
            busyResult: .transitionInProgress,
            supersededResult: .transitionInProgress
        ) { [weak self] epoch in
            guard let self else { return .transitionInProgress }

            let normalizedBaseURL: String?
            if let rawBaseURL {
                let trimmed = rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    normalizedBaseURL = AppConfig.defaultBaseURL
                } else if let normalized = AppConfig.normalizedApiBaseURL(trimmed) {
                    normalizedBaseURL = normalized
                } else {
                    return .invalidURL
                }
            } else {
                normalizedBaseURL = nil
            }

            guard self.pendingUploads == 0 else { return .pendingUploads(self.pendingUploads) }

            let normalizedToken = rawDevToken?.trimmingCharacters(in: .whitespacesAndNewlines)
            let serverChanged = normalizedBaseURL.map { $0 != AppConfig.apiBaseURL } ?? false
            let tokenChanged = normalizedToken.map { $0 != AppConfig.storedDevToken } ?? false
            // A stored dev token is dormant while a Keychain session is active.
            let crossesPrincipalBoundary = serverChanged || (AuthTokens.accessToken == nil && tokenChanged)

            let stopped = await self.stopSync(clearLocal: crossesPrincipalBoundary, epoch: epoch)
            // A sign-out may have superseded this update while database teardown was
            // suspended. Never write its server/token or restart under that old intent.
            guard self.connectionTransitions.isCurrent(epoch) else {
                return .transitionInProgress
            }
            guard stopped else { return .teardownFailed }
            if let testConnectionLifecycle {
                testConnectionLifecycle.applyConfiguration(rawBaseURL, rawDevToken)
            } else {
                if let rawBaseURL { _ = AppConfig.setApiBaseURL(rawBaseURL) }
                if let rawDevToken { AppConfig.setDevToken(rawDevToken) }
            }
            if crossesPrincipalBoundary { self.invalidateRestDataScope() }
            await self.performStart(epoch: epoch)
            return self.connectionTransitions.isCurrent(epoch)
                ? .updated
                : .transitionInProgress
        }
    }

    /// Re-scope the live sync after the active session changed (a kiosk profile claim): tear
    /// the PowerSync session down and stand it back up against whatever token `AppConfig` now
    /// reports. `clearLocal` wipes the mirror, which a HOUSEHOLD change needs — the local
    /// SQLite is one shared file, so a plain disconnect can leave the old rows visible.
    @discardableResult
    func reauthenticate(
        expectedScope: RestDataScopeKey,
        clearLocal: Bool = false,
        adoptCredentials: (() -> Void)? = nil
    ) async -> Bool {
        await connectionTransitions.run(
            preempting: false,
            busyResult: false,
            supersededResult: false
        ) { [weak self] epoch in
            guard let self, self.restDataScopeKey == expectedScope else { return false }
                // Stop with the old credentials installed; rotate scope only after teardown.
            guard await self.stopSync(clearLocal: clearLocal, epoch: epoch),
                  self.connectionTransitions.isCurrent(epoch),
                  self.restDataScopeKey == expectedScope else { return false }
            self.invalidateRestDataScope()
            adoptCredentials?()
            await self.performStart(epoch: epoch)
            return self.connectionTransitions.isCurrent(epoch)
        }
    }

    /// Tear down the sync session on sign-out: stop the live queries, disconnect, drop the
    /// observable state and reset so the next `start()` runs fresh.
    ///
    /// `disconnect()`, not `disconnectAndClear()`: clearing the mirror is heavy and isn't
    /// needed when PowerSync re-scopes its buckets on the next login. A HOUSEHOLD switch
    /// passes `clearLocal: true`.
    @discardableResult
    func signOut(clearLocal: Bool = false) async -> Bool {
        await connectionTransitions.run(
            preempting: true,
            busyResult: false,
            supersededResult: false,
            // Invalidate REST-backed screens before the first suspension point.
            prepare: { [weak self] in self?.invalidateRestDataScope() }
        ) { [weak self] epoch in
            guard let self else { return false }
            return await self.stopSync(clearLocal: clearLocal, epoch: epoch)
        }
    }

    /// Stop PowerSync without deciding whether credentials changed — shared by sign-out and
    /// the connection-settings handoff above.
    private func stopSync(
        clearLocal: Bool,
        epoch: ConnectionTransitionQueue.Epoch
    ) async -> Bool {
        // Stop consuming the live queries BEFORE disconnecting, or a watcher races teardown.
        watchTask?.cancel(); eventsTask?.cancel(); statusTask?.cancel()
        watchTask = nil; eventsTask = nil; statusTask = nil
        let stopped: Bool
        if let testConnectionLifecycle {
            stopped = await testConnectionLifecycle.stop(clearLocal)
        } else if clearLocal {
            do {
                try await db.disconnectAndClear()
                stopped = true
            } catch {
                stopped = false
            }
        } else {
            try? await db.disconnect()
            stopped = true
        }
        // A newer account-exit transition owns all observable cleanup.
        guard connectionTransitions.isCurrent(epoch) else { return false }

        members = []; allEvents = []
        personCount = 0; eventCount = 0; pendingUploads = 0
        lastSyncedAt = nil
        lastError = stopped ? nil : "Couldn’t clear the previous account’s local data."
        status = stopped ? .idle : .offline
        started = false
        return stopped
    }

    /// Synchronous half of credential teardown: no database work, so the privacy boundary is
    /// immediate and race-testable.
    func invalidateRestDataScope() {
        restDataScope = RestDataScope()
        currentPerson = nil
        identityModulesScope = nil
        moduleLoadGeneration &+= 1
        moduleFlags = [:]
        rewardsSubEnabled = true
        eventStyle = .solid
        familyColorHex = EventPalette.defaultFamilyHex
        currencyLoadGeneration &+= 1
        currencies = []
        modulesRev &+= 1
    }

    private func connect(epoch: ConnectionTransitionQueue.Epoch) async {
        guard connectionTransitions.isCurrent(epoch), started else { return }
        guard !AppConfig.bearerToken.isEmpty else {
            status = .offline
            lastError = "Not signed in."
            return
        }
        status = .connecting
        do {
            try await db.connect(connector: connector)
        } catch {
            guard connectionTransitions.isCurrent(epoch), started else { return }
            status = .offline
            lastError = String(describing: error)
        }
    }

    /// Insert an event locally: commits to SQLite immediately and PowerSync queues it.
    func addTestEvent() async {
        guard let owner = try? await db.getOptional(
            sql: "SELECT id, household_id FROM persons ORDER BY sort_order, name LIMIT 1",
            parameters: [],
            mapper: { (try $0.getString(name: "id"), try $0.getString(name: "household_id")) }
        ) else {
            lastError = "No synced person yet to own a test event."
            return
        }

        let id = UUID().uuidString.lowercased()
        let iso = ISO8601DateFormatter()
        let now = Date()
        let starts = iso.string(from: now.addingTimeInterval(3600))
        let ends = iso.string(from: now.addingTimeInterval(7200))
        let label = DateFormatter.shortTime.string(from: now)

        do {
            try await db.execute(
                sql: """
                INSERT INTO events (id, household_id, title, starts_at, ends_at, all_day, person_id, origin)
                VALUES (?, ?, ?, ?, ?, 0, ?, 'manual')
                """,
                parameters: [id, owner.1, "📱 Phone test \(label)", starts, ends, owner.0]
            )
            await refreshCounts()
        } catch {
            lastError = String(describing: error)
        }
    }

    // MARK: capture ("Add anything")

    /// Parse free text into an intent via the server's pluggable LLM.
    func resolveCapture(_ text: String) async throws -> WaffledAPI.CaptureResponse {
        try await api.capture(text: text)
    }

    /// Warm the model so the first parse isn't a cold start (fire-and-forget).
    func warmCapture() async { await api.warmCapture() }

    // MARK: capture Tier 2 (mutate — resolve → pick → commit)

    /// Resolve a parsed mutate to candidate rows. Never throws — a network failure becomes an
    /// `offline` state. `key` is echoed back so a stale result can be dropped.
    func resolveMutate(verb: String, targetKind: String?, description: String,
                       args: [String: JSONValue], key: String) async -> MutateResolveState {
        do {
            let r = try await api.resolveMutate(verb: verb, targetKind: targetKind,
                                                description: description, args: args)
            return MutateResolveState(candidates: r.candidates, disabledReason: r.disabledReason,
                                      unsupported: r.unsupported ?? false, offline: false, forKey: key)
        } catch {
            return MutateResolveState(candidates: [], disabledReason: nil, unsupported: false,
                                      offline: true, forKey: key)
        }
    }

    /// Apply a chosen mutate: `(ok, message)` carries the server's confirmation or its reason.
    /// Bumps the affected surface's rev (events down-sync through PowerSync instead).
    func commitMutate(verb: String, targetKind: String?, targetId: String,
                      args: [String: JSONValue], meta: [String: JSONValue]?) async -> (ok: Bool, message: String) {
        do {
            let message = try await api.commitMutate(verb: verb, targetKind: targetKind,
                                                     targetId: targetId, args: args, meta: meta)
            refreshAfterMutate(targetKind)
            return (true, message)
        } catch let e as WaffledAPI.CaptureCommitError {
            return (false, e.message)
        } catch {
            lastError = String(describing: error)
            return (false, "Couldn’t do that — try again.")
        }
    }

    /// Bump the rev for the surface a committed mutate touched, mirroring the web
    /// `MUTATE_TOPIC` bus (event has no topic — PowerSync down-syncs the calendar change).
    private func refreshAfterMutate(_ targetKind: String?) {
        switch targetKind {
        case "chore": choresRev += 1
        case "goal": goalsRev += 1
        case "listItem": listsRev += 1; groceryRev += 1
        case "reward": rewardsRev += 1
        default: break
        }
    }

    /// Commit a captured event to the local mirror. The resolved person_id drives
    /// server-side calendar routing and the Google push; the phone never talks to Google.
    func commitEvent(title: String, startsAtISO: String, allDay: Bool, personName: String?,
                     rrule: String? = nil, recurrenceEndAt: String? = nil) async -> Bool {
        // Route through the same path the editor uses so the capture also writes the
        // `event_participants` row — otherwise the person is never shown as a participant.
        let personId = personName.flatMap { name in
            members.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.id
        }
        let ends: String? = allDay
            ? nil
            : EventTime.parse(startsAtISO).map { SyncManager.iso8601.string(from: $0.addingTimeInterval(3600)) }
        // A recurring capture goes through REST so the server materializes the
        // occurrences (the local mirror can't expand a rule); PowerSync down-syncs them.
        if let rrule, !rrule.isEmpty {
            do {
                _ = try await api.createEvent(
                    title: title, startsAtISO: startsAtISO, endsAtISO: ends, allDay: allDay,
                    location: nil, personIds: personId.map { [$0] } ?? [], goalId: nil, goalStepId: nil,
                    calendarId: nil, timezone: householdTz.identifier, rrule: rrule, recurrenceEndAt: recurrenceEndAt)
                return true
            } catch { lastError = String(describing: error); return false }
        }
        return await createCalendarEvent(
            title: title, startsAtISO: startsAtISO, endsAtISO: ends, allDay: allDay,
            location: nil, personIds: personId.map { [$0] } ?? [], calendarId: nil)
    }

    // MARK: calendar event writes (synced table → local mirror, queued for upload)

    /// The id of the synced household row, or nil before the first sync.
    private func householdRowId() async -> String? {
        (try? await db.getOptional(
            sql: "SELECT id FROM households LIMIT 1", parameters: [],
            mapper: { try $0.getString(name: "id") })) ?? nil
    }

    func eventParticipantIds(_ eventId: String) async -> [String] {
        (try? await db.getAll(
            sql: "SELECT person_id FROM event_participants WHERE event_id = ?",
            parameters: [eventId],
            mapper: { try $0.getString(name: "person_id") })) ?? []
    }

    private func replaceParticipants(eventId: String, householdId: String, personIds: [String]) async throws {
        try await db.execute(sql: "DELETE FROM event_participants WHERE event_id = ?", parameters: [eventId])
        for pid in Array(Set(personIds)) {
            try await db.execute(
                sql: "INSERT INTO event_participants (id, household_id, event_id, person_id) VALUES (?, ?, ?, ?)",
                parameters: [UUID().uuidString.lowercased(), householdId, eventId, pid])
        }
    }

    /// Create a calendar event in the local mirror; `person_id` is the first participant.
    func createCalendarEvent(title: String, startsAtISO: String, endsAtISO: String?,
                             allDay: Bool, location: String?, personIds: [String],
                             calendarId: String?, isCountdown: Bool = false) async -> Bool {
        guard let hh = await householdRowId() else { lastError = "No household synced yet."; return false }
        let id = UUID().uuidString.lowercased()
        do {
            try await db.execute(
                sql: """
                INSERT INTO events (id, household_id, title, description, location, starts_at, ends_at,
                                    all_day, is_countdown, timezone, person_id, calendar_id, origin)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
                """,
                parameters: [id, hh, title, nil, location, startsAtISO, endsAtISO,
                             allDay ? 1 : 0, isCountdown ? 1 : 0, householdTz.identifier, personIds.first, calendarId])
            try await replaceParticipants(eventId: id, householdId: hh, personIds: personIds)
            await refreshCounts()
            return true
        } catch { lastError = String(describing: error); return false }
    }

    func updateEvent(id: String, title: String, startsAtISO: String, endsAtISO: String?,
                     allDay: Bool, location: String?, personIds: [String], isCountdown: Bool = false) async -> Bool {
        guard let hh = await householdRowId() else { lastError = "No household synced yet."; return false }
        do {
            try await db.execute(
                sql: "UPDATE events SET title = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, is_countdown = ?, person_id = ? WHERE id = ?",
                parameters: [title, location, startsAtISO, endsAtISO, allDay ? 1 : 0, isCountdown ? 1 : 0, personIds.first, id])
            try await replaceParticipants(eventId: id, householdId: hh, personIds: personIds)
            await refreshCounts()
            return true
        } catch { lastError = String(describing: error); return false }
    }

    func deleteEvent(id: String) async -> Bool {
        do {
            try await db.execute(sql: "DELETE FROM event_participants WHERE event_id = ?", parameters: [id])
            try await db.execute(sql: "DELETE FROM events WHERE id = ?", parameters: [id])
            await refreshCounts()
            return true
        } catch { lastError = String(describing: error); return false }
    }

    /// Commit a captured grocery item via REST; the quantity folds in as "milk (2)".
    func commitGrocery(name: String, quantity: String?) async -> Bool {
        let ok = await restCommit { try await api.addGroceryItem(name: SyncManager.groceryLabel(name: name, quantity: quantity)) }
        if ok { groceryRev += 1 }
        return ok
    }

    /// Fold an optional quantity into the grocery label; whitespace-only is dropped.
    nonisolated static func groceryLabel(name: String, quantity: String?) -> String {
        guard let q = quantity?.trimmingCharacters(in: .whitespaces), !q.isEmpty else { return name }
        return "\(name) (\(q))"
    }

    /// Commit a captured task as a chore via REST; stars become the reward amount.
    func commitTask(title: String, personName: String?, stars: Int?, rewardCurrency: String? = nil, rrule: String?) async -> Bool {
        let ok = await restCommit {
            try await api.createChore(
                title: title, personId: personId(for: personName), rewardAmount: stars,
                rewardCurrency: rewardCurrency, rrule: rrule
            )
        }
        if ok { choresRev += 1 }
        return ok
    }

    /// Commit a captured meal via REST. Best-effort title match to a known recipe (exact,
    /// then contains) so the slot links it; otherwise planned as a one-off.
    func commitMeal(title: String, date: String?, mealType: String) async -> Bool {
        let day = date ?? localToday()
        let recipeId = await matchRecipe(title)
        let ok = await restCommit {
            try await api.planMeal(
                date: day, mealType: mealType,
                recipeId: recipeId, title: recipeId == nil ? title : nil
            )
        }
        if ok { mealsRev += 1 }
        return ok
    }

    /// Commit a captured countdown via REST. `date` must be YYYY-MM-DD.
    func commitCountdown(title: String, date: String, emoji: String?) async -> Bool {
        await restCommit { _ = try await api.createCountdown(title: title, date: date, emoji: emoji) }
    }

    /// Commit a captured family member via REST (admin-only; the caller gates on it).
    func commitPerson(name: String, memberType: String, avatarEmoji: String?, birthday: String?, isAdmin: Bool) async -> Bool {
        await restCommit {
            try await api.createPerson(name: name, memberType: memberType, avatarEmoji: avatarEmoji, birthday: birthday, isAdmin: isAdmin)
        }
    }

    /// Commit a captured goal via REST; the caller gates on the Goals module.
    func commitGoal(title: String, goalType: String, trackingMode: String, targetValue: Double?, unit: String?, deadline: String?, participantIds: [String] = []) async -> Bool {
        await restCommit {
            try await api.createGoal(title: title, goalType: goalType, trackingMode: trackingMode,
                                     targetValue: targetValue, unit: unit, deadline: deadline,
                                     participantIds: participantIds)
        }
    }

    /// Commit a captured pantry item via REST; the caller gates on the module (default OFF).
    func commitPantry(name: String, amount: String?, unit: String?, location: String, expiresOn: String?, lowAt: Double? = nil) async -> Bool {
        await restCommit {
            var body: [String: JSONValue] = ["name": .string(name), "location": .string(location)]
            if let amount, !amount.isEmpty { body["amount"] = .string(amount) }
            if let unit, !unit.isEmpty { body["unit"] = .string(unit) }
            if let expiresOn, !expiresOn.isEmpty { body["expiresOn"] = .string(expiresOn) }
            // The server keeps `low_at` only for a finite threshold ≥ 0 (mirrors the route).
            if let lowAt, lowAt >= 0 { body["lowAt"] = .double(lowAt) }
            _ = try await api.pantryCreate(body)
        }
    }

    /// Commit a captured reward via REST. Omits `requiresApproval` when nil so the route
    /// inherits the household default; bumps `rewardsRev`.
    @discardableResult
    func commitReward(title: String, emoji: String?, cost: Int?, requiresApproval: Bool?) async -> Bool {
        let ok = await restCommit {
            var body: [String: JSONValue] = ["title": .string(title)]
            if let cost { body["cost"] = .int(cost) }
            if let emoji, !emoji.isEmpty { body["emoji"] = .string(emoji) }
            if let requiresApproval { body["requiresApproval"] = .bool(requiresApproval) }
            try await api.rewardCreate(body)
        }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Plan (upsert) a meal slot; bumps `mealsRev`. `mealId` puts a plate in the slot.
    func setMealPlan(date: String, mealType: String, recipeId: String?, title: String?,
                     cookPersonId: String? = nil, mealId: String? = nil) async -> Bool {
        let ok = await restCommit {
            try await api.planMeal(date: date, mealType: mealType, recipeId: recipeId, title: title,
                                   cookPersonId: cookPersonId, mealId: mealId)
        }
        if ok { mealsRev += 1 }
        return ok
    }

    /// Clear a planned meal slot; bumps `mealsRev`.
    func clearMealPlan(date: String, mealType: String) async -> Bool {
        let ok = await restCommit { try await api.clearMeal(date: date, mealType: mealType) }
        if ok { mealsRev += 1 }
        return ok
    }

    /// Rebuild the grocery list from a week's dinners. Best-effort, so applying still succeeds.
    @discardableResult
    func rebuildGroceryFromWeek(weekStart: String) async -> Bool {
        let ok = await restCommit { _ = try await api.rebuildGrocery(weekStart: weekStart) }
        if ok { groceryRev += 1 }
        return ok
    }

    /// Execute one step of a planner apply. The sheets hand over a `MealPlanApply`, so which
    /// nights are written and which weeks rebuilt is decided (and tested) in one place.
    func perform(_ op: MealPlanApply.Op) async {
        switch op {
        case let .set(date, mealType, recipeId, title):
            _ = await setMealPlan(date: date, mealType: mealType, recipeId: recipeId, title: title)
        case let .clear(date, mealType):
            _ = await clearMealPlan(date: date, mealType: mealType)
        case let .rebuild(weekStart):
            await rebuildGroceryFromWeek(weekStart: weekStart)
        }
    }

    // MARK: rewards

    /// Redeem a reward for a person. Redeem only — never approve: the server already writes
    /// the debit when the household has approval turned off, and deliberately leaves the
    /// redemption `pending` for a parent when it's on (the web shop calls redeem alone for
    /// exactly that reason). Chaining an approve here did two wrong things — an instant
    /// redemption came straight back as "already decided", so a redemption that HAD succeeded
    /// reported failure, and an approval-required reward was walked past the parent queue.
    /// Bumps `rewardsRev`. Returns false on refusal; the reason surfaces via `lastError`.
    @discardableResult
    func giveReward(rewardId: String, personId: String) async -> Bool {
        do {
            _ = try await api.redeemReward(rewardId: rewardId, personId: personId)
            rewardsRev += 1
            return true
        } catch {
            lastError = String(describing: error)
            return false
        }
    }

    /// Ad-hoc "spot-award" not tied to a chore. Gated by `reward.grant`; bumps rewardsRev.
    @discardableResult
    func awardSpot(personId: String, amount: Int, currency: String?, note: String?) async -> Bool {
        let ok = await restCommit { try await api.awardSpot(personId: personId, amount: amount, currency: currency, note: note) }
        if ok { rewardsRev += 1 }
        return ok
    }

    @discardableResult
    func approveRedemption(id: String) async -> Bool {
        let ok = await restCommit { _ = try await api.approveRedemption(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Deny a pending redemption; the balance is left unchanged.
    @discardableResult
    func denyRedemption(id: String) async -> Bool {
        let ok = await restCommit { _ = try await api.denyRedemption(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Approve a chore completion that was awaiting a parent's OK (awards its stars).
    @discardableResult
    func approveChore(id: String) async -> Bool {
        let ok = await restCommit { try await api.approveChore(id: id) }
        if ok { choresRev += 1 }
        return ok
    }

    /// Reject an awaiting chore completion (sends it back to pending, no stars).
    @discardableResult
    func rejectChore(id: String) async -> Bool {
        let ok = await restCommit { try await api.rejectChore(id: id) }
        if ok { choresRev += 1 }
        return ok
    }

    /// Signal that chores changed elsewhere, so every screen reading `choresRev` reloads.
    func bumpChores() { choresRev += 1 }
    func bumpLists() { listsRev += 1 }

    /// Pin (or clear, with `nil`) the reward a person is saving toward; bumps `rewardsRev`.
    @discardableResult
    func setSavingToward(personId: String, rewardId: String?) async -> Bool {
        let ok = await restCommit { try await api.setSavingToward(personId: personId, rewardId: rewardId) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Create a reward in the catalog (admins); bumps `rewardsRev`.
    @discardableResult
    func createReward(title: String, emoji: String?, cost: Int, currency: String, category: String?, requiresApproval: Bool) async -> Bool {
        let ok = await restCommit { _ = try await api.createReward(title: title, emoji: emoji, cost: cost, currency: currency, category: category, requiresApproval: requiresApproval) }
        if ok { rewardsRev += 1 }
        return ok
    }

    @discardableResult
    func updateReward(id: String, title: String, emoji: String?, cost: Int, currency: String, category: String?, requiresApproval: Bool) async -> Bool {
        let ok = await restCommit { _ = try await api.updateReward(id: id, title: title, emoji: emoji, cost: cost, currency: currency, category: category, requiresApproval: requiresApproval) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Archive (soft-delete) a reward (admins); bumps `rewardsRev`.
    @discardableResult
    func archiveReward(id: String) async -> Bool {
        let ok = await restCommit { try await api.archiveReward(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    @discardableResult
    func restoreReward(id: String) async -> Bool {
        let ok = await restCommit { _ = try await api.restoreReward(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    // MARK: settings — currencies

    /// Create or edit a currency (admins). Refreshes the catalog and bumps rewardsRev.
    @discardableResult
    func saveCurrency(id: String?, _ body: [String: JSONValue]) async -> Bool {
        let ok = await restCommit {
            if let id { try await api.updateCurrency(id: id, body) } else { try await api.createCurrency(body) }
        }
        if ok { await refreshCurrencies(); rewardsRev += 1 }
        return ok
    }
    /// Delete a currency (admins). Fails (with `lastError`) if it's the default or last.
    @discardableResult
    func deleteCurrency(id: String) async -> Bool {
        let ok = await restCommit { try await api.deleteCurrency(id: id) }
        if ok { await refreshCurrencies(); rewardsRev += 1 }
        return ok
    }

    /// Create a conversion/trade rate (admins); bumps `rewardsRev`.
    @discardableResult
    func createConversion(_ body: [String: JSONValue]) async -> Bool {
        let ok = await restCommit { try await api.createConversion(body) }
        if ok { rewardsRev += 1 }
        return ok
    }
    @discardableResult
    func deleteConversion(id: String) async -> Bool {
        let ok = await restCommit { try await api.deleteConversion(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Trade a person's balance through a conversion N times; bumps `rewardsRev`.
    func applyConversion(id: String, personId: String, times: Int) async -> (ok: Bool, error: String?) {
        do {
            let r = try await api.applyConversion(id: id, personId: personId, times: times)
            if r.ok { rewardsRev += 1 }
            return (r.ok, r.error)
        } catch {
            lastError = String(describing: error)
            return (false, "Couldn’t complete that trade.")
        }
    }

    // MARK: settings — family & household

    @discardableResult
    func savePerson(id: String?, _ body: [String: JSONValue]) async -> Bool {
        await restCommit {
            if let id { try await api.updatePerson(id: id, body) } else { try await api.createPerson(body) }
        }
    }
    /// Delete a member (admins; the owner can't be removed → `lastError`).
    @discardableResult
    func deletePerson(id: String) async -> Bool {
        await restCommit { try await api.deletePerson(id: id) }
    }
    /// Edit household name/timezone/weekStart/location (admins).
    @discardableResult
    func updateHousehold(_ body: [String: JSONValue]) async -> Bool {
        await restCommit { try await api.updateHousehold(body) }
    }

    /// Commit a captured "add X to <list>" intent: resolve the named list, add the item.
    func commitListItem(item: String, listName: String?, quantity: String?) async -> Bool {
        do {
            let lists = try await api.listSummaries()
            var target = listName.flatMap { name in
                lists.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
            }
            // Web parity: an unmatched (but named) list is created on the fly.
            if target == nil, let name = listName?.trimmingCharacters(in: .whitespaces), !name.isEmpty {
                target = try await api.addList(name: name, emoji: nil)
            }
            guard let target else {
                lastError = "No matching list."
                return false
            }
            try await api.addListItem(listId: target.id, name: item, quantity: quantity)
            listsRev += 1
            return true
        } catch { lastError = String(describing: error); return false }
    }

    /// Today's date (YYYY-MM-DD) in the household timezone — the meal-plan default.
    private func localToday() -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = householdTz
        let c = cal.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private func matchRecipe(_ title: String) async -> String? {
        guard let recipes = try? await api.recipes() else { return nil }
        let n = title.lowercased()
        return recipes.first { ($0.title ?? "").lowercased() == n }?.id
            ?? recipes.first { ($0.title ?? "").lowercased().contains(n) }?.id
    }

    private func personId(for name: String?) -> String? {
        name.flatMap { n in
            members.first { $0.name.caseInsensitiveCompare(n) == .orderedSame }?.id
        }
    }

    /// Run a REST capture commit, surfacing failure via `lastError` and returning false.
    private func restCommit(_ op: () async throws -> Void) async -> Bool {
        do {
            try await op()
            return true
        } catch {
            lastError = String(describing: error)
            return false
        }
    }

    /// The person a captured name resolves to (for the preview chip + routing hint).
    func member(named name: String?) -> SyncedMember? {
        guard let name else { return nil }
        return members.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }

    /// Whether the person is an adult — gates the approval surfaces (server-gated too).
    var isParent: Bool {
        guard let id = currentPersonId else { return false }
        return members.first { $0.id == id }?.memberType == "adult"
    }

    // MARK: live state

    private func watchMembers() {
        watchTask = Task { [db] in
            do {
                // Match Settings → Family & People's order, so the row reads owner-first.
                let stream = try db.watch(
                    sql: "SELECT id, name, color_hex, avatar_emoji, member_type FROM persons ORDER BY sort_order, created_at",
                    parameters: [],
                    mapper: { cursor in
                        SyncedMember(
                            id: try cursor.getString(name: "id"),
                            name: try cursor.getString(name: "name"),
                            colorHex: try cursor.getStringOptional(name: "color_hex"),
                            emoji: try cursor.getStringOptional(name: "avatar_emoji"),
                            memberType: try cursor.getStringOptional(name: "member_type")
                        )
                    }
                )
                for try await rows in stream {
                    self.members = rows
                    self.personCount = rows.count
                }
            } catch {
                self.lastError = String(describing: error)
            }
        }
    }

    private func watchEvents() {
        eventsTask = Task { [db] in
            do {
                // The query lives in `EventQuery.agenda` so a test can read it.
                let stream = try db.watch(
                    sql: EventQuery.agenda,
                    parameters: [],
                    mapper: { cursor in
                        let raw = try cursor.getStringOptional(name: "starts_at")
                        let pids = (try cursor.getStringOptional(name: "participant_ids"))?
                            .split(separator: ",").map(String.init) ?? []
                        let id = try cursor.getString(name: "id")
                        return SyncedEvent(
                            id: id,
                            title: (try cursor.getStringOptional(name: "title")) ?? "(untitled)",
                            startsAtRaw: raw,
                            startsAt: EventTime.parse(raw),
                            allDay: (try cursor.getIntOptional(name: "all_day")) == 1,
                            personId: try cursor.getStringOptional(name: "person_id"),
                            colorHex: try cursor.getStringOptional(name: "person_color"),
                            emoji: try cursor.getStringOptional(name: "person_emoji"),
                            origin: try cursor.getStringOptional(name: "origin"),
                            endsAt: EventTime.parse(try cursor.getStringOptional(name: "ends_at")),
                            isCountdown: (try cursor.getIntOptional(name: "is_countdown")) == 1,
                            location: try cursor.getStringOptional(name: "location"),
                            participantIds: pids,
                            // For a single event series_id == id; occurrence_start is NULL.
                            seriesId: (try cursor.getStringOptional(name: "series_id")) ?? id,
                            occurrenceStart: try cursor.getStringOptional(name: "occurrence_start"),
                            visibility: (try cursor.getStringOptional(name: "visibility")) ?? "family",
                            ownerPersonId: try cursor.getStringOptional(name: "owner_person_id"),
                            rhythmId: try cursor.getStringOptional(name: "rhythm_id")
                        )
                    }
                )
                for try await rows in stream {
                    self.allEvents = rows
                    self.eventCount = rows.count
                }
            } catch {
                self.lastError = String(describing: error)
            }
        }
    }

    private func observeStatus() {
        statusTask = Task { [db] in
            for await s in db.currentStatus.asFlow() {
                self.lastSyncedAt = s.lastSyncedAt
                if s.connected {
                    self.status = .connected
                } else if s.connecting {
                    self.status = .connecting
                } else {
                    self.status = .offline
                }
                await self.refreshCounts()
            }
        }
    }

    private func refreshCounts() async {
        // ps_crud is PowerSync's internal upload queue — depth = unsynced writes.
        pendingUploads = (try? await db.getOptional(
            sql: "SELECT count(*) AS n FROM ps_crud", parameters: [],
            mapper: { try $0.getInt(name: "n") }
        )) ?? 0

                // Bucket the agenda by the household's timezone, device zone before first sync.
        if let row = try? await db.getOptional(
            sql: "SELECT timezone, week_start FROM households LIMIT 1", parameters: [],
            mapper: { (try $0.getStringOptional(name: "timezone"),
                       try $0.getStringOptional(name: "week_start")) }
        ) {
            if let id = row.0, let zone = TimeZone(identifier: id) {
                // Only assign on a real change — this runs on every sync-status tick, and
                // householdTz's didSet rebuilds the whole event index.
                if zone.identifier != householdTz.identifier { householdTz = zone }
            }
                // adopt() reads AND remembers in one call. The assignment stays guarded against
                // churn; the remembering must NOT be, or a sunday household never records it.
            let first = HouseholdWeekStartStore.adopt(row.1)
            if first != householdWeekStart { householdWeekStart = first }
        }
    }
}

/// The optional-modules catalog — a hand-mirror of apps/api/src/platform/modules.ts.
/// `available` modules toggle in Settings; `planned` ones are always off.
enum WaffledModule: String, CaseIterable, Identifiable {
    // Declaration order drives the Settings → Modules list; keep it in step with Family.
    case chores, goals, meals, lists, pantry, rhythms, familyNight, weeklyPlanning, waffledBites, quotes
    var id: String { rawValue }

    var isAvailable: Bool {
        switch self {
        case .quotes: return false
        default: return true
        }
    }
    /// Opt-in modules default off; the rest default on. Mirrors `defaultOn` in modules.ts —
    /// defaulting ON here and OFF on the server shows pages whose API 403s them.
    var defaultOn: Bool {
        self != .pantry && self != .rhythms && self != .familyNight
            && self != .weeklyPlanning && self != .waffledBites
    }

    var name: String {
        switch self {
        case .pantry: return "Pantry"
        case .rhythms: return "Rhythms"
        case .chores: return "Chores & Tasks"
        case .goals: return "Goals"
        case .meals: return "Meals & Recipes"
        case .lists: return "Lists & Groceries"
        case .familyNight: return "Family Night"
        case .weeklyPlanning: return "Weekly Planning"
        case .waffledBites: return "Waffled-Bites"
        case .quotes: return "Daily quote"
        }
    }
    var icon: String {
        switch self {
        case .pantry: return "🥫"
        case .rhythms: return "🔁"
        case .chores: return "✅"
        case .goals: return "🎯"
        case .meals: return "🍽️"
        case .lists: return "🛒"
        case .familyNight: return "🏡"
        case .weeklyPlanning: return "🗓️"
        case .waffledBites: return "🧇"
        case .quotes: return "💬"
        }
    }
    var summary: String {
        switch self {
        case .pantry: return "Track what's on hand (freezer/fridge/pantry) and feed meal planning."
        case .rhythms: return "The things that should keep happening — the air filter, trash night, a quarterly self-care day — with a place to confirm each one is actually handled."
        case .chores: return "The Tasks board — assignable chores, photo proof, approvals, and stars."
        case .goals: return "Personal and family goals with progress, streaks, and checklists."
        case .meals: return "Recipe library, weekly meal planning, and meals on the calendar."
        case .lists: return "Shared lists and the auto-built grocery board."
        case .familyNight: return "A weekly family gathering with a rotating agenda and a Today card."
        // Copy lifted verbatim from modules.ts so the two Settings screens read the same.
        case .weeklyPlanning: return "A guided session that walks the family through deciding the week ahead — loose ends, the calendar, meals, tasks and goals — reading from the modules you already use."
        case .waffledBites: return "Pair a kid's companion touchscreen — quiet time, wake-light, nightlight, alarm, and sound machine."
        case .quotes: return "A daily quote or snippet on the Today tab."
        }
    }
}

private extension DateFormatter {
    static let shortTime: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()
}
