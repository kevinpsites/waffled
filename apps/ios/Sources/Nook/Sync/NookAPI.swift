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

    enum APIError: Error {
        case http(Int, String)
        /// True for the 422 a photo-required chore returns when completed without proof
        /// (`{ error: "ProofRequired" }`) — lets the capture flow prompt for a photo.
        var isProofRequired: Bool {
            if case let .http(code, _) = self { return code == 422 }
            return false
        }
    }

    /// One shared decoder (default config) — JSONDecoder is reusable and decoding is
    /// thread-safe, so there's no reason to allocate one per request.
    static let decoder = JSONDecoder()

    // MARK: built-in auth (login / refresh / logout)
    //
    // The contract the web uses, verbatim — token-based JSON, no cookies. These
    // calls are public (no bearer) and bypass `perform`'s refresh-retry so a failed
    // login/refresh can't recurse.

    struct AuthStatus: Decodable, Sendable {
        let initialized: Bool
        let methods: [String]
        let oidc: OIDC?
        struct OIDC: Decodable, Sendable { let buttonLabel: String? }
    }
    struct Session: Decodable, Sendable {
        let accessToken: String
        let refreshToken: String
        let expiresIn: Int?
    }

    /// Has this instance been set up, and which sign-in methods are offered.
    func authStatus() async throws -> AuthStatus {
        let req = URLRequest(url: url("/api/auth/status"))
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try Self.decoder.decode(AuthStatus.self, from: data)
    }

    /// Exchange email + password for an access + refresh pair.
    func login(email: String, password: String) async throws -> Session {
        var req = URLRequest(url: url("/api/auth/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["email": email, "password": password])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try Self.decoder.decode(Session.self, from: data)
    }

    /// The deep link the OIDC flow returns to (intercepted by ASWebAuthenticationSession).
    static let oidcRedirect = "nook://auth/callback"

    /// The URL that kicks off backend-mediated OIDC, carrying our deep-link redirect.
    func oidcStartURL() -> URL {
        let encoded = NookAPI.oidcRedirect.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? NookAPI.oidcRedirect
        return url("/api/auth/oidc/start?redirect=\(encoded)")
    }

    /// Exchange the one-time handoff `code` (from the deep-link callback) for a session.
    func oidcExchange(code: String) async throws -> Session {
        var req = URLRequest(url: url("/api/auth/oidc/exchange"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["code": code])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try Self.decoder.decode(Session.self, from: data)
    }

    /// Best-effort server-side revocation of a refresh token (logout).
    func revoke(refreshToken: String) async {
        var req = URLRequest(url: url("/api/auth/logout"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(["refreshToken": refreshToken])
        _ = try? await URLSession.shared.data(for: req)
    }

    /// Exchange the session token for a short-lived PowerSync token + endpoint.
    func fetchPowerSyncToken() async throws -> TokenResponse {
        var req = URLRequest(url: url("/api/powersync/token"))
        authorize(&req)
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(TokenResponse.self, from: data)
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
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(CaptureResponse.self, from: data)
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
    func addGroceryItem(name: String, quantity: String? = nil, section: String? = nil) async throws {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let q = quantity, !q.isEmpty { body["quantity"] = .string(q) }
        if let s = section, !s.isEmpty { body["category"] = .string(s) }
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
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(PlanWeekResult.self, from: data)
    }

    /// The result of an AI "plan my month" run: drafted nights (`suggestions`) plus
    /// the month's already-planned dinners (`existing`, read-only context).
    struct PlanMonthResult: Decodable, Sendable {
        let start: String
        let mealType: String
        let suggestions: [PlanCardDTO]
        let existing: [PlanCardDTO]?
        let via: String?
        let error: String?
    }

    /// Ask the LLM to draft a month of dinners as a rotation with guardrails (themes,
    /// repeat gap, weeknight time cap, leftovers). `dates` re-drafts specific nights.
    func planMonth(start: String, weekdays: [Int]?, skipDates: [String]?, dates: [String]?,
                   cookingFor: Int?, keepInMind: String?, useUp: [String]?, avoidTitles: [String]?,
                   allowRepeats: Bool, repeatGapDays: Int, weekdayThemes: [String: String]?,
                   weeknightMaxMin: Int?, leftovers: Bool) async throws -> PlanMonthResult {
        var body: [String: JSONValue] = ["start": .string(start)]
        if let weekdays, !weekdays.isEmpty { body["weekdays"] = .array(weekdays.map { .int($0) }) }
        if let skipDates, !skipDates.isEmpty { body["skipDates"] = .array(skipDates.map { .string($0) }) }
        if let dates, !dates.isEmpty { body["dates"] = .array(dates.map { .string($0) }) }
        if let cookingFor { body["cookingFor"] = .int(cookingFor) }
        if let keepInMind, !keepInMind.isEmpty { body["keepInMind"] = .string(keepInMind) }
        if let useUp, !useUp.isEmpty { body["useUp"] = .array(useUp.map { .string($0) }) }
        if let avoidTitles, !avoidTitles.isEmpty { body["avoidTitles"] = .array(avoidTitles.map { .string($0) }) }
        body["allowRepeats"] = .bool(allowRepeats)
        body["repeatGapDays"] = .int(repeatGapDays)
        if let weekdayThemes, !weekdayThemes.isEmpty { body["weekdayThemes"] = .object(weekdayThemes.mapValues { .string($0) }) }
        if let weeknightMaxMin { body["weeknightMaxMin"] = .int(weeknightMaxMin) }
        body["leftovers"] = .bool(leftovers)
        var req = URLRequest(url: url("/api/meals/plan-month"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(PlanMonthResult.self, from: data)
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
    /// Planned meals over a date range. `days` (1–45) widens the window past one
    /// week — the month grid fetches 42 days. Omitted → the server's default of 7.
    func mealsWeek(start: String, days: Int? = nil) async throws -> [WeekEntryDTO] {
        struct Resp: Decodable { let entries: [WeekEntryDTO] }
        var path = "/api/meals/week?start=\(start)"
        if let days { path += "&days=\(days)" }
        return try await getJSON(path, as: Resp.self).entries
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

    /// The week's "heads up" digest (busiest day / conflicts) for the agenda view.
    struct HeadsUp: Decodable, Sendable { let headline: String; let body: String }
    func headsUp(from: String, to: String) async throws -> HeadsUp {
        try await getJSON("/api/calendar/heads-up?from=\(from)&to=\(to)", as: HeadsUp.self)
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

    // MARK: - Settings: Google Calendar

    /// Full Google-calendar status for the Settings panel — accounts + calendars.
    struct CalendarStatus: Decodable, Sendable {
        let configured: Bool
        let connected: Bool
        let accounts: [Account]
        let calendars: [Cal]

        struct Account: Decodable, Identifiable, Hashable, Sendable {
            let id: String
            let email: String?
            let connectedAt: String
        }
        struct Cal: Decodable, Identifiable, Hashable, Sendable {
            let id, accountId: String
            let summary: String?
            let accessRole: String?
            let colorHex: String?
            let isPrimary: Bool
            let selected: Bool
            let isWriteTarget: Bool
            let personId, personName, personColor: String?
            let lastSyncedAt: String?
            var isWritable: Bool { accessRole == "owner" || accessRole == "writer" }
        }
    }

    func calendarStatus() async throws -> CalendarStatus {
        try await getJSON("/api/calendar/google/status", as: CalendarStatus.self)
    }
    /// Map a calendar to a person, toggle sync, or set the write-target (admins).
    func updateCalendarLink(id: String, _ body: [String: JSONValue]) async throws {
        try await send("PATCH", "/api/calendar/google/calendars/\(id)", body: body)
    }
    /// Disconnect a Google account + its calendars (admins; imported events stay).
    func disconnectCalendarAccount(id: String) async throws {
        try await delete("/api/calendar/google/accounts/\(id)")
    }

    struct CalendarSyncResult: Decodable, Sendable {
        let imported, updated, deleted: Int
        let calendars: [Line]
        struct Line: Decodable, Sendable { let summary: String?; let error: String? }
        var errors: [String] { calendars.compactMap(\.error) }
    }
    /// Run a manual inbound+outbound sync (all selected calendars, or one).
    func syncCalendars(calendarId: String? = nil) async throws -> CalendarSyncResult {
        var body: [String: JSONValue] = [:]
        if let calendarId { body["calendarId"] = .string(calendarId) }
        return try await sendReturning("POST", "/api/calendar/sync", body: body, as: CalendarSyncResult.self)
    }
    /// Begin connecting a Google account — returns the consent URL to open.
    func connectCalendarURL(redirectTo: String) async throws -> String {
        struct Resp: Decodable { let url: String }
        return try await sendReturning("POST", "/api/calendar/google/connect",
                                       body: ["redirectTo": .string(redirectTo)], as: Resp.self).url
    }

    // MARK: - Settings: AI & capture

    /// The household's capture/AI config — active provider + model, which providers
    /// have server-side credentials (`available`), and each provider's default model.
    /// Keys live in the server env and never reach the client.
    struct CaptureConfig: Decodable, Sendable {
        let provider: String                 // anthropic | openai | ollama | heuristic
        let model: String?
        let available: [String: Bool]
        let defaultModels: [String: String]
    }
    func captureConfig() async throws -> CaptureConfig {
        try await getJSON("/api/capture/config", as: CaptureConfig.self)
    }
    /// Set the active provider + model override (admins). `model` nil ⇒ provider default.
    struct CaptureConfigUpdate: Decodable, Sendable { let provider: String; let model: String? }
    func setCaptureConfig(provider: String, model: String?) async throws -> CaptureConfigUpdate {
        try await sendReturning("PUT", "/api/capture/config",
                                body: ["provider": .string(provider), "model": model.map(JSONValue.string) ?? .null],
                                as: CaptureConfigUpdate.self)
    }

    // MARK: - Settings: meal calendar

    /// How planned meals land on the calendar — calendar toggle, Google push, the
    /// owning person, who's invited (`participantIds` nil ⇒ whole family), and the
    /// per-meal times ("HH:MM").
    struct MealCalendarSettings: Decodable, Sendable {
        let addToCalendar: Bool
        let pushToGoogle: Bool
        let calendarPersonId: String?
        let participantIds: [String]?
        let times: [String: String]
        let durationMinutes: Int
    }
    func mealCalendarSettings() async throws -> MealCalendarSettings {
        struct Resp: Decodable { let settings: MealCalendarSettings }
        return try await getJSON("/api/meals/calendar-settings", as: Resp.self).settings
    }
    /// Save the meal-calendar settings (admins) — re-syncs existing planned meals.
    func setMealCalendarSettings(_ body: [String: JSONValue]) async throws -> MealCalendarSettings {
        struct Resp: Decodable { let settings: MealCalendarSettings }
        return try await sendReturning("PUT", "/api/meals/calendar-settings", body: body, as: Resp.self).settings
    }

    // MARK: - Weather

    /// Current conditions for the household location (server-side, Open-Meteo).
    /// `configured` is false when no location is set.
    struct Weather: Decodable, Sendable {
        let configured: Bool
        let tempF: Double?
        let emoji: String?
        let label: String?
        let location: String?
    }
    func weather() async throws -> Weather { try await getJSON("/api/weather", as: Weather.self) }

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
        /// Photo-proof: the chore needs a snapshot to complete; the (resolved, maybe
        /// relative) proof URL once one is attached; and whether a proof was ever
        /// attached (it auto-expires server-side, leaving this flag so the UI can say
        /// the photo's gone). Decoded defensively so an older payload missing these
        /// fields still loads the rest of the row.
        let requiresPhoto: Bool
        let proofUrl: String?
        let hadProof: Bool

        private enum CodingKeys: String, CodingKey {
            case id, choreId, choreTitle, emoji, personId, personName, status
            case rewardAmount, rewardCurrency, rrule, requiresApproval, streak
            case requiresPhoto, proofUrl, hadProof
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            choreId = try c.decode(String.self, forKey: .choreId)
            choreTitle = try c.decode(String.self, forKey: .choreTitle)
            emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
            personId = try c.decodeIfPresent(String.self, forKey: .personId)
            personName = try c.decodeIfPresent(String.self, forKey: .personName)
            status = try c.decode(String.self, forKey: .status)
            rewardAmount = (try? c.decode(Int.self, forKey: .rewardAmount)) ?? 0
            rewardCurrency = try c.decodeIfPresent(String.self, forKey: .rewardCurrency)
            rrule = try c.decodeIfPresent(String.self, forKey: .rrule)
            requiresApproval = (try? c.decode(Bool.self, forKey: .requiresApproval)) ?? false
            streak = (try? c.decode(Int.self, forKey: .streak)) ?? 0
            requiresPhoto = (try? c.decode(Bool.self, forKey: .requiresPhoto)) ?? false
            proofUrl = try? c.decodeIfPresent(String.self, forKey: .proofUrl)
            hadProof = (try? c.decode(Bool.self, forKey: .hadProof)) ?? false
        }
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

    // MARK: - Settings: reward-approval policy

    struct RewardSettings: Decodable, Sendable { let requireApproval: Bool }
    /// Household reward-approval gate (on = redemptions wait for a parent).
    func rewardSettings() async throws -> RewardSettings {
        try await getJSON("/api/rewards/settings", as: RewardSettings.self)
    }
    /// Flip the gate (admin-only server-side).
    func setRewardApproval(_ requireApproval: Bool) async throws {
        try await send("PUT", "/api/rewards/settings", body: ["requireApproval": .bool(requireApproval)])
    }

    // MARK: - Settings: chore photo-proof retention

    struct ChoresSettings: Decodable, Sendable { let proofTtlDays: Int }
    /// How long completed-chore proof photos are kept, in days (0 = keep until deleted).
    func choresSettings() async throws -> ChoresSettings {
        try await getJSON("/api/chores/settings", as: ChoresSettings.self)
    }
    /// Set the proof-retention window (admin-only server-side). Returns the saved value
    /// (the server clamps to 0…365).
    @discardableResult
    func setProofTtlDays(_ days: Int) async throws -> Int {
        struct Resp: Decodable { let proofTtlDays: Int }
        return try await sendReturning("PUT", "/api/chores/settings",
                                       body: ["proofTtlDays": .int(days)], as: Resp.self).proofTtlDays
    }

    /// A retained chore-proof photo, for the "stored photos" manager in settings.
    struct StoredProof: Decodable, Identifiable, Sendable {
        let instanceId: String
        let choreTitle: String
        let emoji: String?
        let personName: String?
        let personAvatar: String?
        let personColor: String?
        let proofUrl: String?
        let completedAt: String?
        var id: String { instanceId }
    }
    /// Every currently-retained proof photo (settled chores whose blob hasn't expired).
    func storedProofs() async throws -> [StoredProof] {
        struct Resp: Decodable { let proofs: [StoredProof] }
        return try await getJSON("/api/chore-proofs", as: Resp.self).proofs
    }
    /// Delete one stored proof (drops the blob, keeps the chore's `hadProof` flag).
    func deleteProof(instanceId: String) async throws { try await delete("/api/chore-proofs/\(instanceId)") }
    /// Delete every stored proof at once. Returns how many were cleared.
    @discardableResult
    func clearProofs() async throws -> Int {
        struct Resp: Decodable { let cleared: Int }
        return try await sendReturning("DELETE", "/api/chore-proofs", body: [:], as: Resp.self).cleared
    }

    // MARK: - Permissions matrix (role × capability)

    /// The household's role→capability grid, e.g. `["adult": ["chore.manage": true, …]]`.
    /// Admins always hold every capability regardless of the matrix (server-enforced).
    struct PermissionsResponse: Decodable, Sendable {
        let permissions: [String: [String: Bool]]
        let capabilities: [String]
        let roles: [String]
    }
    /// Read the per-role capability matrix (admin-only server-side; 403 for everyone else).
    func permissionsMatrix() async throws -> PermissionsResponse {
        try await getJSON("/api/permissions", as: PermissionsResponse.self)
    }
    /// Save the whole matrix (admin-only). Returns the sanitized matrix the server stored.
    @discardableResult
    func setPermissionsMatrix(_ matrix: [String: [String: Bool]]) async throws -> [String: [String: Bool]] {
        struct Resp: Decodable { let permissions: [String: [String: Bool]] }
        let body: [String: JSONValue] = [
            "permissions": .object(matrix.mapValues { row in .object(row.mapValues { .bool($0) }) }),
        ]
        return try await sendReturning("PUT", "/api/permissions", body: body, as: Resp.self).permissions
    }

    /// A trade rate between two currencies (e.g. 10 ⭐ → 1 🥢).
    struct Conversion: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let fromCurrency, toCurrency: String
        let fromAmount, toAmount: Int
        let from, to: Side
        struct Side: Decodable, Hashable, Sendable {
            let key: String
            let label, symbol, color: String?
        }
    }

    func conversions() async throws -> [Conversion] {
        struct Resp: Decodable { let conversions: [Conversion] }
        return try await getJSON("/api/conversions", as: Resp.self).conversions
    }
    /// Create a trade rate (admins). Body: fromCurrency, toCurrency, fromAmount, toAmount.
    func createConversion(_ body: [String: JSONValue]) async throws { try await send("POST", "/api/conversions", body: body) }
    /// Delete a trade rate (admins).
    func deleteConversion(id: String) async throws { try await delete("/api/conversions/\(id)") }

    /// Apply a conversion to a person's balance N times (anyone, for their own).
    /// Returns `{ ok }` — `ok: false` (with `error`) on insufficient funds.
    struct ConversionResult: Decodable, Sendable { let ok: Bool; let error: String? }
    func applyConversion(id: String, personId: String, times: Int) async throws -> ConversionResult {
        try await sendReturning("POST", "/api/conversions/\(id)/apply",
                                body: ["personId": .string(personId), "times": .int(times)], as: ConversionResult.self)
    }

    // MARK: - Settings: family display (kiosk screensaver / idle / night-dim)

    /// Household-wide "family display" settings — what a wall tablet or browser signed
    /// in as a kiosk does when idle. Mirrors the web `DisplayConfig`. Stored in
    /// households.settings.display; read is open to any member, write is admin-only.
    struct DisplayConfig: Codable, Sendable, Equatable, Hashable {
        var screensaverMinutes: Int
        var content: String            // "photos" | "clock" | "off"
        var returnToPicker: Bool
        var resetHomeMinutes: Int      // 0 = never reset to Today
        var nightDim: NightDim
        // Photo-slideshow options (a server may omit these → sensible defaults).
        var photoSource: String        // "all" | "favorites" | "album"
        var photoAlbum: String?        // album name when photoSource == "album"
        var photoInterval: Int         // seconds each photo stays on screen
        var photoShuffle: Bool
        struct NightDim: Codable, Sendable, Equatable, Hashable {
            var enabled: Bool
            var start: String          // "HH:mm"
            var end: String            // "HH:mm"
        }

        enum CodingKeys: String, CodingKey {
            case screensaverMinutes, content, returnToPicker, resetHomeMinutes, nightDim
            case photoSource, photoAlbum, photoInterval, photoShuffle
        }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            screensaverMinutes = try c.decode(Int.self, forKey: .screensaverMinutes)
            content = try c.decode(String.self, forKey: .content)
            returnToPicker = try c.decode(Bool.self, forKey: .returnToPicker)
            resetHomeMinutes = try c.decode(Int.self, forKey: .resetHomeMinutes)
            nightDim = try c.decode(NightDim.self, forKey: .nightDim)
            photoSource = try c.decodeIfPresent(String.self, forKey: .photoSource) ?? "all"
            photoAlbum = try c.decodeIfPresent(String.self, forKey: .photoAlbum)
            photoInterval = try c.decodeIfPresent(Int.self, forKey: .photoInterval) ?? 8
            photoShuffle = try c.decodeIfPresent(Bool.self, forKey: .photoShuffle) ?? true
        }
    }

    /// Pick + order the photos the screensaver should play for a given config (all,
    /// favorites, or a single album) and shuffle if asked. Mirrors web `screensaverPhotos`.
    static func screensaverPhotos(_ photos: [Photo], _ cfg: DisplayConfig) -> [Photo] {
        var out: [Photo]
        switch cfg.photoSource {
        case "favorites": out = photos.filter { $0.isFavorite }
        case "album": out = cfg.photoAlbum.map { a in photos.filter { $0.memory == a } } ?? photos
        default: out = photos
        }
        if cfg.photoShuffle { out.shuffle() }
        return out
    }

    func displayConfig() async throws -> DisplayConfig {
        try await getJSON("/api/kiosk/display", as: DisplayConfig.self)
    }

    /// Save the family-display settings (admin-only server-side). Returns the
    /// server-normalized config (clamped minutes, coerced fields).
    @discardableResult
    func setDisplayConfig(_ cfg: DisplayConfig) async throws -> DisplayConfig {
        let body: [String: JSONValue] = [
            "screensaverMinutes": .int(cfg.screensaverMinutes),
            "content": .string(cfg.content),
            "returnToPicker": .bool(cfg.returnToPicker),
            "resetHomeMinutes": .int(cfg.resetHomeMinutes),
            "nightDim": .object([
                "enabled": .bool(cfg.nightDim.enabled),
                "start": .string(cfg.nightDim.start),
                "end": .string(cfg.nightDim.end),
            ]),
            "photoSource": .string(cfg.photoSource),
            "photoAlbum": cfg.photoAlbum.map(JSONValue.string) ?? .null,
            "photoInterval": .int(cfg.photoInterval),
            "photoShuffle": .bool(cfg.photoShuffle),
        ]
        return try await sendReturning("PUT", "/api/kiosk/display", body: body, as: DisplayConfig.self)
    }

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
            let loginEmail: String?
            let hasPassword: Bool
            let hasPin: Bool
            let isOwner: Bool
        }
    }

    func householdSettings() async throws -> HouseholdSettings {
        try await getJSON("/api/household/settings", as: HouseholdSettings.self)
    }

    /// The logged-in person, resolved server-side from the token's `sub` via the
    /// identities table. nil if the account hasn't been provisioned yet.
    func currentPersonId() async throws -> String? {
        try await currentPerson()?.id
    }

    /// The logged-in person plus the household role & capabilities the UI uses to
    /// gate management/approval controls — mirrors the web `can(person, cap)` helper.
    /// Capabilities are server-resolved (admins implicitly get all four). nil if the
    /// account hasn't been provisioned yet.
    struct CurrentPerson: Decodable, Sendable, Equatable {
        let id: String
        let memberType: String       // "adult" | "teen" | "kid"
        let isAdmin: Bool
        let capabilities: [String]   // e.g. "chore.manage", "chore.approve", "reward.manage", "reward.approve"
    }
    func currentPerson() async throws -> CurrentPerson? {
        struct Resp: Decodable {
            let person: P?
            struct P: Decodable {
                let id: String
                let memberType: String?
                let isAdmin: Bool?
                let capabilities: [String]?
            }
        }
        guard let p = try await getJSON("/api/household", as: Resp.self).person else { return nil }
        // Default conservatively: an absent role/flag/array grants nothing (least
        // privilege) — the server is the real gate, this only hides UI we'd be told no on.
        return CurrentPerson(id: p.id,
                             memberType: p.memberType ?? "",
                             isAdmin: p.isAdmin ?? false,
                             capabilities: p.capabilities ?? [])
    }

    // MARK: mobile Today layout (per-user override + family default)

    struct MobileTodayLayout: Decodable, Sendable, Equatable {
        var order: [String]
        var hidden: [String]
    }
    struct MobileLayoutResponse: Decodable, Sendable {
        let resolved: MobileTodayLayout
        let source: String          // "user" | "family" | "default"
        let cards: [String]
        let canEditFamily: Bool
    }
    func mobileTodayLayout() async throws -> MobileLayoutResponse {
        try await getJSON("/api/today-layout/mobile", as: MobileLayoutResponse.self)
    }
    /// Save the layout to a tier. scope is "user" (own override) or "family" (admins).
    func saveMobileTodayLayout(scope: String, order: [String], hidden: [String]) async throws {
        let body: [String: JSONValue] = [
            "scope": .string(scope),
            "layout": .object([
                "order": .array(order.map(JSONValue.string)),
                "hidden": .array(hidden.map(JSONValue.string)),
            ]),
        ]
        try await send("PUT", "/api/today-layout/mobile", body: body)
    }
    /// Reset a tier back to inheriting (user → family, family → built-in default).
    func resetMobileTodayLayout(scope: String) async throws {
        try await delete("/api/today-layout/mobile?scope=\(scope)")
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

    // MARK: - Member login + kiosk PIN

    /// Give a member an email + password login (admins). Omit the password to invite
    /// SSO-only. 409 if the email is already in use.
    func setPersonLogin(id: String, email: String, password: String?) async throws {
        var body: [String: JSONValue] = ["email": .string(email)]
        if let password, !password.isEmpty { body["password"] = .string(password) }
        try await send("PUT", "/api/persons/\(id)/login", body: body)
    }
    /// Remove a member's login (admins; not the owner's).
    func removePersonLogin(id: String) async throws { try await delete("/api/persons/\(id)/login") }

    /// Set/replace a member's kiosk PIN (self or admin). 4–8 digits.
    func setPersonPin(id: String, pin: String) async throws {
        try await send("PUT", "/api/persons/\(id)/pin", body: ["pin": .string(pin)])
    }
    /// Clear a member's kiosk PIN.
    func clearPersonPin(id: String) async throws { try await delete("/api/persons/\(id)/pin") }

    // MARK: - Kiosk device pairing

    struct PairingCode: Decodable, Sendable {
        let code: String
        let label: String
        let expiresAt: String
    }
    struct KioskDevice: Decodable, Identifiable, Sendable {
        let id: String
        let label: String
        let lastSeenAt: String?
        let createdAt: String
    }
    /// Mint a one-time pairing code for a new kiosk tablet (admins, ~10-min TTL).
    func createPairingCode(label: String?) async throws -> PairingCode {
        var body: [String: JSONValue] = [:]
        if let label, !label.isEmpty { body["label"] = .string(label) }
        return try await sendReturning("POST", "/api/kiosk/pairing-code", body: body, as: PairingCode.self)
    }
    /// The household's paired kiosk devices (admins).
    func kioskDevices() async throws -> [KioskDevice] {
        struct Resp: Decodable { let devices: [KioskDevice] }
        return try await getJSON("/api/kiosk/devices", as: Resp.self).devices
    }
    func renameKioskDevice(id: String, label: String) async throws {
        try await send("PATCH", "/api/kiosk/devices/\(id)", body: ["label": .string(label)])
    }
    /// Revoke (unpair) a kiosk device (admins).
    func revokeKioskDevice(id: String) async throws { try await delete("/api/kiosk/devices/\(id)") }

    // MARK: - Rewards

    /// One reward in the household catalog — costs `cost` of `currency`.
    struct Reward: Decodable, Identifiable, Hashable, Sendable {
        let id: String
        let title: String
        let emoji: String?
        let cost: Int
        let currency: String        // currency key (e.g. "stars")
        let sortOrder: Int
        let requiresApproval: Bool   // per-reward parent-approval gate
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
    func createReward(title: String, emoji: String?, cost: Int, currency: String, requiresApproval: Bool) async throws -> Reward {
        struct Resp: Decodable { let reward: Reward }
        var body: [String: JSONValue] = ["title": .string(title), "cost": .int(cost), "currency": .string(currency), "requiresApproval": .bool(requiresApproval)]
        body["emoji"] = emoji.map(JSONValue.string) ?? .null
        return try await sendReturning("POST", "/api/rewards", body: body, as: Resp.self).reward
    }

    /// Edit a reward's title/emoji/cost/currency/approval (admins).
    func updateReward(id: String, title: String, emoji: String?, cost: Int, currency: String, requiresApproval: Bool) async throws -> Reward {
        struct Resp: Decodable { let reward: Reward }
        var body: [String: JSONValue] = ["title": .string(title), "cost": .int(cost), "currency": .string(currency), "requiresApproval": .bool(requiresApproval)]
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

    /// All chore completions awaiting a parent's OK, across every date (approvals queue).
    func awaitingChores() async throws -> [ChoreInstanceDTO] {
        struct Resp: Decodable { let instances: [ChoreInstanceDTO] }
        return try await getJSON("/api/chore-instances/awaiting", as: Resp.self).instances
    }

    /// Create a chore definition (admins). Body: title, emoji?, personId?,
    /// rewardAmount?, rrule?, requiresApproval?.
    func createChore(_ body: [String: JSONValue]) async throws { try await send("POST", "/api/chores", body: body) }
    /// Edit a chore definition (admins) — same fields as create.
    func updateChore(id: String, _ body: [String: JSONValue]) async throws { try await send("PATCH", "/api/chores/\(id)", body: body) }
    /// Delete a chore definition + today's instances (admins).
    func deleteChore(id: String) async throws { try await delete("/api/chores/\(id)") }

    /// Mark an instance done. Pass an uploaded proof blob (`storageKey`/`contentType`)
    /// for a photo-required chore; without it the server returns 422 `ProofRequired`,
    /// which `APIError.isProofRequired` detects so the caller can prompt for a photo.
    func completeChore(id: String, storageKey: String? = nil, contentType: String? = nil) async throws {
        var body: [String: JSONValue] = [:]
        if let storageKey { body["storageKey"] = .string(storageKey) }
        if let contentType { body["contentType"] = .string(contentType) }
        try await send("POST", "/api/chore-instances/\(id)/complete", body: body)
    }
    func uncompleteChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/uncomplete", body: [:]) }
    func approveChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/approve", body: [:]) }
    func rejectChore(id: String) async throws { try await send("POST", "/api/chore-instances/\(id)/reject", body: [:]) }
    /// Claim an up-for-grabs instance for a person (credits their stars on complete).
    func claimChore(id: String, personId: String) async throws {
        try await send("POST", "/api/chore-instances/\(id)/claim", body: ["personId": .string(personId)])
    }
    /// Move an instance to another person, or back to up-for-grabs (personId nil).
    /// Powers the board's drag-and-drop between columns.
    func assignChore(id: String, personId: String?) async throws {
        try await send("POST", "/api/chore-instances/\(id)/assign", body: ["personId": personId.map(JSONValue.string) ?? .null])
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
                      streakDays: streakDays, autoFromCalendar: false, participants: [])
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
    struct ListRefDTO: Decodable { let id: String }
    struct FamilyStarsDTO: Decodable, Sendable { let name: String?; let stars: Int }

    /// Active goals across the household (for the Goals tile count).
    func goals() async throws -> [GoalDTO] {
        struct Resp: Decodable { let goals: [GoalDTO] }
        return try await getJSON("/api/goals", as: Resp.self).goals
    }

    /// All photos (for the Photos tile count + latest memory, and the Photos wall),
    /// newest first. Optional `memory` filters to one album.
    func photos(memory: String? = nil) async throws -> [Photo] {
        struct Resp: Decodable { let photos: [Photo] }
        let path = memory.flatMap { m in
            m.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        }.map { "/api/photos?memory=\($0)" } ?? "/api/photos"
        return try await getJSON(path, as: Resp.self).photos
    }

    /// One photo's full detail.
    func photo(id: String) async throws -> Photo {
        struct Resp: Decodable { let photo: Photo }
        return try await getJSON("/api/photos/\(id)", as: Resp.self).photo
    }

    /// Create a photo (typically `{ storageKey, caption, memory, isFavorite }` for an
    /// uploaded blob). Returns the new photo's id.
    @discardableResult
    func createPhoto(_ body: [String: JSONValue]) async throws -> String {
        struct Resp: Decodable { let photo: NewPhoto; struct NewPhoto: Decodable { let id: String } }
        return try await sendReturning("POST", "/api/photos", body: body, as: Resp.self).photo.id
    }

    /// Patch a photo (caption / memory / isFavorite / takenAt). Returns the updated photo.
    @discardableResult
    func updatePhoto(id: String, _ body: [String: JSONValue]) async throws -> Photo {
        struct Resp: Decodable { let photo: Photo }
        return try await sendReturning("PATCH", "/api/photos/\(id)", body: body, as: Resp.self).photo
    }

    /// Soft-delete a photo.
    func deletePhoto(id: String) async throws { try await delete("/api/photos/\(id)") }

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

    /// Pantry staples (assumed in-house, left off the list) — the editable master list,
    /// shared with the Meals settings tab. Add/remove mirror the web's staples modal.
    func pantryStaples() async throws -> [GroceryBoardDTO.Staple] {
        struct Resp: Decodable { let staples: [GroceryBoardDTO.Staple] }
        return try await getJSON("/api/pantry-staples", as: Resp.self).staples
    }
    func addPantryStaple(name: String) async throws -> GroceryBoardDTO.Staple {
        struct Resp: Decodable { let staple: GroceryBoardDTO.Staple }
        return try await sendReturning("POST", "/api/pantry-staples", body: ["name": .string(name)], as: Resp.self).staple
    }
    func removePantryStaple(id: String) async throws {
        try await delete("/api/pantry-staples/\(id)")
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
    func addListItem(listId: String, name: String, quantity: String?, section: String? = nil) async throws {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let q = quantity, !q.isEmpty { body["quantity"] = .string(q) }
        if let s = section, !s.isEmpty { body["category"] = .string(s) }
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
        /// Goal opted in to count matching calendar events (drives "Plan time").
        let autoFromCalendar: Bool
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
        let autoFromCalendar: Bool
        let participants: [Goal.Participant]
        let milestones: [Milestone]
        let steps: [Step]
        let recent: [LogEntry]
        /// A checklist goal's steps (empty for other goal types).
        struct Step: Decodable, Identifiable, Sendable {
            let id: String
            let label: String
            let done: Bool
            let doneBy: String?
        }
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
    /// Log progress. `loggedOn` (YYYY-MM-DD) backdates the entry to catch up a missed
    /// day and keep a streak alive; nil logs against today.
    func logGoalProgress(goalId: String, amount: Double, personIds: [String], note: String?, loggedOn: String? = nil) async throws {
        var body: [String: JSONValue] = ["amount": .double(amount)]
        if !personIds.isEmpty { body["personIds"] = .array(personIds.map(JSONValue.string)) }
        if let note, !note.isEmpty { body["note"] = .string(note) }
        if let loggedOn, !loggedOn.isEmpty { body["loggedOn"] = .string(loggedOn) }
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

    // MARK: Goal ↔ calendar review (the Today "review events" queues)

    /// A *confirmed* link (purple): an event the household agreed ties to a goal,
    /// now ended and waiting to be logged. `suggestedAmount` is a default preview;
    /// the user can edit it. For checklist goals `goalStepId`/`stepLabel` say which
    /// step a confirm ticks (and the amount is ignored).
    struct GoalRecapItem: Decodable, Identifiable, Sendable {
        let eventId: String
        let occurrenceDate: String
        let title: String
        let startsAt: String
        let endsAt: String?
        let allDay: Bool
        let goalId: String
        let goalTitle: String
        let goalEmoji: String?
        let goalType: String            // total | count | habit | checklist
        let unit: String?
        let trackingMode: String        // shared_total | each_tracks
        let suggestedAmount: Double
        let defaultPersonIds: [String]
        let goalParticipantIds: [String]
        let goalStepId: String?
        let stepLabel: String?
        var id: String { "\(eventId)|\(occurrenceDate)|\(goalId)" }
        /// Amount-based goals get an editable stepper; habits/checklists don't.
        var isAmountBased: Bool { goalType == "total" || goalType == "count" }
    }

    /// A *suggested* link (orange): an untagged event the matcher thinks might
    /// count toward `goalId` (best single match). Link or dismiss.
    struct GoalSuggestionItem: Decodable, Identifiable, Sendable {
        let eventId: String
        let title: String
        let startsAt: String
        let allDay: Bool
        let goalId: String
        let goalTitle: String
        let goalEmoji: String?
        let via: String?                // memory | keyword | llm
        var id: String { eventId }
    }

    /// Confirmed links awaiting review (household-wide).
    func goalRecap() async throws -> [GoalRecapItem] {
        struct Resp: Decodable { let items: [GoalRecapItem] }
        return try await getJSON("/api/goal-calendar/recap", as: Resp.self).items
    }

    /// Untagged events that might count toward a goal (household-wide).
    func goalSuggestions() async throws -> [GoalSuggestionItem] {
        struct Resp: Decodable { let items: [GoalSuggestionItem] }
        return try await getJSON("/api/goal-calendar/suggestions", as: Resp.self).items
    }

    /// Confirm a linked event → logs `amount` to `personIds` (checklist goals tick
    /// their step and ignore amount). Idempotent on (event, occurrence, goal).
    func confirmRecap(eventId: String, occurrenceDate: String, amount: Double, personIds: [String], note: String? = nil) async throws {
        var body: [String: JSONValue] = [
            "eventId": .string(eventId),
            "occurrenceDate": .string(occurrenceDate),
            "amount": .double(amount),
        ]
        if !personIds.isEmpty { body["personIds"] = .array(personIds.map(JSONValue.string)) }
        if let note, !note.isEmpty { body["note"] = .string(note) }
        try await send("POST", "/api/goal-calendar/recap/confirm", body: body)
    }

    /// Mark a linked event as "didn't happen" — clears it without logging progress.
    func skipRecap(eventId: String, occurrenceDate: String) async throws {
        try await send("POST", "/api/goal-calendar/recap/skip",
                       body: ["eventId": .string(eventId), "occurrenceDate": .string(occurrenceDate)])
    }

    /// Tag a suggested event to the goal (it later surfaces in the recap queue).
    func linkSuggestion(eventId: String, goalId: String) async throws {
        try await send("POST", "/api/goal-calendar/suggestions/link",
                       body: ["eventId": .string(eventId), "goalId": .string(goalId)])
    }

    /// Permanently dismiss a suggestion for this household.
    func dismissSuggestion(eventId: String) async throws {
        try await send("POST", "/api/goal-calendar/suggestions/dismiss", body: ["eventId": .string(eventId)])
    }

    /// A live single-event goal match (memory → keyword → LLM) for the event editor's
    /// inline "looks like this counts toward …" hint. Read-only (records nothing).
    struct GoalSuggestOne: Decodable, Sendable {
        let goalId: String
        let goalTitle: String
        let goalEmoji: String?
        let via: String?
        /// True when the learned memory score crosses the server's AUTO_LINK_THRESHOLD —
        /// confident enough to pre-link in the modal (never on a one-off keyword/LLM guess).
        let auto: Bool?
    }
    func suggestOne(title: String, participantIds: [String]) async throws -> GoalSuggestOne? {
        struct Resp: Decodable { let suggestion: GoalSuggestOne? }
        var body: [String: JSONValue] = ["title": .string(title)]
        if !participantIds.isEmpty { body["participantIds"] = .array(participantIds.map(JSONValue.string)) }
        return try await sendReturning("POST", "/api/goal-calendar/suggest-one", body: body, as: Resp.self).suggestion
    }

    /// Create an event via the rich REST route (records the goal-match signal +
    /// routes to Google). Used when linking a goal — the PowerSync `events` table
    /// has no goal columns, so goal-tagged creates can't go through the local mirror.
    /// Returns the new event id; PowerSync down-syncs it for display.
    func createEvent(title: String, startsAtISO: String, endsAtISO: String?, allDay: Bool,
                     location: String?, personIds: [String], goalId: String?, goalStepId: String?,
                     calendarId: String?, timezone: String?, rrule: String? = nil,
                     recurrenceEndAt: String? = nil) async throws -> String {
        var body: [String: JSONValue] = [
            "title": .string(title),
            "startsAt": .string(startsAtISO),
            "allDay": .bool(allDay),
        ]
        if let e = endsAtISO { body["endsAt"] = .string(e) }
        if let l = location, !l.isEmpty { body["location"] = .string(l) }
        if let owner = personIds.first { body["personId"] = .string(owner) }
        if !personIds.isEmpty { body["participantIds"] = .array(personIds.map(JSONValue.string)) }
        if let g = goalId { body["goalId"] = .string(g) }
        if let s = goalStepId { body["goalStepId"] = .string(s) }
        if let c = calendarId { body["calendarId"] = .string(c) }
        if let tz = timezone { body["timezone"] = .string(tz) }
        if let rr = rrule, !rr.isEmpty { body["rrule"] = .string(rr) }
        if let end = recurrenceEndAt { body["recurrenceEndAt"] = .string(end) }
        struct Resp: Decodable { let event: Ev; struct Ev: Decodable { let id: String } }
        return try await sendReturning("POST", "/api/events", body: body, as: Resp.self).event.id
    }

    /// Update an event via REST (PATCH /api/events/:id) — used when a goal link or a
    /// recurrence is involved, since the local mirror's events table has no goal_id
    /// columns and can't expand a rule. For a recurring occurrence, `scope`
    /// ('this' | 'following' | 'all') + `occurrenceStart` pick which occurrences change;
    /// the master `rrule` should only be sent with scope 'all' (or when promoting a
    /// single event to recurring).
    func updateEvent(id: String, title: String, startsAtISO: String, endsAtISO: String?,
                     allDay: Bool, location: String?, personIds: [String],
                     goalId: String?, goalStepId: String?,
                     rrule: String? = nil, clearRrule: Bool = false, recurrenceEndAt: String? = nil,
                     scope: String? = nil, occurrenceStart: String? = nil) async throws {
        var body: [String: JSONValue] = [
            "title": .string(title),
            "startsAt": .string(startsAtISO),
            "endsAt": endsAtISO.map(JSONValue.string) ?? .null,
            "allDay": .bool(allDay),
            "location": location.map(JSONValue.string) ?? .null,
            "personId": personIds.first.map(JSONValue.string) ?? .null,
            "participantIds": .array(personIds.map(JSONValue.string)),
            "goalId": goalId.map(JSONValue.string) ?? .null,
            "goalStepId": goalStepId.map(JSONValue.string) ?? .null,
        ]
        if let scope { body["scope"] = .string(scope) }
        if let occ = occurrenceStart { body["occurrenceStart"] = .string(occ) }
        // Send the rule only when set (or explicitly cleared → `null` tombstones the
        // occurrences); omitting it leaves an existing rule untouched.
        if let rr = rrule { body["rrule"] = .string(rr) }
        else if clearRrule { body["rrule"] = .null }
        if let end = recurrenceEndAt { body["recurrenceEndAt"] = .string(end) }
        try await send("PATCH", "/api/events/\(id)", body: body)
    }

    /// Delete an event via REST (DELETE /api/events/:id). For a recurring occurrence,
    /// `scope` 'this' cancels the one occurrence and 'following' caps the series before
    /// it; both require `occurrenceStart` (carried as query params — DELETE has no body).
    /// `scope` 'all' (the default) drops the whole series.
    func deleteEvent(id: String, scope: String? = nil, occurrenceStart: String? = nil) async throws {
        var path = "/api/events/\(id)"
        if let scope, scope != "all", let occ = occurrenceStart {
            var comps = URLComponents()
            comps.queryItems = [.init(name: "scope", value: scope), .init(name: "occurrenceStart", value: occ)]
            path += "?\(comps.percentEncodedQuery ?? "")"
        }
        try await delete(path)
    }

    // MARK: event detail (the rich detail screen)

    /// One event with its full detail (rrule, Google calendar + sync state, named
    /// participants, goal link) — fields the thin local mirror doesn't carry.
    struct EventDetailDTO: Decodable, Sendable {
        let id: String
        let title: String
        let description: String?
        let location: String?
        let startsAt: String?
        let endsAt: String?
        let allDay: Bool
        let personId: String?
        let goalId: String?
        let goalStepId: String?
        let rrule: String?
        let calendarName: String?
        let syncState: String?
        let origin: String?
        let personName: String?
        let personColor: String?
        let personEmoji: String?
        let participants: [Participant]
        struct Participant: Decodable, Sendable, Identifiable {
            let id: String
            let name: String
            let colorHex: String?
            let avatarEmoji: String?
        }
    }
    func eventDetail(id: String) async throws -> EventDetailDTO {
        struct Resp: Decodable { let event: EventDetailDTO }
        return try await getJSON("/api/events/\(id)", as: Resp.self).event
    }

    /// The per-event AI insight card (headline + prep advice + optional "leave by").
    struct EventInsight: Decodable, Sendable {
        let headline: String
        let body: String
        let leaveBy: String?
        let reminder: String?
        let via: String?
    }
    func eventInsight(id: String) async throws -> EventInsight {
        try await getJSON("/api/events/\(id)/insight", as: EventInsight.self)
    }

    /// Forward a batch of queued local writes to the server's CRUD sink.
    func uploadCrud(_ ops: [CrudOpDTO]) async throws {
        var req = URLRequest(url: url("/api/powersync/crud"))
        req.httpMethod = "POST"
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["ops": ops])
        let (data, resp) = try await perform(req)
        try check(resp, data)
    }

    // MARK: Photos (the family photo wall)

    /// Who uploaded a photo (display info for the "added by" row).
    struct PhotoPerson: Decodable, Sendable {
        let personId: String
        let name: String?
        let avatarEmoji: String?
        let colorHex: String?
    }

    /// One photo on the family wall. `imageUrl` is a stored-blob URL (resolve through
    /// `MediaURL.resolve`) or nil for an emoji-on-gradient tile (`emoji` + `colorHex`).
    struct Photo: Decodable, Identifiable, Sendable {
        let id: String
        let imageUrl: String?
        let caption: String
        let emoji: String?
        let colorHex: String?
        let memory: String?
        let takenAt: String?
        let isFavorite: Bool
        let reactions: [String: Int]
        let uploadedBy: PhotoPerson?
        let createdAt: String
    }

    // MARK: media upload (blob store)

    /// The result of a media upload: the opaque storage key (persist as an entity's
    /// `storageKey`), its resolved (relative) URL, and the stored content type.
    struct UploadedMedia: Decodable, Sendable { let key: String; let url: String; let contentType: String }

    /// Upload image bytes (base64) to the blob store. Returns the opaque storage key
    /// (persist as an entity's storageKey) + its resolved (relative) URL.
    func uploadMedia(base64Data: String, contentType: String) async throws -> UploadedMedia {
        try await sendReturning("POST", "/api/media",
            body: ["data": .string(base64Data), "contentType": .string(contentType)],
            as: UploadedMedia.self)
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
        let (data, resp) = try await perform(req)
        try check(resp, data)
    }

    /// POST/PATCH a JSON body and decode the JSON response, throwing on non-2xx.
    private func sendReturning<T: Decodable>(_ method: String, _ path: String, body: [String: JSONValue], as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        authorize(&req)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(T.self, from: data)
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
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// POST/PATCH (no body) and decode the JSON response, throwing on non-2xx.
    private func sendJSON<T: Decodable>(_ method: String, _ path: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        authorize(&req)
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// GET `path` and decode the JSON body, throwing on non-2xx.
    private func getJSON<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: url(path))
        authorize(&req)
        let (data, resp) = try await perform(req)
        try check(resp, data)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// DELETE `path`, throwing on non-2xx (204 is success).
    private func delete(_ path: String) async throws {
        var req = URLRequest(url: url(path))
        req.httpMethod = "DELETE"
        authorize(&req)
        let (data, resp) = try await perform(req)
        try check(resp, data)
    }

    private func url(_ path: String) -> URL {
        URL(string: AppConfig.apiBaseURL + path)!
    }

    private func authorize(_ req: inout URLRequest) {
        req.setValue("Bearer \(AppConfig.bearerToken)", forHTTPHeaderField: "Authorization")
    }

    /// Run an authed request, transparently refreshing the access token once on a
    /// 401 and retrying. Mirrors the web's `authFetch`: a single rotating-refresh
    /// (coordinated by `TokenRefresher`) recovers an expired access token without the
    /// user noticing; if the refresh token is dead, the original 401 is returned and
    /// `.nookAuthExpired` (fired by the refresher) sends the user to login.
    private func perform(_ req: URLRequest) async throws -> (Data, URLResponse) {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 401,
              AuthTokens.refreshToken != nil,
              await TokenRefresher.shared.refresh() else {
            return (data, resp)
        }
        var retry = req
        authorize(&retry)   // swap in the freshly-minted access token
        return try await URLSession.shared.data(for: retry)
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
    }
}
