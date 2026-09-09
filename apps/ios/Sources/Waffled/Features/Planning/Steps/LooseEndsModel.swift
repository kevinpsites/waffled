import Foundation
import Observation

// Weekly Planning · step 1 "Loose ends" — the step's state and its copy; the view is in
// `LooseEndsStep.swift`.
//
// THREE THINGS WRITE, AND ONLY THREE: "It's done already" and "Drop it" go to the module
// that owns the item, and the capture bar parks a note. Routing records a DESTINATION on
// the session; "leave it open" writes nothing, which is why the set-aside list lives in
// this object and never becomes a row.

/// The two halves of step 1. "Not done" is COMPUTED from the modules that already own the
/// work; "Parked" is what somebody wrote down during the week and exists nowhere else,
/// which is why one of its answers is to drop it.
enum LooseEndGroup: String, CaseIterable, Sendable {
    case notDone
    case parked

    var label: String { self == .notDone ? "Not done" : "Parked" }

    var caption: String { self == .notDone ? "already in the app" : "somebody wrote it down" }

    /// The full explanation. It travels with the SWITCH, because in one-at-a-time mode
    /// the switch is the entire explanation of the two kinds.
    var note: String {
        switch self {
        case .notDone:
            return "Computed from your modules — overdue chores, unchecked items on your lists, rhythms past due, habit goals short for the week. Nobody typed these; they are simply still open."
        case .parked:
            return "What somebody wrote down during the week that exists nowhere else yet. Which is why one of the answers here is to drop it."
        }
    }

    var other: LooseEndGroup { self == .notDone ? .parked : .notDone }
}

/// The words on the card. Kept beside the group table so the two never drift.
enum LooseEndCopy {
    /// The little label over the title. Falls back to the raw key rather than crashing or
    /// hiding the card — the kinds are server-owned and a newer server may name a fifth.
    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "chore": return "Chore"
        case "list": return "List"
        case "rhythm": return "Rhythm"
        case "goal": return "Goal"
        case "parked": return "Parked"
        default: return kind.capitalized
        }
    }

    /// The label each WRITING answer wears. Both read differently by group: the same word
    /// means a different thing to a computed item and to a note.
    static func actionLabel(_ action: String, kind: String) -> String {
        if action == "done" { return kind == "parked" ? "Talk about it now" : "It’s done already" }
        return "Drop it"
    }

    static func actionHint(_ action: String, kind: String) -> String {
        if action == "done" { return kind == "parked" ? "Two minutes, then decide" : "Just tell its module" }
        return "It was never really a thing"
    }

    static func leaveLabel(_ group: LooseEndGroup) -> String {
        group == .parked ? "Keep it parked" : "Leave it open"
    }

    static func leaveHint(_ group: LooseEndGroup) -> String {
        group == .parked ? "It isn’t time yet" : "Nothing changes anywhere"
    }

    /// The one claim the user has to believe for this step to feel safe.
    static let disclaimer = "Routing here changes nothing in your modules — it only decides which step handles it."

    /// WHAT THE ARROW MEANS, said once. Routing does not DO the thing: it hands the item
    /// to the step that will, and every destination is still ahead of this one tonight.
    static let trailCaption = "Sent ahead — they’ll come up at that step later tonight"

    static let capturePlaceholder = "Drop something new on the board — one line is enough"

    static let writeFailed = "That didn’t go through — try again."

    /// The cleared state says WHAT was looked at — "nothing's left undone" from a step
    /// that never named its sources would just be a claim.
    static func clearedTitle(_ group: LooseEndGroup) -> String {
        group == .parked ? "Nothing’s parked" : "Nothing’s left undone"
    }

    static func clearedSubtitle(_ group: LooseEndGroup, sources: [String], remainingOther: Int) -> String {
        let head: String
        if group == .parked {
            head = "Nobody wrote anything down this week that lives nowhere else yet."
        } else {
            head = "We checked your \(sources.isEmpty ? "modules" : sources.joined(separator: ", "))."
        }
        guard remainingOther > 0 else { return head + " Both groups are clear." }
        let other = group.other
        let noun: String
        if other == .parked {
            noun = remainingOther == 1 ? "parked note is" : "parked notes are"
        } else {
            noun = remainingOther == 1 ? "loose end is" : "loose ends are"
        }
        return "\(head) \(remainingOther) \(noun) still waiting."
    }
}

/// One choice on the card: a destination, one of the two answers that write, or the quiet
/// "leave it" that writes nothing. Built as DATA rather than closures so the card renders
/// one uniform layout whichever group it shows, and so the arrangement can be tested
/// without a view.
struct LooseEndChoice: Identifiable, Equatable, Sendable {
    enum Act: Equatable, Sendable {
        /// Send it to the step that will handle it. Writes nothing to any module.
        case route(String)
        /// "It’s done already" / "Drop it" — the two answers that write.
        case settle(String)
        /// Set it aside for this screen only. Writes nothing anywhere.
        case leave
    }

    let key: String
    let label: String
    let hint: String
    let isPrimary: Bool
    let act: Act

    var id: String { key }

    /// The choices a card offers: its group's destinations, then the answers that settle
    /// it here. `parked` keeps two of its four in the grid because a note might turn out
    /// to be nothing.
    static func build(
        item: WaffledAPI.LooseEnd,
        group: LooseEndGroup,
        destinations: [WaffledAPI.LooseEndDestination]
    ) -> (choices: [LooseEndChoice], quiet: [LooseEndChoice]) {
        var choices: [LooseEndChoice] = destinations.map {
            LooseEndChoice(key: "to:\($0.to)", label: $0.label, hint: $0.hint,
                           isPrimary: $0.primary == true, act: .route($0.to))
        }
        var quiet: [LooseEndChoice] = []
        for a in item.actions {
            let c = LooseEndChoice(
                key: "do:\(a)",
                label: LooseEndCopy.actionLabel(a, kind: item.kind),
                hint: LooseEndCopy.actionHint(a, kind: item.kind),
                isPrimary: false,
                act: .settle(a))
            // A note's "talk about it now" is one of its four choices; everywhere else
            // the writing answers stay quiet, under the destinations.
            if group == .parked && a == "done" { choices.append(c) } else { quiet.append(c) }
        }
        let leave = LooseEndChoice(
            key: "leave", label: LooseEndCopy.leaveLabel(group), hint: LooseEndCopy.leaveHint(group),
            isPrimary: false, act: .leave)
        if group == .parked { choices.append(leave) } else { quiet.insert(leave, at: 0) }
        return (choices, quiet)
    }
}

// MARK: - Model

@MainActor
@Observable
final class PlanningLooseEndsModel {
    typealias FetchLooseEnds = (_ weekStart: String, _ sessionId: String) async throws -> WaffledAPI.LooseEndsView
    /// `to == nil` UNDOES the routing — the trail's Undo. Returns the whole array back.
    typealias RouteLooseEnd = (
        _ sessionId: String, _ kind: String, _ id: String, _ title: String, _ source: String, _ to: String?
    ) async throws -> [WaffledAPI.LooseEndRoute]
    typealias ResolveLooseEnd = (
        _ kind: String, _ id: String, _ action: String, _ sessionId: String
    ) async throws -> WaffledAPI.LooseEndResolution
    typealias ParkNote = (_ note: String, _ sessionId: String) async throws -> WaffledAPI.PlanningParkedItem
    /// Rule one list in or out. SPARSE by construction — one list per call — because the
    /// server merges the map and a whole one built here would rule lists back in behind
    /// another device.
    typealias RuleList = (_ listId: String, _ relevant: Bool) async throws -> Void

    private(set) var view: WaffledAPI.LooseEndsView?
    /// A FAILED fetch keeps the previous value and still counts as loaded — the shared
    /// REST loading contract (`Features/Shared/RestDomain.swift`).
    private(set) var loaded = false
    /// What has been routed this session. Seeded from the read, so a reload mid-step
    /// doesn't re-ask everything already triaged.
    private(set) var routes: [WaffledAPI.LooseEndRoute] = []
    /// How many items were SETTLED here ("done"/"drop") — the human half of the crumb.
    private(set) var answered = 0
    private(set) var working = false
    private(set) var errorMessage: String?

    /// The two decks, recomputed once per state change rather than filtered per render.
    private(set) var openNotDone: [WaffledAPI.LooseEnd] = []
    private(set) var openParked: [WaffledAPI.LooseEnd] = []

    /// Bumped on every state change, so the view can push the crumb with one `onChange`
    /// instead of watching five properties.
    private(set) var revision = 0

    /// Items set aside on THIS screen. Client-only by design: that answer writes nothing
    /// anywhere, so it must not become a row.
    private var setAside: Set<String> = []
    private var routedKeys: Set<String> = []

    private let fetchLooseEnds: FetchLooseEnds
    private let routeLooseEnd: RouteLooseEnd
    private let resolveLooseEnd: ResolveLooseEnd
    private let parkNote: ParkNote
    private let ruleListCall: RuleList

    init(
        fetchLooseEnds: @escaping FetchLooseEnds = { weekStart, sessionId in
            try await WaffledAPI().planningLooseEnds(weekStart: weekStart, sessionId: sessionId)
        },
        routeLooseEnd: @escaping RouteLooseEnd = { sessionId, kind, id, title, source, to in
            try await WaffledAPI().routePlanningLooseEnd(
                sessionId: sessionId, kind: kind, id: id, title: title, source: source, to: to)
        },
        resolveLooseEnd: @escaping ResolveLooseEnd = { kind, id, action, sessionId in
            try await WaffledAPI().resolvePlanningLooseEnd(
                kind: kind, id: id, action: action, sessionId: sessionId)
        },
        ruleList: @escaping RuleList = { listId, relevant in
            _ = try await WaffledAPI().setWeeklyPlanningConfig(lists: [listId: relevant])
        },
        parkNote: @escaping ParkNote = { note, sessionId in
            try await WaffledAPI().parkPlanningNote(note: note, sessionId: sessionId)
        }
    ) {
        self.fetchLooseEnds = fetchLooseEnds
        self.routeLooseEnd = routeLooseEnd
        self.resolveLooseEnd = resolveLooseEnd
        self.ruleListCall = ruleList
        self.parkNote = parkNote
    }

    // MARK: reads

    func load(weekStart: String, sessionId: String) async {
        if let next = try? await fetchLooseEnds(weekStart, sessionId) {
            view = next
            routes = next.routes
        }
        loaded = true
        recompute()
    }

    /// Seed the routes from the step's OWN persisted `data.routes` before the read lands.
    ///
    /// NOT A NICETY — it is what stops a second visit destroying the first one's work.
    /// The crumb REPLACES the step's `data` when the step is answered, and a fresh model
    /// whose read then FAILED would push an empty `routes`, silently losing every routing
    /// decision. `routes. isEmpty` guards it, so a read that came back stays
    /// authoritative.
    func seedRoutes(from value: JSONValue?) {
        guard routes.isEmpty, let value, case .array = value else { return }
        // Round-tripped through the SAME decoder the read uses, so the tolerant
        // `LooseEndRoute.init(from:)` applies here too and one malformed row costs that
        // row rather than the seed. Wrapped in an object because a top-level JSON
        // fragment is not something every encoder will write.
        struct Seed: Decodable { let routes: [WaffledAPI.LooseEndRoute] }
        guard let bytes = try? JSONEncoder().encode(["routes": value]),
              let seed = try? WaffledAPI.decoder.decode(Seed.self, from: bytes)
        else { return }
        routes = seed.routes
        recompute()
    }

    /// A different week is a different set of loose ends, so the aside list and the tally
    /// reset.
    func resetForWeek() {
        setAside = []
        answered = 0
        recompute()
    }

    func open(_ group: LooseEndGroup) -> [WaffledAPI.LooseEnd] {
        group == .notDone ? openNotDone : openParked
    }

    func remaining(_ group: LooseEndGroup) -> Int { open(group).count }

    /// Everything the server reported for this group, before triage — the denominator of
    /// "3 of 7".
    func total(_ group: LooseEndGroup) -> Int {
        (group == .notDone ? view?.notDone : view?.parked)?.count ?? 0
    }

    func destinations(_ group: LooseEndGroup) -> [WaffledAPI.LooseEndDestination] {
        guard let d = view?.destinations else { return [] }
        return group == .notDone ? d.notDone : d.parked
    }

    /// The trail: what was just routed, most recent first, capped at three.
    var trail: [WaffledAPI.LooseEndRoute] { Array(routes.suffix(3).reversed()) }

    /// Step NAMES for the trail. "Not done"'s destination labels ARE the step titles;
    /// "Parked"'s are verbs ("Make it a task"), which read wrong after an arrow — so the
    /// trail always uses the notDone label, falling back to the key for a step whose
    /// module is off.
    func stepName(_ to: String) -> String {
        view?.destinations.notDone.first { $0.to == to }?.label ?? to
    }

    /// THE CRUMB, and the cross-step contract in one. `routes` is here on purpose and is
    /// NOT "a copy of module data": answering a step REPLACES its `data` server-side, so
    /// a crumb of bare counts would wipe `data.routes` — the array steps 2/6/8/9 read off
    /// the session view.
    var decisionData: [String: JSONValue] {
        [
            "routes": .array(routes.map(\.json)),
            "answered": .int(answered),
            "left": .int(openNotDone.count + openParked.count),
        ]
    }

    // MARK: writes

    /// Send an item to the step that will handle it. WRITES NOTHING TO ANY MODULE.
    @discardableResult
    func send(_ item: WaffledAPI.LooseEnd, from group: LooseEndGroup, to: String, sessionId: String) async -> Bool {
        await guarded {
            self.routes = try await self.routeLooseEnd(
                sessionId, item.kind, item.id, item.title, group.rawValue, to)
        }
    }

    /// Undo the last routing — `to: nil`, which the server reads as "drop the entry".
    @discardableResult
    func undo(_ route: WaffledAPI.LooseEndRoute, sessionId: String) async -> Bool {
        await guarded {
            self.routes = try await self.routeLooseEnd(
                sessionId, route.kind, route.id, route.title, route.source, nil)
        }
    }

    /// One of the two answers that write, then a reload — the item's own module decides
    /// whether it is still open, so we re-read rather than removing it locally.
    @discardableResult
    func settle(_ item: WaffledAPI.LooseEnd, action: String, weekStart: String, sessionId: String) async -> Bool {
        await guarded {
            _ = try await self.resolveLooseEnd(item.kind, item.id, action, sessionId)
            self.answered += 1
            await self.reload(weekStart: weekStart, sessionId: sessionId)
        }
    }

    /// The capture bar: the board is where "one more thing" goes when it belongs to no
    /// module yet.
    @discardableResult
    func park(_ note: String, weekStart: String, sessionId: String) async -> Bool {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        return await guarded {
            _ = try await self.parkNote(text, sessionId)
            await self.reload(weekStart: weekStart, sessionId: sessionId)
        }
    }

    /// The lists this step could ask about. Empty is a real answer — a household with no
    /// custom lists has nothing to choose between — and so is a server that predates the
    /// setting.
    var listCandidates: [WaffledAPI.PlanningListCandidate] { view?.lists ?? [] }

    /// Rule one list in or out, from inside the step.
    ///
    /// WHY THE STEP AND NOT SETTINGS: the friction is here, and Settings → Modules is
    /// admin-only — which whoever sat down to run the session may not be. The route takes
    /// `planning.manage`.
    ///
    /// THEN IT RE-READS. A list ruled out takes its cards out of the deck with it, and
    /// working out WHICH cards those were is the server's job, not a guess from a
    /// `detail` string. `guarded` skips the reload when the write itself failed.
    @discardableResult
    func ruleList(_ listId: String, relevant: Bool, weekStart: String, sessionId: String) async -> Bool {
        await guarded {
            try await self.ruleListCall(listId, relevant)
            await self.reload(weekStart: weekStart, sessionId: sessionId)
        }
    }

    /// "Leave it open" / "Keep it parked" — the answer that writes nothing at all.
    func leave(_ item: WaffledAPI.LooseEnd) {
        errorMessage = nil
        setAside.insert(item.key)
        recompute()
    }

    func clearError() {
        errorMessage = nil
        revision &+= 1
    }

    // MARK: internals

    /// A refetch that keeps what it has on failure — the same contract as `load`, so a
    /// write that succeeded is never reported as failed because the reload after it
    /// didn't come back.
    private func reload(weekStart: String, sessionId: String) async {
        if let next = try? await fetchLooseEnds(weekStart, sessionId) {
            view = next
            routes = next.routes
        }
    }

    /// One write at a time, and a failure leaves every piece of state as it was — the
    /// assignment inside each operation only runs when the call returned.
    private func guarded(_ operation: () async throws -> Void) async -> Bool {
        guard !working else { return false }
        working = true
        errorMessage = nil
        defer {
            working = false
            recompute()
        }
        do {
            try await operation()
            return true
        } catch {
            errorMessage = APIErrorText.message(for: error, fallback: LooseEndCopy.writeFailed)
            return false
        }
    }

    private func recompute() {
        routedKeys = Set(routes.map { "\($0.kind):\($0.id)" })
        let hidden = routedKeys.union(setAside)
        openNotDone = (view?.notDone ?? []).filter { !hidden.contains($0.key) }
        openParked = (view?.parked ?? []).filter { !hidden.contains($0.key) }
        revision &+= 1
    }
}
