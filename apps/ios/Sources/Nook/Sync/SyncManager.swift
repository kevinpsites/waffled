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
    private(set) var listsRev = 0
    private(set) var rewardsRev = 0
    /// Bumped after a goal-calendar review action (confirm/skip/link/dismiss) so the
    /// Today review card and the Goals screens reload their progress.
    private(set) var goalsRev = 0

    /// Nudge the goals refresh bus (call after logging/review changes goal progress).
    func touchGoals() { goalsRev += 1 }

    /// The logged-in person's id, resolved from the token (so "my" goals etc. respect
    /// whoever the device is signed in as). Loaded once.
    private(set) var currentPersonId: String?
    func loadIdentity() async {
        guard currentPersonId == nil else { return }
        currentPersonId = try? await api.currentPersonId()
    }

    /// The household's reward currencies, loaded once (for chore/goal reward symbols).
    private(set) var currencies: [NookAPI.Currency] = []
    /// The symbol for a currency key (defaults to ⭐ / the household default).
    func currencySymbol(_ key: String?) -> String {
        if let key, let c = currencies.first(where: { $0.key == key }) { return c.symbol }
        return currencies.first(where: { $0.isDefault })?.symbol ?? "⭐"
    }
    /// The display color (hex) for a currency key, if one is set.
    func currencyColor(_ key: String?) -> String? {
        currencies.first(where: { $0.key == key })?.color
    }
    func loadCurrencies() async {
        guard currencies.isEmpty else { return }
        currencies = (try? await api.currencies()) ?? []
    }
    /// Re-fetch the currency catalog (after an edit), ignoring the once-only guard.
    func refreshCurrencies() async {
        if let fresh = try? await api.currencies() { currencies = fresh }
    }

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
        // A dead refresh token (caught mid-request) tears the sync session down too,
        // so we don't keep retrying with a token that will never be accepted.
        NotificationCenter.default.addObserver(forName: .nookAuthExpired, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.signOut() }
        }
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

    /// Tear down the sync session on sign-out: stop the live queries, disconnect
    /// PowerSync, drop the observable state, and reset so the next `start()` runs
    /// fresh. Keychain tokens are cleared separately by `Session`.
    ///
    /// We `disconnect()` (not `disconnectAndClear()`): clearing the local mirror is
    /// heavy work to run during teardown and isn't needed for correctness — on the
    /// next login PowerSync re-scopes its buckets to the new token, the same as the
    /// web. Keeping teardown light also avoids a memory/Keychain spike at sign-out.
    func signOut() async {
        // Stop consuming the live queries BEFORE disconnecting so a watcher can't
        // race the teardown.
        watchTask?.cancel(); eventsTask?.cancel(); statusTask?.cancel()
        watchTask = nil; eventsTask = nil; statusTask = nil
        try? await db.disconnect()
        members = []; events = []
        personCount = 0; eventCount = 0; pendingUploads = 0
        lastSyncedAt = nil; lastError = nil
        currentPersonId = nil; currencies = []
        status = .idle
        started = false
    }

    private func connect() async {
        guard !AppConfig.bearerToken.isEmpty else {
            status = .offline
            lastError = "Not signed in."
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
        // Resolve the named assignee to a person id and route through the same path the
        // editor uses, so the capture also writes the `event_participants` row (not just
        // `person_id`) — otherwise the person never shows up as a participant.
        let personId = personName.flatMap { name in
            members.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.id
        }
        let ends: String? = allDay
            ? nil
            : EventTime.parse(startsAtISO).map { SyncManager.iso8601.string(from: $0.addingTimeInterval(3600)) }
        return await createCalendarEvent(
            title: title, startsAtISO: startsAtISO, endsAtISO: ends, allDay: allDay,
            location: nil, personIds: personId.map { [$0] } ?? [], calendarId: nil)
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
    func commitTask(title: String, personName: String?, stars: Int?, rewardCurrency: String? = nil, rrule: String?) async -> Bool {
        let ok = await restCommit {
            try await api.createChore(
                title: title, personId: personId(for: personName), rewardAmount: stars,
                rewardCurrency: rewardCurrency, rrule: rrule
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

    /// Plan (upsert) a meal slot from the weekly planner; bumps `mealsRev` so the
    /// Today card and any open week reload.
    func setMealPlan(date: String, mealType: String, recipeId: String?, title: String?, cookPersonId: String? = nil) async -> Bool {
        let ok = await restCommit {
            try await api.planMeal(date: date, mealType: mealType, recipeId: recipeId, title: title, cookPersonId: cookPersonId)
        }
        if ok { mealsRev += 1 }
        return ok
    }

    /// Clear a planned meal slot; bumps `mealsRev`.
    func clearMealPlan(date: String, mealType: String) async -> Bool {
        let ok = await restCommit { try await api.clearMeal(date: date, mealType: mealType) }
        if ok { mealsRev += 1 }
        return ok
    }

    /// Rebuild the grocery list from a week's planned dinners (web's "& build list");
    /// bumps `groceryRev` so the Lists screen refreshes. Best-effort — failures are
    /// swallowed so applying a plan still succeeds.
    @discardableResult
    func rebuildGroceryFromWeek(weekStart: String) async -> Bool {
        let ok = await restCommit { _ = try await api.rebuildGrocery(weekStart: weekStart) }
        if ok { groceryRev += 1 }
        return ok
    }

    // MARK: rewards

    /// Give a reward to a person from this (parent) phone: request the redemption and
    /// immediately approve it, so the balance debits in one action. Bumps `rewardsRev`.
    /// The caller gates this on affordability, so approval shouldn't fail; if it does
    /// (e.g. balance changed underfoot) the error surfaces via `lastError`.
    @discardableResult
    func giveReward(rewardId: String, personId: String) async -> Bool {
        do {
            let redemption = try await api.redeemReward(rewardId: rewardId, personId: personId)
            _ = try await api.approveRedemption(id: redemption.id)
            rewardsRev += 1
            return true
        } catch {
            lastError = String(describing: error)
            return false
        }
    }

    /// Approve a pending redemption (e.g. one a kid filed from the web kiosk).
    @discardableResult
    func approveRedemption(id: String) async -> Bool {
        let ok = await restCommit { _ = try await api.approveRedemption(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Deny a pending redemption; the balance is left unchanged.
    @discardableResult
    func denyRedemption(id: String) async -> Bool {
        let ok = await restCommit { _ = try await api.denyRedemption(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Approve a chore completion that was awaiting a parent's OK (awards its stars).
    @discardableResult
    func approveChore(id: String) async -> Bool {
        let ok = await restCommit { try await api.approveChore(id: id) }
        if ok { choresRev += 1 }
        return ok
    }

    /// Reject an awaiting chore completion (sends it back to pending, no stars).
    @discardableResult
    func rejectChore(id: String) async -> Bool {
        let ok = await restCommit { try await api.rejectChore(id: id) }
        if ok { choresRev += 1 }
        return ok
    }

    /// Pin (or clear, with `nil`) the reward a person is saving toward. Bumps
    /// `rewardsRev` so the person spotlight and their reward shop reflect it.
    @discardableResult
    func setSavingToward(personId: String, rewardId: String?) async -> Bool {
        let ok = await restCommit { try await api.setSavingToward(personId: personId, rewardId: rewardId) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Create a reward in the catalog (admins); bumps `rewardsRev`.
    @discardableResult
    func createReward(title: String, emoji: String?, cost: Int, currency: String) async -> Bool {
        let ok = await restCommit { _ = try await api.createReward(title: title, emoji: emoji, cost: cost, currency: currency) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Edit a reward (admins); bumps `rewardsRev`.
    @discardableResult
    func updateReward(id: String, title: String, emoji: String?, cost: Int, currency: String) async -> Bool {
        let ok = await restCommit { _ = try await api.updateReward(id: id, title: title, emoji: emoji, cost: cost, currency: currency) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Archive (soft-delete) a reward (admins); bumps `rewardsRev`.
    @discardableResult
    func archiveReward(id: String) async -> Bool {
        let ok = await restCommit { try await api.archiveReward(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Restore an archived reward (admins); bumps `rewardsRev`.
    @discardableResult
    func restoreReward(id: String) async -> Bool {
        let ok = await restCommit { _ = try await api.restoreReward(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    // MARK: settings — currencies

    /// Create or edit a currency (admins). Refreshes the catalog + bumps rewardsRev
    /// so symbols/colors update everywhere.
    @discardableResult
    func saveCurrency(id: String?, _ body: [String: JSONValue]) async -> Bool {
        let ok = await restCommit {
            if let id { try await api.updateCurrency(id: id, body) } else { try await api.createCurrency(body) }
        }
        if ok { await refreshCurrencies(); rewardsRev += 1 }
        return ok
    }
    /// Delete a currency (admins). Fails (with `lastError`) if it's the default or last.
    @discardableResult
    func deleteCurrency(id: String) async -> Bool {
        let ok = await restCommit { try await api.deleteCurrency(id: id) }
        if ok { await refreshCurrencies(); rewardsRev += 1 }
        return ok
    }

    /// Create a conversion/trade rate (admins); bumps `rewardsRev`.
    @discardableResult
    func createConversion(_ body: [String: JSONValue]) async -> Bool {
        let ok = await restCommit { try await api.createConversion(body) }
        if ok { rewardsRev += 1 }
        return ok
    }
    /// Delete a conversion (admins); bumps `rewardsRev`.
    @discardableResult
    func deleteConversion(id: String) async -> Bool {
        let ok = await restCommit { try await api.deleteConversion(id: id) }
        if ok { rewardsRev += 1 }
        return ok
    }

    /// Trade a person's balance through a conversion N times. Returns success + an
    /// optional error message (e.g. "not enough to trade"). Bumps `rewardsRev`.
    func applyConversion(id: String, personId: String, times: Int) async -> (ok: Bool, error: String?) {
        do {
            let r = try await api.applyConversion(id: id, personId: personId, times: times)
            if r.ok { rewardsRev += 1 }
            return (r.ok, r.error)
        } catch {
            lastError = String(describing: error)
            return (false, "Couldn’t complete that trade.")
        }
    }

    // MARK: settings — family & household

    /// Create or edit a member (admins).
    @discardableResult
    func savePerson(id: String?, _ body: [String: JSONValue]) async -> Bool {
        await restCommit {
            if let id { try await api.updatePerson(id: id, body) } else { try await api.createPerson(body) }
        }
    }
    /// Delete a member (admins; the owner can't be removed → `lastError`).
    @discardableResult
    func deletePerson(id: String) async -> Bool {
        await restCommit { try await api.deletePerson(id: id) }
    }
    /// Edit household name/timezone/weekStart/location (admins).
    @discardableResult
    func updateHousehold(_ body: [String: JSONValue]) async -> Bool {
        await restCommit { try await api.updateHousehold(body) }
    }

    /// Commit a captured "add X to <list>" intent: resolve the named list and add
    /// the item. Mirrors the web kiosk's list-intent commit.
    func commitListItem(item: String, listName: String?, quantity: String?) async -> Bool {
        do {
            let lists = try await api.listSummaries()
            var target = listName.flatMap { name in
                lists.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }
            }
            // Web parity: an unmatched (but named) list is created on the fly.
            if target == nil, let name = listName?.trimmingCharacters(in: .whitespaces), !name.isEmpty {
                target = try await api.addList(name: name, emoji: nil)
            }
            guard let target else {
                lastError = "No matching list."
                return false
            }
            try await api.addListItem(listId: target.id, name: item, quantity: quantity)
            listsRev += 1
            return true
        } catch { lastError = String(describing: error); return false }
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
