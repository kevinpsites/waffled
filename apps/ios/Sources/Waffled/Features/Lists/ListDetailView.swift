import SwiftUI
import Observation

/// Grocery board view modes.
enum GroceryViewMode: Hashable { case aisle, meal }

/// A run of items under one meal in "By meal" mode (`meal == nil` is the trailing
/// "Staples & extras" group).
struct MealGroup: Identifiable {
    let meal: WaffledAPI.GroceryBoardDTO.Meal?
    let items: [WaffledAPI.ListItemDTO]
    var id: String { meal?.id ?? "__extras__" }
}

/// One list's items — works for any list (Grocery included). Tapping the circle
/// toggles done; tapping the row edits it inline (name + a quantity field on the
/// right). Swipe to delete. Items group by section (aisle for grocery). A checked
/// item lingers in place for a moment, then drops into a collapsed "Completed"
/// section. Online-only (lists aren't a synced table).
@MainActor
@Observable
final class ListDetailModel {
    let list: WaffledAPI.ListSummary
    private(set) var items: [WaffledAPI.ListItemDTO] = []
    /// Checked items still shown in place (before they settle into Completed).
    private(set) var settling: Set<String> = []
    private(set) var loading = true
    private(set) var error = false

    /// This week's meals (grocery board only) — drive the meal grouping + dots.
    private(set) var meals: [WaffledAPI.GroceryBoardDTO.Meal] = []
    /// Pantry staples (assumed in-house, left off the list) — tap to add anyway.
    private(set) var staples: [WaffledAPI.GroceryBoardDTO.Staple] = []
    /// The week the board covers (YYYY-MM-DD) — passed to rebuild.
    private(set) var weekStart = ""
    /// True while a rebuild-from-meals is in flight (drives the Refresh spinner).
    private(set) var rebuilding = false

    private let api = WaffledAPI()
    /// Grocery gets the richer board (aisle/meal toggle + meal dots).
    var isGrocery: Bool { list.listType.lowercased() == "grocery" }

    init(list: WaffledAPI.ListSummary) { self.list = list }

    /// Canonical grocery aisles in shopping order (mirrors the server's aisles.ts).
    static let groceryAisles = ["Produce", "Pantry", "Dairy & Chilled", "Meat & Seafood", "Bakery", "Frozen", "Other"]

    /// Free-text filter applied to both active and completed items. Empty = show all.
    var searchQuery = ""

    /// True if the item matches the current search (name / section / quantity).
    private func matches(_ item: WaffledAPI.ListItemDTO) -> Bool {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return true }
        if item.name.lowercased().contains(q) { return true }
        if let s = item.section, s.lowercased().contains(q) { return true }
        if let qt = item.quantity, qt.lowercased().contains(q) { return true }
        return false
    }

    /// Active items: unchecked, plus just-checked ones that haven't settled yet.
    private var activeItems: [WaffledAPI.ListItemDTO] {
        items.filter { (!$0.checked || settling.contains($0.id)) && matches($0) }
    }

    /// "By aisle" grouping (also used for non-grocery lists).
    var activeSections: [ListSectionGroup] {
        ListGrouping.sections(activeItems, preferredOrder: isGrocery ? Self.groceryAisles : [])
    }

    /// "By meal" grouping: each active item under its first matching dinner (by
    /// date), with a trailing "Staples & extras" group for anything meal-less.
    func mealSections() -> [MealGroup] {
        MealGrouping.sections(items: activeItems, meals: meals)
    }

    /// One meal-color dot per *distinct recipe* the item belongs to (a recipe planned
    /// in two slots is the same dot, not two).
    func dotColors(for item: WaffledAPI.ListItemDTO) -> [String] {
        var seen = Set<String>()
        var colors: [String] = []
        for rid in (item.sourceRecipeIds ?? []) where seen.insert(rid).inserted {
            if let m = meals.first(where: { $0.recipeId == rid }) { colors.append(m.color) }
        }
        return colors
    }

    /// Settled, checked items — shown in the collapsed Completed section.
    var completed: [WaffledAPI.ListItemDTO] { items.filter { $0.checked && !settling.contains($0.id) && matches($0) } }

    func load() async {
        loading = true
        settling = []
        do {
            if isGrocery {
                let board = try await api.groceryBoard()
                meals = board.meals
                staples = board.staples
                weekStart = board.weekStart
                items = board.items.map { var i = $0; if i.section == nil { i.section = i.aisle }; return i }
            } else {
                items = try await api.listItems(listId: list.id)
            }
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }

    func add(name rawName: String, quantity rawQty: String, section rawSection: String? = nil) async {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        let section = rawSection?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sec = (section?.isEmpty == false) ? section : nil
        do {
            if isGrocery {
                try await api.addGroceryItem(name: name, quantity: qty.isEmpty ? nil : qty, section: sec)
            } else {
                try await api.addListItem(listId: list.id, name: name, quantity: qty.isEmpty ? nil : qty, section: sec)
            }
            await load()
        } catch {
            self.error = true
        }
    }

    /// Optimistic toggle. Checking keeps the row in place briefly (settling), then
    /// it animates down into Completed; unchecking returns it to its section now.
    func toggle(_ id: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let target = !items[idx].checked
        withAnimation { items[idx].checked = target }
        if target {
            settling.insert(id)
            scheduleSettle(id)
        } else {
            settling.remove(id)
        }
        do {
            try await api.patchListItem(id: id, checked: target)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) {
                withAnimation { items[i].checked = !target }
            }
            settling.remove(id)
        }
    }

    private func scheduleSettle(_ id: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            // Only settle if it's still checked (the user may have toggled it back).
            if self.items.first(where: { $0.id == id })?.checked == true {
                withAnimation { _ = self.settling.remove(id) }
            }
        }
    }

    /// Optimistic inline edit; revert on failure.
    func edit(_ id: String, name rawName: String, quantity rawQty: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        let prev = items[idx]
        guard name != prev.name || qty != (prev.quantity ?? "") else { return }
        items[idx].name = name
        items[idx].quantity = qty.isEmpty ? nil : qty
        do {
            try await api.patchListItem(id: id, name: name, quantity: qty)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i] = prev }
        }
    }

    /// Optimistic full-detail edit (name / quantity / assignee / section); revert on
    /// failure. `member` is the chosen assignee (nil = unassigned).
    func editDetails(_ id: String, name rawName: String, quantity rawQty: String,
                     member: SyncedMember?, section rawSection: String) async {
        guard let idx = items.firstIndex(where: { $0.id == id }) else { return }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        let section = rawSection.trimmingCharacters(in: .whitespacesAndNewlines)
        let prev = items[idx]
        items[idx].name = name
        items[idx].quantity = qty.isEmpty ? nil : qty
        items[idx].section = section.isEmpty ? nil : section
        items[idx].assignee = member.map { .init(name: $0.name, avatarEmoji: $0.emoji, colorHex: $0.colorHex) }
        do {
            try await api.updateItemDetails(id: id, name: name, quantity: qty, assignedTo: member?.id, section: section)
        } catch {
            if let i = items.firstIndex(where: { $0.id == id }) { items[i] = prev }
        }
    }

    /// Add a pantry staple to the list anyway (it's normally assumed in-house).
    /// Returns the aisle/section it landed in (for the confirmation toast), or nil.
    @discardableResult
    func addStaple(_ name: String) async -> String? {
        do {
            try await api.addGroceryItem(name: name, quantity: nil)
            await load()
            return items.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.section
        } catch { self.error = true; return nil }
    }

    /// Reload just the staples master list (after editing them in the sheet).
    func reloadStaples() async {
        staples = (try? await api.pantryStaples()) ?? staples
    }

    /// Rebuild the auto items from this week's planned meals (keeps hand-added and
    /// checked items). Reuses the returned board so it's a single round-trip.
    func rebuild() async {
        guard !weekStart.isEmpty else { return }
        rebuilding = true
        defer { rebuilding = false }
        do {
            let board = try await api.rebuildGrocery(weekStart: weekStart)
            meals = board.meals
            staples = board.staples
            weekStart = board.weekStart
            settling = []
            withAnimation {
                items = board.items.map { var i = $0; if i.section == nil { i.section = i.aisle }; return i }
            }
        } catch { self.error = true }
    }

    /// Optimistic removal; restore on failure.
    func remove(_ id: String) async {
        let snapshot = items
        withAnimation { items.removeAll { $0.id == id } }
        do {
            try await api.deleteListItem(id: id)
        } catch {
            items = snapshot
        }
    }

    /// Snapshot this list as a reusable template (unchecked copies of its live items).
    /// Returns true on success so the view can show a brief confirmation.
    func saveAsTemplate() async -> Bool {
        do {
            _ = try await api.saveListAsTemplate(listId: list.id)
            return true
        } catch {
            self.error = true
            return false
        }
    }

    /// Soft-delete the whole list. Returns true so the view can pop back + refresh.
    func deleteList() async -> Bool {
        do { try await api.deleteList(id: list.id); return true }
        catch { self.error = true; return false }
    }
}

struct ListDetailView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    @State private var model: ListDetailModel
    @State private var confirmingDelete = false
    @State private var draftName = ""
    @State private var draftQty = ""
    /// Target section for the next added item (nil = auto-classify / no section).
    @State private var draftSection: String?
    @State private var query = ""
    @State private var newSectionPrompt = false
    @State private var newSectionName = ""
    @State private var editingId: String?
    @State private var editName = ""
    @State private var editQty = ""
    @State private var showCompleted = false
    @State private var detailItem: WaffledAPI.ListItemDTO?
    @State private var didAutoDetails = false
    @State private var mode: GroceryViewMode = .aisle
    @State private var railMeal = "dinner"
    /// Section ids (aisle title or meal-group id) the user has collapsed.
    @State private var collapsed: Set<String> = []
    /// Transient confirmation banner ("Added Butter to Pantry").
    @State private var toast: String?
    @State private var toastTask: Task<Void, Never>?
    @State private var editingStaples = false
    @FocusState private var focus: Field?

    /// Meal-type ordering for the summary filter (matches the web rail).
    private static let mealTypeOrder = ["breakfast", "lunch", "dinner", "snack"]
    private static let mealTypeLabel = ["breakfast": "Breakfast", "lunch": "Lunch", "dinner": "Dinner", "snack": "Snack"]
    private static let mealTypeEmoji = ["breakfast": "🍳", "lunch": "🥪", "dinner": "🍽️", "snack": "🍎"]

    private enum Field: Hashable { case add, editName, editQty, search }

    /// True once the search box has text (focus alone doesn't count — hiding chrome
    /// the instant the field is tapped is jarring). Used to hide non-item chrome
    /// (meals recap, pantry staples) so matching results stand out.
    private var searchActive: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Jump to the Meals tab and open a recipe — tapping a meal in the recap.
    var openRecipe: (WaffledAPI.RecipeSummary) -> Void = { _ in }

    init(list: WaffledAPI.ListSummary, openRecipe: @escaping (WaffledAPI.RecipeSummary) -> Void = { _ in }) {
        _model = State(initialValue: ListDetailModel(list: list))
        self.openRecipe = openRecipe
    }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        Group {
            if isKiosk { kioskBody } else { phoneBody }
        }
        .background(WF.canvas)
        .navigationTitle(model.list.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Non-grocery lists can be snapshotted as a reusable template (mirrors the
            // web "Save as template" header action). Grocery is auto-built, so skip it.
            if !model.isGrocery {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            Task {
                                if await model.saveAsTemplate() {
                                    showToast("Saved “\(model.list.name)” as a template")
                                }
                            }
                        } label: { Label("Save as template", systemImage: "doc.on.doc") }
                        Button(role: .destructive) { confirmingDelete = true } label: {
                            Label("Delete list", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .task {
            await model.load()
            if DemoHooks.groceryMode == "meal" { mode = .meal }
            if DemoHooks.openDetails, !didAutoDetails, let first = model.items.first {
                didAutoDetails = true
                detailItem = first
            }
        }
        .refreshable { await model.load() }
        .onChange(of: sync.groceryRev) { _, _ in if model.isGrocery { Task { await model.load() } } }
        .onChange(of: sync.listsRev) { _, _ in if !model.isGrocery { Task { await model.load() } } }
        .onChange(of: focus) { _, new in
            // Tapping away from an inline edit commits it.
            if editingId != nil, new != .editName, new != .editQty { commitEdit() }
        }
        .onChange(of: query) { _, q in model.searchQuery = q }
        .sheet(item: $detailItem) { item in
            ItemDetailEditor(item: item, members: sync.members, suggestions: sectionSuggestions) { name, qty, member, section in
                Task { await model.editDetails(item.id, name: name, quantity: qty, member: member, section: section) }
            }
        }
        .confirmationDialog("Delete “\(model.list.name)”?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete list", role: .destructive) {
                Task { if await model.deleteList() { sync.bumpLists(); dismiss() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This deletes the list and its items. This can’t be undone.")
        }
        .sheet(isPresented: $editingStaples) {
            PantryStaplesEditor(initial: model.staples) { Task { await model.reloadStaples() } }
        }
        .overlay(alignment: .bottom) { toastBanner }
        .alert("New section", isPresented: $newSectionPrompt) {
            TextField("Section name", text: $newSectionName)
            Button("Cancel", role: .cancel) { newSectionName = "" }
            Button("Use") {
                let s = newSectionName.trimmingCharacters(in: .whitespacesAndNewlines)
                if !s.isEmpty { draftSection = s }
                newSectionName = ""
            }
        } message: { Text("New items will be added to this section.") }
    }

    /// iPhone: items with the meals recap + staples inline in the list.
    private var phoneBody: some View {
        List {
            if model.isGrocery && !model.meals.isEmpty && !searchActive {
                summaryPanel
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            itemRows
            if model.isGrocery && !model.staples.isEmpty && !searchActive {
                staplesPanel
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 24, trailing: 16))
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top, spacing: 0) { topControls }
        .safeAreaInset(edge: .bottom, spacing: 0) { addBar }
    }

    /// iPad: items as the main column + a side panel with this-week's-meals + pantry
    /// staples (the web grocery layout). The side panel shows only for grocery.
    private var kioskBody: some View {
        HStack(spacing: 0) {
            List { itemRows }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .safeAreaInset(edge: .top, spacing: 0) { topControls }
                .safeAreaInset(edge: .bottom, spacing: 0) { addBar }
                .frame(maxWidth: .infinity)
            if model.isGrocery && !searchActive && (!model.meals.isEmpty || !model.staples.isEmpty) {
                Rectangle().fill(WF.hair).frame(width: 1)
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 16) {
                        if !model.meals.isEmpty { summaryPanel }
                        if !model.staples.isEmpty { staplesPanel }
                    }
                    .padding(16)
                }
                .frame(width: 340)
                .background(WF.panel.opacity(0.3))
            }
        }
    }

    /// The list's item sections + completed group — shared by both layouts.
    @ViewBuilder private var itemRows: some View {
        if model.items.isEmpty && !model.loading {
            Text(model.error ? "Couldn’t load this list." : "Nothing here yet.")
                .font(.system(size: 14)).foregroundStyle(WF.ink3)
                .listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
        if model.isGrocery && mode == .meal {
            ForEach(model.mealSections()) { group in
                Section {
                    if !collapsed.contains(group.id) {
                        ForEach(group.items) { item in itemRow(item) }
                    }
                } header: { mealHeader(group) }
            }
        } else {
            ForEach(model.activeSections) { group in
                Section {
                    if !collapsed.contains(group.id) {
                        ForEach(group.items) { item in itemRow(item) }
                    }
                } header: { sectionHeader(group) }
            }
        }
        completedSection
    }

    /// Whether to show the search field — only worth the space once a list is long.
    private var showSearch: Bool { model.items.count > 6 }

    /// Pinned controls below the nav bar: a search field (long lists) above the
    /// grocery aisle/meal toggle.
    @ViewBuilder private var topControls: some View {
        VStack(spacing: 0) {
            if showSearch { searchField }
            if model.isGrocery { modeToggle }
        }
        .background(WF.canvas)
    }

    /// Inline search box — filters items by name, section, or quantity.
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
            TextField("Search this list…", text: $query)
                .font(.system(size: 15, weight: .medium))
                .focused($focus, equals: .search)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15)).foregroundStyle(WF.ink3)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 13).padding(.vertical, 9)
        .background(WF.panel)
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, model.isGrocery ? 2 : 8)
    }

    /// Section chips offered in the editor: the grocery aisle taxonomy (for grocery
    /// lists) plus any sections already in use on this list, deduped.
    private var sectionSuggestions: [String] {
        var result = model.list.listType.lowercased() == "grocery" ? ListDetailModel.groceryAisles : []
        for s in model.items.compactMap(\.section) where !s.isEmpty && !result.contains(s) {
            result.append(s)
        }
        return result
    }

    /// A row plus its swipe actions (Delete + Details), shared by the active and
    /// completed sections.
    @ViewBuilder private func itemRow(_ item: WaffledAPI.ListItemDTO) -> some View {
        row(item)
            .listRowBackground(Color.clear)
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await model.remove(item.id) }
                } label: { Label("Delete", systemImage: "trash") }
                Button {
                    if editingId != nil { commitEdit() }
                    detailItem = item
                } label: { Label("Details", systemImage: "slider.horizontal.3") }
                    .tint(WF.ai)
            }
    }

    @ViewBuilder private func sectionHeader(_ group: ListSectionGroup) -> some View {
        if let title = group.title {
            headerChrome {
                collapseButton(id: group.id) {
                    chevron(for: group.id)
                    Text(title.uppercased())
                        .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                        .foregroundStyle(WF.ink3)
                    Spacer(minLength: 6)
                    Text("\(group.items.count)")
                        .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                }
            }
        }
    }

    /// Shared section-header chrome: an opaque tan (canvas) strip spanning the full
    /// width so that, while the header is pinned during scroll, row text doesn't
    /// bleed through behind it.
    private func headerChrome<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)
            .background(WF.canvas)
            .listRowInsets(EdgeInsets())
    }

    /// A header laid out as a tap target that collapses/expands its section.
    private func collapseButton<V: View>(id: String, @ViewBuilder _ content: () -> V) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
            }
        } label: {
            HStack(spacing: 6) { content() }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Disclosure chevron — points right when the section is collapsed, down when open.
    private func chevron(for id: String) -> some View {
        DisclosureChevron(isOpen: !collapsed.contains(id), size: 10)
    }

    /// Grocery-only By aisle / By meal segmented control, pinned below the nav bar.
    @ViewBuilder private var modeToggle: some View {
        if model.isGrocery {
            Picker("View", selection: $mode) {
                Text("By aisle").tag(GroceryViewMode.aisle)
                Text("By meal").tag(GroceryViewMode.meal)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
            .background(WF.canvas)
        }
    }

    /// "By meal" section header — a meal-type tag (tinted with the meal's color, so
    /// it doubles as the legend for the item dots) + the meal name + item count.
    @ViewBuilder private func mealHeader(_ group: MealGroup) -> some View {
        headerChrome {
            collapseButton(id: group.id) {
                chevron(for: group.id)
                if let meal = group.meal {
                    let color = Color(hexString: meal.color) ?? WF.ink3
                    if let type = meal.mealType, !type.isEmpty {
                        Text(type.uppercased())
                            .font(.system(size: 9.5, weight: .heavy)).tracking(0.4)
                            .foregroundStyle(color)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(color.opacity(0.15))
                            .clipShape(Capsule())
                    }
                    Text((meal.title ?? "Meal").uppercased())
                        .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                        .foregroundStyle(WF.ink3)
                        .lineLimit(1)
                } else {
                    Text("STAPLES & EXTRAS")
                        .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                        .foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 6)
                Text("\(group.items.count)")
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            }
        }
    }

    /// Colored dots showing which dinners need this item (grocery board).
    @ViewBuilder private func mealDots(for item: WaffledAPI.ListItemDTO) -> some View {
        let colors = model.dotColors(for: item)
        if !colors.isEmpty {
            HStack(spacing: 3) {
                ForEach(Array(colors.prefix(4).enumerated()), id: \.offset) { _, hex in
                    Circle().fill(Color(hexString: hex) ?? WF.ink3).frame(width: 7, height: 7)
                }
            }
        }
    }

    // MARK: This week's meals (summary + legend)

    /// Meal types actually planned this week, in breakfast→snack order.
    private var availableMealTypes: [String] {
        Self.mealTypeOrder.filter { t in model.meals.contains { $0.mealType == t } }
    }
    /// The selected meal type, falling back to the first available.
    private var effectiveRailMeal: String {
        availableMealTypes.contains(railMeal) ? railMeal : (availableMealTypes.first ?? "dinner")
    }
    /// This week's meals of the selected type, deduped by recipe, earliest first.
    private var railMeals: [WaffledAPI.GroceryBoardDTO.Meal] {
        var seen = Set<String>()
        return model.meals
            .filter { $0.mealType == effectiveRailMeal }
            .sorted { $0.date < $1.date }
            .filter { seen.insert($0.recipeId ?? $0.id).inserted }
    }

    /// "This week's meals" recap — a meal-type filter, the meals of that type (each a
    /// colored pill that doubles as the legend for the item dots), and a Refresh that
    /// rebuilds the auto items from the plan.
    @ViewBuilder private var summaryPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("THIS WEEK’S MEALS")
                    .font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                Spacer()
                Button { Task { await model.rebuild() } } label: {
                    HStack(spacing: 5) {
                        if model.rebuilding {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 11, weight: .bold))
                        }
                        Text(model.rebuilding ? "Refreshing…" : "Refresh").font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(WF.ai)
                }
                .buttonStyle(.plain).disabled(model.rebuilding)
            }

            if availableMealTypes.count > 1 {
                Picker("Meal", selection: $railMeal) {
                    ForEach(availableMealTypes, id: \.self) { t in
                        Text(Self.mealTypeLabel[t] ?? t.capitalized).tag(t)
                    }
                }
                .pickerStyle(.segmented)
            }

            VStack(spacing: 8) {
                ForEach(railMeals) { meal in mealRecapRow(meal) }
            }
        }
        .padding(14)
        .wfField()
    }

    @ViewBuilder private func mealRecapRow(_ meal: WaffledAPI.GroceryBoardDTO.Meal) -> some View {
        let color = Color(hexString: meal.color) ?? WF.ink3
        let row = HStack(spacing: 10) {
            Circle().fill(color).frame(width: 9, height: 9)
            Text(weekday(meal.date))
                .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                .frame(width: 34, alignment: .leading)
            Text(meal.title ?? "—")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                .lineLimit(1)
            Spacer(minLength: 6)
            // A chevron hints the row drills into the recipe (only when it links one).
            if meal.recipeId != nil {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            }
            Text(meal.emoji ?? Self.mealTypeEmoji[meal.mealType ?? ""] ?? "🍽️")
                .font(.system(size: 14))
                .frame(width: 28, height: 28)
                .background(color.opacity(0.12)).clipShape(Circle())
        }
        if let rid = meal.recipeId {
            Button { openRecipe(recipeSummary(for: meal, recipeId: rid)) } label: { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }

    /// A lightweight summary the Meals detail screen can open (it reloads the full
    /// recipe on appear), built from the recap row's known fields.
    private func recipeSummary(for meal: WaffledAPI.GroceryBoardDTO.Meal, recipeId: String) -> WaffledAPI.RecipeSummary {
        .placeholder(id: recipeId, title: meal.title ?? "Recipe", emoji: meal.emoji,
                     category: meal.mealType, cookTimeMinutes: nil, servings: nil)
    }

    /// "Sun"/"Mon"… from a YYYY-MM-DD(THH…) date string.
    private func weekday(_ iso: String) -> String {
        guard let d = DateFmt.date(String(iso.prefix(10)), "yyyy-MM-dd", DateFmt.utc) else { return "" }
        return DateFmt.string(d, "EEE", DateFmt.utc)
    }

    // MARK: Pantry check (staples)

    /// "Pantry check" — staples assumed in-house (left off the list); tap a chip to
    /// add one anyway. Mirrors the web rail's staples card.
    @ViewBuilder private var staplesPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("PANTRY CHECK")
                    .font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
                Spacer()
                Button { editingStaples = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "gearshape").font(.system(size: 11, weight: .bold))
                        Text("Edit staples").font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(WF.ai)
                }
                .buttonStyle(.plain)
            }
            Text("These staples are assumed in the house, so they’re left off the list. Tap one to add it anyway.")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink2)
                .fixedSize(horizontal: false, vertical: true)
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(model.staples) { s in
                    Button {
                        Task {
                            let sec = await model.addStaple(s.name)
                            showToast("Added \(s.name)\(sec.map { " to \($0)" } ?? "")")
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "plus").font(.system(size: 10, weight: .heavy))
                            Text(s.name).font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundStyle(WF.ink2)
                        .padding(.horizontal, 11).padding(.vertical, 7)
                        .background(WF.card2)
                        .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.panel)
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    @ViewBuilder private var completedSection: some View {
        if !model.completed.isEmpty {
            Section {
                if showCompleted {
                    ForEach(model.completed) { item in itemRow(item) }
                }
            } header: {
                headerChrome {
                    Button {
                        withAnimation { showCompleted.toggle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: showCompleted ? "chevron.down" : "chevron.right")
                                .font(.system(size: 10, weight: .heavy))
                            Text("COMPLETED (\(model.completed.count))")
                                .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                            Spacer()
                        }
                        .foregroundStyle(WF.ink3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder private func row(_ item: WaffledAPI.ListItemDTO) -> some View {
        HStack(spacing: 12) {
            // Circle: tap to complete (separate hit target).
            Button {
                if editingId != nil { commitEdit() }
                Task { await model.toggle(item.id) }
            } label: {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 21))
                    .foregroundStyle(item.checked ? WF.primary : WF.ink3)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if editingId == item.id {
                TextField("Name", text: $editName)
                    .font(.system(size: 16, weight: .semibold))
                    .focused($focus, equals: .editName)
                    .submitLabel(.next)
                    .onSubmit { focus = .editQty }
                TextField("Qty", text: $editQty)
                    .font(.system(size: 14, weight: .semibold))
                    .multilineTextAlignment(.trailing)
                    .frame(width: 56)
                    .focused($focus, equals: .editQty)
                    .submitLabel(.done)
                    .onSubmit { commitEdit() }
                // A discoverable route to the full editor (assignee + section) so
                // users don't have to find the swipe action.
                Button {
                    var updated = item
                    updated.name = editName
                    updated.quantity = editQty.isEmpty ? nil : editQty
                    editingId = nil
                    detailItem = updated
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(WF.ai)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Button { startEdit(item) } label: {
                    HStack(spacing: 8) {
                        Text(item.name)
                            .font(.system(size: 16, weight: .semibold))
                            .strikethrough(item.checked, color: WF.ink3)
                            .foregroundStyle(item.checked ? WF.ink3 : WF.ink)
                        Spacer(minLength: 8)
                        mealDots(for: item)
                        if let q = item.quantity, !q.isEmpty {
                            Text(q).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                        if let a = item.assignee, a.avatarEmoji != nil || a.colorHex != nil {
                            Avatar(colorHex: a.colorHex, emoji: a.avatarEmoji ?? "🙂", size: 24)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }

    /// Whether the section picker is revealed (while typing, or once a section is set).
    private var showSectionPicker: Bool { focus == .add || draftSection != nil }

    private var addBar: some View {
        VStack(spacing: 8) {
            if showSectionPicker {
                sectionPicker
            }
            HStack(spacing: 10) {
                Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(WF.primary)
                TextField("Add item", text: $draftName)
                    .font(.system(size: 16, weight: .semibold))
                    .focused($focus, equals: .add)
                    .submitLabel(.next)
                    .onSubmit(submit)
                TextField("Qty", text: $draftQty)
                    .font(.system(size: 15, weight: .semibold))
                    .multilineTextAlignment(.trailing)
                    .frame(width: 64)
                    .focused($focus, equals: .add)
                    .submitLabel(.done)
                    .onSubmit(submit)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .wfField()
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, isKiosk ? 14 : 78)   // iPhone clears the floating tab bar; iPad has none
        .background(WF.canvas)           // opaque strip so rows don't show through
        .animation(.easeInOut(duration: 0.18), value: showSectionPicker)
    }

    /// A horizontal strip of section chips for the add bar — "Auto" (let the server
    /// classify), each known section, and "+ New" to name a fresh one.
    private var sectionPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                addSectionChip(label: "Auto", systemImage: "wand.and.stars", selected: draftSection == nil) {
                    draftSection = nil
                }
                ForEach(sectionSuggestions, id: \.self) { s in
                    addSectionChip(label: s, systemImage: nil,
                                   selected: draftSection?.caseInsensitiveCompare(s) == .orderedSame) {
                        draftSection = s
                    }
                }
                addSectionChip(label: "New", systemImage: "plus", selected: false) {
                    newSectionName = ""; newSectionPrompt = true
                }
            }
            .padding(.horizontal, 2).padding(.vertical, 1)
        }
    }

    private func addSectionChip(label: String, systemImage: String?, selected: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 5) {
                if let img = systemImage { Image(systemName: img).font(.system(size: 10, weight: .heavy)) }
                Text(label).font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(selected ? WF.ink : WF.ink2)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .wfChip(selected: selected)
        }
        .buttonStyle(.plain)
    }

    private func startEdit(_ item: WaffledAPI.ListItemDTO) {
        if editingId != nil, editingId != item.id { commitEdit() }
        editName = item.name
        editQty = item.quantity ?? ""
        editingId = item.id
        focus = .editName
    }

    private func commitEdit() {
        guard let id = editingId else { return }
        let n = editName, q = editQty
        editingId = nil
        Task { await model.edit(id, name: n, quantity: q) }
    }

    private func submit() {
        let name = draftName, qty = draftQty, section = draftSection
        draftName = ""; draftQty = ""
        // Keep draftSection so several items in a row land in the same section.
        Task { await model.add(name: name, quantity: qty, section: section) }
    }

    /// Show a transient confirmation banner (auto-dismisses).
    private func showToast(_ message: String) {
        withAnimation(.spring(response: 0.3)) { toast = message }
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2.2))
            if !Task.isCancelled { withAnimation { toast = nil } }
        }
    }

    /// A pill that floats above the add bar after tapping a pantry staple.
    @ViewBuilder private var toastBanner: some View {
        if let t = toast {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.primary)
                Text(t).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
            }
            .padding(.horizontal, 16).padding(.vertical, 11)
            .background(WF.card)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
            .padding(.bottom, 150)            // clear the add bar + tab bar
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// The fuller "Details" editor reached by swiping a row — name, quantity, assignee,
/// and section. The 90% case stays on the inline row editor; this is for the rest.
/// Styled to match the app (WF cards on canvas) rather than the stock iOS Form.
struct ItemDetailEditor: View {
    @Environment(\.dismiss) private var dismiss
    let originalName: String
    let members: [SyncedMember]
    let suggestions: [String]
    let onSave: (String, String, SyncedMember?, String) -> Void

    @State private var name: String
    @State private var quantity: String
    @State private var assigneeId: String?
    @State private var section: String

    init(item: WaffledAPI.ListItemDTO, members: [SyncedMember], suggestions: [String],
         onSave: @escaping (String, String, SyncedMember?, String) -> Void) {
        self.originalName = item.name
        self.members = members
        self.suggestions = suggestions
        self.onSave = onSave
        _name = State(initialValue: item.name)
        _quantity = State(initialValue: item.quantity ?? "")
        _section = State(initialValue: item.section ?? "")
        // The item's assignee carries no id, so resolve it to a member by name.
        let assigneeName = item.assignee?.name
        _assigneeId = State(initialValue: members.first { $0.name == assigneeName }?.id)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    field("Name") { TextField("Item", text: $name).textInputAutocapitalization(.words) }
                    field("Quantity") { TextField("e.g. 2 lb", text: $quantity) }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Assigned to")
                        assigneeRow
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Section")
                        sectionChips
                        inputCard { TextField("e.g. Produce", text: $section) }
                        Text(sectionIsAuto
                             ? "Auto — filed by item name."
                             : "Filed under “\(section.trimmingCharacters(in: .whitespaces))”.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Edit \(originalName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(name, quantity, members.first { $0.id == assigneeId }, section)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.large])
    }

    // MARK: pieces

    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: label)
            inputCard(content)
        }
    }

    private func inputCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .font(.system(size: 16, weight: .semibold))
            .padding(.horizontal, 15).padding(.vertical, 13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .wfField()
    }

    private var assigneeRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                assigneePill(member: nil, label: "Anyone", selected: assigneeId == nil) { assigneeId = nil }
                ForEach(members) { m in
                    assigneePill(member: m, label: m.name, selected: assigneeId == m.id) { assigneeId = m.id }
                }
            }
            .padding(.vertical, 1)
        }
    }

    private func assigneePill(member: SyncedMember?, label: String, selected: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 7) {
                if let m = member {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 24)
                } else {
                    Image(systemName: "person.2")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(WF.ink3)
                        .frame(width: 24, height: 24)
                        .background(WF.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(selected ? WF.ink : WF.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
            .wfChip(selected: selected)
        }
        .buttonStyle(.plain)
    }

    private var sectionIsAuto: Bool { section.trimmingCharacters(in: .whitespaces).isEmpty }

    /// "Auto" (clear the override → let the server classify by name) followed by each
    /// known section. Mirrors the web grocery editor's "Auto (by name)" option.
    private var sectionChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button { section = "" } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "wand.and.stars").font(.system(size: 10, weight: .heavy))
                        Text("Auto").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(sectionIsAuto ? WF.ink : WF.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .wfChip(selected: sectionIsAuto)
                }
                .buttonStyle(.plain)
                ForEach(suggestions, id: \.self) { s in
                    let selected = section.caseInsensitiveCompare(s) == .orderedSame
                    Button { section = s } label: {
                        Text(s).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(selected ? WF.ink : WF.ink2)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .wfChip(selected: selected)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
    }
}

/// Manage the pantry staples master list (assumed in-house, left off the grocery
/// list). Mirrors the web's "Pantry staples" modal — add via a field, remove via an
/// ✕ on each chip. The same list is also managed from the Meals settings tab.
struct PantryStaplesEditor: View {
    @Environment(\.dismiss) private var dismiss
    let onChange: () -> Void

    @State private var staples: [WaffledAPI.GroceryBoardDTO.Staple]
    @State private var draft = ""
    @State private var busy = false
    @FocusState private var fieldFocused: Bool
    private let api = WaffledAPI()

    init(initial: [WaffledAPI.GroceryBoardDTO.Staple], onChange: @escaping () -> Void) {
        _staples = State(initialValue: initial)
        self.onChange = onChange
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Assumed in the house — the grocery list leaves these off.")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink2)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 10) {
                        TextField("Add a staple… (e.g. Soy sauce)", text: $draft)
                            .font(.system(size: 16, weight: .semibold))
                            .textInputAutocapitalization(.words).submitLabel(.done)
                            .focused($fieldFocused)
                            .onSubmit { Task { await add() } }
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .wfField()
                        Button { Task { await add() } } label: {
                            Text("Add").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 18).padding(.vertical, 12)
                                .background(canAdd ? WF.primary : WF.primary.opacity(0.4))
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain).disabled(!canAdd || busy)
                    }

                    if staples.isEmpty {
                        Text("No staples yet.").font(.system(size: 14)).foregroundStyle(WF.ink3)
                    } else {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(staples) { s in
                                HStack(spacing: 7) {
                                    Text(s.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
                                    Button { Task { await remove(s) } } label: {
                                        Image(systemName: "xmark").font(.system(size: 10, weight: .heavy)).foregroundStyle(WF.ink3)
                                    }
                                    .buttonStyle(.plain)
                                }
                                .padding(.leading, 12).padding(.trailing, 9).padding(.vertical, 8)
                                .background(WF.card2)
                                .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                                .clipShape(Capsule())
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Pantry staples")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var canAdd: Bool {
        let n = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !n.isEmpty && !staples.contains { $0.name.caseInsensitiveCompare(n) == .orderedSame }
    }

    private func add() async {
        let n = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canAdd else { return }
        busy = true; defer { busy = false }
        do {
            let s = try await api.addPantryStaple(name: n)
            withAnimation { staples.append(s) }
            draft = ""
            onChange()
        } catch {}
    }

    private func remove(_ s: WaffledAPI.GroceryBoardDTO.Staple) async {
        let snapshot = staples
        withAnimation { staples.removeAll { $0.id == s.id } }
        do { try await api.removePantryStaple(id: s.id); onChange() }
        catch { staples = snapshot }
    }
}

/// A simple wrapping flow layout (left-to-right, top-to-bottom) for chip rows that
/// should show every item rather than scroll — used by the pantry-staples panel.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8
    /// `.center` centers each wrapped row within the width; `.leading` (default) keeps
    /// the original left-packed behavior for existing callers.
    var alignment: HorizontalAlignment = .leading

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > maxWidth { x = 0; y += rowHeight + lineSpacing; rowHeight = 0 }
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // Group into wrapped rows first, so a centered row can be offset by its slack.
        var rows: [[(v: LayoutSubview, s: CGSize)]] = [[]]
        var x: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > bounds.width { rows.append([]); x = 0 }
            rows[rows.count - 1].append((v, s))
            x += s.width + spacing
        }
        var y = bounds.minY
        for row in rows where !row.isEmpty {
            let rowWidth = row.reduce(0) { $0 + $1.s.width } + spacing * CGFloat(row.count - 1)
            var rx = bounds.minX + (alignment == .center ? max(0, (bounds.width - rowWidth) / 2) : 0)
            let rowHeight = row.map(\.s.height).max() ?? 0
            for item in row {
                item.v.place(at: CGPoint(x: rx, y: y), anchor: .topLeading, proposal: ProposedViewSize(item.s))
                rx += item.s.width + spacing
            }
            y += rowHeight + lineSpacing
        }
    }
}
