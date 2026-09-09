import Foundation

// Weekly Planning — the SHELL's eight endpoints (plus the one the parked-note banner needs). The
// ten steps' own reads live in their own `Planning<Step>API.swift`, which is why `WaffledAPI`'s
// `getJSON` / `send*` / `delete` were widened to internal.
//
// EVERY BODY IS A `[String: JSONValue]` DICTIONARY, NOT AN `Encodable` STRUCT, because three of
// these routes read key PRESENCE rather than value: `PATCH /session/:id` gates `currentStep` and
// `status` on `!== undefined` (a `null` is a 400); `PUT /config`'s `steps` is a SPARSE MERGE, so
// sending the whole map would clobber another device's opt-out; and `POST /session/:id/step`'s
// `data` is coerced to `{}` when it isn't an object, so an absent crumb must be an absent key.
extension WaffledAPI {

    // MARK: - The view

    /// The landing read: config, the week in question, its session, and all ten steps.
    ///
    /// `weekStart` plans a week other than the default; the server snaps and floors it, and the
    /// answer's own `weekStart` is the authority — echo that, never a week the device computed.
    func weeklyPlanning(weekStart: String? = nil) async throws -> WeeklyPlanningView {
        var path = "/api/weekly-planning"
        if let weekStart, !weekStart.isEmpty {
            let escaped = weekStart.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? weekStart
            path += "?weekStart=\(escaped)"
        }
        return try await getJSON(path, as: WeeklyPlanningView.self)
    }

    // MARK: - Config

    /// One entry of the SERVER-OWNED step catalog as `GET /config` serves it. Deliberately NOT
    /// `PlanningStep`: that route returns the bare `STEPS` array, with none of the per-household,
    /// per-session keys the full view computes, so decoding it as one would fail.
    struct PlanningStepCatalogEntry: Decodable, Identifiable, Hashable, Sendable {
        let key: String
        let title: String
        let ask: String
        let primary: String
        let act: String
        let requiresModule: String?

        var id: String { key }
    }

    /// A list the loose-ends step COULD ask about — the `custom` allowlist, resolved server-side.
    /// Grocery and templates never appear, so a settings panel cannot offer a switch that does nothing.
    struct PlanningListCandidate: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let emoji: String?
        let relevant: Bool
    }

    struct WeeklyPlanningConfigView: Decodable, Sendable {
        let config: WeeklyPlanningConfig
        let steps: [PlanningStepCatalogEntry]
        /// Optional for the same reason `WeeklyPlanningConfig.lists` is: an older server omits it.
        let lists: [PlanningListCandidate]?

        init(
            config: WeeklyPlanningConfig, steps: [PlanningStepCatalogEntry],
            lists: [PlanningListCandidate]? = nil
        ) {
            self.config = config
            self.steps = steps
            self.lists = lists
        }
    }

    /// Config plus the bare catalog — the session-free read, for when all you want is the day/time.
    func weeklyPlanningConfig() async throws -> WeeklyPlanningConfigView {
        try await getJSON("/api/weekly-planning/config", as: WeeklyPlanningConfigView.self)
    }

    /// Admin-only. A PARTIAL patch: pass only what changed.
    ///
    /// `steps` is merged server-side onto the household's existing opt-out map, so
    /// `["horizon": false]` leaves the other nine as they were. Passing the whole map from a
    /// client's snapshot is how one device's stale view re-enables a step another just turned off.
    func setWeeklyPlanningConfig(
        dayOfWeek: Int? = nil,
        time: String? = nil,
        showOnToday: Bool? = nil,
        steps: [String: Bool]? = nil,
        lists: [String: Bool]? = nil
    ) async throws -> WeeklyPlanningConfig {
        var body: [String: JSONValue] = [:]
        if let dayOfWeek { body["dayOfWeek"] = .int(dayOfWeek) }
        if let time { body["time"] = .string(time) }
        if let showOnToday { body["showOnToday"] = .bool(showOnToday) }
        if let steps { body["steps"] = .object(steps.mapValues { JSONValue.bool($0) }) }
        // `lists` merges server-side exactly as `steps` does, so send only what changed.
        if let lists { body["lists"] = .object(lists.mapValues { JSONValue.bool($0) }) }

        struct Resp: Decodable { let config: WeeklyPlanningConfig }
        return try await sendReturning("PUT", "/api/weekly-planning/config", body: body, as: Resp.self).config
    }

    // MARK: - The session record

    /// Start this week's session, or resume the one already there — the route does both. An absent
    /// `weekStart` takes the server's default week.
    func startWeeklyPlanningSession(weekStart: String? = nil) async throws -> PlanningSession {
        var body: [String: JSONValue] = [:]
        if let weekStart, !weekStart.isEmpty { body["weekStart"] = .string(weekStart) }
        struct Resp: Decodable { let session: PlanningSession }
        return try await sendReturning("POST", "/api/weekly-planning/session", body: body, as: Resp.self).session
    }

    /// Move the driver between steps, and/or reopen/finish the session. OMIT WHAT YOU AREN'T
    /// CHANGING: both fields are gated on `!== undefined`, so a `null` `currentStep` is a 400.
    func patchWeeklyPlanningSession(
        id: String,
        currentStep: String? = nil,
        status: String? = nil
    ) async throws -> PlanningSession {
        var body: [String: JSONValue] = [:]
        if let currentStep { body["currentStep"] = .string(currentStep) }
        if let status { body["status"] = .string(status) }
        struct Resp: Decodable { let session: PlanningSession }
        return try await sendReturning(
            "PATCH", "/api/weekly-planning/session/\(id)", body: body, as: Resp.self
        ).session
    }

    /// Record what a step decided (`"skipped"` is a real answer). `data` is the step's crumb,
    /// omitted entirely when nil — the route coerces a non-object to `{}`.
    func decideWeeklyPlanningStep(
        sessionId: String,
        stepKey: String,
        status: String,
        data: [String: JSONValue]? = nil
    ) async throws -> [PlanningStep] {
        var body: [String: JSONValue] = ["stepKey": .string(stepKey), "status": .string(status)]
        if let data { body["data"] = .object(data) }
        struct Resp: Decodable { let steps: [PlanningStep] }
        return try await sendReturning(
            "POST", "/api/weekly-planning/session/\(sessionId)/step", body: body, as: Resp.self
        ).steps
    }

    /// Throw the session away. What it already decided lives in the modules that own it.
    func discardWeeklyPlanningSession(id: String) async throws {
        try await delete("/api/weekly-planning/session/\(id)")
    }

    struct WeeklyPlanningCompletion: Decodable, Sendable {
        let session: PlanningSession
        let steps: [PlanningStep]
    }

    /// Finish it. No body, hence `sendJSON` rather than `sendReturning`.
    func completeWeeklyPlanningSession(id: String) async throws -> WeeklyPlanningCompletion {
        try await sendJSON(
            "POST", "/api/weekly-planning/session/\(id)/complete", as: WeeklyPlanningCompletion.self)
    }

    // MARK: - Loose ends (what the parked-note banner answers with)

    /// Settle one routed loose end. The banner only ever uses `kind: "parked"`; the other kinds
    /// belong to the Loose ends step. `sessionId` retires the item from THIS session's route list,
    /// so a note dealt with here stops being offered by the recap.
    func resolveWeeklyPlanningLooseEnd(
        kind: String,
        id: String,
        action: String,
        sessionId: String? = nil
    ) async throws {
        var body: [String: JSONValue] = [
            "kind": .string(kind), "id": .string(id), "action": .string(action),
        ]
        if let sessionId { body["sessionId"] = .string(sessionId) }
        try await send("POST", "/api/weekly-planning/loose-ends/resolve", body: body)
    }
}
