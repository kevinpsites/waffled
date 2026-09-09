import Foundation
import Observation

/// Weekly Planning · step 6 "Goals" — the step's state, with no view in it. Every network op
/// is an injected closure (the test seam). THE LOADING CONTRACT (`Shared/RestDomain.swift`):
/// a FAILED fetch keeps the previous value and still sets `loaded`; a failed write neither
/// refetches nor mutates.
@MainActor
@Observable
final class PlanningGoalsStepModel {
    typealias FetchGoals = (_ sessionId: String) async throws -> WaffledAPI.PlanningGoalsView
    typealias SetFocus = (
        _ sessionId: String, _ listId: String, _ goalId: String?
    ) async throws -> WaffledAPI.PlanningGoalsView
    /// `POST /api/goals` — the goals module's own create; no planning-only endpoint.
    typealias CreateGoal = (_ body: [String: JSONValue]) async throws -> Void

    private(set) var view: WaffledAPI.PlanningGoalsView?
    private(set) var loaded = false
    /// The list a write is in flight for. ONE AT A TIME: two clicks race the same crumb.
    private(set) var savingListId: String?
    private(set) var errorMessage: String?
    /// Which tab is on screen; a refetch that drops the list re-lands on something real.
    private(set) var tabId: String?
    /// Bumped when a read or write LANDS, so the view pushes the crumb from one `onChange`
    /// and a half-applied answer never reaches the session record.
    private(set) var rev = 0
    /// The composer's group as a LIST ID, not the group: a refetch replaces every group
    /// object, and holding one would leave the composer on a stale copy.
    private(set) var newForListId: String?
    /// A create is in flight. Separate from `savingListId`, which would read as "settling".
    private(set) var creating = false

    private let fetchGoals: FetchGoals
    private let setFocus: SetFocus
    private let createGoal: CreateGoal

    init(
        fetchGoals: @escaping FetchGoals = { sessionId in
            try await WaffledAPI().planningGoals(sessionId: sessionId)
        },
        setFocus: @escaping SetFocus = { sessionId, listId, goalId in
            try await WaffledAPI().planningGoalsSetFocus(
                sessionId: sessionId, listId: listId, goalId: goalId)
        },
        createGoal: @escaping CreateGoal = { body in
            try await WaffledAPI().createGoal(body)
        }
    ) {
        self.fetchGoals = fetchGoals
        self.setFocus = setFocus
        self.createGoal = createGoal
    }

    var groups: [WaffledAPI.PlanningGoalGroup] { view?.groups ?? [] }

    var settledCount: Int { groups.filter(\.settled).count }

    var active: WaffledAPI.PlanningGoalGroup? {
        groups.first { $0.listId == tabId } ?? groups.first
    }

    var newGoalGroup: WaffledAPI.PlanningGoalGroup? {
        guard let newForListId else { return nil }
        return groups.first { $0.listId == newForListId }
    }

    func isFrozen(shellBusy: Bool) -> Bool {
        shellBusy || savingListId != nil || creating
    }

    /// The crumb to hand the shell after every read AND write. NIL UNTIL A READ HAS LANDED:
    /// an empty map is a claim, and since the shell REPLACES the step's data when the primary
    /// is pressed, one handed up after a failed fetch would erase every recorded answer.
    var crumb: [String: JSONValue]? {
        guard view != nil else { return nil }
        return PlanningGoalsCrumb.decision(view)
    }

    func load(sessionId: String) async {
        if let latest = try? await fetchGoals(sessionId) { apply(latest) }
        loaded = true
    }

    func selectTab(_ listId: String) {
        guard groups.contains(where: { $0.listId == listId }) else { return }
        tabId = listId
    }

    func dismissError() { errorMessage = nil }

    /// Answer one group; `goalId` nil is the real answer "nothing this week". A MID-STEP
    /// WRITE: it does not settle the STEP, so the caller must not either.
    func pick(sessionId: String, listId: String, goalId: String?) async {
        guard savingListId == nil else { return }
        savingListId = listId
        errorMessage = nil
        defer { savingListId = nil }
        do {
            apply(try await setFocus(sessionId, listId, goalId))
        } catch {
            errorMessage = "That didn’t take — try again."
        }
    }

    // MARK: - "＋ New goal for this week"

    /// Open the goals module's editor for the group ON SCREEN — hence no argument: a composer
    /// that let the group be chosen would create a goal where it appears to vanish.
    func openNewGoal() {
        guard !creating, let listId = active?.listId else { return }
        errorMessage = nil
        newForListId = listId
    }

    func closeNewGoal() { newForListId = nil }

    /// Take the editor's body, make the goal, then re-read so it is ON SCREEN in the group it
    /// joined and can be picked as the week's focus.
    ///
    /// CREATING IS NOT CONFIRMING: it deliberately does not call `/goals/focus`, so the tab
    /// stays unstarred. The goal arrives PINNED, which is how `getGoalsStepView` adopts a
    /// list's LONE `is_featured` goal (two pins is ambiguous and it adopts neither). `listId`
    /// is PASSED IN because `GoalCreateSheet` clears the flag the instant it submits.
    @discardableResult
    func submitNewGoal(
        sessionId: String, listId: String, body: [String: JSONValue]
    ) async -> Bool {
        // A group this step never heard of is not a target: refusing beats creating a goal
        // somewhere the family cannot see it.
        guard !creating, groups.contains(where: { $0.listId == listId }) else { return false }
        creating = true
        errorMessage = nil
        // The editor is already gone, so the flag goes too, or a sheet reopens unasked.
        newForListId = nil
        defer { creating = false }
        do {
            try await createGoal(Self.newGoalBody(body, listId: listId))
        } catch {
            errorMessage = "That goal didn’t save — try again."
            return false
        }
        // A failed refetch keeps the last good groups and does NOT bump `rev`, so no crumb is
        // pushed off a read that never landed.
        if let latest = try? await fetchGoals(sessionId) {
            apply(latest)
            // Land back on the group the goal joined even if `tabId` was still nil.
            if latest.groups.contains(where: { $0.listId == listId }) { tabId = listId }
        }
        return true
    }

    /// The ONE thing the step decides about a goal made here: which group it joins.
    /// `goalListId` is overwritten because the STEP, not the form, asked whose focus this is.
    static func newGoalBody(
        _ body: [String: JSONValue], listId: String
    ) -> [String: JSONValue] {
        var out = body
        out["goalListId"] = .string(listId)
        return out
    }

    /// Whose goals this viewer may add to — the GOALS MODULE's rule: `goal.manage` for any
    /// group, else only a group that is just them. Offering an editor the server would refuse
    /// is show-then-403.
    nonisolated static func canTarget(
        _ g: WaffledAPI.PlanningGoalGroup,
        canManageGoals: Bool,
        personId: String?
    ) -> Bool {
        if canManageGoals { return true }
        guard let personId, g.members.count == 1 else { return false }
        return g.members[0].personId == personId
    }

    private func apply(_ latest: WaffledAPI.PlanningGoalsView) {
        view = latest
        rev += 1
        // Land on WHAT'S LEFT the first time and stay put: re-deriving per write would jump
        // the family off the group they just answered.
        if let tabId, latest.groups.contains(where: { $0.listId == tabId }) { return }
        tabId = (latest.groups.first { !$0.settled } ?? latest.groups.first)?.listId
    }
}

enum PlanningGoalsText {

    /// The axis label under the number, matching the rule `GoalDisplay` implements.
    static func axisLabel(_ g: WaffledAPI.Goal) -> String {
        switch g.goalType {
        case "habit": return g.habitPeriod == "day" ? "today" : "this \(g.habitPeriod ?? "week")"
        case "checklist": return "steps done"
        default: return g.unit ?? "so far"
        }
    }

    static func kindLabel(_ g: WaffledAPI.Goal) -> String {
        ["count": "Count", "total": "Total", "habit": "Habit", "checklist": "Checklist"][g.goalType]
            ?? g.goalType
    }

    /// EVERY CLAUSE IS A FACT THE SERVER SENT — no birthday on file drops the age.
    static func groupSubtitle(_ g: WaffledAPI.PlanningGoalGroup) -> String {
        let n = g.members.count
        if g.isPrivate {
            if n == 2 { return "private · just the two of you" }
            if n == 1 { return "private · just you" }
            return "private · \(n) people"
        }
        if n == 1 {
            if let age = g.members.first?.age { return "individual · age \(age)" }
            return "individual"
        }
        if g.isEveryone { return "shared · everyone tracks it" }
        if n == 2 { return "shared · " + g.members.map(firstName).joined(separator: " & ") }
        return "shared · \(n) people"
    }

    /// THREE STATES, because "already pinned" and "we decided" are not the same claim.
    static func verdict(_ g: WaffledAPI.PlanningGoalGroup) -> String {
        guard let focus = g.goals.first(where: { $0.id == g.focusGoalId }) else {
            return "No focus this week — that’s allowed"
        }
        return g.settled
            ? "★ This week · \(focus.goal.title)"
            : "Pinned already · \(focus.goal.title) — keep it, or pick another"
    }

    private static func firstName(_ m: WaffledAPI.PlanningGoalMember) -> String {
        m.name.split(separator: " ").first.map(String.init) ?? m.name
    }
}
