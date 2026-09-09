import Foundation

// Weekly Planning · step 1 "Loose ends" — the four endpoints this step owns and their wire
// types. Ported from `apps/web/src/lib/api/planning/looseEnds.ts`.
//
// STEP 1 IS INTAKE, NOT REPAIR. Its main verb is ROUTING, which decides which LATER step
// handles a loose end and writes NOTHING to any module. Only "It's done already" (`done`),
// "Drop it" (`drop`) on a parked note, and the capture bar write anything.
//
// THE CROSS-STEP CONTRACT lives here: `LooseEndRoute`, persisted on step 1's own
// `planning_session_steps.data` as `{ routes: [...] }`, which steps 2/6/8/9 read straight off
// the session view. Changing its shape is a cross-platform break.
//
// An `extension WaffledAPI` rather than another thousand lines in `Sync/WaffledAPI.swift` —
// which is why `getJSON`/`sendReturning` are internal.

extension WaffledAPI {

    /// One thing still open. `kind` and `actions` are left as `String` ON PURPOSE: the decoder
    /// is strict, so a newer server naming a fifth kind would throw and blank the whole step
    /// rather than render the four this build understands.
    struct LooseEnd: Decodable, Sendable, Equatable {
        let key: String
        let kind: String
        let id: String
        let title: String
        let emoji: String?
        let detail: String?
        let actions: [String]
        /// Who already has it, or nil for "nobody has this" — a real state, and exactly the row
        /// worth routing. OPTIONAL so a server predating it still decodes.
        let owner: LooseEndOwner?

        init(
            key: String, kind: String, id: String, title: String, emoji: String?,
            detail: String?, actions: [String], owner: LooseEndOwner? = nil
        ) {
            self.key = key
            self.kind = kind
            self.id = id
            self.title = title
            self.emoji = emoji
            self.detail = detail
            self.actions = actions
            self.owner = owner
        }
    }

    struct LooseEndOwner: Decodable, Sendable, Equatable {
        let id: String
        let name: String
        let colorHex: String?
        let avatarEmoji: String?
    }

    struct LooseEndDestination: Decodable, Sendable, Equatable {
        let to: String
        let label: String
        let hint: String
        /// OPTIONAL, and absent on every destination but one — the server omits the key
        /// entirely rather than sending `false`, so this must not be a plain `Bool`.
        let primary: Bool?
    }

    struct LooseEndRoute: Decodable, Sendable, Equatable {
        let kind: String
        let id: String
        let title: String
        let source: String
        let to: String

        /// Tolerant on purpose: the server's own guard for a persisted route checks only
        /// `kind`/`id`/`to`, so an older row can come back missing `title` or `source` and a
        /// strict decode would blank the whole step over one bad row.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decode(String.self, forKey: .kind)
            id = try c.decode(String.self, forKey: .id)
            to = try c.decode(String.self, forKey: .to)
            title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
            source = try c.decodeIfPresent(String.self, forKey: .source)
                ?? (kind == "parked" ? "parked" : "notDone")
        }

        init(kind: String, id: String, title: String, source: String, to: String) {
            self.kind = kind
            self.id = id
            self.title = title
            self.source = source
            self.to = to
        }

        private enum CodingKeys: String, CodingKey { case kind, id, title, source, to }

        /// Back onto the session's `data.routes`.
        ///
        /// THIS IS WHY THE CRUMB IS NOT COUNT-ONLY HERE: `decideStep` REPLACES the step's
        /// `data` with what the shell sends (`do update set data = excluded.data`), so a crumb
        /// of bare counts would wipe the `data.routes` array steps 2/6/8/9 read.
        var json: JSONValue {
            .object([
                "kind": .string(kind), "id": .string(id), "title": .string(title),
                "source": .string(source), "to": .string(to),
            ])
        }
    }

    struct LooseEndDestinations: Decodable, Sendable, Equatable {
        let notDone: [LooseEndDestination]
        let parked: [LooseEndDestination]
    }

    struct LooseEndCounts: Decodable, Sendable, Equatable {
        let notDone: Int
        let parked: Int
    }

    struct LooseEndsView: Decodable, Sendable, Equatable {
        let weekStart: String
        let notDone: [LooseEnd]
        let parked: [LooseEnd]
        let counts: LooseEndCounts
        let destinations: LooseEndDestinations
        let routes: [LooseEndRoute]
        let sources: [String]
        let lists: [PlanningListCandidate]?

        init(
            weekStart: String, notDone: [LooseEnd], parked: [LooseEnd],
            counts: LooseEndCounts, destinations: LooseEndDestinations,
            routes: [LooseEndRoute], sources: [String],
            lists: [PlanningListCandidate]? = nil
        ) {
            self.weekStart = weekStart
            self.notDone = notDone
            self.parked = parked
            self.counts = counts
            self.destinations = destinations
            self.routes = routes
            self.sources = sources
            self.lists = lists
        }
    }

    struct LooseEndResolution: Decodable, Sendable, Equatable {
        let ok: Bool
        let kind: String
        let id: String
        let action: String
    }

    struct PlanningParkedItem: Decodable, Sendable, Equatable {
        let id: String
        let note: String
        let stepKey: String?
        let status: String
        let sessionId: String?
        let createdAt: String
    }

    // MARK: - The four routes

    func planningLooseEnds(weekStart: String?, sessionId: String?) async throws -> LooseEndsView {
        var q: [String] = []
        if let weekStart, !weekStart.isEmpty { q.append("weekStart=\(PlanningQuery.esc(weekStart))") }
        if let sessionId, !sessionId.isEmpty { q.append("sessionId=\(PlanningQuery.esc(sessionId))") }
        let path = "/api/weekly-planning/loose-ends" + (q.isEmpty ? "" : "?\(q.joined(separator: "&"))")
        return try await getJSON(path, as: LooseEndsView.self)
    }

    ///
    /// `to: nil` UNDOES the routing, and we send an explicit `null` because it says what it
    /// means — which is exactly why bodies are `[String: JSONValue]` and not a synthesized
    /// `Encodable`: Swift omits a nil optional, so "undo" would look like a route that forgot
    /// to say where.
    @discardableResult
    func routePlanningLooseEnd(
        sessionId: String, kind: String, id: String, title: String, source: String, to: String?
    ) async throws -> [LooseEndRoute] {
        let body: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "kind": .string(kind),
            "id": .string(id),
            "title": .string(title),
            "source": .string(source),
            "to": to.map(JSONValue.string) ?? .null,
        ]
        return try await sendReturning(
            "POST", "/api/weekly-planning/loose-ends/route", body: body,
            as: PlanningRoutesResponse.self).routes
    }

    @discardableResult
    func resolvePlanningLooseEnd(
        kind: String, id: String, action: String, sessionId: String?
    ) async throws -> LooseEndResolution {
        var body: [String: JSONValue] = [
            "kind": .string(kind), "id": .string(id), "action": .string(action),
        ]
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = .string(sessionId) }
        return try await sendReturning(
            "POST", "/api/weekly-planning/loose-ends/resolve", body: body,
            as: LooseEndResolution.self)
    }

    ///
    /// Both optionals are OMITTED rather than sent as null when absent: the server reads key
    /// PRESENCE, and "No tag" is the absence of a tag rather than a tag called nothing.
    @discardableResult
    func parkPlanningNote(
        note: String, stepKey: String? = nil, sessionId: String? = nil
    ) async throws -> PlanningParkedItem {
        var body: [String: JSONValue] = ["note": .string(note)]
        if let stepKey, !stepKey.isEmpty { body["stepKey"] = .string(stepKey) }
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = .string(sessionId) }
        return try await sendReturning(
            "POST", "/api/weekly-planning/loose-ends/parked", body: body,
            as: PlanningParkedResponse.self).item
    }

    /// FIX A NOTE THAT IS ALREADY PARKED — its words, its tag, or both.
    ///
    /// `stepKey` is doubly wrapped because the server reads both fields for PRESENCE:
    ///   * `note: nil` / `stepKey: nil` → key omitted → leave that half alone.
    ///   * `stepKey: .some(nil)`        → `null` sent → "No tag", the real answer.
    /// A synthesized `Encodable` cannot say the third thing — hence the `[String: JSONValue]`
    /// bodies. `sessionId` is worth passing: a routed note also has a trail entry quoting its
    /// words, and the server moves the two together.
    @discardableResult
    func updatePlanningParkedNote(
        id: String, note: String? = nil, stepKey: String?? = nil, sessionId: String? = nil
    ) async throws -> PlanningParkedItem {
        var body: [String: JSONValue] = [:]
        if let note { body["note"] = .string(note) }
        if let stepKey { body["stepKey"] = stepKey.map(JSONValue.string) ?? .null }
        if let sessionId, !sessionId.isEmpty { body["sessionId"] = .string(sessionId) }
        return try await sendReturning(
            "PATCH", "/api/weekly-planning/loose-ends/parked/\(PlanningQuery.esc(id))", body: body,
            as: PlanningParkedResponse.self).item
    }

}

enum PlanningQuery {
    static func esc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
    }
}

private struct PlanningRoutesResponse: Decodable {
    let routes: [WaffledAPI.LooseEndRoute]
}

private struct PlanningParkedResponse: Decodable {
    let item: WaffledAPI.PlanningParkedItem
}
