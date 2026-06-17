import Foundation
import Observation
import PowerSync

/// A family member as read from the local SQLite mirror (proves offline reads).
struct SyncedMember: Identifiable, Sendable {
    let id: String
    let name: String
    let colorHex: String?
    let emoji: String?
    let memberType: String?
}

/// Owns the PowerSync database lifecycle and surfaces live, observable state to
/// SwiftUI: connection status, the synced family (watched query), row counts, and
/// the pending-upload queue depth. This is the Phase 1 de-risk in one place.
@MainActor
@Observable
final class SyncManager {
    enum Status: String { case idle, connecting, connected, offline }

    private(set) var status: Status = .idle
    private(set) var members: [SyncedMember] = []
    private(set) var events: [SyncedEvent] = []
    private(set) var householdTz: TimeZone = .current
    private(set) var personCount = 0
    private(set) var eventCount = 0
    private(set) var pendingUploads = 0
    private(set) var lastSyncedAt: Date?
    private(set) var lastError: String?

    /// Bumped after a REST capture commit so screens reading these (non-synced)
    /// domains reload without a manual pull-to-refresh. Mirrors the web refresh bus.
    private(set) var choresRev = 0
    private(set) var groceryRev = 0
    private(set) var mealsRev = 0

    private let db: PowerSyncDatabaseProtocol
    private let connector = NookConnector()
    private let api = NookAPI()
    static let iso8601 = ISO8601DateFormatter()
    private var started = false
    private var watchTask: Task<Void, Never>?
    private var eventsTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?

    init() {
        db = PowerSyncDatabase(schema: SyncSchema.schema, dbFilename: "nook.sqlite")
    }

    /// Stand up watchers once, then connect. Safe to call on every app launch.
    func start() async {
        guard !started else { return }
        started = true
        await openDatabase()   // serialize the first open before concurrent access
        watchMembers()
        watchEvents()
        observeStatus()
        await connect()
    }

    /// Force a single, serialized database open before any watches or the sync
    /// connection run. PowerSync sets WAL journal mode on first access, which needs
    /// a brief exclusive lock; opening the watch + sync connections concurrently can
    /// race it and throw "database is locked" (SQLITE_BUSY). Touching the DB once up
    /// front avoids the race, and we retry in case a prior instance is still
    /// releasing its lock.
    private func openDatabase() async {
        let failure = await Retry.run(attempts: 6, delay: 400_000_000) { [db] in
            _ = try await db.getOptional(
                sql: "SELECT 1 AS n", parameters: [],
                mapper: { try $0.getInt(name: "n") }
            )
        }
        lastError = failure.map { "Couldn't open the local database: \($0)" }
    }

    /// (Re)connect with fresh credentials — used by the Settings "Reconnect" button
    /// after pasting a token or changing the API URL.
    func reconnect() async {
        try? await db.disconnect()
        await connect()
    }

    private func connect() async {
        guard !AppConfig.devToken.isEmpty else {
            status = .offline
            lastError = "No dev token set — paste one in Sync settings."
            return
        }
        status = .connecting
        do {
            try await db.connect(connector: connector)
        } catch {
            status = .offline
            lastError = String(describing: error)
        }
    }

    /// Insert an event locally. It commits to SQLite immediately (offline-safe) and
    /// PowerSync queues it for upload — the write half of the airplane-mode demo.
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
    func resolveCapture(_ text: String) async throws -> NookAPI.CaptureResponse {
        try await api.capture(text: text)
    }

    /// Warm the model so the first parse isn't a cold start (fire-and-forget).
    func warmCapture() async { await api.warmCapture() }

    /// Commit a captured event by writing it to the local mirror. The resolved
    /// person_id drives server-side calendar routing + the Google push (the phone
    /// never talks to Google). Returns false on failure.
    func commitEvent(title: String, startsAtISO: String, allDay: Bool, personName: String?) async -> Bool {
        let householdId = (try? await db.getOptional(
            sql: "SELECT id FROM households LIMIT 1", parameters: [],
            mapper: { try $0.getString(name: "id") })) ?? nil
        guard let householdId else {
            lastError = "No household synced yet."
            return false
        }
        let personId = personName.flatMap { name in
            members.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.id
        }
        let id = UUID().uuidString.lowercased()
        let ends: String? = allDay
            ? nil
            : EventTime.parse(startsAtISO).map { SyncManager.iso8601.string(from: $0.addingTimeInterval(3600)) }
        do {
            try await db.execute(
                sql: """
                INSERT INTO events (id, household_id, title, starts_at, ends_at, all_day, person_id, origin)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')
                """,
                parameters: [id, householdId, title, startsAtISO, ends, allDay ? 1 : 0, personId]
            )
            await refreshCounts()
            return true
        } catch {
            lastError = String(describing: error)
            return false
        }
    }

    // MARK: calendar event writes (synced table → local mirror, queued for upload)

    /// The id of the synced household row, or nil before the first sync.
    private func householdRowId() async -> String? {
        (try? await db.getOptional(
            sql: "SELECT id FROM households LIMIT 1", parameters: [],
            mapper: { try $0.getString(name: "id") })) ?? nil
    }

    /// The participant person ids on an event — used to prefill the editor.
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

    /// Create a calendar event in the local mirror (PowerSync uploads it). `person_id`
    /// is the first participant — the server uses it for calendar routing.
    func createCalendarEvent(title: String, startsAtISO: String, endsAtISO: String?,
                             allDay: Bool, location: String?, personIds: [String],
                             calendarId: String?) async -> Bool {
        guard let hh = await householdRowId() else { lastError = "No household synced yet."; return false }
        let id = UUID().uuidString.lowercased()
        do {
            try await db.execute(
                sql: """
                INSERT INTO events (id, household_id, title, description, location, starts_at, ends_at,
                                    all_day, timezone, person_id, calendar_id, origin)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
                """,
                parameters: [id, hh, title, nil, location, startsAtISO, endsAtISO,
                             allDay ? 1 : 0, householdTz.identifier, personIds.first, calendarId])
            try await replaceParticipants(eventId: id, householdId: hh, personIds: personIds)
            await refreshCounts()
            return true
        } catch { lastError = String(describing: error); return false }
    }

    /// Update an event + its participants in the local mirror.
    func updateEvent(id: String, title: String, startsAtISO: String, endsAtISO: String?,
                     allDay: Bool, location: String?, personIds: [String]) async -> Bool {
        guard let hh = await householdRowId() else { lastError = "No household synced yet."; return false }
        do {
            try await db.execute(
                sql: "UPDATE events SET title = ?, location = ?, starts_at = ?, ends_at = ?, all_day = ?, person_id = ? WHERE id = ?",
                parameters: [title, location, startsAtISO, endsAtISO, allDay ? 1 : 0, personIds.first, id])
            try await replaceParticipants(eventId: id, householdId: hh, personIds: personIds)
            await refreshCounts()
            return true
        } catch { lastError = String(describing: error); return false }
    }

    /// Delete an event + its participants from the local mirror.
    func deleteEvent(id: String) async -> Bool {
        do {
            try await db.execute(sql: "DELETE FROM event_participants WHERE event_id = ?", parameters: [id])
            try await db.execute(sql: "DELETE FROM events WHERE id = ?", parameters: [id])
            await refreshCounts()
            return true
        } catch { lastError = String(describing: error); return false }
    }

    /// Commit a captured grocery item via REST (not a synced table). The quantity is
    /// folded into the label the same way the web kiosk does ("milk (2)").
    func commitGrocery(name: String, quantity: String?) async -> Bool {
        let ok = await restCommit { try await api.addGroceryItem(name: SyncManager.groceryLabel(name: name, quantity: quantity)) }
        if ok { groceryRev += 1 }
        return ok
    }

    /// Fold an optional quantity into the grocery label ("milk" + "2" → "milk (2)"),
    /// matching the web kiosk. An empty/whitespace quantity is dropped.
    nonisolated static func groceryLabel(name: String, quantity: String?) -> String {
        guard let q = quantity?.trimmingCharacters(in: .whitespaces), !q.isEmpty else { return name }
        return "\(name) (\(q))"
    }

    /// Commit a captured task as a chore via REST. The assignee name resolves to a
    /// synced person; stars become the reward amount.
    func commitTask(title: String, personName: String?, stars: Int?, rrule: String?) async -> Bool {
        let ok = await restCommit {
            try await api.createChore(
                title: title, personId: personId(for: personName), rewardAmount: stars, rrule: rrule
            )
        }
        if ok { choresRev += 1 }
        return ok
    }

    /// Commit a captured meal to the plan via REST. Best-effort matches a known
    /// recipe by title (exact, then contains) so the slot links it; otherwise the
    /// title is planned as a one-off — mirroring the web kiosk.
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

    /// Run a REST capture commit, surfacing any failure via `lastError`. Returns
    /// false on throw so the sheet can keep the preview up and show the error.
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

    // MARK: live state

    private func watchMembers() {
        watchTask = Task { [db] in
            do {
                let stream = try db.watch(
                    sql: "SELECT id, name, color_hex, avatar_emoji, member_type FROM persons ORDER BY sort_order, name",
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
                let stream = try db.watch(
                    sql: """
                    SELECT e.id, e.title, e.starts_at, e.ends_at, e.all_day, e.location, e.person_id,
                           p.color_hex AS person_color, p.avatar_emoji AS person_emoji,
                           (SELECT group_concat(ep.person_id) FROM event_participants ep
                             WHERE ep.event_id = e.id) AS participant_ids
                      FROM events e
                      LEFT JOIN persons p ON p.id = e.person_id
                    """,
                    parameters: [],
                    mapper: { cursor in
                        let raw = try cursor.getStringOptional(name: "starts_at")
                        let pids = (try cursor.getStringOptional(name: "participant_ids"))?
                            .split(separator: ",").map(String.init) ?? []
                        return SyncedEvent(
                            id: try cursor.getString(name: "id"),
                            title: (try cursor.getStringOptional(name: "title")) ?? "(untitled)",
                            startsAtRaw: raw,
                            startsAt: EventTime.parse(raw),
                            allDay: (try cursor.getIntOptional(name: "all_day")) == 1,
                            personId: try cursor.getStringOptional(name: "person_id"),
                            colorHex: try cursor.getStringOptional(name: "person_color"),
                            emoji: try cursor.getStringOptional(name: "person_emoji"),
                            endsAt: EventTime.parse(try cursor.getStringOptional(name: "ends_at")),
                            location: try cursor.getStringOptional(name: "location"),
                            participantIds: pids
                        )
                    }
                )
                for try await rows in stream {
                    self.events = rows
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

        // Bucket the agenda by the household's timezone (synced households row),
        // falling back to the device zone before the first sync.
        if let tz = try? await db.getOptional(
            sql: "SELECT timezone FROM households LIMIT 1", parameters: [],
            mapper: { try $0.getStringOptional(name: "timezone") }
        ), let id = tz, let zone = TimeZone(identifier: id) {
            householdTz = zone
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
