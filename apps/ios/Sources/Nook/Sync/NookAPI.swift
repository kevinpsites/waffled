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

    /// Add a grocery item. `name` already folds in the quantity (e.g. "milk (2)"),
    /// matching the web `addGroceryItem(label)`.
    func addGroceryItem(name: String) async throws {
        try await send("POST", "/api/lists/grocery/items", body: ["name": .string(name)])
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

    /// GET `path` and decode the JSON body, throwing on non-2xx.
    private func getJSON<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        authorize(&req)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
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
