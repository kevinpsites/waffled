import Foundation

/// One queued row op forwarded to the server's CRUD sink, matching the shape the
/// web connector sends (`{ op, table, id, data }`) and `powersync-crud.ts` reads.
struct CrudOpDTO: Encodable {
    let op: String
    let table: String
    let id: String
    let data: [String: String?]?
}

/// A minimal JSON value so a single body dict can mix strings, ints, and explicit
/// nulls (the server distinguishes "absent" from `null` for some fields).
enum JSONValue: Encodable {
    case string(String), int(Int), bool(Bool), null

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(s): try c.encode(s)
        case let .int(i): try c.encode(i)
        case let .bool(b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}

/// Tiny HTTP client for the two endpoints the sync layer needs. Stateless — reads
/// `AppConfig` at call time so a token edit takes effect on the next request.
struct NookAPI: Sendable {
    struct TokenResponse: Decodable {
        let token: String
        let powerSyncUrl: String?
    }

    enum APIError: Error { case http(Int, String) }

    /// Exchange the session token for a short-lived PowerSync token + endpoint.
    func fetchPowerSyncToken() async throws -> TokenResponse {
        var req = URLRequest(url: url("/api/powersync/token"))
        authorize(&req)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(TokenResponse.self, from: data)
    }

    struct CaptureResponse: Decodable {
        let intent: CaptureIntent?
        let via: String
        let fallback: Bool
    }

    /// Parse free text into an intent via the server's pluggable-LLM endpoint.
    func capture(text: String) async throws -> CaptureResponse {
        var req = URLRequest(url: url("/api/capture"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["text": text])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(CaptureResponse.self, from: data)
    }

    /// Preload the model (fire-and-forget) so the first parse isn't a cold start.
    func warmCapture() async {
        var req = URLRequest(url: url("/api/capture/warm"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = "{}".data(using: .utf8)
        _ = try? await URLSession.shared.data(for: req)
    }

    // MARK: capture commits (non-synced tables go over REST)
    //
    // Grocery / chore / meal-plan rows aren't in the PowerSync schema, so unlike
    // events (written to the local mirror) these commit straight to the server —
    // mirroring the web kiosk's CaptureBar.commit() contract exactly.

    /// Add a grocery item. Capture folds the quantity into `name` ("milk (2)"); the
    /// Lists screen passes a separate `quantity` so the aisle/board keeps it tidy.
    func addGroceryItem(name: String, quantity: String? = nil) async throws {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let q = quantity, !q.isEmpty { body["quantity"] = .string(q) }
        try await send("POST", "/api/lists/grocery/items", body: body)
    }

    /// Create a chore (the "task" intent). personId resolves the assignee; stars map
    /// to the reward amount; rrule carries a recurrence if the LLM inferred one.
    func createChore(title: String, personId: String?, rewardAmount: Int?, rrule: String?) async throws {
        var body: [String: JSONValue] = ["title": .string(title)]
        body["personId"] = personId.map(JSONValue.string) ?? .null
        if let rewardAmount { body["rewardAmount"] = .int(rewardAmount) }
        if let rrule, !rrule.isEmpty { body["rrule"] = .string(rrule) }
        try await send("POST", "/api/chores", body: body)
    }

    /// Plan a meal slot. recipeId links a known recipe; otherwise title is a one-off.
    func planMeal(date: String, mealType: String, recipeId: String?, title: String?) async throws {
        var body: [String: JSONValue] = ["date": .string(date), "mealType": .string(mealType)]
        if let recipeId { body["recipeId"] = .string(recipeId) }
        if let title { body["title"] = .string(title) }
        try await send("POST", "/api/meals/plan", body: body)
    }

    struct RecipeRef: Decodable { let id: String; let title: String? }

    /// The household's recipes — used for best-effort title→recipe matching before
    /// planning a meal (so "tacos for Friday" links the Tacos recipe when it exists).
    func recipes() async throws -> [RecipeRef] {
        struct Resp: Decodable { let recipes: [RecipeRef] }
        return try await getJSON("/api/recipes", as: Resp.self).recipes
    }

    // MARK: Today dashboard reads (non-synced domains, fetched over REST)

    /// One dinner/lunch/etc. slot in the planned week (mirrors web `WeekEntry`).
    struct WeekEntryDTO: Decodable {
        let id: String
        let date: String
        let mealType: String
        let title: String?
        let recipeId: String?
        let recipe: RecipeInfo?
        struct RecipeInfo: Decodable {
            let title: String?
            let emoji: String?
            let cookTimeMinutes: Int?
            let servings: Int?
        }
    }

    /// A person's chore tally for today (mirrors web `PersonChores`).
    struct PersonChoresDTO: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
        let avatarEmoji: String?
        let colorHex: String?
        let total: Int
        let done: Int
        let stars: Int
    }

    struct GroceryItemDTO: Decodable { let id: String; let checked: Bool }

    /// The planned meals for the week starting `start` (YYYY-MM-DD).
    func mealsWeek(start: String) async throws -> [WeekEntryDTO] {
        struct Resp: Decodable { let entries: [WeekEntryDTO] }
        return try await getJSON("/api/meals/week?start=\(start)", as: Resp.self).entries
    }

    /// Per-person chore progress for today.
    func choresToday() async throws -> [PersonChoresDTO] {
        struct Resp: Decodable { let people: [PersonChoresDTO] }
        return try await getJSON("/api/chores/today", as: Resp.self).people
    }

    /// The grocery list items (for the Today summary count).
    func groceryItems() async throws -> [GroceryItemDTO] {
        struct Resp: Decodable { let items: [GroceryItemDTO] }
        return try await getJSON("/api/lists/grocery", as: Resp.self).items
    }

    // MARK: Family hub tile counts (non-synced domains, fetched over REST)

    struct GoalDTO: Decodable { let id: String; let isFeatured: Bool }
    struct PhotoDTO: Decodable { let id: String; let memory: String? }
    struct ListRefDTO: Decodable { let id: String }
    struct FamilyStarsDTO: Decodable, Sendable { let name: String?; let stars: Int }

    /// Active goals across the household (for the Goals tile count).
    func goals() async throws -> [GoalDTO] {
        struct Resp: Decodable { let goals: [GoalDTO] }
        return try await getJSON("/api/goals", as: Resp.self).goals
    }

    /// All photos (for the Photos tile count + latest memory).
    func photos() async throws -> [PhotoDTO] {
        struct Resp: Decodable { let photos: [PhotoDTO] }
        return try await getJSON("/api/photos", as: Resp.self).photos
    }

    /// The household's lists (for the Lists tile count).
    func lists() async throws -> [ListRefDTO] {
        struct Resp: Decodable { let lists: [ListRefDTO] }
        return try await getJSON("/api/lists", as: Resp.self).lists
    }

    /// Per-person star balances (for the Rewards tile).
    func familyStars() async throws -> [FamilyStarsDTO] {
        struct Resp: Decodable { let people: [FamilyStarsDTO] }
        return try await getJSON("/api/family/overview", as: Resp.self).people
    }

    // MARK: Lists (index + generic detail)

    /// A list in the household's index (Grocery, packing lists, …).
    struct ListSummary: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let emoji: String?
        let listType: String
        let itemCount: Int
    }

    /// One row in a list detail — section (aisle for grocery), quantity, assignee.
    /// The grocery *board* endpoint also fills `aisle` and `sourceRecipeIds` (which
    /// dinners need this item); the plain list endpoint leaves them nil.
    struct ListItemDTO: Decodable, Identifiable, Sendable {
        let id: String
        var name: String
        var quantity: String?
        var checked: Bool
        var section: String?
        var assignee: Assignee?
        var aisle: String?
        var sourceRecipeIds: [String]?
        struct Assignee: Decodable, Sendable {
            let name: String?
            let avatarEmoji: String?
            let colorHex: String?
        }
    }

    /// The grocery board: items tagged with aisle + the meals that need them, plus
    /// this week's meals (each with a color used for the per-item meal dots) and the
    /// pantry staples (assumed in-house, so left off the list).
    struct GroceryBoardDTO: Decodable, Sendable {
        let weekStart: String
        let meals: [Meal]
        let items: [ListItemDTO]
        let staples: [Staple]
        struct Meal: Decodable, Sendable, Identifiable {
            let recipeId: String?
            let title: String?
            let emoji: String?
            let color: String
            let date: String
            let mealType: String?
            var id: String { (recipeId ?? "") + "|" + date + "|" + (mealType ?? "") }
        }
        struct Staple: Decodable, Sendable, Identifiable {
            let id: String
            let name: String
        }
    }

    /// The grocery board (aisle groupings + meal dots + this week's meals + staples).
    func groceryBoard() async throws -> GroceryBoardDTO {
        try await getJSON("/api/lists/grocery/board", as: GroceryBoardDTO.self)
    }

    /// Rebuild the auto-added grocery items from this week's planned meals (keeps
    /// hand-added and checked items). Returns the refreshed board.
    func rebuildGrocery(weekStart: String) async throws -> GroceryBoardDTO {
        struct Resp: Decodable { let board: GroceryBoardDTO }
        return try await sendJSON("POST", "/api/lists/grocery/rebuild?weekStart=\(weekStart)", as: Resp.self).board
    }

    /// All lists in the household (for the Lists index).
    func listSummaries() async throws -> [ListSummary] {
        struct Resp: Decodable { let lists: [ListSummary] }
        return try await getJSON("/api/lists", as: Resp.self).lists
    }

    /// The items in a list (works for any list, grocery included).
    func listItems(listId: String) async throws -> [ListItemDTO] {
        struct Resp: Decodable { let items: [ListItemDTO] }
        return try await getJSON("/api/lists/\(listId)", as: Resp.self).items
    }

    /// Add an item to a non-grocery list.
    func addListItem(listId: String, name: String, quantity: String?) async throws {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let q = quantity, !q.isEmpty { body["quantity"] = .string(q) }
        try await send("POST", "/api/lists/\(listId)/items", body: body)
    }

    /// Edit a list item (name / quantity / checked). Empty quantity clears it.
    func patchListItem(id: String, name: String? = nil, quantity: String? = nil, checked: Bool? = nil) async throws {
        var body: [String: JSONValue] = [:]
        if let name { body["name"] = .string(name) }
        if let quantity { body["quantity"] = quantity.isEmpty ? .null : .string(quantity) }
        if let checked { body["checked"] = .bool(checked) }
        guard !body.isEmpty else { return }
        try await send("PATCH", "/api/list-items/\(id)", body: body)
    }

    /// Full-detail edit (the swipe → Details editor): always sets name, quantity,
    /// assignee, and section. `assignedTo`/empty section send null to clear.
    func updateItemDetails(id: String, name: String, quantity: String, assignedTo: String?, section: String) async throws {
        let body: [String: JSONValue] = [
            "name": .string(name),
            "quantity": quantity.isEmpty ? .null : .string(quantity),
            "assignedTo": assignedTo.map(JSONValue.string) ?? .null,
            "category": section.isEmpty ? .null : .string(section),
        ]
        try await send("PATCH", "/api/list-items/\(id)", body: body)
    }

    /// Remove a list item.
    func deleteListItem(id: String) async throws {
        try await delete("/api/list-items/\(id)")
    }

    /// Forward a batch of queued local writes to the server's CRUD sink.
    func uploadCrud(_ ops: [CrudOpDTO]) async throws {
        var req = URLRequest(url: url("/api/powersync/crud"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["ops": ops])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
    }

    // MARK: helpers

    /// POST/PATCH a JSON body to `path`, throwing on non-2xx. The response body is
    /// ignored — capture commits only care that the write succeeded.
    private func send(_ method: String, _ path: String, body: [String: JSONValue]) async throws {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
    }

    /// POST/PATCH (no body) and decode the JSON response, throwing on non-2xx.
    private func sendJSON<T: Decodable>(_ method: String, _ path: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        authorize(&req)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// GET `path` and decode the JSON body, throwing on non-2xx.
    private func getJSON<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        authorize(&req)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// DELETE `path`, throwing on non-2xx (204 is success).
    private func delete(_ path: String) async throws {
        var req = URLRequest(url: url(path))
        req.httpMethod = "DELETE"
        authorize(&req)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
    }

    private func url(_ path: String) -> URL {
        URL(string: AppConfig.apiBaseURL + path)!
    }

    private func authorize(_ req: inout URLRequest) {
        req.setValue("Bearer \(AppConfig.devToken)", forHTTPHeaderField: "Authorization")
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
    }
}
