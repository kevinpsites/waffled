import Foundation
import Observation

// The Meal Builder's derivation + write logic, kept out of the view so it can be driven
// by tests. See docs/product/meal-builder-plan.md for the decision list.
//
// A "plate" is a named, multi-recipe meal with meal-level servings, a per-dish cook and
// a "keep in library" flag; it can be scheduled to a day + slot OR sent to the grocery
// list.

/// One role group on the plate. `role` is free text server-side (decision 3) — these are
/// the three the builder scaffolds, in plate order.
struct PlateRole: Hashable, Identifiable, Sendable {
    let key: String
    let label: String
    /// The label on the group's trailing "＋". A dish already on the plate can also be
    /// **dragged** between roles; see `PlateReorder`.
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

    /// The dishes filed under one role, in plate order. Sides is the **catch-all**:
    /// roles are free text, so matching it strictly would leave a 'bread' or 'appetizer'
    /// dish rendered nowhere.
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

/// Dragging a dish from one role to another in the builder.
///
/// The builder renders its roles as ONE flat run because SwiftUI's `.onMove` only
/// reorders within a Section, and a `List` silently refuses `.dropDestination` (the row
/// lifts and nothing lands). The rule that reads the landing role lives here so it can
/// be tested without a running app.
enum PlateReorder {
    /// One row of the flat run, in render order. **This is the single definition of that
    /// order** — the view renders from it and the drop is resolved against it, so the
    /// two cannot drift.
    enum Slot: Equatable, Identifiable {
        case header(PlateRole)
        case dish(String, role: PlateRole)
        /// An empty role's drop target — see `showsEmptySlots`.
        case empty(PlateRole)
        case add(PlateRole)

        var id: String {
            switch self {
            case .header(let r): return "h:" + r.key
            case .dish(let id, _): return "d:" + id
            case .empty(let r): return "e:" + r.key
            case .add(let r): return "a:" + r.key
            }
        }
        /// Header and ＋ rows can't be dragged; dishes and the drop target can.
        var isMovable: Bool {
            if case .header = self { return false }
            if case .add = self { return false }
            return true
        }
    }

    static func slots(_ groups: [PlateGroup]) -> [Slot] {
        var out: [Slot] = []
        let draggable = showsEmptySlots(groups)
        for g in groups {
            out.append(.header(g.role))
            for d in g.dishes { out.append(.dish(d.recipeId, role: g.role)) }
            if g.dishes.isEmpty && draggable { out.append(.empty(g.role)) }
            out.append(.add(g.role))
        }
        return out
    }

    /// The same run as `ListReorder` sees it. Every row occupies an index, including
    /// undraggable ones.
    static func rows(_ groups: [PlateGroup]) -> [ListReorder.Row] {
        slots(groups).map { slot in
            switch slot {
            case .header(let r): return .header(r.key)
            case .dish(let id, let r): return .item(id: id, section: r.key)
            case .empty(let r): return .item(id: "empty:" + r.key, section: r.key)
            case .add(let r): return .item(id: "add:" + r.key, section: r.key)
            }
        }
    }

    /// Whether empty roles should show their "drag a dish here" slot at all. Only once
    /// the plate holds a dish somewhere — on a brand-new plate the slots would invite a
    /// drag with nothing anywhere to drag.
    static func showsEmptySlots(_ groups: [PlateGroup]) -> Bool {
        groups.contains { !$0.dishes.isEmpty }
    }

    /// What a drop should write: the dish that moved, the role it lands in, and the
    /// plate's whole new dish order. The order matters as much as the role: `sort_order`
    /// is plate-wide and the roles are rendered by sorting on it, so a dish that changes
    /// role keeping its old number lands wherever that number falls. Writing the full
    /// order is also what makes a reorder *within* a role mean anything.
    struct Move: Equatable {
        let id: String
        let role: PlateRole
        /// Every dish on the plate, in its new order — what `reorderDishes` writes.
        let order: [String]
    }

    /// nil when the drop should write nothing: a ＋ / placeholder row moved, or the dish
    /// ended up in the same role at the same position.
    static func move(_ groups: [PlateGroup], from: IndexSet, to: Int) -> Move? {
        let rows = rows(groups)
        guard let src = from.min(), src < rows.count,
              case let .item(movedId, oldSection) = rows[src],
              !isSynthetic(movedId)
        else { return nil }

        // Replay SwiftUI's move on a copy — same semantics ListReorder uses.
        var arr = rows
        let moving = from.sorted().map { rows[$0] }
        for i in from.sorted(by: >) { arr.remove(at: i) }
        let removedBefore = from.filter { $0 < to }.count
        arr.insert(contentsOf: moving, at: max(0, min(to - removedBefore, arr.count)))

        // Walk the result: each dish belongs to the nearest header above it.
        var section: String?
        var landedIn: String?
        var order: [String] = []
        for row in arr {
            switch row {
            case .header(let title): section = title
            case .item(let id, _):
                guard !isSynthetic(id) else { continue }
                order.append(id)
                if id == movedId { landedIn = section }
            }
        }
        guard let key = landedIn, let role = ordered.first(where: { $0.key == key }) else { return nil }
        if key == oldSection && order == groups.flatMap({ $0.dishes.map(\.recipeId) }) { return nil }
        return Move(id: movedId, role: role, order: order)
    }

    /// The header/＋/placeholder rows carry ids that aren't dishes.
    private static func isSynthetic(_ id: String) -> Bool {
        id.hasPrefix("add:") || id.hasPrefix("empty:")
    }

    private static var ordered: [PlateRole] { PlateRoles.ordered }
}

/// What a dish (or a whole plate) may honestly say about the pantry. `onHand` is nil
/// whenever the pantry module is off, and that means "we can't say" — not "you have
/// none". With the pantry off and nothing left to buy there is simply nothing to render:
/// a "0 of N" badge or a "✓ all on hand" tick would both be claims the server never
/// made.
enum OnHandClaim: Equatable, Sendable {
    case nothingToSay
    case allOnHand
    case toBuy(Int)

    static func of(onHand: WaffledAPI.OnHandCount?, toBuy: Int) -> OnHandClaim {
        if toBuy > 0 { return .toBuy(toBuy) }
        return onHand == nil ? .nothingToSay : .allOnHand
    }
}

/// The plate writes the builder needs, as closures so the model can be tested without a
/// server. `.live` wires them to `WaffledAPI`, which owns every endpoint and DTO.
struct MealBuilderAPI: Sendable {
    var fetch: @Sendable (_ id: String) async throws -> WaffledAPI.MealDTO
    var create: @Sendable (_ name: String, _ servings: Int) async throws -> WaffledAPI.MealDTO
    var update: @Sendable (_ id: String, _ name: String?, _ servings: Int?, _ isSaved: Bool?) async throws -> WaffledAPI.MealDTO
    var addDish: @Sendable (_ id: String, _ recipeId: String, _ role: String?) async throws -> WaffledAPI.MealDTO
    var flatten: @Sendable (_ id: String, _ savedMealId: String) async throws -> WaffledAPI.MealDTO
    var patchDish: @Sendable (_ id: String, _ recipeId: String, _ role: String?, _ cook: WaffledAPI.CookAssignment) async throws -> WaffledAPI.MealDTO
    var removeDish: @Sendable (_ id: String, _ recipeId: String) async throws -> WaffledAPI.MealDTO
    /// The plate's dishes in their new order — one write for the whole plate.
    var reorder: @Sendable (_ id: String, _ recipeIds: [String]) async throws -> WaffledAPI.MealDTO
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
            reorder: { try await api.reorderDishes(mealId: $0, recipeIds: $1) },
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
    /// its own commit — repainting from an older reply resurrects a removed dish and
    /// does not self-heal.
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
        // The role is always explicit: it is the group whose ＋ was tapped. Sending none
        // files everything under the server default, and a bare re-add can wipe an
        // existing dish's role/cook.
        await run { api, id in try await api.addDish(id, recipeId, role.key) }
    }

    /// A saved plate added here FLATTENS — its dishes arrive as individual editable rows
    /// keeping their own roles. Meals never nest (decision 12).
    func addSavedMeal(_ savedMealId: String) async {
        await run { api, id in try await api.flatten(id, savedMealId) }
    }

    func removeDish(_ recipeId: String) async {
        await run { api, id in try await api.removeDish(id, recipeId) }
    }

    /// Re-file a dish, from the row menu — no position was chosen, so only the role
    /// changes.
    func moveDish(_ recipeId: String, to role: PlateRole) async {
        await run { api, id in try await api.patchDish(id, recipeId, role.key, .unchanged) }
    }

    /// Apply a drop: the role AND the plate's new order. Two writes because the role
    /// lives on the dish and the order is plate-wide; the second answers with the plate,
    /// so it repaints from that.
    func apply(_ move: PlateReorder.Move) async {
        await run { api, id in
            _ = try await api.patchDish(id, move.id, move.role.key, .unchanged)
            return try await api.reorder(id, move.order)
        }
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
        // Nothing exists AND nothing is being created — the number rides along on the
        // lazy create when one eventually happens, so there's nothing to write yet. A
        // create already in flight is a different case and must be allowed through:
        // `ensureId` captured `servings` before the tap, so `run` has to wait on the
        // in-flight create and then PATCH.
        guard mealId != nil || createTask != nil else { return }
        await run(rollback: { [weak self] in self?.servings = previous }) { api, id in
            try await api.update(id, nil, n, nil)
        }
    }

    /// "Keep in library". Applied the moment it is flipped — a state, not a pending
    /// action.
    func toggleSaved() async {
        let next = !isSaved
        let previous = isSaved
        isSaved = next
        await run(rollback: { [weak self] in self?.isSaved = previous }) { api, id in
            try await api.update(id, nil, nil, next)
        }
    }

    /// The plate is about to fill a slot the caller already decided ("＋ New meal"). Get
    /// it into the library first, and report whether it is really usable.
    ///
    /// **BEING SAVED IS LOAD-BEARING, NOT COSMETIC.** `POST /api/meals/:id/schedule`
    /// COPIES a saved plate and schedules an unsaved one directly, so handing over an
    /// unsaved plate means editing it later silently rewrites the night it was planned
    /// on.
    ///
    /// **AND IT IS DONE HERE, NOT AT CREATE.** The plate stays one-off — invisible to a
    /// library that lists `where is_saved` — right up until somebody uses it, so a plate
    /// abandoned mid-build cannot leak and there is no delete to get wrong.
    @discardableResult
    func saveForUse() async -> Bool {
        // An EMPTY plate is not a meal. This is also why nothing is created here — a
        // plate with no dishes has never been POSTed and must not be.
        guard mealId != nil, !isEmpty else {
            message = "Add a dish first."
            return false
        }
        guard !isSaved else { return true }
        let previous = isSaved
        isSaved = true
        // A FAILED SAVE MUST REPORT FAILURE. Handing the plate over anyway would
        // schedule an unsaved one, losing the copy-on-schedule guarantee above.
        return await run(rollback: { [weak self] in self?.isSaved = previous }) { api, id in
            try await api.update(id, nil, nil, true)
        }
    }

    /// Commit the inline name edit. Creates the plate if this is the first thing that
    /// happened.
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
        // painted back the next time the (now-empty) field lost focus.
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

    /// Put the plate on a day + slot. Returns false if it couldn't. Deliberately does
    /// NOT repaint from the reply: scheduling a **saved** plate copies it, so the reply
    /// is next week's copy.
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
    /// optimistically — without it a rejected rename / toggle / servings change stays on
    /// screen until a reload.
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
            // Deliberately NOT gated on `mine == seq`: a write that failed still failed,
            // and staying quiet because something else went out afterwards is how a
            // silent failure happens.
            rollback?()
            message = Self.writeFailed
            ok = false
        }
        if mine == seq { busy = false }
        return ok
    }

    /// The plate's id, creating it on first use. One create, ever — a rename and an add
    /// racing each other share the same in-flight task rather than both POSTing.
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
