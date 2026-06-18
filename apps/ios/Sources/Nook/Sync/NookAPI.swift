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
    case string(String), int(Int), double(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(s): try c.encode(s)
        case let .int(i): try c.encode(i)
        case let .double(d): try c.encode(d)
        case let .bool(b): try c.encode(b)
        case .null: try c.encodeNil()
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
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
    func createChore(title: String, personId: String?, rewardAmount: Int?, rewardCurrency: String? = nil, rrule: String?) async throws {
        var body: [String: JSONValue] = ["title": .string(title)]
        body["personId"] = personId.map(JSONValue.string) ?? .null
        if let rewardAmount { body["rewardAmount"] = .int(rewardAmount) }
        if let rewardCurrency, !rewardCurrency.isEmpty { body["rewardCurrency"] = .string(rewardCurrency) }
        if let rrule, !rrule.isEmpty { body["rrule"] = .string(rrule) }
        try await send("POST", "/api/chores", body: body)
    }

    /// Plan a meal slot. recipeId links a known recipe; otherwise title is a one-off.
    /// `cookPersonId` optionally assigns who's cooking. Upserts (re-planning the same
    /// date+mealType replaces, not duplicates).
    func planMeal(date: String, mealType: String, recipeId: String?, title: String?, cookPersonId: String? = nil) async throws {
        var body: [String: JSONValue] = ["date": .string(date), "mealType": .string(mealType)]
        if let recipeId { body["recipeId"] = .string(recipeId) }
        if let title { body["title"] = .string(title) }
        if let cookPersonId { body["cookPersonId"] = .string(cookPersonId) }
        try await send("POST", "/api/meals/plan", body: body)
    }

    /// Clear a planned slot (soft-delete). 404 if nothing was planned there.
    func clearMeal(date: String, mealType: String) async throws {
        try await delete("/api/meals/plan?date=\(date)&mealType=\(mealType)")
    }

    /// One AI-suggested meal for a night (mirrors the server `PlanCard`). `recipeId`
    /// is set when it matched a library recipe; otherwise it's a brand-new dish.
    struct PlanCardDTO: Decodable, Identifiable, Hashable, Sendable {
        let date: String
        let mealType: String
        let title: String
        let recipeId: String?
        let emoji: String?
        let minutes: Int?
        let servings: Int?
        let note: String?
        var id: String { "\(date)|\(mealType)|\(title)" }
    }

    /// The result of an AI "plan my week" run. `error` is set (with empty
    /// suggestions) when the provider failed at runtime; a 501 throws instead.
    struct PlanWeekResult: Decodable, Sendable {
        let start: String
        let mealType: String
        let suggestions: [PlanCardDTO]
        let via: String?
        let error: String?
    }

    /// Ask the household's LLM to draft a dish for each empty night of the week
    /// (nothing is saved — the client applies accepted cards via `planMeal`). Can be
    /// slow on a local model, so it uses a generous timeout.
    func planWeek(start: String, mealType: String = "dinner", dates: [String]? = nil,
                  cookingFor: Int?, keepInMind: String?, useUp: [String]?,
                  avoidTitles: [String]? = nil) async throws -> PlanWeekResult {
        var body: [String: JSONValue] = ["start": .string(start), "mealType": .string(mealType)]
        if let dates, !dates.isEmpty { body["dates"] = .array(dates.map { .string($0) }) }
        if let cookingFor { body["cookingFor"] = .int(cookingFor) }   // omit ⇒ server uses whole family
        if let keepInMind, !keepInMind.isEmpty { body["keepInMind"] = .string(keepInMind) }
        if let useUp, !useUp.isEmpty { body["useUp"] = .array(useUp.map { .string($0) }) }
        if let avoidTitles, !avoidTitles.isEmpty { body["avoidTitles"] = .array(avoidTitles.map { .string($0) }) }
        var req = URLRequest(url: url("/api/meals/plan-week"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(PlanWeekResult.self, from: data)
    }

    struct RecipeRef: Decodable { let id: String; let title: String? }

    /// The household's recipes — used for best-effort title→recipe matching before
    /// planning a meal (so "tacos for Friday" links the Tacos recipe when it exists).
    func recipes() async throws -> [RecipeRef] {
        struct Resp: Decodable { let recipes: [RecipeRef] }
        return try await getJSON("/api/recipes", as: Resp.self).recipes
    }

    // MARK: Recipes library + detail

    /// One recipe as it appears in the library list. `GET /api/recipes` returns the
    /// full shape; the card reads title/emoji/meta and the cooked tally. Most fields
    /// are nullable in the source (markdown frontmatter), so almost everything is
    /// optional; `servings` and the array meta default server-side.
    struct RecipeSummary: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let title: String
        let emoji: String?
        let category: String?
        let prepTimeMinutes: Int?
        let cookTimeMinutes: Int?
        let servings: Int?
        let imageUrl: String?
        let sourceName: String?
        let isFavorite: Bool
        let cookedCount: Int
        let lastCookedAt: String?
        let mealType: String?
        let protein: String?
        let base: String?
        let cuisine: String?
        let effort: String?
        let cookMethod: String?
        let dietary: [String]?
        let vegetables: [String]?
        let collection: String?
        let tags: [String]?           // merged: source ∪ addedTags − removedTags
        let addedTags: [String]?      // user-added only
        let notes: String?            // markdown source notes (read-only)
        let userNotes: String?        // user's own notes (top-level column)
        let overrides: RecipeOverrides?
    }

    /// The user-owned override blob layered over the markdown source. `PATCH
    /// /api/recipes/:id` **replaces this whole object**, so edits are read-modify-
    /// write: start from the recipe's current `overrides`, change one key, send it
    /// all back. (The web kiosk does the same.)
    struct RecipeOverrides: Codable, Hashable, Sendable {
        var meta: [String: String]?
        var dietary: [String]?
        var addedTags: [String]?
        var removedTags: [String]?
        var subs: [String: String]?
        var stepNotes: [String: String]?
    }

    /// One ingredient row on the detail screen. `amount` is numeric; `display` is the
    /// raw original line; `aisle`/`isStaple` drive the "on hand" banner; `sub` is the
    /// current override substitution if the user picked one.
    struct RecipeIngredientDTO: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let amount: Double?
        let unit: String?
        let prepNote: String?
        let display: String?
        let section: String?
        let aisle: String?
        let isStaple: Bool
        let sortOrder: Int?
        let sub: String?
    }

    /// One method step. `ingredients` are the raw lines used at this step; `note` is
    /// the user's per-step override note if any.
    struct RecipeStepDTO: Decodable, Identifiable, Hashable, Sendable {
        let stepNumber: Int
        let instruction: String
        let ingredients: [String]
        let note: String?
        var id: Int { stepNumber }
    }

    /// Full recipe detail: the summary fields plus structured ingredients + steps.
    struct RecipeDetailDTO: Decodable, Sendable {
        let recipe: RecipeSummary
        let ingredients: [RecipeIngredientDTO]
        let steps: [RecipeStepDTO]
    }

    /// The whole recipe library (no server-side search/filter — the client filters).
    func recipeLibrary() async throws -> [RecipeSummary] {
        struct Resp: Decodable { let recipes: [RecipeSummary] }
        return try await getJSON("/api/recipes", as: Resp.self).recipes
    }

    /// Full detail for one recipe: metadata + ingredients + steps.
    func recipeDetail(id: String) async throws -> RecipeDetailDTO {
        try await getJSON("/api/recipes/\(id)", as: RecipeDetailDTO.self)
    }

    /// Toggle a recipe's favorite flag; returns the updated recipe.
    @discardableResult
    func setRecipeFavorite(id: String, isFavorite: Bool) async throws -> RecipeSummary {
        struct Resp: Decodable { let recipe: RecipeSummary }
        return try await sendReturning("PATCH", "/api/recipes/\(id)",
                                       body: ["isFavorite": .bool(isFavorite)], as: Resp.self).recipe
    }

    /// Mark a recipe cooked (bumps the count + timestamp); returns the updated recipe.
    @discardableResult
    func markRecipeCooked(id: String) async throws -> RecipeSummary {
        struct Resp: Decodable { let recipe: RecipeSummary }
        return try await sendJSON("POST", "/api/recipes/\(id)/cooked", as: Resp.self).recipe
    }

    /// Patch a recipe's user notes and/or its full overrides blob (tags, dietary,
    /// per-step notes). Omitted fields are left untouched server-side; `overrides`,
    /// when sent, replaces the whole blob — so pass the complete current object.
    @discardableResult
    func updateRecipe(id: String, userNotes: String? = nil, overrides: RecipeOverrides? = nil) async throws -> RecipeSummary {
        struct Body: Encodable { var userNotes: String?; var overrides: RecipeOverrides? }
        struct Resp: Decodable { let recipe: RecipeSummary }
        return try await patchEncodable("/api/recipes/\(id)",
                                        body: Body(userNotes: userNotes, overrides: overrides), as: Resp.self).recipe
    }

    // MARK: Today dashboard reads (non-synced domains, fetched over REST)

    /// One dinner/lunch/etc. slot in the planned week (mirrors web `WeekEntry`).
    struct WeekEntryDTO: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let date: String
        let mealType: String
        let title: String?
        let recipeId: String?
        let recipe: RecipeInfo?
        let cook: Cook?
        struct RecipeInfo: Decodable, Hashable, Sendable {
            let title: String?
            let emoji: String?
            let category: String?
            let prepTimeMinutes: Int?
            let cookTimeMinutes: Int?
            let servings: Int?
            let imageUrl: String?
        }
        struct Cook: Decodable, Hashable, Sendable {
            let personId: String?
            let name: String?
            let avatarEmoji: String?
            let colorHex: String?
        }
        /// The label to show for this slot — the recipe title, the free-text title,
        /// or a placeholder.
        var displayTitle: String { recipe?.title ?? title ?? "Planned meal" }
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

    // MARK: Google Calendar links (for the event editor's calendar picker)

    /// One linked Google calendar. `accessRole` owner/writer = writable; the ★
    /// `isWriteTarget` is a person's default calendar.
    struct CalendarLink: Decodable, Identifiable, Sendable {
        let id: String
        let summary: String?
        let accessRole: String?
        let selected: Bool
        let isWriteTarget: Bool
        let personId: String?
        var isWritable: Bool { accessRole == "owner" || accessRole == "writer" }
    }

    /// The household's linked Google calendars (empty if Google isn't connected).
    func calendarLinks() async throws -> [CalendarLink] {
        struct Resp: Decodable { let calendars: [CalendarLink] }
        return ((try? await getJSON("/api/calendar/google/status", as: Resp.self))?.calendars) ?? []
    }

    // MARK: Chores board (non-synced; fetched over REST)

    /// One chore instance for a given day (the Tasks list row).
    struct ChoreInstanceDTO: Decodable, Identifiable, Sendable {
        let id: String
        let choreId: String
        let choreTitle: String
        let emoji: String?
        let personId: String?
        let personName: String?
        var status: String            // pending | done | awaiting
        let rewardAmount: Int
        let rewardCurrency: String?   // currency key (e.g. "stars"); nil = default
        let rrule: String?
        let requiresApproval: Bool
        let streak: Int
    }

    /// A household reward currency (stars, sticks, …) — symbol/label/color for display.
    struct Currency: Decodable, Identifiable, Sendable {
        let key, label, symbol: String
        let color: String?
        let isDefault: Bool
        let spendable: Bool
        let sortOrder: Int
        var id: String { key }
    }

    /// The household's reward currencies (for rendering chore/goal reward symbols).
    func currencies() async throws -> [Currency] {
        struct Resp: Decodable { let currencies: [Currency] }
        return try await getJSON("/api/currencies", as: Resp.self).currencies
    }

    // MARK: - Settings: currencies (admin CRUD)

    /// Create a currency. Body: label, symbol?, color?, spendable?, isDefault?.
    func createCurrency(_ body: [String: JSONValue]) async throws { try await send("POST", "/api/currencies", body: body) }
    /// Edit a currency (key is immutable). Same fields + sortOrder?.
    func updateCurrency(id: String, _ body: [String: JSONValue]) async throws { try await send("PATCH", "/api/currencies/\(id)", body: body) }
    /// Soft-delete a currency (can't be the default or the last one).
    func deleteCurrency(id: String) async throws { try await delete("/api/currencies/\(id)") }

    // MARK: - Settings: family & household

    /// Household settings + members (with owner/login flags) for the Settings screen.
    struct HouseholdSettings: Decodable, Sendable {
        let household: Household
        let members: [Member]

        struct Household: Decodable, Sendable {
            let id, name, timezone, weekStart: String
            let location: String?
            let ownerPersonId: String?
        }
        struct Member: Decodable, Identifiable, Hashable, Sendable {
            let id, name, memberType: String
            let isAdmin: Bool
            let avatarEmoji, colorHex, birthday, dietaryNotes: String?
            let showOnKiosk: Bool
            let hasLogin: Bool
            let isOwner: Bool
        }
    }

    func householdSettings() async throws -> HouseholdSettings {
        try await getJSON("/api/household/settings", as: HouseholdSettings.self)
    }
    /// Edit household name/timezone/weekStart/location (admins).
    func updateHousehold(_ body: [String: JSONValue]) async throws { try await send("PATCH", "/api/household", body: body) }

    /// Create a member (admins). Body: name, memberType, avatarEmoji?, colorHex?,
    /// birthday?, isAdmin?, showOnKiosk?.
    func createPerson(_ body: [String: JSONValue]) async throws { try await send("POST", "/api/persons", body: body) }
    /// Edit a member (admins) — same fields.
    func updatePerson(id: String, _ body: [String: JSONValue]) async throws { try await send("PATCH", "/api/persons/\(id)", body: body) }
    /// Soft-delete a member (admins; the household owner can't be removed).
    func deletePerson(id: String) async throws { try await delete("/api/persons/\(id)") }

    // MARK: - Rewards

    /// One reward in the household catalog — costs `cost` of `currency`.
    struct Reward: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let title: String
        let emoji: String?
        let cost: Int
        let currency: String        // currency key (e.g. "stars")
        let sortOrder: Int
    }

    /// A reward redemption: request → pending → approved/denied. Carries the
    /// requesting person's display info and a snapshot of the reward at request time.
    struct RewardRedemption: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let rewardId: String
        let personId: String
        let personName: String?
        let personAvatar: String?
        let personColor: String?
        let title: String
        let emoji: String?
        let cost: Int
        let currency: String
        let status: String          // pending | approved | denied
        let decidedAt: String?
        let createdAt: String
    }

    /// One person's balances across every currency, plus recent ledger activity.
    struct PersonBalance: Decodable, Identifiable, Hashable, Sendable {
        let personId: String
        let name: String?
        let avatarEmoji: String?
        let colorHex: String?
        let stars: Int              // back-compat: balance in the default currency
        let balances: [CurrencyBalance]
        let recent: [LedgerLine]
        var id: String { personId }

        struct CurrencyBalance: Decodable, Identifiable, Hashable, Sendable {
            let currency: String
            let balance: Int
            var id: String { currency }
        }
        struct LedgerLine: Decodable, Identifiable, Hashable, Sendable {
            let amount: Int
            let reason: String
            let currency: String
            let createdAt: String
            var id: String { createdAt + reason + "\(amount)" + currency }
        }
    }

    /// The household reward-economy snapshot — currency catalog + every person's
    /// per-currency balances and recent activity.
    struct BalancesSummary: Decodable, Sendable {
        let currencies: [Currency]
        let people: [PersonBalance]
    }

    /// The full rewards catalog (active rewards, in sort order).
    func rewardsCatalog() async throws -> [Reward] {
        struct Resp: Decodable { let rewards: [Reward] }
        return try await getJSON("/api/rewards", as: Resp.self).rewards
    }

    /// Per-person, per-currency balances for the whole household.
    func balancesSummary() async throws -> BalancesSummary {
        try await getJSON("/api/balances", as: BalancesSummary.self)
    }

    /// Redemptions, optionally filtered by status (pending | approved | denied).
    func redemptions(status: String? = nil) async throws -> [RewardRedemption] {
        struct Resp: Decodable { let redemptions: [RewardRedemption] }
        let path = status.map { "/api/redemptions?status=\($0)" } ?? "/api/redemptions"
        return try await getJSON(path, as: Resp.self).redemptions
    }

    /// Request a reward for a person — creates a pending redemption.
    func redeemReward(rewardId: String, personId: String) async throws -> RewardRedemption {
        struct Resp: Decodable { let redemption: RewardRedemption }
        return try await sendReturning("POST", "/api/rewards/\(rewardId)/redeem",
                                       body: ["personId": .string(personId)], as: Resp.self).redemption
    }

    /// Approve a pending redemption (admin) — writes the debit ledger entry.
    func approveRedemption(id: String) async throws -> RewardRedemption {
        struct Resp: Decodable { let redemption: RewardRedemption }
        return try await sendJSON("POST", "/api/redemptions/\(id)/approve", as: Resp.self).redemption
    }

    /// Deny a pending redemption (admin) — leaves the balance unchanged.
    func denyRedemption(id: String) async throws -> RewardRedemption {
        struct Resp: Decodable { let redemption: RewardRedemption }
        return try await sendJSON("POST", "/api/redemptions/\(id)/deny", as: Resp.self).redemption
    }

    /// Pin (or clear, with `nil`) the reward a person is saving toward.
    func setSavingToward(personId: String, rewardId: String?) async throws {
        try await send("POST", "/api/persons/\(personId)/saving-toward",
                       body: ["rewardId": rewardId.map(JSONValue.string) ?? .null])
    }

    // MARK: rewards catalog admin

    /// Create a reward (admins). Returns the new reward.
    func createReward(title: String, emoji: String?, cost: Int, currency: String) async throws -> Reward {
        struct Resp: Decodable { let reward: Reward }
        var body: [String: JSONValue] = ["title": .string(title), "cost": .int(cost), "currency": .string(currency)]
        body["emoji"] = emoji.map(JSONValue.string) ?? .null
        return try await sendReturning("POST", "/api/rewards", body: body, as: Resp.self).reward
    }

    /// Edit a reward's title/emoji/cost/currency (admins).
    func updateReward(id: String, title: String, emoji: String?, cost: Int, currency: String) async throws -> Reward {
        struct Resp: Decodable { let reward: Reward }
        var body: [String: JSONValue] = ["title": .string(title), "cost": .int(cost), "currency": .string(currency)]
        body["emoji"] = emoji.map(JSONValue.string) ?? .null
        return try await sendReturning("PATCH", "/api/rewards/\(id)", body: body, as: Resp.self).reward
    }

    /// Soft-archive a reward (admins) — its redemption history is kept.
    func archiveReward(id: String) async throws { try await delete("/api/rewards/\(id)") }

    /// Archived (soft-deleted) rewards (admins).
    func archivedRewards() async throws -> [Reward] {
        struct Resp: Decodable { let rewards: [Reward] }
        return try await getJSON("/api/rewards/archived", as: Resp.self).rewards
    }

    /// Restore an archived reward (admins).
    func restoreReward(id: String) async throws -> Reward {
        struct Resp: Decodable { let reward: Reward }
        return try await sendJSON("POST", "/api/rewards/\(id)/restore", as: Resp.self).reward
    }

    /// The chore instances for `date` (YYYY-MM-DD; defaults to today within ±31 days).
    func choreInstances(date: String) async throws -> [ChoreInstanceDTO] {
        struct Resp: Decodable { let instances: [ChoreInstanceDTO] }
        return try await getJSON("/api/chore-instances/today?date=\(date)", as: Resp.self).instances
    }

    /// Create a chore definition (admins). Body: title, emoji?, personId?,
    /// rewardAmount?, rrule?, requiresApproval?.
    func createChore(_ body: [String: JSONValue]) async throws { try await send("POST", "/api/chores", body: body) }
    /// Edit a chore definition (admins) — same fields as create.
    func updateChore(id: String, _ body: [String: JSONValue]) async throws { try await send("PATCH", "/api/chores/\(id)", body: body) }
    /// Delete a chore definition + today's instances (admins).
    func deleteChore(id: String) async throws { try await delete("/api/chores/\(id)") }

    func completeChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/complete", body: [:]) }
    func uncompleteChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/uncomplete", body: [:]) }
    func approveChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/approve", body: [:]) }
    func rejectChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/reject", body: [:]) }
    /// Claim an up-for-grabs instance for a person (credits their stars on complete).
    func claimChore(id: String, personId: String) async throws {
        try await send("POST", "/api/chore-instances/\(id)/claim", body: ["personId": .string(personId)])
    }

    // MARK: Person overview (the Family per-person spotlight)

    /// A person's spotlight: stars, streak, their goals (with per-person progress),
    /// whole-person category balance + insight, recent stars ledger, redemptions.
    struct PersonOverview: Decodable, Sendable {
        let person: Person
        let stars: Int
        let topStreak: Int
        let currencies: [Currency]
        let balances: [Balance]
        let goals: [Goal]
        let categoryBalance: [CategoryBalance]
        let insight: Insight?
        let recentLedger: [LedgerEntry]
        let redemptions: [Redemption]
        let savingToward: SavingToward?   // the reward this person is pinned to (hero)
        let rewardShop: [ShopReward]      // the catalog with this person's have/toGo

        struct Currency: Decodable, Sendable, Identifiable {
            let key, label, symbol: String
            let color: String?
            let isDefault: Bool
            let sortOrder: Int
            var id: String { key }
        }
        struct Balance: Decodable, Sendable, Identifiable {
            let currency: String
            let balance: Int
            var id: String { currency }
        }

        struct Person: Decodable, Sendable {
            let id, name: String
            let avatarEmoji, colorHex: String?
            let age: Int?
            let memberType: String?
        }
        struct Goal: Decodable, Sendable, Identifiable {
            let id, title: String
            let emoji, category, unit: String?
            let goalType: String?
            let progress, target: Double?
            let pct: Int?            // null for target-less goals (no computable %)
            let streakDays: Int

            /// A full `NookAPI.Goal` for navigating to the goal detail (which reloads
            /// the rest by id); the missing fields get harmless defaults.
            var asGoal: Goal2 {
                Goal2(id: id, goalListId: nil, title: title, emoji: emoji, category: category,
                      goalType: goalType ?? "total", unit: unit, habitPeriod: nil, habitTargetPerPeriod: nil,
                      trackingMode: "shared_total", deadline: nil, isFeatured: false, target: target,
                      totalProgress: progress ?? 0, milestoneTotal: 0, milestoneReached: 0,
                      streakDays: streakDays, participants: [])
            }
        }
        /// Alias so `asGoal` can name the outer `NookAPI.Goal` from inside this nested type.
        typealias Goal2 = NookAPI.Goal
        struct CategoryBalance: Decodable, Sendable, Identifiable {
            let category, emoji, label: String
            let goalCount, avgPct: Int
            var id: String { category }
        }
        struct Insight: Decodable, Sendable {
            let lean, light, suggestions: [String]
            let text: String
        }
        struct LedgerEntry: Decodable, Sendable, Identifiable {
            let amount: Int
            let reason, currency: String
            let detail: String?
            let createdAt: String
            var id: String { createdAt + reason + "\(amount)" + (detail ?? "") }
        }
        struct Redemption: Decodable, Sendable, Identifiable {
            let id, title: String
            let emoji: String?
            let cost: Int
            let currency, status: String
            let createdAt: String
        }
        /// The reward a person is saving toward — drives the shop's hero card.
        struct SavingToward: Decodable, Sendable {
            let id, title: String
            let emoji: String?
            let cost, have, toGo, pct: Int
            let currency: String
        }
        /// A catalog reward with this person's progress toward it (for the picker).
        struct ShopReward: Decodable, Sendable, Identifiable {
            let id, title: String
            let emoji: String?
            let cost, have, toGo: Int
            let currency: String
        }
    }

    /// One person's spotlight overview (goals, stars, balance, redemptions).
    func personOverview(id: String) async throws -> PersonOverview {
        try await getJSON("/api/persons/\(id)/overview", as: PersonOverview.self)
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

    /// Create a custom list. Returns the new list summary.
    func addList(name: String, emoji: String?) async throws -> ListSummary {
        var body: [String: JSONValue] = ["name": .string(name)]
        body["emoji"] = emoji.map(JSONValue.string) ?? .null
        struct Resp: Decodable { let list: ListSummary }
        return try await sendReturning("POST", "/api/lists", body: body, as: Resp.self).list
    }

    /// Delete a custom list.
    func deleteList(id: String) async throws { try await delete("/api/lists/\(id)") }

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

    // MARK: Goals (lists + goals + log/create; non-synced, fetched over REST)

    /// A goal-list membership group (Family, an individual, a couple…). `members`
    /// drives the avatar stack and the "Personal / Kevin & Kelly / Everyone" subline.
    struct GoalList: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let name: String
        let emoji: String?
        let colorHex: String?
        let goalCount: Int
        let members: [Member]
        struct Member: Decodable, Hashable, Sendable {
            let personId: String
            let name: String
            let avatarEmoji: String?
            let colorHex: String?
        }
    }

    /// A goal with its rolled-up progress + per-person contributions.
    struct Goal: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let goalListId: String?
        let title: String
        let emoji: String?
        let category: String?
        let goalType: String
        let unit: String?
        let habitPeriod: String?
        let habitTargetPerPeriod: Int?
        let trackingMode: String
        let deadline: String?
        let isFeatured: Bool
        let target: Double?
        let totalProgress: Double
        let milestoneTotal: Int
        let milestoneReached: Int
        let streakDays: Int
        let participants: [Participant]
        struct Participant: Decodable, Hashable, Sendable {
            let personId: String
            let name: String
            let colorHex: String?
            let avatarEmoji: String?
            let target: Double?
            let progress: Double
        }
    }

    /// A goal's full detail read: the goal fields plus its milestone ladder, recent
    /// activity log, this-week total, and start date.
    struct GoalDetail: Decodable, Sendable {
        let id: String
        let goalListId: String?
        let title: String
        let emoji: String?
        let category: String?
        let goalType: String
        let unit: String?
        let target: Double?
        let trackingMode: String
        let habitPeriod: String?
        let habitTargetPerPeriod: Int?
        let isFeatured: Bool
        let hasRewards: Bool
        let totalProgress: Double
        let streakDays: Int
        let deadline: String?
        let createdAt: String
        let thisWeek: Double
        let participants: [Goal.Participant]
        let milestones: [Milestone]
        let recent: [LogEntry]
        struct Milestone: Decodable, Identifiable, Sendable {
            let id: String
            let threshold: Double
            let emoji: String?
            let label: String?
            let rewardText: String?
            let reached: Bool
        }
        struct LogEntry: Decodable, Identifiable, Sendable {
            let id: String
            let amount: Double
            let loggedAt: String
            let note: String?
            let name: String?
            let avatarEmoji: String?
            let colorHex: String?
        }
    }

    /// One goal's full detail (milestones, recent activity, this-week, streak).
    func goalDetail(id: String) async throws -> GoalDetail {
        struct Resp: Decodable { let goal: GoalDetail }
        return try await getJSON("/api/goals/\(id)", as: Resp.self).goal
    }

    /// Delete a goal (soft-delete server-side).
    func deleteGoal(id: String) async throws {
        try await delete("/api/goals/\(id)")
    }

    /// Create a goal list (membership group). Returns the new list's id.
    func addGoalList(name: String, emoji: String?, memberIds: [String], isPrivate: Bool) async throws -> String {
        var body: [String: JSONValue] = ["name": .string(name), "isPrivate": .bool(isPrivate)]
        body["emoji"] = emoji.map(JSONValue.string) ?? .null
        if !memberIds.isEmpty { body["memberIds"] = .array(memberIds.map(JSONValue.string)) }
        struct Resp: Decodable { let list: NewList; struct NewList: Decodable { let id: String } }
        return try await sendReturning("POST", "/api/goal-lists", body: body, as: Resp.self).list.id
    }

    /// The household's goal lists (the membership picker).
    func goalLists() async throws -> [GoalList] {
        struct Resp: Decodable { let lists: [GoalList] }
        return try await getJSON("/api/goal-lists", as: Resp.self).lists
    }

    /// The goals in a list (nil = every goal across the household).
    func goalsIn(listId: String?) async throws -> [Goal] {
        struct Resp: Decodable { let goals: [Goal] }
        let path = listId.map { "/api/goals?listId=\($0)" } ?? "/api/goals"
        return try await getJSON(path, as: Resp.self).goals
    }

    /// Log progress against a goal: `amount` (can be negative to correct), credited
    /// to `personIds` (one log per person; empty = unattributed pool).
    func logGoalProgress(goalId: String, amount: Double, personIds: [String], note: String?) async throws {
        var body: [String: JSONValue] = ["amount": .int(Int(amount))]
        if !personIds.isEmpty { body["personIds"] = .array(personIds.map(JSONValue.string)) }
        if let note, !note.isEmpty { body["note"] = .string(note) }
        try await send("POST", "/api/goals/\(goalId)/log", body: body)
    }

    /// Create a goal. Required: title, goalType (count|total|habit|checklist),
    /// trackingMode (shared_total|each_tracks). The rest are optional refinements.
    func createGoal(_ body: [String: JSONValue]) async throws {
        try await send("POST", "/api/goals", body: body)
    }

    /// Update a goal — same field set as create (the server PATCH accepts any subset).
    func updateGoal(id: String, _ body: [String: JSONValue]) async throws {
        try await send("PATCH", "/api/goals/\(id)", body: body)
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

    /// POST/PATCH a JSON body and decode the JSON response, throwing on non-2xx.
    private func sendReturning<T: Decodable>(_ method: String, _ path: String, body: [String: JSONValue], as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// PATCH an arbitrary Encodable body and decode the JSON response. Optionals in
    /// the body are omitted when nil (Swift's `encodeIfPresent`), so only the fields
    /// you set are sent.
    private func patchEncodable<B: Encodable, T: Decodable>(_ path: String, body: B, as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "PATCH"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
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
