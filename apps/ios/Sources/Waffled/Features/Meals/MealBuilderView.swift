import SwiftUI

/// **Meal Builder** — compose a plate: a named, multi-recipe meal ("BBQ Sunday" =
/// BBQ Chicken (main) + Potato Salad + Coleslaw (sides) + Peach Cobbler (dessert)).
///
/// Dishes are grouped by role in a native `List` (so removing one is a plain
/// swipe), the name is edited inline, and a pinned ink bar carries the plate stats,
/// the "Keep in library" toggle and the two actions.
///
/// **Tap to add on BOTH iPhone and iPad** (decision 8) — each group ends in a
/// "＋ Add a side" that opens the recipe/meal picker. A dish already on the plate can
/// also be **dragged** between roles (press and hold); see `PlateReorder`.
///
/// The plate is created **lazily** (`MealBuilderModel`): opening this screen posts
/// nothing, and every mutation answers with the whole plate, so the screen repaints
/// from the response rather than refetching.
struct MealBuilderView: View {
    let start: MealBuilderStart
    /// The library the picker browses (owned by the Meals tab, or made here when the
    /// builder is presented modally from a recipe).
    let recipes: RecipesModel
    @Environment(\.dismiss) private var dismiss
    @Environment(SyncManager.self) private var sync
    @State private var model: MealBuilderModel
    @State private var adding: PlateRole?
    @State private var scheduling = false
    @State private var seeded = false
    @FocusState private var nameFocused: Bool

    init(start: MealBuilderStart, recipes: RecipesModel) {
        self.start = start
        self.recipes = recipes
        _model = State(initialValue: MealBuilderModel(existing: start.existingPlate))
    }

    var body: some View {
        List {
            nameSection
            // ONE flat run — a header row per role, then that role's dishes, then its ＋ —
            // rather than a Section per role. That's what lets a drag cross a header and
            // re-file a dish: SwiftUI's `.onMove` only reorders *within* a Section, and a
            // `List` silently refuses `.dropDestination` outright (the row lifts and
            // nothing lands). Built once per render and reused by the drop handler.
            Section {
                let rows = flatRows
                ForEach(rows) { row in
                    switch row {
                    case .header(let group):
                        roleHeaderRow(group).moveDisabled(true)
                    case .dish(let dish, _):
                        dishRow(dish)
                    case .empty(let role):
                        emptyDropRow(role)
                    case .add(let role):
                        addRow(role).moveDisabled(true)
                    }
                }
                .onMove { from, to in handleMove(rows: rows, from: from, to: to) }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(WF.canvas)
        .navigationTitle("Build a meal")
        .navigationBarTitleDisplayMode(.inline)
        // Always presented (never pushed): this screen is opened from the library,
        // from a recipe and from a plate's detail — three different navigation stacks.
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .safeAreaInset(edge: .bottom) { plateBar }
        .overlay(alignment: .top) { toast }
        .task { await seedIfNeeded() }
        .sheet(item: $adding) { role in
            AddDishSheet(role: role, recipes: recipes, excludeMealId: model.mealId) { picked in
                adding = nil
                Task {
                    switch picked {
                    case .recipe(let r): await model.addRecipe(r.id, role: role)
                    // A saved plate FLATTENS into this one — its dishes arrive as
                    // individual rows keeping their own roles (decision 12).
                    case .meal(let m): await model.addSavedMeal(m.id)
                    }
                }
            }
        }
        .sheet(isPresented: $scheduling) {
            RecipeScheduleSheet(title: model.displayName, recipeId: model.mealId ?? "",
                                eyebrow: "Schedule this meal",
                                perform: { date, mealType in
                                    guard await model.schedule(date: date, mealType: mealType) else {
                                        throw MealScheduleError.failed
                                    }
                                }) { label in
                model.message = "Scheduled for \(label)."
            }
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: name

    private var nameSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                // Committed on submit / focus loss, never per keystroke: a debounce
                // here would race the lazy create.
                TextField(MealBuilderModel.newName, text: $model.name)
                    .font(WF.serif(22, .bold)).foregroundStyle(WF.ink)
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit { Task { await model.commitRename() } }
                    .onChange(of: nameFocused) { _, focused in
                        if !focused { Task { await model.commitRename() } }
                    }
                Text("Tap the name to rename this meal.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            .listRowBackground(WF.card)
        }
    }

    // MARK: one role group

    /// One row of the flat run. The indices line up 1:1 with the `ListReorder.Row`
    /// array `handleMove` reasons over, so the two must stay built from the same source.
    private enum PlateDisplayRow: Identifiable {
        case header(PlateGroup)
        case dish(WaffledAPI.MealDishDTO, role: String)
        /// The drop slot an EMPTY role gets — see `flatRows`.
        case empty(PlateRole)
        case add(PlateRole)
        var id: String {
            switch self {
            case .header(let g): return "h:\(g.role.key)"
            case .dish(let d, _): return "d:\(d.recipeId)"
            case .empty(let r): return "e:\(r.key)"
            case .add(let r): return "a:\(r.key)"
            }
        }
    }

    /// Every role's header, dishes and ＋ in render order.
    ///
    /// An EMPTY role also gets a placeholder row, and that row is what makes it a
    /// possible destination: the header and the ＋ are both `moveDisabled`, and a run of
    /// non-movable rows offers SwiftUI nowhere to drop — so an empty role silently
    /// refused every drag until something was already in it. The placeholder is movable
    /// (dragging it does nothing; `PlateReorder` ignores it as a source).
    private var flatRows: [PlateDisplayRow] {
        var out: [PlateDisplayRow] = []
        // Suppressed entirely while the plate is empty — see `PlateReorder.showsEmptySlots`.
        let slots = PlateReorder.showsEmptySlots(model.groups)
        for group in model.groups {
            out.append(.header(group))
            for dish in group.dishes { out.append(.dish(dish, role: group.role.key)) }
            if group.dishes.isEmpty && slots { out.append(.empty(group.role)) }
            out.append(.add(group.role))
        }
        return out
    }

    /// Re-file the dragged dish under whichever role header it landed beneath. The rule
    /// (and the flat run's exact ordering) lives in `PlateReorder`, where it is tested.
    private func handleMove(rows _: [PlateDisplayRow], from: IndexSet, to: Int) {
        guard let move = PlateReorder.move(model.groups, from: from, to: to) else { return }
        Task { await model.apply(move) }
    }

    @ViewBuilder private func roleHeaderRow(_ group: PlateGroup) -> some View {
        HStack(spacing: 6) {
            SectionLabel(text: group.role.label)
            if !group.dishes.isEmpty {
                Text("\(group.dishes.count)")
                    .font(.system(size: 11, weight: .heavy)).foregroundStyle(WF.ink3)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(WF.panel).clipShape(Capsule())
            }
            Spacer()
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private func dishRow(_ dish: WaffledAPI.MealDishDTO) -> some View {
        PlateDishRow(dish: dish, members: sync.members,
                     onAssignCook: { id in Task { await model.assignCook(dish.recipeId, personId: id) } },
                     onMove: { role in Task { await model.moveDish(dish.recipeId, to: role) } })
            .listRowBackground(WF.card)
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await model.removeDish(dish.recipeId) }
                } label: { Label("Remove", systemImage: "trash") }
            }
    }

    /// An empty role's drop slot — deliberately movable so SwiftUI treats this position
    /// as a valid destination. Dragging it re-files nothing.
    private func emptyDropRow(_ role: PlateRole) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "tray").font(.system(size: 14))
                .foregroundStyle(WF.ink3)
            Text("Drag a dish here")
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
            Spacer()
        }
        .listRowBackground(WF.card)
    }

    /// The trailing ＋ carries THIS group's role. Sending no role files everything under
    /// the server default — the "I can't add a main" bug.
    private func addRow(_ role: PlateRole) -> some View {
        Button { adding = role } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle.fill").font(.system(size: 17))
                    .foregroundStyle(WF.primary)
                Text(role.addLabel)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink2)
                Spacer()
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(WF.card2)
    }

    // MARK: the pinned plate bar

    /// The stats + actions bar. `WF.ink` is the repo's inverted-fill idiom and flips
    /// in both themes — which is exactly why every label on it is `WF.onInk` and never
    /// a literal `.white` (ink becomes a warm off-white in dark mode).
    private var plateBar: some View {
        VStack(spacing: 12) {
            HStack(spacing: 16) {
                servesStepper
                Spacer(minLength: 0)
                stat("Hands-on", "≈ \(MealBuilderModel.hoursMinutes(model.totalMinutes))")
                stat("Groceries", "\(model.toBuy) to buy")
            }
            HStack(spacing: 10) {
                // Disabled on a blank plate, like both bar buttons: flipping it there
                // triggers the lazy create and leaves a dishless "New meal" card in the
                // library forever, which is nobody's intent.
                Toggle("", isOn: Binding(get: { model.isSaved },
                                         set: { _ in Task { await model.toggleSaved() } }))
                    .labelsHidden().tint(WF.primary)
                    .disabled(model.isEmpty)
                    .opacity(model.isEmpty ? 0.5 : 1)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Keep in library")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.onInk)
                    // It applies the moment it's flipped — a state, not a pending
                    // action waiting on Schedule or Add-to-list.
                    Text(model.isSaved ? "Saved — it’s in your library" : "One-off — not saved")
                        .font(.system(size: 11)).foregroundStyle(WF.onInk.opacity(0.6))
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                barButton("Add plate to list", filled: false) { Task { await model.addToGrocery() } }
                barButton("Schedule", filled: true) { scheduling = true }
            }
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
        .background(WF.ink)
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .heavy)).tracking(0.4)
                .foregroundStyle(WF.onInk.opacity(0.55))
            Text(value).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.onInk)
        }
    }

    /// Hand-rolled rather than a `Stepper`: the native control renders its own gray
    /// chrome, which reads as a disabled system widget dropped onto the ink bar.
    private var servesStepper: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("SERVES")
                .font(.system(size: 10, weight: .heavy)).tracking(0.4)
                .foregroundStyle(WF.onInk.opacity(0.55))
            HStack(spacing: 10) {
                stepButton("minus") { Task { await model.changeServings(model.servings - 1) } }
                Text("\(model.servings)")
                    .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.onInk)
                    .frame(minWidth: 20)
                stepButton("plus") { Task { await model.changeServings(model.servings + 1) } }
            }
        }
    }

    private func stepButton(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 12, weight: .bold))
                .foregroundStyle(WF.onInk)
                .frame(width: 26, height: 26)
                .background(WF.onInk.opacity(0.14)).clipShape(Circle())
        }
        .buttonStyle(.plain)
    }

    private func barButton(_ label: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 15, weight: .bold))
                // Coral stays saturated in both themes, so .white is correct on it;
                // the ghost button sits on ink and must use WF.onInk.
                .foregroundStyle(filled ? .white : WF.onInk)
                .frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(filled ? WF.primary : WF.onInk.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(model.isEmpty || model.busy)
        .opacity(model.isEmpty ? 0.5 : 1)
    }

    @ViewBuilder private var toast: some View {
        if let text = model.message {
            Text(text)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.onInk)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(WF.ink).clipShape(Capsule())
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: text) {
                    try? await Task.sleep(for: .seconds(4))
                    withAnimation { model.message = nil }
                }
        }
    }

    // MARK: seeding

    /// "Build a meal around this" opens here with the recipe already chosen as the
    /// main. Adding it is what triggers the lazy create, so there is still exactly one
    /// path that creates a plate.
    private func seedIfNeeded() async {
        guard !seeded else { return }
        seeded = true
        switch start {
        case .fresh, .editing: break
        case .around(let recipe): await model.addRecipe(recipe.id, role: PlateRoles.main)
        }
        // A brand-new plate opens with the keyboard up on its name: naming it is the
        // first thing you do, and the placeholder is only an invitation. An existing
        // plate already has a name, so stealing focus there would just be in the way.
        if start.existingPlate == nil { nameFocused = true }
    }
}

enum MealScheduleError: Error { case failed }

/// How the builder opened.
enum MealBuilderStart: Hashable, Identifiable {
    /// A blank plate (the library's "New meal").
    case fresh
    /// Seeded with one recipe as the main ("Build a meal around this").
    case around(WaffledAPI.RecipeSummary)
    /// Editing a plate that already exists.
    case editing(WaffledAPI.MealDTO)

    var id: String {
        switch self {
        case .fresh: return "fresh"
        case .around(let r): return "around:\(r.id)"
        case .editing(let m): return "editing:\(m.id)"
        }
    }

    var existingPlate: WaffledAPI.MealDTO? {
        if case .editing(let m) = self { return m }
        return nil
    }
}

// MARK: - one dish on the plate

/// A plate row: the dish, its time + shopping claim, and its own cook.
///
/// A four-dish plate has up to four cooks, which is why the picker hangs off the row
/// and not off the plate.
struct PlateDishRow: View {
    let dish: WaffledAPI.MealDishDTO
    let members: [SyncedMember]
    var onAssignCook: ((String?) -> Void)? = nil
    var onMove: ((PlateRole) -> Void)? = nil
    /// Cook this one dish (the meal detail wires it; the builder doesn't).
    var onCook: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 11) {
            // CachedImage, never AsyncImage: these rows are recycled on every scroll.
            CachedImage(dish.imageUrl, contentMode: .fill) {
                RecipeGradient.forCategory(dish.category)
                    .overlay(Text(dish.emoji ?? RecipeGradient.emoji(dish.category)).font(.system(size: 20)))
            }
            .frame(width: 46, height: 46).clipped()
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(dish.displayTitle)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(2)
                HStack(spacing: 8) {
                    if let t = dish.totalMinutes, t > 0 { PlanTag(text: "🕐 \(t)m") }
                    onHandTag
                }
                cookControl
            }
            Spacer(minLength: 0)
            if let onCook {
                Button(action: onCook) {
                    HStack(spacing: 4) {
                        Image(systemName: "flame.fill").font(.system(size: 11, weight: .bold))
                        Text("Cook").font(.system(size: 12, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .background(WF.primary).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            if let onMove {
                Menu {
                    ForEach(PlateRoles.ordered) { role in
                        Button { onMove(role) } label: { Label("Move to \(role.label)", systemImage: "arrow.right") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.system(size: 16)).foregroundStyle(WF.ink3)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// `onHand == nil` means the pantry module is off — "we can't say". Render nothing
    /// at all rather than a "0 of N" badge, which claims something untrue.
    @ViewBuilder private var onHandTag: some View {
        switch OnHandClaim.of(onHand: dish.onHand, toBuy: dish.toBuy) {
        case .nothingToSay: EmptyView()
        case .allOnHand:
            Text("✓ all on hand")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.success)
        case .toBuy(let n):
            Text("\(n) to buy")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(WF.panel).clipShape(Capsule())
        }
    }

    @ViewBuilder private var cookControl: some View {
        if let onAssignCook {
            Menu {
                ForEach(members) { m in
                    Button { onAssignCook(m.id) } label: { Text("\(m.emoji ?? "🙂")  \(m.name)") }
                }
                // "Nobody" must CLEAR the cook — the server tells an absent
                // cookPersonId (leave it alone) apart from an explicit null.
                Button(role: .destructive) { onAssignCook(nil) } label: { Text("Nobody") }
            } label: {
                cookChip
            }
        } else if dish.cook?.name != nil {
            cookChip
        }
    }

    private var cookChip: some View {
        HStack(spacing: 5) {
            if let cook = dish.cook, let name = cook.name {
                Avatar(colorHex: cook.colorHex, emoji: cook.avatarEmoji ?? "🙂", size: 18)
                Text(name).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink2)
            } else {
                Image(systemName: "person.badge.plus").font(.system(size: 11, weight: .bold))
                    .foregroundStyle(WF.ink3)
                Text("Add cook").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(WF.panel).clipShape(Capsule())
    }
}

// MARK: - the add-a-dish picker

/// What the picker handed back.
enum PickedDish {
    case recipe(WaffledAPI.RecipeSummary)
    case meal(WaffledAPI.MealDTO)
}

/// "＋ Add a side" → the existing recipe/meal library in pick mode. Reuses
/// `RecipesLibraryView` wholesale so search, filters and the type filter behave
/// exactly as they do when browsing.
struct AddDishSheet: View {
    let role: PlateRole
    let recipes: RecipesModel
    /// The plate being built — kept out of its own picker.
    var excludeMealId: String?
    let onPick: (PickedDish) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            RecipesLibraryView(model: recipes,
                               onPick: { onPick(.recipe($0)); dismiss() },
                               onPickMeal: { onPick(.meal($0)); dismiss() },
                               excludeMealId: excludeMealId)
                .navigationTitle(role.addLabel)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
