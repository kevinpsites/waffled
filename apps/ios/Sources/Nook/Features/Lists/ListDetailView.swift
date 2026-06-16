import SwiftUI
import Observation

/// Grocery board view modes.
enum GroceryViewMode: Hashable { case aisle, meal }

/// A run of items under one meal in "By meal" mode (`meal == nil` is the trailing
/// "Staples & extras" group).
struct MealGroup: Identifiable {
    let meal: NookAPI.GroceryBoardDTO.Meal?
    let items: [NookAPI.ListItemDTO]
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
    let list: NookAPI.ListSummary
    private(set) var items: [NookAPI.ListItemDTO] = []
    /// Checked items still shown in place (before they settle into Completed).
    private(set) var settling: Set<String> = []
    private(set) var loading = true
    private(set) var error = false

    /// This week's meals (grocery board only) — drive the meal grouping + dots.
    private(set) var meals: [NookAPI.GroceryBoardDTO.Meal] = []

    private let api = NookAPI()
    /// Grocery gets the richer board (aisle/meal toggle + meal dots).
    var isGrocery: Bool { list.listType.lowercased() == "grocery" }

    init(list: NookAPI.ListSummary) { self.list = list }

    /// Canonical grocery aisles in shopping order (mirrors the server's aisles.ts).
    static let groceryAisles = ["Produce", "Pantry", "Dairy & Chilled", "Meat & Seafood", "Bakery", "Frozen", "Other"]

    /// Active items: unchecked, plus just-checked ones that haven't settled yet.
    private var activeItems: [NookAPI.ListItemDTO] {
        items.filter { !$0.checked || settling.contains($0.id) }
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

    /// The meal colors for an item's meal dots.
    func dotColors(for item: NookAPI.ListItemDTO) -> [String] {
        let ids = Set(item.sourceRecipeIds ?? [])
        guard !ids.isEmpty else { return [] }
        return meals.compactMap { m in m.recipeId.flatMap { ids.contains($0) ? m.color : nil } }
    }

    /// Settled, checked items — shown in the collapsed Completed section.
    var completed: [NookAPI.ListItemDTO] { items.filter { $0.checked && !settling.contains($0.id) } }

    func load() async {
        loading = true
        settling = []
        do {
            if isGrocery {
                let board = try await api.groceryBoard()
                meals = board.meals
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

    func add(name rawName: String, quantity rawQty: String) async {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let qty = rawQty.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if isGrocery {
                try await api.addGroceryItem(name: name, quantity: qty.isEmpty ? nil : qty)
            } else {
                try await api.addListItem(listId: list.id, name: name, quantity: qty.isEmpty ? nil : qty)
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
}

struct ListDetailView: View {
    @Environment(SyncManager.self) private var sync
    @State private var model: ListDetailModel
    @State private var draftName = ""
    @State private var draftQty = ""
    @State private var editingId: String?
    @State private var editName = ""
    @State private var editQty = ""
    @State private var showCompleted = false
    @State private var detailItem: NookAPI.ListItemDTO?
    @State private var didAutoDetails = false
    @State private var mode: GroceryViewMode = .aisle
    @FocusState private var focus: Field?

    private enum Field: Hashable { case add, editName, editQty }

    init(list: NookAPI.ListSummary) {
        _model = State(initialValue: ListDetailModel(list: list))
    }

    var body: some View {
        List {
            if model.items.isEmpty && !model.loading {
                Text(model.error ? "Couldn’t load this list." : "Nothing here yet.")
                    .font(.system(size: 14)).foregroundStyle(NK.ink3)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
            }
            if model.isGrocery && mode == .meal {
                ForEach(model.mealSections()) { group in
                    Section {
                        ForEach(group.items) { item in itemRow(item) }
                    } header: { mealHeader(group.meal) }
                }
            } else {
                ForEach(model.activeSections) { group in
                    Section {
                        ForEach(group.items) { item in itemRow(item) }
                    } header: { sectionHeader(group.title) }
                }
            }
            completedSection
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(NK.canvas)
        .safeAreaInset(edge: .top, spacing: 0) { modeToggle }
        .safeAreaInset(edge: .bottom, spacing: 0) { addBar }
        .navigationTitle(model.list.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load()
            if DemoHooks.groceryMode == "meal" { mode = .meal }
            if DemoHooks.openDetails, !didAutoDetails, let first = model.items.first {
                didAutoDetails = true
                detailItem = first
            }
        }
        .refreshable { await model.load() }
        .onChange(of: focus) { _, new in
            // Tapping away from an inline edit commits it.
            if editingId != nil, new != .editName, new != .editQty { commitEdit() }
        }
        .sheet(item: $detailItem) { item in
            ItemDetailEditor(item: item, members: sync.members, suggestions: sectionSuggestions) { name, qty, member, section in
                Task { await model.editDetails(item.id, name: name, quantity: qty, member: member, section: section) }
            }
        }
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
    @ViewBuilder private func itemRow(_ item: NookAPI.ListItemDTO) -> some View {
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
                    .tint(NK.ai)
            }
    }

    @ViewBuilder private func sectionHeader(_ title: String?) -> some View {
        if let title {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                .foregroundStyle(NK.ink3)
        }
    }

    /// Grocery-only By aisle / By meal segmented control, pinned below the nav bar.
    @ViewBuilder private var modeToggle: some View {
        if model.isGrocery {
            Picker("View", selection: $mode.animation()) {
                Text("By aisle").tag(GroceryViewMode.aisle)
                Text("By meal").tag(GroceryViewMode.meal)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
            .background(NK.canvas)
        }
    }

    /// "By meal" section header — the meal's color dot + title (or Staples).
    @ViewBuilder private func mealHeader(_ meal: NookAPI.GroceryBoardDTO.Meal?) -> some View {
        HStack(spacing: 7) {
            if let meal {
                Circle().fill(Color(hexString: meal.color) ?? NK.ink3).frame(width: 9, height: 9)
                Text("\(meal.emoji ?? "🍽️")  \(meal.title ?? "Meal")".uppercased())
                    .font(.system(size: 11, weight: .heavy)).tracking(0.5)
            } else {
                Text("STAPLES & EXTRAS").font(.system(size: 11, weight: .heavy)).tracking(0.5)
            }
            Spacer()
        }
        .foregroundStyle(NK.ink3)
    }

    /// Colored dots showing which dinners need this item (grocery board).
    @ViewBuilder private func mealDots(for item: NookAPI.ListItemDTO) -> some View {
        let colors = model.dotColors(for: item)
        if !colors.isEmpty {
            HStack(spacing: 3) {
                ForEach(Array(colors.prefix(4).enumerated()), id: \.offset) { _, hex in
                    Circle().fill(Color(hexString: hex) ?? NK.ink3).frame(width: 7, height: 7)
                }
            }
        }
    }

    @ViewBuilder private var completedSection: some View {
        if !model.completed.isEmpty {
            Section {
                if showCompleted {
                    ForEach(model.completed) { item in itemRow(item) }
                }
            } header: {
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
                    .foregroundStyle(NK.ink3)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private func row(_ item: NookAPI.ListItemDTO) -> some View {
        HStack(spacing: 12) {
            // Circle: tap to complete (separate hit target).
            Button {
                if editingId != nil { commitEdit() }
                Task { await model.toggle(item.id) }
            } label: {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 21))
                    .foregroundStyle(item.checked ? NK.primary : NK.ink3)
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
                    .frame(width: 70)
                    .focused($focus, equals: .editQty)
                    .submitLabel(.done)
                    .onSubmit { commitEdit() }
            } else {
                Button { startEdit(item) } label: {
                    HStack(spacing: 8) {
                        Text(item.name)
                            .font(.system(size: 16, weight: .semibold))
                            .strikethrough(item.checked, color: NK.ink3)
                            .foregroundStyle(item.checked ? NK.ink3 : NK.ink)
                        Spacer(minLength: 8)
                        mealDots(for: item)
                        if let q = item.quantity, !q.isEmpty {
                            Text(q).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
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

    private var addBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(NK.primary)
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
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 96)            // clear the floating tab bar
        .background(NK.canvas)           // opaque strip so rows don't show through
    }

    private func startEdit(_ item: NookAPI.ListItemDTO) {
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
        let name = draftName, qty = draftQty
        draftName = ""; draftQty = ""
        Task { await model.add(name: name, quantity: qty) }
    }
}

/// The fuller "Details" editor reached by swiping a row — name, quantity, assignee,
/// and section. The 90% case stays on the inline row editor; this is for the rest.
/// Styled to match the app (NK cards on canvas) rather than the stock iOS Form.
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

    init(item: NookAPI.ListItemDTO, members: [SyncedMember], suggestions: [String],
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
                        if !suggestions.isEmpty { sectionChips }
                        inputCard { TextField("e.g. Produce", text: $section) }
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
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
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
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
                        .foregroundStyle(NK.ink3)
                        .frame(width: 24, height: 24)
                        .background(NK.panel).clipShape(Circle())
                }
                Text(label).font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(selected ? NK.ink : NK.ink2)
            }
            .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
            .background(selected ? NK.primary.opacity(0.12) : NK.card)
            .overlay(Capsule().strokeBorder(selected ? NK.primary : NK.hair, lineWidth: selected ? 1.5 : 1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private var sectionChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { s in
                    let selected = section.caseInsensitiveCompare(s) == .orderedSame
                    Button { section = s } label: {
                        Text(s).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(selected ? NK.ink : NK.ink2)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(selected ? NK.primary.opacity(0.12) : NK.card)
                            .overlay(Capsule().strokeBorder(selected ? NK.primary : NK.hair, lineWidth: selected ? 1.5 : 1))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
    }
}
