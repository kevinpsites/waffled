import Foundation

// Weekly Planning · step 8 (Tasks) — this step's wire types and its ONE read. Ported from
// `apps/web/src/lib/api/planning/tasks.ts`. Handing a chore out is a write to the CHORES
// module, so `handOut` below composes two chores endpoints the app already has — which is why
// this step stores nothing of its own and adds no write route.

extension WaffledAPI {

    /// One card on the board: a chore DEFINITION, not a day's instance.
    struct PlanningTasksChore: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let title: String
        let emoji: String?
        let rrule: String?
        /// "daily" | "weekly" | "once", in the chore editor's own words.
        let cadence: String
        /// The days inside the planned week this chore lands on, computed server-side from the
        /// same rule the chores module materializes by. Empty ⇒ no day inside the week.
        let days: [String]
        /// A one-off's own date, which may sit outside the planned week. Null for recurring.
        let dueOn: String?
        /// "HH:mm", or null for no set time.
        let dueTime: String?
        /// A one-off whose day has PASSED, still open, rolling forward.
        let carriedOver: Bool
        let rewardAmount: Double
        let rewardCurrency: String?
        /// Not drawn on the card, but carried so the chore editor opened from it prefills
        /// honestly — it reads a missing flag as false, which would turn approval or photo
        /// proof off the moment somebody fixed a typo.
        let requiresApproval: Bool
        let requiresPhoto: Bool
        /// Every day of this chore already sitting on a board still open. `PATCH
        /// /api/chores/:id` only cascades to instances from today forward, so the days behind
        /// us have to be moved by hand — see `handOut`. THIS IS THE EASY-TO-MISS HALF.
        let pendingInstanceIds: [String]
    }

    struct PlanningTasksPerson: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let avatarEmoji: String?
        /// A real `persons.color_hex` — data, so `Color(hexString:)`, not a `WF` token.
        let colorHex: String?
        let memberType: String
        let isAdmin: Bool
        /// The standing load this person already carries — what makes the fairness read
        /// visible without anyone computing a score.
        let recurringChores: Int
        /// What they are actually holding for the week being planned. Server-owned, so it
        /// survives a refresh, a remount, or a change of device.
        let chores: [PlanningTasksChore]
    }

    struct PlanningTasksBoard: Decodable, Sendable {
        /// The week the server resolved — echoed so nothing on the device does week arithmetic.
        let weekStart: String
        /// The day a task added during this session should land on. Server-owned for the same
        /// reason the week boundary is: a client using the device's today would date a task
        /// added on a Wednesday while planning next week to that Wednesday.
        let newTaskDay: String
        let people: [PlanningTasksPerson]
        let unassigned: [PlanningTasksChore]
    }

    /// The board for the week being planned. `weekStart` is the one the shell handed us.
    func planningTasksBoard(weekStart: String) async throws -> PlanningTasksBoard {
        try await getJSON("/api/weekly-planning/tasks?weekStart=\(weekStart)",
                          as: PlanningTasksBoard.self)
    }

    /// Move a chore to a person, or back up for grabs when `personId` is nil — the same call
    /// both ways, because handing a chore over has to be undoable.
    ///
    /// TWO WRITES, NOT ONE, and the second is the one that gets forgotten: the PATCH writes the
    /// DEFINITION (every occurrence from today forward), the loop moves every open day of it
    /// already sitting on a board. `personId` is sent as an EXPLICIT `null` when taking a chore
    /// back — a body with the key omitted means "change nothing".
    func planningHandOutChore(_ chore: PlanningTasksChore, to personId: String?) async throws {
        let plan = PlanningTasksHandOut.plan(chore, to: personId)
        try await updateChore(id: plan.choreId, plan.patch)
        for instanceId in plan.instanceIds {
            try await assignChore(id: instanceId, personId: plan.personId)
        }
    }
}

/// The writes a hand-out actually is, as data — so the "and every open instance" half can be
/// asserted without a network.
enum PlanningTasksHandOut {
    struct Plan: Equatable {
        let choreId: String
        /// The `PATCH /api/chores/:id` body.
        let patch: [String: JSONValue]
        /// Every open day already sitting on a board, each needing its own assign call.
        let instanceIds: [String]
        let personId: String?
    }

    static func plan(_ chore: WaffledAPI.PlanningTasksChore, to personId: String?) -> Plan {
        Plan(
            choreId: chore.id,
            // EXPLICIT `null` when taking a chore back: a PATCH body with the key left out
            // means "change nothing", which would make the take-back a silent no-op.
            patch: ["personId": personId.map(JSONValue.string) ?? .null],
            // ALL of them, not just the first: miss these and the reassignment appears not to
            // stick, because the Chores board keeps showing the old name.
            instanceIds: chore.pendingInstanceIds,
            personId: personId)
    }
}
