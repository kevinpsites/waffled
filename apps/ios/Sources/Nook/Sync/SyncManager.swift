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

    private let db: PowerSyncDatabaseProtocol
    private let connector = NookConnector()
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
        for attempt in 1...6 {
            do {
                _ = try await db.getOptional(
                    sql: "SELECT 1 AS n", parameters: [],
                    mapper: { try $0.getInt(name: "n") }
                )
                lastError = nil
                return
            } catch {
                lastError = "Opening local database (attempt \(attempt))… \(error)"
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }
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
                    SELECT e.id, e.title, e.starts_at, e.all_day, e.person_id,
                           p.color_hex AS person_color, p.avatar_emoji AS person_emoji
                      FROM events e
                      LEFT JOIN persons p ON p.id = e.person_id
                    """,
                    parameters: [],
                    mapper: { cursor in
                        let raw = try cursor.getStringOptional(name: "starts_at")
                        return SyncedEvent(
                            id: try cursor.getString(name: "id"),
                            title: (try cursor.getStringOptional(name: "title")) ?? "(untitled)",
                            startsAtRaw: raw,
                            startsAt: EventTime.parse(raw),
                            allDay: (try cursor.getIntOptional(name: "all_day")) == 1,
                            personId: try cursor.getStringOptional(name: "person_id"),
                            colorHex: try cursor.getStringOptional(name: "person_color"),
                            emoji: try cursor.getStringOptional(name: "person_emoji")
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
