import Foundation
import Observation

// The Meal Builder's derivation + write logic, kept out of the view so it can be
// driven by tests. See docs/product/meal-builder-plan.md for the decision list.
//
// A "plate" is a named, multi-recipe meal ("BBQ Sunday" = BBQ Chicken (main) +
// Potato Salad + Coleslaw (sides) + Peach Cobbler (dessert)). It has meal-level
// servings, a per-dish cook, a "keep in library" flag, and can be scheduled to a
// day + slot OR sent to the grocery list without ever being scheduled.

/// One role group on the plate. `role` is free text server-side (decision 3) — these
/// are the three the builder scaffolds, in plate order.
struct PlateRole: Hashable, Identifiable, Sendable {
    let key: String
    let label: String
    /// The label on the group's trailing "＋" — iPhone and iPad both tap to add
    /// (decision 8); drag-and-drop is deliberately web-only.
    let addLabel: String
    var id: String { key }
}

/// A role plus the dishes filed under it, in plate order.
struct PlateGroup: Identifiable {
    let role: PlateRole
    let dishes: [WaffledAPI.MealDishDTO]
    var id: String { role.key }
}

enum PlateRoles {
    static let main = PlateRole(key: "main", label: "Main", addLabel: "Add a main")
    static let side = PlateRole(key: "side", label: "Sides", addLabel: "Add a side")
    static let dessert = PlateRole(key: "dessert", label: "Dessert", addLabel: "Add a dessert")
    static let ordered: [PlateRole] = [main, side, dessert]

    /// The dishes filed under one role, in plate order.
    ///
    /// Sides is the **catch-all**: roles are free text, so a plate could carry a
    /// 'bread' or 'appetizer' dish the builder doesn't scaffold. Matching Sides
    /// strictly would leave that dish on the plate but rendered nowhere (the web
    /// groups it the same way).
    static func dishes(_ all: [WaffledAPI.MealDishDTO], in role: PlateRole) -> [WaffledAPI.MealDishDTO] {
        all
            .filter { d in
                role.key == side.key ? (d.role != main.key && d.role != dessert.key) : d.role == role.key
            }
            .sorted { $0.sortOrder < $1.sortOrder }
    }

    /// Every scaffold group, **including the empty ones** — an empty group's "＋ Add a
    /// main" slot is the only way to add a main, so hiding it removes the affordance.
    static func groups(of all: [WaffledAPI.MealDishDTO]) -> [PlateGroup] {
        ordered.map { PlateGroup(role: $0, dishes: dishes(all, in: $0)) }
    }

    static func label(for role: String) -> String {
        ordered.first { $0.key == role }?.label ?? side.label
    }
}

/// What a dish (or a whole plate) may honestly say about the pantry.
///
/// `onHand` is nil whenever the pantry module is off, and that means "we can't say" —
/// not "you have none of these". Three outcomes, and the middle one is the trap: with
/// the pantry off and nothing left to buy there is simply nothing to render. A
/// "0 of N" badge or a "✓ all on hand" tick would both be claims the server never made.
enum OnHandClaim: Equatable, Sendable {
    case nothingToSay
    case allOnHand
    case toBuy(Int)

    static func of(onHand: WaffledAPI.OnHandCount?, toBuy: Int) -> OnHandClaim {
        if toBuy > 0 { return .toBuy(toBuy) }
        return onHand == nil ? .nothingToSay : .allOnHand
    }
}

/// The plate writes the builder needs, as closures so the model can be tested without
/// a server. `.live` wires them to `WaffledAPI` (which owns every endpoint and DTO —
/// nothing here does its own networking).
struct MealBuilderAPI: Sendable {
    var fetch: @Sendable (_ id: String) async throws -> WaffledAPI.MealDTO
    var create: @Sendable (_ name: String, _ servings: Int) async throws -> WaffledAPI.MealDTO
    var update: @Sendable (_ id: String, _ name: String?, _ servings: Int?, _ isSaved: Bool?) async throws -> WaffledAPI.MealDTO
    var addDish: @Sendable (_ id: String, _ recipeId: String, _ role: String?) async throws -> WaffledAPI.MealDTO
    var flatten: @Sendable (_ id: String, _ savedMealId: String) async throws -> WaffledAPI.MealDTO
    var patchDish: @Sendable (_ id: String, _ recipeId: String, _ role: String?, _ cook: WaffledAPI.CookAssignment) async throws -> WaffledAPI.MealDTO
    var removeDish: @Sendable (_ id: String, _ recipeId: String) async throws -> WaffledAPI.MealDTO
    var addToList: @Sendable (_ id: String) async throws -> Int
    var schedule: @Sendable (_ id: String, _ date: String, _ mealType: String, _ cookPersonId: String?) async throws -> Void

    static var live: MealBuilderAPI {
        let api = WaffledAPI()
        return MealBuilderAPI(
            fetch: { try await api.meal(id: $0) },
            create: { try await api.createMeal(name: $0, servings: $1) },
            update: { try await api.updateMeal(id: $0, name: $1, servings: $2, isSaved: $3) },
            addDish: { try await api.addDish(mealId: $0, recipeId: $1, role: $2) },
            flatten: { try await api.flattenMeal(intoMealId: $0, savedMealId: $1) },
            patchDish: { try await api.patchDish(mealId: $0, recipeId: $1, role: $2, cook: $3) },
            removeDish: { try await api.removeDish(mealId: $0, recipeId: $1) },
            addToList: { try await api.addMealToGrocery(id: $0) },
            // The reply carries a plate, but for a SAVED plate that is the *copy* the
            // server scheduled — not this one — so it is deliberately dropped rather
            // than repainted over the builder.
            schedule: { _ = try await api.scheduleMeal(id: $0, date: $1, mealType: $2, cookPersonId: $3) })
    }
}

/// The plate under construction.
@MainActor
@Observable
final class MealBuilderModel {
    /// The name a plate gets when someone starts adding dishes without naming it.
    static let newName = "New meal"
    static let writeFailed = "Couldn’t save that — check your connection and try again."

    private(set) var meal: WaffledAPI.MealDTO?
    /// Bound to the inline name field. Committed on submit / focus loss, not per
    /// keystroke — a debounce here would make the lazy-create guard a timing race.
    var name = ""
    private(set) var servings = 4
    private(set) var isSaved = false
    private(set) var busy = false
    /// Precomputed on every repaint so the view doesn't regroup per render.
    private(set) var groups: [PlateGroup] = PlateRoles.groups(of: [])
    /// A transient message for the toast.
    var message: String?

    /// nil until the plate exists server-side (it is created lazily).
    private(set) var mealId: String?

    private let api: MealBuilderAPI
    /// The in-flight create, shared so a fast rename-then-add fires ONE POST.
    private var createTask: Task<WaffledAPI.MealDTO, Error>?
    /// Which write is newest. Every mutation answers with the whole plate, true as of
    /// its own commit — repainting from an older reply resurrects a removed dish, and
    /// it does not self-heal (nothing refetches).
    private var seq = 0
    /// The name the server last confirmed, so a blur with no edit doesn't PATCH.
    private var committedName: String?

    init(api: MealBuilderAPI = .live, existing: WaffledAPI.MealDTO? = nil) {
        self.api = api
        if let existing { adopt(existing) }
    }

    var isEmpty: Bool { (meal?.recipes.isEmpty ?? true) }
    var toBuy: Int { meal?.toBuy ?? 0 }
    var totalMinutes: Int? { meal?.totalMinutes }
    var displayName: String {
        let t = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? Self.newName : t
    }

    /// "≈ 1h 15m" for the footer. Hands-on + cooking across the whole plate.
    nonisolated static func hoursMinutes(_ total: Int?) -> String {
        guard let total, total > 0 else { return "—" }
        let h = total / 60, m = total % 60
        if h == 0 { return "\(m)m" }
        if m == 0 { return "\(h)h" }
        return "\(h)h \(m)m"
    }

    /// Adopt a whole plate (opening an existing one, or reloading it).
    func adopt(_ m: WaffledAPI.MealDTO) {
        mealId = m.id
        meal = m
        groups = PlateRoles.groups(of: m.recipes)
        name = m.name
        committedName = m.name
        servings = m.servings
        isSaved = m.isSaved
    }

    /// Repaint from a write's reply — unless a newer write has gone out since.
    func applyIfCurrent(_ updated: WaffledAPI.MealDTO, seq: Int) {
        guard seq == self.seq else { return }
        mealId = updated.id
        meal = updated
        groups = PlateRoles.groups(of: updated.recipes)
    }

    func reload() async {
        guard let mealId else { return }
        if let m = try? await api.fetch(mealId) { adopt(m) }
    }

    // MARK: writes

    func addRecipe(_ recipeId: String, role: PlateRole) async {
        // The role is always explicit: it is the group whose ＋ was tapped. Sending
        // none files everything under the server default (the web's "＋ always filed
        // under Sides" bug) and a bare re-add can wipe an existing dish's role/cook.
        await run { api, id in try await api.addDish(id, recipeId, role.key) }
    }

    /// A saved plate added here FLATTENS — its dishes arrive as individual, editable
    /// rows keeping their own roles. Meals never nest (decision 12).
    func addSavedMeal(_ savedMealId: String) async {
        await run { api, id in try await api.flatten(id, savedMealId) }
    }

    func removeDish(_ recipeId: String) async {
        await run { api, id in try await api.removeDish(id, recipeId) }
    }

    func moveDish(_ recipeId: String, to role: PlateRole) async {
        await run { api, id in try await api.patchDish(id, recipeId, role.key, .unchanged) }
    }

    /// `nil` = "Nobody". The server distinguishes an absent cook (leave it alone) from
    /// an explicit null (clear it), so this must say `.clear` rather than `.unchanged`.
    func assignCook(_ recipeId: String, personId: String?) async {
        let cook: WaffledAPI.CookAssignment = personId.map { .person($0) } ?? .clear
        await run { api, id in try await api.patchDish(id, recipeId, nil, cook) }
    }

    func changeServings(_ next: Int) async {
        let n = max(1, next)
        guard n != servings else { return }
        let previous = servings
        servings = n
        // On a plate that doesn't exist yet the new number just rides along on the
        // lazy create — no point creating a meal because someone tapped the stepper.
        guard mealId != nil else { return }
        await run(rollback: { [weak self] in self?.servings = previous }) { api, id in
            try await api.update(id, nil, n, nil)
        }
    }

    /// "Keep in library". Applied the moment it is flipped — a state, not a pending
    /// action waiting on Schedule or Add-to-list.
    func toggleSaved() async {
        let next = !isSaved
        let previous = isSaved
        isSaved = next
        await run(rollback: { [weak self] in self?.isSaved = previous }) { api, id in
            try await api.update(id, nil, nil, next)
        }
    }

    /// Commit the inline name edit (on submit / focus loss). Creates the plate if this
    /// is the first thing that happened on the screen.
    func commitRename() async {
        let next = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else {
            name = committedName ?? meal?.name ?? ""
            return
        }
        guard next != committedName else { return }
        let previous = committedName ?? ""
        let ok = await run(rollback: { [weak self] in self?.name = previous }) { [weak self] api, id in
            // The lazy create may have just used this very name — don't PATCH it back.
            if let m = self?.meal, m.name == next { return m }
            return try await api.update(id, next, nil, nil)
        }
        // Only on success. A rejected name that still counted as "confirmed" would be
        // painted straight back the next time the (now-empty) field lost focus.
        if ok { committedName = meal?.name ?? next }
    }

    /// Put the whole plate's shopping on the grocery list without scheduling it.
    func addToGrocery() async {
        guard let id = mealId, !isEmpty else {
            message = "Add a dish first."
            return
        }
        busy = true
        do {
            let added = try await api.addToList(id)
            message = added == 1 ? "Added 1 item to the grocery list"
                                 : "Added \(added) items to the grocery list"
        } catch {
            message = "Couldn’t add this plate to the list."
        }
        busy = false
    }

    /// Put the plate on a day + slot. Returns false if it couldn't.
    ///
    /// Deliberately does NOT repaint from the reply: scheduling a **saved** plate
    /// copies it, so the plate that comes back is next week's copy, not this one.
    @discardableResult
    func schedule(date: String, mealType: String, cookPersonId: String? = nil) async -> Bool {
        guard let id = mealId, !isEmpty else {
            message = "Add a dish first."
            return false
        }
        do {
            try await api.schedule(id, date, mealType, cookPersonId)
            return true
        } catch {
            message = "Couldn’t schedule this plate."
            return false
        }
    }

    // MARK: plumbing

    /// Run a write against the plate, creating it first if this is a fresh one, and
    /// repaint from the response. `rollback` restores whatever the caller painted
    /// optimistically — without it a rejected rename / toggle / servings change stays
    /// on screen, silently, until a reload.
    @discardableResult
    private func run(rollback: (() -> Void)? = nil,
                     _ fn: (MealBuilderAPI, String) async throws -> WaffledAPI.MealDTO) async -> Bool {
        seq += 1
        let mine = seq
        busy = true
        var ok = true
        do {
            let id = try await ensureId()
            let updated = try await fn(api, id)
            applyIfCurrent(updated, seq: mine)
        } catch {
            // Deliberately NOT gated on `mine == seq`: a write that failed still
            // failed, and staying quiet because something else went out afterwards is
            // how the web's silent-failure bug happened.
            rollback?()
            message = Self.writeFailed
            ok = false
        }
        if mine == seq { busy = false }
        return ok
    }

    /// The plate's id, creating it on first use. One create, ever — a rename and an
    /// add racing each other share the same in-flight task rather than both POSTing.
    private func ensureId() async throws -> String {
        if let mealId { return mealId }
        if let createTask { return try await createTask.value.id }
        let label = displayName
        let wanted = servings
        let api = self.api
        let task = Task { try await api.create(label, wanted) }
        createTask = task
        do {
            let created = try await task.value
            mealId = created.id
            meal = created
            groups = PlateRoles.groups(of: created.recipes)
            committedName = created.name
            return created.id
        } catch {
            createTask = nil
            throw error
        }
    }
}
