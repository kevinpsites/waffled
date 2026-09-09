import Foundation

// Weekly Planning · step 6 "Goals" — the wire types and the two endpoints. Ported from
// `apps/web/src/lib/api/planning/goals.ts`.
//
// A READ over the goal lists that already exist plus ONE write: picking a group's focus, which
// sets that goal's existing `is_featured` flag. Nothing invents a "focus" record — `settled` /
// `focusGoalId` are the SESSION's memory of what it decided (so "nothing this week" can be a
// real answer), while `goals[].isFeatured` stays the goals module's own truth.
extension WaffledAPI {

    struct PlanningGoalPace: Decodable, Hashable, Sendable {
        let text: String
        /// "ok" | "flat" | "behind". A String, not an enum: a newer server naming a fourth tone
        /// must render in the neutral one, never fail to decode.
        let tone: String
    }

    struct PlanningGoalGoal: Decodable, Identifiable, Sendable {
        let goal: Goal
        let pace: PlanningGoalPace?

        var id: String { goal.id }

        private enum CodingKeys: String, CodingKey { case pace }

        init(from decoder: Decoder) throws {
            goal = try Goal(from: decoder)
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pace = try c.decodeIfPresent(PlanningGoalPace.self, forKey: .pace)
        }
    }

    struct PlanningGoalMember: Decodable, Identifiable, Hashable, Sendable {
        let personId: String
        let name: String
        let avatarEmoji: String?
        let colorHex: String?
        let age: Int?

        var id: String { personId }
    }

    struct PlanningGoalGroup: Decodable, Identifiable, Sendable {
        /// Named `listId` (not `id`) by the server so a tab can never be confused with a goal;
        /// `id` below is the `Identifiable` conformance, not a decoded field.
        let listId: String
        let name: String
        let emoji: String?
        let colorHex: String?
        let isPrivate: Bool
        let sortOrder: Int
        let members: [PlanningGoalMember]
        let isEveryone: Bool
        let goals: [PlanningGoalGoal]
        let settled: Bool
        let focusGoalId: String?

        var id: String { listId }
    }

    struct PlanningGoalsView: Decodable, Sendable {
        let groups: [PlanningGoalGroup]
    }

    // MARK: Endpoints

    func planningGoals(sessionId: String) async throws -> PlanningGoalsView {
        let q = sessionId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? sessionId
        return try await getJSON("/api/weekly-planning/goals?sessionId=\(q)", as: PlanningGoalsView.self)
    }

    func planningGoalsSetFocus(
        sessionId: String,
        listId: String,
        goalId: String?
    ) async throws -> PlanningGoalsView {
        // `null`, `""` and an omitted key are all read by the server as "nothing this week", so
        // an explicit null needs no presence gymnastics (unlike the kids step's four states).
        let body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "listId": .string(listId),
            "goalId": goalId.map(JSONValue.string) ?? .null,
        ]
        return try await sendReturning(
            "PUT", "/api/weekly-planning/goals/focus", body: body, as: PlanningGoalsView.self)
    }
}

extension WaffledAPI.PlanningGoalGroup {

    var asGoalList: WaffledAPI.GoalList {
        WaffledAPI.GoalList(
            id: listId,
            name: name,
            emoji: emoji,
            colorHex: colorHex,
            goalCount: goals.count,
            members: members.map {
                WaffledAPI.GoalList.Member(
                    personId: $0.personId,
                    name: $0.name,
                    avatarEmoji: $0.avatarEmoji,
                    colorHex: $0.colorHex)
            })
    }
}

/// The crumb this step hands the session record: which group settled on what.
///
/// IT MUST MIRROR THE SERVER'S OWN MAP. `/goals/focus` merges `{ focus: { <listId>: <goalId>|
/// null } }` onto the step row with `jsonb_set`, but the shell's `decideStep` REPLACES `data`
/// wholesale when the primary is pressed, so a crumb that summarised would erase what every
/// mid-step write persisted. A record of the DECISION, not a copy of module data — `is_featured`
/// stays the goals module's truth. Kept identical to the web's `planningGoalsDecision`.
enum PlanningGoalsCrumb {
    static func decision(_ view: WaffledAPI.PlanningGoalsView?) -> [String: JSONValue] {
        var focus: [String: JSONValue] = [:]
        // SETTLED GROUPS ONLY. An unsettled group's `focusGoalId` may be a pre-existing pin the
        // server merely adopted for display; writing it would star a tab nobody has looked at.
        for g in view?.groups ?? [] where g.settled {
            focus[g.listId] = g.focusGoalId.map(JSONValue.string) ?? .null
        }
        return ["focus": .object(focus)]
    }
}
