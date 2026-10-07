import Foundation

// Weekly Planning · step 9 "Kids" — the wire types and the three endpoints. Ported from
// `apps/web/src/lib/api/planning/kids.ts`. A read over the kids' own goals, chores and calendar,
// plus two answers that have no other module to land in; nothing here invents an option.
//
// NO MODULE GATE. The step reads goals AND chores, which a household toggles separately, so
// gating on either would delete the step for a family that runs the other.

/// ONE ANSWER ON THE WIRE, AND IT HAS FOUR STATES — NOT AN OPTIONAL. `focus` and `forward` on
/// `/kids/answer` each mean four things a `String?` cannot say:
///
///   * **absent** — key not in the body: leave the other answer alone (the two questions are
///     answered one at a time, and half an answer must not erase the other half).
///   * **clear** — an explicit `null`: forget this answer.
///   * **key** — one of the options the server offered; **text** — free words.
///
/// THIS IS WHY THE BODY IS A DICTIONARY AND NOT AN `Encodable` STRUCT: `JSONEncoder` omits a nil
/// Optional, which collapses "clear" into "absent" and makes the forget button do nothing.
enum PlanningKidPick: Equatable, Sendable {
    case absent
    case clear
    case key(String)
    case text(String)

    /// What this state puts in the body, or `nil` for "put nothing in the body". Assigning `nil`
    /// through `Dictionary`'s subscript REMOVES the key — which is what `.absent` means — while
    /// `.clear` assigns a real `JSONValue.null`. That distinction is the whole contract.
    var wireValue: JSONValue? {
        switch self {
        case .absent: return nil
        case .clear: return .null
        case let .key(k): return .object(["key": .string(k)])
        case let .text(t): return .object(["text": .string(t)])
        }
    }
}

extension WaffledAPI {

    struct PlanningKidFocusOption: Decodable, Sendable {
        let key: String
        let source: String
        let id: String?
        let emoji: String
        let label: String
        let detail: String?
        let routed: Bool
        /// The whole goal, so the number is read through `GoalDisplay` rather than an inline
        /// `totalProgress` — which would tell a kid they'd read 99 times this week.
        let goal: Goal?
    }

    struct PlanningKidForwardOption: Decodable, Sendable {
        let key: String
        let eventId: String?
        let emoji: String
        let label: String
        let when: String
    }

    struct PlanningKidEvent: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        let when: String
        let startsAt: String
        let allDay: Bool
    }

    struct PlanningKidChore: Decodable, Identifiable, Sendable {
        let id: String
        let title: String
        let emoji: String?
        let when: String
        let late: Bool
    }

    struct PlanningKidFocus: Decodable, Equatable, Sendable {
        let source: String
        let id: String?
        let emoji: String
        let label: String
        let detail: String?
    }

    struct PlanningKidForward: Decodable, Equatable, Sendable {
        let eventId: String?
        let emoji: String
        let label: String
        let when: String
    }

    struct PlanningKidCard: Decodable, Identifiable, Sendable {
        let personId: String
        let name: String
        let avatarEmoji: String?
        let colorHex: String?
        let age: Int?
        /// Nil when the reward economy is off (it is funded by chores, so chores off ⇒
        /// off). NEVER DRAW A ZERO IN ITS PLACE — that reads as "you've earned nothing".
        let stars: Int?
        let starsSymbol: String?
        let week: [PlanningKidEvent]
        let chores: [PlanningKidChore]
        let focusOptions: [PlanningKidFocusOption]
        let forwardOptions: [PlanningKidForwardOption]
        let focus: PlanningKidFocus?
        let forward: PlanningKidForward?
        let settled: Bool

        var id: String { personId }
    }

    struct PlanningKidsSources: Decodable, Hashable, Sendable {
        let goals: Bool
        let chores: Bool
        let rewards: Bool
    }

    struct PlanningKidsView: Decodable, Sendable {
        let weekStart: String
        let kids: [PlanningKidCard]
        let sources: PlanningKidsSources
        let canRepeat: Bool
    }

    // MARK: Endpoints

    /// The whole read: a card per child, with their week, their stars and both sets of options.
    /// `weekStart` is sent for the sessionless case only — WHEN A SESSION IS NAMED, ITS OWN WEEK
    /// WINS on the server, so a client that computed its own would get a different week's events.
    func planningKids(sessionId: String, weekStart: String?) async throws -> PlanningKidsView {
        var path = "/api/weekly-planning/kids?sessionId=\(Self.escape(sessionId))"
        if let weekStart, !weekStart.isEmpty { path += "&weekStart=\(Self.escape(weekStart))" }
        return try await getJSON(path, as: PlanningKidsView.self)
    }

    static func planningKidsAnswerBody(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick,
        forward: PlanningKidPick
    ) -> [String: JSONValue] {
        var body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "personId": .string(personId),
        ]
        if let weekStart, !weekStart.isEmpty { body["weekStart"] = .string(weekStart) }
        // Dictionary subscript semantics ARE the four-state contract: nil removes the key
        // (absent), `.null` writes an explicit null (clear).
        body["focus"] = focus.wireValue
        body["forward"] = forward.wireValue
        return body
    }

    func planningKidsAnswer(
        sessionId: String,
        personId: String,
        weekStart: String?,
        focus: PlanningKidPick = .absent,
        forward: PlanningKidPick = .absent
    ) async throws -> PlanningKidsView {
        let body = Self.planningKidsAnswerBody(
            sessionId: sessionId, personId: personId, weekStart: weekStart,
            focus: focus, forward: forward)
        return try await sendReturning(
            "PUT", "/api/weekly-planning/kids/answer", body: body, as: PlanningKidsView.self)
    }

    func planningKidsRepeat(sessionId: String, weekStart: String?) async throws -> PlanningKidsView {
        var body: [String: JSONValue] = ["sessionId": .string(sessionId)]
        if let weekStart, !weekStart.isEmpty { body["weekStart"] = .string(weekStart) }
        return try await sendReturning(
            "POST", "/api/weekly-planning/kids/repeat", body: body, as: PlanningKidsView.self)
    }

    private static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
    }
}

/// The crumb this step hands the session record: what each kid settled on.
///
/// IT MUST MIRROR THE SERVER'S OWN MAP. `/kids/answer` merges `{ kids: { <personId>: … } }`
/// onto the step row with `jsonb_set`, but the shell's `decideStep` REPLACES `data` wholesale,
/// so summarising instead of mirroring throws away the two sentences the step exists to
/// produce. The server's `parseAnswers` reads these key names and types back — nothing here may
/// be renamed or dropped. Kept identical to the web's `planningKidsDecision`.
enum PlanningKidsCrumb {
    static func decision(_ view: WaffledAPI.PlanningKidsView?) -> [String: JSONValue] {
        var kids: [String: JSONValue] = [:]
        for k in view?.kids ?? [] where k.focus != nil || k.forward != nil {
            kids[k.personId] = .object([
                "focus": k.focus.map(focusJSON) ?? .null,
                "forward": k.forward.map(forwardJSON) ?? .null,
            ])
        }
        return ["kids": .object(kids)]
    }

    private static func focusJSON(_ f: WaffledAPI.PlanningKidFocus) -> JSONValue {
        .object([
            "source": .string(f.source),
            "id": f.id.map(JSONValue.string) ?? .null,
            "emoji": .string(f.emoji),
            "label": .string(f.label),
            "detail": f.detail.map(JSONValue.string) ?? .null,
        ])
    }

    private static func forwardJSON(_ f: WaffledAPI.PlanningKidForward) -> JSONValue {
        .object([
            "eventId": f.eventId.map(JSONValue.string) ?? .null,
            "emoji": .string(f.emoji),
            "label": .string(f.label),
            "when": .string(f.when),
        ])
    }
}

enum PlanningKidsChoice {
    static func focusChosen(
        _ card: WaffledAPI.PlanningKidCard,
        _ option: WaffledAPI.PlanningKidFocusOption
    ) -> Bool {
        guard let focus = card.focus else { return false }
        return focus.source == option.source && focus.id == option.id
    }

    static func focusIsCustom(_ card: WaffledAPI.PlanningKidCard) -> Bool {
        card.focus?.source == "custom"
    }

    /// Guarded against both-nil on purpose: a bare `card.forward?.eventId == option.eventId`
    /// reads TRUE for every option when nothing has been answered.
    static func forwardChosen(
        _ card: WaffledAPI.PlanningKidCard,
        _ option: WaffledAPI.PlanningKidForwardOption
    ) -> Bool {
        guard let forward = card.forward, let answered = forward.eventId,
              let offered = option.eventId else { return false }
        return answered == offered
    }

    static func forwardIsCustom(_ card: WaffledAPI.PlanningKidCard) -> Bool {
        guard let forward = card.forward else { return false }
        return forward.eventId == nil
    }
}
