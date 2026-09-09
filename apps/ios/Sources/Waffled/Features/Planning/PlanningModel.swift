import Foundation
import Observation

/// One act of the agenda and its steps, given a name so `ForEach` has something
/// `Identifiable`. The id includes the first step's key: two separated runs CAN share an act
/// name, and a duplicated id makes SwiftUI reuse the wrong rows.
struct PlanningActGroup: Identifiable, Equatable {
    let act: String
    let steps: [WaffledAPI.PlanningStep]
    var id: String { act + "\u{1}" + (steps.first?.key ?? "") }
}

/// Weekly Planning — the session shell's model, a port of `WeeklyPlanning.tsx`'s state with
/// one translation: the web keeps "which step am I looking at" in the URL and "which week"
/// in the query, so here they are `askedStep`/`requestedWeek` and every place the web
/// navigates this model assigns. `currentStep` stays the cross-DEVICE resume pointer.
@MainActor
@Observable
final class PlanningModel {

    // MARK: - The seam

    typealias FetchView = (_ weekStart: String?) async throws -> WaffledAPI.WeeklyPlanningView
    typealias FetchConfig = () async throws -> WaffledAPI.WeeklyPlanningConfigView
    typealias SaveConfig = (
        _ dayOfWeek: Int?, _ time: String?, _ showOnToday: Bool?, _ steps: [String: Bool]?,
        _ lists: [String: Bool]?
    ) async throws -> WaffledAPI.WeeklyPlanningConfig
    typealias StartSession = (_ weekStart: String?) async throws -> WaffledAPI.PlanningSession
    typealias PatchSession = (
        _ id: String, _ currentStep: String?, _ status: String?
    ) async throws -> WaffledAPI.PlanningSession
    typealias DecideStep = (
        _ sessionId: String, _ stepKey: String, _ status: String, _ data: [String: JSONValue]?
    ) async throws -> [WaffledAPI.PlanningStep]
    typealias CompleteSession = (_ id: String) async throws -> WaffledAPI.WeeklyPlanningCompletion
    typealias DiscardSession = (_ id: String) async throws -> Void
    typealias ResolveLooseEnd = (
        _ kind: String, _ id: String, _ action: String, _ sessionId: String?
    ) async throws -> Void

    private let fetchView: FetchView
    private let fetchConfig: FetchConfig
    private let saveConfigCall: SaveConfig
    private let startSessionCall: StartSession
    private let patchSessionCall: PatchSession
    private let decideStepCall: DecideStep
    private let completeSessionCall: CompleteSession
    private let discardSessionCall: DiscardSession
    private let resolveLooseEndCall: ResolveLooseEnd

    private let defaults: UserDefaults

    init(
        fetchView: @escaping FetchView = { weekStart in
            try await WaffledAPI().weeklyPlanning(weekStart: weekStart)
        },
        fetchConfig: @escaping FetchConfig = {
            try await WaffledAPI().weeklyPlanningConfig()
        },
        saveConfig: @escaping SaveConfig = { dayOfWeek, time, showOnToday, steps, lists in
            try await WaffledAPI().setWeeklyPlanningConfig(
                dayOfWeek: dayOfWeek, time: time, showOnToday: showOnToday, steps: steps,
                lists: lists)
        },
        startSession: @escaping StartSession = { weekStart in
            try await WaffledAPI().startWeeklyPlanningSession(weekStart: weekStart)
        },
        patchSession: @escaping PatchSession = { id, currentStep, status in
            try await WaffledAPI().patchWeeklyPlanningSession(
                id: id, currentStep: currentStep, status: status)
        },
        decideStep: @escaping DecideStep = { sessionId, stepKey, status, data in
            try await WaffledAPI().decideWeeklyPlanningStep(
                sessionId: sessionId, stepKey: stepKey, status: status, data: data)
        },
        completeSession: @escaping CompleteSession = { id in
            try await WaffledAPI().completeWeeklyPlanningSession(id: id)
        },
        discardSession: @escaping DiscardSession = { id in
            try await WaffledAPI().discardWeeklyPlanningSession(id: id)
        },
        resolveLooseEnd: @escaping ResolveLooseEnd = { kind, id, action, sessionId in
            try await WaffledAPI().resolveWeeklyPlanningLooseEnd(
                kind: kind, id: id, action: action, sessionId: sessionId)
        },
        defaults: UserDefaults = .standard
    ) {
        self.fetchView = fetchView
        self.fetchConfig = fetchConfig
        self.saveConfigCall = saveConfig
        self.startSessionCall = startSession
        self.patchSessionCall = patchSession
        self.decideStepCall = decideStep
        self.completeSessionCall = completeSession
        self.discardSessionCall = discardSession
        self.resolveLooseEndCall = resolveLooseEnd
        self.defaults = defaults
        self.pausedSessionId = defaults.string(forKey: Self.pausedKey)
    }

    // MARK: - State

    private(set) var view: WaffledAPI.WeeklyPlanningView?
    /// Set even by a FAILED fetch, which keeps the previous `view` (the `RestDomain` contract).
    private(set) var loaded = false
    private(set) var busy = false
    private(set) var errorMessage: String?

    /// The week the NEXT fetch asks for; `nil` means the server's default week.
    private(set) var requestedWeek: String?

    /// The step this screen is looking at, or `nil` to follow the session's own pointer.
    private(set) var askedStep: String?

    private(set) var pausedSessionId: String?

    // Precomputed once per load — date math must never run in the render path.
    private(set) var weekLabel = ""
    private(set) var sessionDayName = ""
    private(set) var savedAtLabel: String?
    /// The lists the loose-ends step could ask about. Empty is a real answer.
    private(set) var listCandidates: [WaffledAPI.PlanningListCandidate] = []
    private(set) var actGroups: [PlanningActGroup] = []
    /// Every runnable step's 1-based position, keyed by step key. NOT `PlanningStep.number`:
    /// the server sets that from the CATALOG index, so with a module off it skips — "4 of 9"
    /// with no step 3.
    private(set) var stepNumbers: [String: Int] = [:]

    // The crumb the current step wants kept, and the step that set it: pairing them makes
    // "a crumb belongs to its step" structural. Persisted only when the step is answered.
    private var decisionData: [String: JSONValue]?
    private var decisionStepKey: String?

    // MARK: - Derived

    var steps: [WaffledAPI.PlanningStep] { view?.steps ?? [] }
    var runnable: [WaffledAPI.PlanningStep] { PlanningFormat.availableSteps(steps) }
    var session: WaffledAPI.PlanningSession? { view?.session }
    var config: WaffledAPI.WeeklyPlanningConfig? { view?.config }

    var current: WaffledAPI.PlanningStep? { PlanningFormat.resolveCurrent(view, asked: askedStep) }
    var next: WaffledAPI.PlanningStep? {
        guard let key = current?.key else { return nil }
        return PlanningFormat.nextStepAfter(steps, key: key)
    }

    var position: Int { current.flatMap { stepNumbers[$0.key] } ?? 0 }
    /// The 2px hair — POSITION over total, as `WeeklyPlanning.tsx` draws it. A bar that fills
    /// differently on phone and kiosk for the same session is worse than either definition.
    var progress: Double { PlanningFormat.hairFraction(steps, currentKey: current?.key) }

    /// The stepper's floor: a week that has already finished cannot be planned.
    var canGoBack: Bool {
        guard let view else { return false }
        return view.weekStart > view.minWeekStart
    }

    var hasNoRunnableSteps: Bool { loaded && view != nil && runnable.isEmpty }

    /// The finished record is the surface, checked BEFORE the paused screen: a completed
    /// session is a receipt whether or not somebody stepped out. `askedStep` overrides it (as
    /// it does `isPaused`), and yields only to a RUNNABLE step, or `resolveCurrent` dumps you
    /// on step 1.
    var showsRecord: Bool {
        guard session?.isCompleted == true else { return false }
        guard let asked = askedStep else { return true }
        return !runnable.contains { $0.key == asked }
    }

    /// "Left for now": stepped out of THIS session, with no step asked for since.
    var isPaused: Bool {
        guard let session, session.isActive else { return false }
        return pausedSessionId == session.id && askedStep == nil
    }

    var decidedSteps: [WaffledAPI.PlanningStep] { runnable.filter(\.isSettled) }
    var settledCount: Int { decidedSteps.count }

    // MARK: - Loading

    /// Re-read the session view. A failure keeps the last good view and still marks the model
    /// loaded — the screen must not blank because one refresh lost the network.
    func load() async {
        if let latest = try? await fetchView(requestedWeek) {
            apply(latest)
        }
        loaded = true
    }

    private func apply(_ latest: WaffledAPI.WeeklyPlanningView) {
        view = latest
        weekLabel = PlanningFormat.weekLabel(latest.weekStart)
        sessionDayName = PlanningFormat.planningDayName(latest.config.dayOfWeek)
        actGroups = PlanningFormat.stepsByAct(latest.steps)
            .map { PlanningActGroup(act: $0.act, steps: $0.steps) }
        var numbers: [String: Int] = [:]
        for (i, s) in PlanningFormat.availableSteps(latest.steps).enumerated() { numbers[s.key] = i + 1 }
        stepNumbers = numbers
        savedAtLabel = latest.session.flatMap { s in
            s.isCompleted ? Self.savedLabel(s.completedAt ?? s.startedAt) : nil
        }
    }

    /// The bare config plus the SERVER-OWNED catalog. Cheaper than the full view.
    func loadConfigCatalog() async -> WaffledAPI.WeeklyPlanningConfigView? {
        try? await fetchConfig()
    }

    // MARK: - Writes

    /// The web's `go()`: one write at a time, and ALWAYS refetch — the server's answer, not
    /// the optimistic guess, is what the shell renders.
    private func go(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        do {
            try await work()
        } catch {
            errorMessage = APIErrorText.message(
                for: error, fallback: "That didn’t stick. Check your connection and try again.")
        }
        busy = false
        await load()
    }

    func dismissError() { errorMessage = nil }

    func start() async {
        let week = view?.weekStart
        await go {
            let session = try await startSessionCall(week)
            askedStep = session.currentStep
            // Pressing Start is being in the session; a pause recorded for this very
            // session id would otherwise bounce straight back to "Left for now".
            if pausedSessionId == session.id { writePaused(nil) }
        }
    }

    /// Answer the step on screen; with no next step, the answer IS the save.
    func answer(_ status: String) async {
        guard let session, let step = current else { return }
        let crumb = crumbForCurrentStep
        let following = PlanningFormat.nextStepAfter(steps, key: step.key)
        await go {
            _ = try await decideStepCall(session.id, step.key, status, crumb)
            clearCrumb()
            if let following {
                _ = try await patchSessionCall(session.id, following.key, nil)
                askedStep = following.key
            } else {
                _ = try await completeSessionCall(session.id)
                askedStep = nil
                // The session is finished, so an old "not right now" is stale — otherwise
                // coming back from the record lands on "Left for now".
                if pausedSessionId == session.id { writePaused(nil) }
            }
        }
    }

    /// Land on a step from the agenda sheet, moving the pointer so another device follows.
    func jump(to key: String) async {
        askedStep = key
        guard let session else { return }
        await go { _ = try await patchSessionCall(session.id, key, nil) }
    }

    /// SHOW a step without claiming the session moved there. `jump(to:)` is the agenda
    /// sheet's gesture and PATCHes `currentStep`, the cross-DEVICE pointer; a recap row is
    /// only a link, so following one must not tell the kitchen kiosk the family went back.
    func show(_ key: String) {
        askedStep = key
    }

    /// Reopen a saved session. `status` is the only field sent, so the server leaves the
    /// pointer where the session ended.
    func reopen() async {
        guard let session else { return }
        await go {
            let updated = try await patchSessionCall(session.id, nil, "active")
            askedStep = updated.currentStep
        }
    }

    /// Throw the session away. What it decided lives in the modules that own it.
    func discard() async {
        guard let session else { return }
        await go {
            try await discardSessionCall(session.id)
            askedStep = nil
            clearCrumb()
            writePaused(nil)
        }
    }

    /// Move the stepper, dropping the step: it would name a step of a different record.
    func goWeek(_ week: String) async {
        askedStep = nil
        clearCrumb()
        // `nil` when it IS the default, so the everyday case keeps following the calendar.
        requestedWeek = (week == view?.defaultWeekStart) ? nil : week
        await load()
    }

    func goPreviousWeek() async {
        guard let view, canGoBack else { return }
        await goWeek(PlanningFormat.addWeeks(view.weekStart, -1))
    }

    func goNextWeek() async {
        guard let view else { return }
        await goWeek(PlanningFormat.addWeeks(view.weekStart, 1))
    }

    // MARK: - Leaving, and coming back

    /// "I've stepped out of this session" — remembered on THIS DEVICE only.
    ///
    /// `UserDefaults`, not memory (the intent must survive tapping back in, the very gesture
    /// that throws away this screen's `@State`) and not the server ("not right now" is one
    /// person at one screen). The key holds a session id, so a stale value is inert.
    func leave() {
        guard let id = session?.id else { return }
        askedStep = nil
        clearCrumb()
        writePaused(id)
    }

    func resume() {
        writePaused(nil)
        askedStep = session?.currentStep
    }

    private static let pausedKey = "waffled.planning.pausedSession"

    private func writePaused(_ id: String?) {
        pausedSessionId = id
        if let id {
            defaults.set(id, forKey: Self.pausedKey)
        } else {
            defaults.removeObject(forKey: Self.pausedKey)
        }
    }

    // MARK: - The step's crumb

    /// `PlanningStepProps.setDecisionData`. Held, never written on its own.
    func setDecisionData(_ data: [String: JSONValue]?) {
        decisionData = data
        decisionStepKey = data == nil ? nil : current?.key
    }

    /// The crumb, but only if the step that set it is still the step on screen.
    var crumbForCurrentStep: [String: JSONValue]? {
        guard let key = current?.key, decisionStepKey == key else { return nil }
        return decisionData
    }

    private func clearCrumb() {
        decisionData = nil
        decisionStepKey = nil
    }

    // MARK: - Parked notes (the shell's handoff banner)

    /// Settle one parked note; true when the server took it, so the banner can hide the row.
    @discardableResult
    func resolveParked(id: String, action: String) async -> Bool {
        guard let sessionId = session?.id else { return false }
        do {
            try await resolveLooseEndCall("parked", id, action, sessionId)
            await load()
            return true
        } catch {
            return false
        }
    }

    // MARK: - Config (Settings)

    /// Save part of the config, passing ONLY what changed: `steps` is merged server-side, so
    /// a whole map from this client's snapshot would clobber another device's change.
    func saveConfig(
        dayOfWeek: Int? = nil, time: String? = nil, showOnToday: Bool? = nil,
        steps: [String: Bool]? = nil, lists: [String: Bool]? = nil
    ) async {
        await go {
            _ = try await saveConfigCall(dayOfWeek, time, showOnToday, steps, lists)
        }
    }

    /// The lists step 1 could ask about, off the CONFIG read rather than the session view:
    /// which lists are candidates is step 1's own rule, and letting the server resolve it
    /// stops this app drifting from the web.
    func loadListCandidates() async {
        guard let view = try? await fetchConfig() else { return }
        listCandidates = view.lists ?? []
    }

    // MARK: - Formatting

    // `static let`, per the project's formatter rule. Two of them because the server's
    // timestamps carry fractional seconds in some payloads and not others, and the wrong
    // formatter returns nil rather than tolerating it.
    private static let isoFractional: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
        return f
    }()
    private static let isoPlain: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        return f
    }()

    /// "Sep 2, 5:32 PM", or the raw string: an unrecognized timestamp costs the prettiness.
    static func savedLabel(_ iso: String) -> String {
        guard let d = isoFractional.date(from: iso) ?? isoPlain.date(from: iso) else { return iso }
        return DateFmt.localizedString(d, "MMM d, h:mm a", .current)
    }
}
