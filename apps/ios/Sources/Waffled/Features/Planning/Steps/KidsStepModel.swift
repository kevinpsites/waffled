import Foundation
import Observation

/// Weekly Planning · step 9 "Kids" — the step's state, with no view in it.
///
/// Every network op is an injected closure with a `WaffledAPI()`-backed default, so
/// `PlanningKidsStepTests` drives the whole step without a server.
///
/// THE LOADING CONTRACT (`Features/Shared/RestDomain.swift`): a FAILED fetch keeps the
/// previous value and still sets `loaded`; a failed write does not refetch and does not
/// mutate. The answers are a REAL write, never `setDecisionData`.
@MainActor
@Observable
final class PlanningKidsStepModel {
    typealias FetchKids = (
        _ sessionId: String, _ weekStart: String?
    ) async throws -> WaffledAPI.PlanningKidsView
    typealias AnswerKid = (
        _ sessionId: String, _ personId: String, _ weekStart: String?,
        _ focus: PlanningKidPick, _ forward: PlanningKidPick
    ) async throws -> WaffledAPI.PlanningKidsView
    /// Named `RepeatAnswers`, not `RepeatLastWeek`: a stored closure sharing a name with
    /// the method that calls it resolves to the method — infinite recursion the compiler
    /// accepts happily.
    typealias RepeatAnswers = (
        _ sessionId: String, _ weekStart: String?
    ) async throws -> WaffledAPI.PlanningKidsView

    enum Question: String, Hashable, Sendable {
        case focus
        case forward
    }

    struct TypeTarget: Equatable, Sendable {
        let personId: String
        let which: Question
    }

    static let repeatToken = "repeat"

    private(set) var view: WaffledAPI.PlanningKidsView?
    private(set) var loaded = false
    /// One at a time: two answers landing together would race two read-modify-writes of
    /// the same session crumb.
    private(set) var saving: String?
    private(set) var errorMessage: String?
    private(set) var activePersonId: String?
    private(set) var changing = false
    private(set) var typing: TypeTarget?
    /// Bumped when a read or write lands, so the view pushes the crumb on ONE `onChange`.
    /// A failed write never bumps it, keeping a half-applied answer out of the record.
    private(set) var rev = 0

    /// WHAT THEY TYPED BUT NEVER SAVED, keyed `<personId>:<which>`. Picking an existing
    /// option is a change of answer, but the words they typed must still be there when
    /// they reopen the hatch.
    ///
    /// KEPT OUT OF `view` ON PURPOSE: a draft is not an answer, never reaches the server,
    /// and lives exactly as long as the step is on screen.
    private(set) var drafts: [String: String] = [:]

    private let fetchKids: FetchKids
    private let answerKid: AnswerKid
    private let repeatAnswers: RepeatAnswers

    init(
        fetchKids: @escaping FetchKids = { sessionId, weekStart in
            try await WaffledAPI().planningKids(sessionId: sessionId, weekStart: weekStart)
        },
        answerKid: @escaping AnswerKid = { sessionId, personId, weekStart, focus, forward in
            try await WaffledAPI().planningKidsAnswer(
                sessionId: sessionId, personId: personId, weekStart: weekStart,
                focus: focus, forward: forward)
        },
        repeatAnswers: @escaping RepeatAnswers = { sessionId, weekStart in
            try await WaffledAPI().planningKidsRepeat(sessionId: sessionId, weekStart: weekStart)
        }
    ) {
        self.fetchKids = fetchKids
        self.answerKid = answerKid
        self.repeatAnswers = repeatAnswers
    }

    var kids: [WaffledAPI.PlanningKidCard] { view?.kids ?? [] }

    var canRepeat: Bool { view?.canRepeat ?? false }

    var activeCard: WaffledAPI.PlanningKidCard? {
        kids.first { $0.personId == activePersonId } ?? kids.first
    }

    var isReadBack: Bool {
        !changing && !kids.isEmpty && kids.allSatisfy(\.settled)
    }

    func isFrozen(shellBusy: Bool) -> Bool { shellBusy || saving != nil }

    /// Mirrors the server's map rather than summarising it — see `PlanningKidsCrumb`.
    ///
    /// NIL UNTIL A READ HAS LANDED: an empty map is a claim, not "nobody answered", and
    /// the shell REPLACES the step's data with it when the primary is pressed.
    var crumb: [String: JSONValue]? {
        guard view != nil else { return nil }
        return PlanningKidsCrumb.decision(view)
    }

    var heading: String {
        let names = kids.map(\.name)
        guard names.count > 1 else { return names.first ?? "Kids" }
        return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
    }

    func load(sessionId: String, weekStart: String?) async {
        if let latest = try? await fetchKids(sessionId, weekStart) { apply(latest) }
        loaded = true
    }

    func select(personId: String) {
        guard kids.contains(where: { $0.personId == personId }) else { return }
        activePersonId = personId
    }

    func beginChanging() { changing = true }

    func dismissError() { errorMessage = nil }


    func beginTyping(personId: String, which: Question) {
        typing = TypeTarget(personId: personId, which: which)
    }

    func cancelTyping() { typing = nil }

    func isTyping(personId: String, which: Question) -> Bool {
        typing == TypeTarget(personId: personId, which: which)
    }

    func recordDraft(personId: String, which: Question, text: String) {
        drafts[Self.draftKey(personId, which)] = text
    }

    /// THE UNSAVED DRAFT WINS, then their own saved custom answer: reopening the hatch
    /// must show the words they said, not an empty box.
    func typeInSeed(_ card: WaffledAPI.PlanningKidCard, _ which: Question) -> String {
        if let draft = drafts[Self.draftKey(card.personId, which)] { return draft }
        switch which {
        case .focus:
            return PlanningKidsChoice.focusIsCustom(card) ? (card.focus?.label ?? "") : ""
        case .forward:
            return PlanningKidsChoice.forwardIsCustom(card) ? (card.forward?.label ?? "") : ""
        }
    }

    static func draftKey(_ personId: String, _ which: Question) -> String {
        "\(personId):\(which.rawValue)"
    }


    /// The other question is `.absent` by default, which puts NO key in the body — sending
    /// half an answer must not erase the other half.
    func answer(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick = .absent,
        forward: PlanningKidPick = .absent
    ) async {
        guard saving == nil else { return }
        saving = personId
        errorMessage = nil
        typing = nil
        defer { saving = nil }
        do {
            let latest = try await answerKid(sessionId, personId, weekStart, focus, forward)
            apply(latest)
            changing = false
        } catch {
            errorMessage = "That didn’t take — try again."
        }
    }

    func repeatLastWeek(sessionId: String, weekStart: String?) async {
        guard saving == nil, canRepeat else { return }
        saving = Self.repeatToken
        errorMessage = nil
        defer { saving = nil }
        do {
            apply(try await repeatAnswers(sessionId, weekStart))
            changing = false
        } catch {
            errorMessage = "Couldn’t copy last week — pick this week’s instead."
        }
    }

    private func apply(_ latest: WaffledAPI.PlanningKidsView) {
        view = latest
        rev += 1
        if let activePersonId, latest.kids.contains(where: { $0.personId == activePersonId }) {
            return
        }
        activePersonId = latest.kids.first?.personId
    }
}
