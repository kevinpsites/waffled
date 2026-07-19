import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Create or edit a recipe — the native twin of the web `RecipeEditor`. One shared view
/// for iPhone and iPad (presented full-screen). Covers the basics, the AI-assisted Details
/// (it auto-fills cuisine/protein/tags/… from the title + ingredients + steps), the
/// ingredient rows, and the method steps — including the web's "ingredients used per step"
/// with an editable **per-step amount** (½ the soy sauce here, the rest later).
struct RecipeEditorView: View {
    enum Mode { case create; case edit(WaffledAPI.RecipeDetailDTO) }
    let mode: Mode
    var onSaved: (WaffledAPI.RecipeSummary) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    private let api = WaffledAPI()
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    // Basics
    @State private var emoji = ""
    @State private var title = ""
    @State private var servings = "4"
    @State private var prep = ""
    @State private var cook = ""
    // Details (scalars keyed by field; arrays separate)
    @State private var meta: [String: String] = [:]
    @State private var dietary: [String] = []
    @State private var vegetables: [String] = []
    @State private var tags: [String] = []
    // Photo
    @State private var imageUrl = ""
    @State private var storageKey: String?
    @State private var contentType: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var photoPreview: UIImage?
    @State private var uploadingPhoto = false
    // Content
    @State private var ings: [EditIng]
    @State private var steps: [EditStep]
    // Ingredient sections — the household's previously-used section names (merged with
    // the curated defaults for autocomplete), and the uid of a just-added section row so
    // it keeps its own blank-headed group even when emptied (mirrors web f8332e5).
    @State private var usedSections: [String] = []
    @State private var pendingSectionId: UUID?
    // Drag-and-drop highlight targets (the row / section currently hovered).
    @State private var dropTargetRow: UUID?
    @State private var dropTargetSection: UUID?
    // AI Details auto-fill
    @State private var suggestion: WaffledAPI.RecipeMetadataSuggestion?
    @State private var suggesting = false
    @State private var dismissedSug: Set<String> = []
    // Keyboard focus (auto-focus the title on a new recipe; chain Return between rows)
    enum Field: Hashable { case title; case ingAmount(UUID); case ingName(UUID) }
    @FocusState private var focused: Field?
    // Notes
    @State private var notes = ""
    // Import (create only): paste-markdown + the AI photo/describe paths (web parity).
    @State private var showPaste = false
    @State private var markdown = ""
    @State private var parsing = false
    @State private var parseErr: String?
    // Which AI import paths this household can use (nil until fetched); gates the buttons.
    @State private var ingestConfig: WaffledAPI.RecipeIngestConfig?
    @State private var showPhotoImport = false
    @State private var showDescribe = false
    // Save
    @State private var saving = false
    @State private var errorText: String?

    private var editingId: String? { if case let .edit(d) = mode { return d.recipe.id }; return nil }

    /// Curated common ingredient sections; merged with the household's own sections
    /// (global look) for the section-name autocomplete (canonical first).
    private static let defaultSections = [
        "Produce", "Meat", "Poultry", "Seafood", "Dairy", "Eggs", "Pantry", "Spices & seasonings",
        "Grains & pasta", "Canned goods", "Condiments & sauces", "Baking", "Bakery", "Frozen",
        "Herbs", "Nuts & seeds", "Beverages", "Sauce", "Garnish", "For serving",
    ]

    private static let scalarFields: [(key: String, label: String, ph: String)] = [
        ("cuisine", "CUISINE", "Italian, Thai…"),
        ("protein", "PROTEIN", "chicken, beef…"),
        ("mealType", "MEAL TYPE", "dinner, breakfast…"),
        ("base", "BASE", "rice, pasta…"),
        ("effort", "EFFORT", "weeknight…"),
        ("cookMethod", "COOK METHOD", "sheet-pan, skillet…"),
        ("flavorProfile", "FLAVOR", "savory, spicy…"),
        ("collection", "COLLECTION", "Weeknight favorites…"),
    ]

    init(mode: Mode, onSaved: @escaping (WaffledAPI.RecipeSummary) -> Void = { _ in }) {
        self.mode = mode
        self.onSaved = onSaved
        switch mode {
        case .create:
            _ings = State(initialValue: [EditIng()])
            _steps = State(initialValue: [EditStep()])
        case let .edit(d):
            let r = d.recipe
            _emoji = State(initialValue: r.emoji ?? "")
            _title = State(initialValue: r.title)
            _servings = State(initialValue: r.servings.map(String.init) ?? "4")
            _prep = State(initialValue: r.prepTimeMinutes.map(String.init) ?? "")
            _cook = State(initialValue: r.cookTimeMinutes.map(String.init) ?? "")
            var m: [String: String] = [:]
            m["cuisine"] = r.cuisine; m["protein"] = r.protein; m["mealType"] = r.mealType
            m["base"] = r.base; m["effort"] = r.effort; m["cookMethod"] = r.cookMethod
            m["flavorProfile"] = r.flavorProfile; m["collection"] = r.collection
            _meta = State(initialValue: m.compactMapValues { $0 })
            _dietary = State(initialValue: r.dietary ?? [])
            _vegetables = State(initialValue: r.vegetables ?? [])
            _tags = State(initialValue: r.tags ?? [])
            _notes = State(initialValue: r.notes ?? "")
            _imageUrl = State(initialValue: r.imageUrl ?? "")
            let editIngs = d.ingredients.map { EditIng($0) }
            _ings = State(initialValue: editIngs.isEmpty ? [EditIng()] : editIngs)
            let editSteps = d.steps.map { EditStep($0, ings: editIngs) }
            _steps = State(initialValue: editSteps.isEmpty ? [EditStep()] : editSteps)
        }
    }

    // MARK: body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let errorText {
                        Text(errorText).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if editingId == nil { pasteBar }
                    basicsCard
                    detailsCard
                    ingredientsCard
                    methodCard
                    notesCard
                }
                .padding(16)
                .padding(.bottom, 40)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .background(WF.canvas)
            .navigationTitle(editingId == nil ? "New recipe" : "Edit recipe")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .fontWeight(.semibold).disabled(saving || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            // Debounced AI Details auto-fill — restarts whenever the signature changes.
            .task(id: aiSignature) { await runSuggest() }
            // New recipe → land the cursor in the title, where you'll start.
            .task {
                guard editingId == nil else { return }
                try? await Task.sleep(for: .milliseconds(350))
                focused = .title
            }
            // Global look at the household's existing section names (for autocomplete).
            .task { usedSections = (try? await api.recipeSections()) ?? [] }
            // Which AI import paths this household can use (new recipes only). Failure →
            // nil, so only "Paste markdown" shows (graceful when no provider is set).
            .task { if editingId == nil { ingestConfig = try? await api.recipeIngestConfig() } }
            .onChange(of: photoItem) { _, item in Task { await loadPhoto(item) } }
            .sheet(isPresented: $showPaste) { pasteSheet }
            .sheet(isPresented: $showPhotoImport) { PhotoImportSheet { applyParsed($0) } }
            .sheet(isPresented: $showDescribe) { DescribeRecipeSheet { applyParsed($0) } }
        }
    }

    // MARK: paste-markdown import

    /// "Build it by hand, or start from…" — the import shortcuts above the form (new
    /// recipes only). Paste-markdown is always offered; the AI photo/describe paths appear
    /// when the household's provider supports them (gated by `ingestConfig`, web parity).
    private var pasteBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Build it by hand, or start from…")
                .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
            ChipFlow(spacing: 8, lineSpacing: 8) {
                if ingestConfig?.vision == true {
                    importButton("From a photo", "camera") { showPhotoImport = true }
                }
                if ingestConfig?.text == true {
                    importButton("Describe it", "mic") { showDescribe = true }
                }
                importButton("Paste markdown", "doc.on.clipboard") { showPaste = true }
            }
        }
    }

    private func importButton(_ label: String, _ icon: String, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Label(label, systemImage: icon)
                .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink)
                .padding(.horizontal, 13).padding(.vertical, 8).background(WF.card).clipShape(Capsule())
                .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private var pasteSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Button("Use template") { markdown = Self.template }
                            .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.primary)
                        Button("See example") { markdown = Self.example }
                            .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.primary)
                        Spacer()
                    }
                    TextField("Paste frontmatter + markdown here…", text: $markdown, axis: .vertical)
                        .font(.system(size: 14, design: .monospaced)).lineLimit(10...30)
                        .padding(12).wfField(fill: WF.panel)
                    if let parseErr {
                        Text(parseErr).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primaryD)
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Paste a recipe").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showPaste = false } }
                ToolbarItem(placement: .primaryAction) {
                    Button(parsing ? "Parsing…" : "Parse → fill") { Task { await parseMarkdown() } }
                        .fontWeight(.semibold)
                        .disabled(parsing || markdown.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func parseMarkdown() async {
        parsing = true; parseErr = nil
        defer { parsing = false }
        do {
            applyParsed(try await api.parseRecipeMarkdown(markdown))
            showPaste = false
        } catch {
            parseErr = "Couldn’t parse that — check the format and try again."
        }
    }

    /// Hydrate the editor fields from a parsed recipe (the user reviews, then saves).
    private func applyParsed(_ p: WaffledAPI.ParsedRecipe) {
        title = p.recipe.title
        emoji = p.recipe.emoji ?? ""
        servings = p.recipe.servings.map(String.init) ?? "4"
        meta["cuisine"] = p.recipe.cuisine; meta["protein"] = p.recipe.protein
        meta["mealType"] = p.recipe.mealType; meta["base"] = p.recipe.base
        meta["effort"] = p.recipe.effort; meta["cookMethod"] = p.recipe.cookMethod
        meta["flavorProfile"] = p.recipe.flavorProfile
        dietary = p.recipe.dietary ?? []
        vegetables = p.recipe.vegetables ?? []
        tags = p.recipe.tags ?? []
        notes = p.recipe.notes ?? ""
        let editIngs = p.ingredients.map { EditIng(parsed: $0) }
        ings = editIngs.isEmpty ? [EditIng()] : editIngs
        let editSteps = p.steps.map { EditStep(instruction: $0.instruction, ingredientLines: $0.ingredients ?? [], ings: editIngs) }
        steps = editSteps.isEmpty ? [EditStep()] : editSteps
    }

    private static let template = """
    ---
    type: dinner
    protein: chicken
    cuisine: Italian
    effort: weeknight
    dietary: [gluten-free]
    vegetables: [spinach]
    tags: [family-favorite]
    ---

    # Recipe title

    *4 servings*

    ## Ingredients

    ### Section name
    - 1 lb main ingredient, prepped
    - 2 tbsp something

    ## Instructions

    1. First step.
    2. Second step.

    ## Notes

    Anything worth remembering.
    """

    private static let example = """
    ---
    type: dinner
    protein: chicken
    cuisine: Italian
    effort: weeknight
    tags: [weeknight, one-pan]
    ---

    # Garlic Butter Chicken

    *4 servings*

    ## Ingredients

    - 1.5 lb chicken thighs, boneless
    - 4 cloves garlic, minced
    - 3 tbsp butter
    - 1 cup chicken broth
    - 2 tbsp parsley, chopped

    ## Instructions

    1. Season the chicken and sear in butter until golden, 4 min per side.
    2. Add garlic and cook 30 seconds, then pour in the broth.
    3. Simmer until the chicken is cooked through, 8–10 min. Finish with parsley.

    ## Notes

    Great over rice or with crusty bread.
    """

    // MARK: basics

    private var basicsCard: some View {
        WaffledFieldCard(title: "Basics") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .bottom, spacing: 10) {
                    field("EMOJI") {
                        TextField("🍽️", text: $emoji)
                            .font(.system(size: 22)).multilineTextAlignment(.center)
                            .frame(width: 58).padding(.vertical, 9).wfField(fill: WF.panel)
                    }
                    field("TITLE") {
                        TextField("Recipe title", text: $title)
                            .font(.system(size: 16)).focused($focused, equals: .title)
                            .submitLabel(.next).onSubmit { focused = ings.first.map { .ingAmount($0.id) } }
                            .padding(.horizontal, 12).padding(.vertical, 11).wfField(fill: WF.panel)
                    }
                }
                HStack(spacing: 10) {
                    field("SERVINGS") { numField($servings, "4") }
                    field("PREP (MIN)") { numField($prep, "") }
                    field("COOK (MIN)") { numField($cook, "") }
                }
            }
        }
    }

    private func numField(_ value: Binding<String>, _ ph: String) -> some View {
        TextField(ph, text: value)
            .keyboardType(.numberPad).font(.system(size: 16))
            .padding(.horizontal, 12).padding(.vertical, 11).wfField(fill: WF.panel)
    }

    // MARK: details (+ AI auto-fill)

    private var detailsCard: some View {
        WaffledFieldCard(title: "Details") {
            VStack(alignment: .leading, spacing: 14) {
                if suggesting {
                    Label("Thinking…", systemImage: "sparkles")
                        .font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ai)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else if hasSuggestions {
                    Button { keepAllSuggestions() } label: {
                        Label("Keep all suggestions", systemImage: "sparkles")
                            .font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ai)
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12, alignment: .top)],
                          alignment: .leading, spacing: 12) {
                    ForEach(Self.scalarFields, id: \.key) { f in scalarField(f.key, f.label, f.ph) }
                }
                ChipEditorField(label: "DIETARY", items: $dietary, placeholder: "gluten-free, vegan…",
                                suggestions: sugArray(\.dietary, current: dietary, prefix: "dietary"),
                                onAccept: { dietary.append($0) },
                                onDismiss: { dismissedSug.insert("dietary:\($0.lowercased())") })
                ChipEditorField(label: "VEGETABLES", items: $vegetables, placeholder: "spinach, tomato…",
                                suggestions: sugArray(\.vegetables, current: vegetables, prefix: "veg"),
                                onAccept: { vegetables.append($0) },
                                onDismiss: { dismissedSug.insert("veg:\($0.lowercased())") })
                ChipEditorField(label: "TAGS", items: $tags, placeholder: "family-favorite…",
                                suggestions: sugArray(\.tags, current: tags, prefix: "tag"),
                                onAccept: { tags.append($0) },
                                onDismiss: { dismissedSug.insert("tag:\($0.lowercased())") })
                photoRow
            }
        }
    }

    private func scalarField(_ key: String, _ label: String, _ ph: String) -> some View {
        field(label) {
            VStack(alignment: .leading, spacing: 5) {
                TextField(ph, text: metaBinding(key))
                    .font(.system(size: 15)).padding(.horizontal, 11).padding(.vertical, 9).wfField(fill: WF.panel)
                if let s = sugScalar(key) {
                    HStack(spacing: 5) {
                        Button { meta[key] = s } label: {
                            Text("✨ \(s)").font(.system(size: 11.5, weight: .bold)).foregroundStyle(WF.ai)
                                .lineLimit(1).padding(.horizontal, 8).padding(.vertical, 4)
                                .background(WF.ai.opacity(0.12)).clipShape(Capsule())
                        }.buttonStyle(.plain)
                        Button { dismissedSug.insert(key) } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var photoRow: some View {
        field("PHOTO (OPTIONAL)") {
            HStack(spacing: 10) {
                if let photoPreview {
                    Image(uiImage: photoPreview).resizable().scaledToFill()
                        .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else if let url = MediaURL.resolve(imageUrl.isEmpty ? nil : imageUrl) {
                    AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { WF.panel }
                        .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                TextField("Paste an image URL…", text: $imageUrl)
                    .font(.system(size: 14)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .padding(.horizontal, 11).padding(.vertical, 10).wfField(fill: WF.panel)
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Label(uploadingPhoto ? "…" : "Upload", systemImage: "camera")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink)
                        .padding(.horizontal, 12).padding(.vertical, 10).background(WF.panel).clipShape(Capsule())
                }
                .disabled(uploadingPhoto)
            }
        }
    }

    // MARK: ingredients

    private var ingredientsCard: some View {
        WaffledFieldCard(title: "Ingredients") {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(ingGroups.enumerated()), id: \.offset) { gi, grp in
                    // A horizontal rule clearly separates each section (web parity) — the
                    // 🏷 header alone was too subtle. No rule above the very first group.
                    if gi > 0 { Divider().overlay(WF.hair) }
                    ingredientGroup(grp)
                }
                HStack(spacing: 10) {
                    Button { addIngredient() } label: {
                        Label("Add ingredient", systemImage: "plus").font(.system(size: 14, weight: .bold))
                            .foregroundStyle(WF.ink).padding(.horizontal, 13).padding(.vertical, 9)
                            .background(WF.panel).clipShape(Capsule())
                    }.buttonStyle(.plain)
                    Button { addSection() } label: {
                        Label("Add section", systemImage: "plus").font(.system(size: 14, weight: .bold))
                            .foregroundStyle(WF.primary).padding(.horizontal, 13).padding(.vertical, 9)
                            .overlay(Capsule().strokeBorder(WF.primary.opacity(0.35), lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    /// A section run: an editable header (with autocomplete) above its rows. The default
    /// (empty-section) run shows no header — unless it's a just-added pending section,
    /// which keeps its blank-headed group so backspacing the name doesn't merge it up.
    @ViewBuilder private func ingredientGroup(_ grp: IngGroup) -> some View {
        let section = grp.section
        VStack(alignment: .leading, spacing: 8) {
            if grp.section != "" || grp.firstId == pendingSectionId {
                SectionInput(
                    text: sectionBinding(for: grp),
                    suggestions: sectionSuggestions,
                    autoFocus: grp.firstId == pendingSectionId
                )
            }
            ForEach(grp.ids, id: \.self) { id in
                if let i = ings.firstIndex(where: { $0.id == id }) {
                    // Each row is its own view identity (with the move/delete/drop wiring
                    // passed as closures), so a keystroke in one ingredient doesn't
                    // re-evaluate every other row + the section drop targets — part of the
                    // monolithic-body re-render that froze the keyboard.
                    IngredientRowView(
                        row: $ings[i], section: section, focused: $focused,
                        canMoveUp: i > 0, canMoveDown: i < ings.count - 1,
                        isDropTarget: dropTargetRow == id,
                        onAdvance: { advanceIngredient(after: id) },
                        onUp: { moveIngredientStep(id, by: -1) },
                        onDown: { moveIngredientStep(id, by: 1) },
                        onDelete: { ings.removeAll { $0.id == id } },
                        onDrop: { dragged in moveIngredient(dragged, toSection: section, before: id) },
                        onHover: { over in dropTargetRow = over ? id : (dropTargetRow == id ? nil : dropTargetRow) }
                    )
                }
            }
        }
        .padding(8).padding(.horizontal, -8)   // a bit of hit-area around the run
        .background(
            RoundedRectangle(cornerRadius: WF.rSM, style: .continuous)
                .fill(dropTargetSection == grp.firstId ? WF.primary.opacity(0.06) : .clear)
                .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous)
                    .strokeBorder(dropTargetSection == grp.firstId ? WF.primary.opacity(0.4) : .clear, lineWidth: 1.5))
        )
        .contentShape(Rectangle())
        // Drop onto a section's empty space → the dragged row adopts this section and
        // lands at the END of the run. (Dropping on a specific row lands it before that
        // row — see IngredientRowView's own dropDestination.)
        .dropDestination(for: IngredientRowDrag.self) { items, _ in
            dropTargetSection = nil
            guard let raw = items.first?.id, let dragged = UUID(uuidString: raw) else { return false }
            moveIngredient(dragged, toSection: section, before: nil)
            return true
        } isTargeted: { over in
            dropTargetSection = over ? grp.firstId : (dropTargetSection == grp.firstId ? nil : dropTargetSection)
        }
    }

    // MARK: ingredient sections

    /// Consecutive runs of ingredient rows sharing a `section`. A pending (just-added)
    /// section always starts its own group, even when empty (web parity).
    struct IngGroup { var section: String; var ids: [UUID]; var firstId: UUID? { ids.first } }

    private var ingGroups: [IngGroup] {
        var groups: [IngGroup] = []
        for row in ings {
            if var last = groups.last, last.section == row.section, row.id != pendingSectionId {
                last.ids.append(row.id)
                groups[groups.count - 1] = last
            } else {
                groups.append(IngGroup(section: row.section, ids: [row.id]))
            }
        }
        return groups
    }

    /// Canonical sections first, then the household's own (deduped case-insensitively).
    private var sectionSuggestions: [String] {
        var seen = Set<String>(); var out: [String] = []
        for s in Self.defaultSections + usedSections {
            let key = s.trimmingCharacters(in: .whitespaces).lowercased()
            guard !key.isEmpty, !seen.contains(key) else { continue }
            seen.insert(key); out.append(s.trimmingCharacters(in: .whitespaces))
        }
        return out
    }

    /// Header text for a group — writes any rename to every row in the run. We keep the
    /// pending marker even when emptied (so the blank-headed group survives a backspace).
    private func sectionBinding(for grp: IngGroup) -> Binding<String> {
        let ids = Set(grp.ids)
        return Binding(
            get: { grp.section },
            set: { name in
                for i in ings.indices where ids.contains(ings[i].id) { ings[i].section = name }
            }
        )
    }

    /// "+ Add section" — append a blank row carrying a new pending section. The header's
    /// SectionInput auto-focuses it so you can name it right away (with suggestions).
    private func addSection() {
        let row = EditIng()
        ings.append(row)
        pendingSectionId = row.id
    }

    /// Re-home a dragged ingredient: it adopts `section` and is inserted just before
    /// `before` (or appended to the end of that section's run when `before` is nil). The
    /// flat `ings` order IS the section grouping, so we splice within the run's range.
    private func moveIngredient(_ draggedId: UUID, toSection section: String, before: UUID?) {
        guard let from = ings.firstIndex(where: { $0.id == draggedId }) else { return }
        // A dropped row stops being the "pending" blank-headed section (it's now placed).
        if pendingSectionId == draggedId { pendingSectionId = nil }
        var moved = ings.remove(at: from)
        moved.section = section
        if let before, let to = ings.firstIndex(where: { $0.id == before }) {
            ings.insert(moved, at: to)
        } else {
            // Append after the last row already in this section (keep the run contiguous).
            if let last = ings.lastIndex(where: { $0.section == section }) {
                ings.insert(moved, at: last + 1)
            } else {
                ings.append(moved)
            }
        }
    }

    /// Move a row one slot up/down through the flat list. Crossing the boundary of its
    /// run makes it ADOPT the neighbor's section (web's "adopt the section you land after"),
    /// so repeatedly pressing ↓ walks a row through its section and into the next one.
    private func moveIngredientStep(_ id: UUID, by delta: Int) {
        guard let i = ings.firstIndex(where: { $0.id == id }) else { return }
        let j = i + delta
        guard ings.indices.contains(j) else { return }
        if pendingSectionId == id { pendingSectionId = nil }
        // Adopt the section of the row we're stepping onto (the neighbor we land at/after).
        ings[i].section = ings[j].section
        ings.swapAt(i, j)
    }

    // MARK: method

    private var notesCard: some View {
        WaffledFieldCard(title: "Notes") {
            TextField("Anything worth remembering…", text: $notes, axis: .vertical)
                .font(.system(size: 15)).lineLimit(2...8)
                .padding(10).wfField(fill: WF.panel)
        }
    }

    private var methodCard: some View {
        // Snapshot the named ingredients ONCE per render (as plain values) instead of
        // re-filtering `ings` inside every step row — and pass them down so each step's
        // tag UI doesn't recompute the list on its own re-renders.
        let named = ings.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { g in
                let amt = [g.amount.trimmingCharacters(in: .whitespaces), g.unit.trimmingCharacters(in: .whitespaces)]
                    .filter { !$0.isEmpty }.joined(separator: " ")
                return NamedIngredient(id: g.id, name: g.name, defaultAmount: amt)
            }
        return WaffledFieldCard(title: "Method") {
            VStack(alignment: .leading, spacing: 16) {
                // Each step is its own view identity, so a keystroke in one step (or in a
                // totally different card) doesn't re-evaluate/re-lay-out every other step's
                // TextField + ChipFlow tag UI — the freeze came from the whole monolithic
                // body re-running on every keystroke. (See MethodStepRow.)
                ForEach(Array($steps.enumerated()), id: \.element.id) { i, $step in
                    MethodStepRow(index: i, step: $step, named: named, total: steps.count,
                                  onUp: { steps.swapAt(i, i - 1) }, onDown: { steps.swapAt(i, i + 1) },
                                  onDelete: { steps.remove(at: i) })
                }
                Button { steps.append(EditStep()) } label: {
                    Label("Add step", systemImage: "plus").font(.system(size: 14, weight: .bold))
                        .foregroundStyle(WF.ink).padding(.horizontal, 13).padding(.vertical, 9)
                        .background(WF.panel).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
    }

    // MARK: shared bits

    @ViewBuilder private func field<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
            content()
        }
    }

    private func metaBinding(_ key: String) -> Binding<String> {
        Binding(get: { meta[key] ?? "" }, set: { meta[key] = $0 })
    }

    /// Add an ingredient row (joining the current/last section) and put the cursor in its
    /// amount (you start with "how many").
    private func addIngredient() {
        var new = EditIng()
        new.section = ings.last?.section ?? ""
        ings.append(new)
        focused = .ingAmount(new.id)
    }

    /// Return on a field → next ingredient's amount, appending a fresh row past the last.
    private func advanceIngredient(after id: UUID) {
        guard let i = ings.firstIndex(where: { $0.id == id }) else { return }
        if i == ings.count - 1 { addIngredient() } else { focused = .ingAmount(ings[i + 1].id) }
    }

    // MARK: AI suggestions

    private var ingNames: [String] { ings.map { $0.name.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var stepTexts: [String] { steps.map { $0.instruction.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    private var aiSignature: String { ([title.trimmingCharacters(in: .whitespaces)] + ingNames + ["|"] + stepTexts).joined(separator: "\u{1}") }

    private func runSuggest() async {
        guard title.trimmingCharacters(in: .whitespaces).count >= 3, !ingNames.isEmpty else { return }
        try? await Task.sleep(for: .milliseconds(1200))   // debounce — restarts as you type
        if Task.isCancelled { return }
        suggesting = true
        defer { suggesting = false }
        // Never throws (failures → nil), so a slow-model timeout can't permanently kill it;
        // it simply tries again on the next change. The prior suggestion stays visible.
        if let s = try? await api.suggestRecipeMetadata(title: title.trimmingCharacters(in: .whitespaces),
                                                        ingredients: ingNames, steps: stepTexts) {
            suggestion = s
            dismissedSug = []
        }
    }

    /// A scalar suggestion shows only when the field is empty and not dismissed.
    private func sugScalar(_ key: String) -> String? {
        guard let s = suggestion, !dismissedSug.contains(key),
              (meta[key] ?? "").trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let v: String?
        switch key {
        case "cuisine": v = s.cuisine; case "protein": v = s.protein; case "mealType": v = s.mealType
        case "base": v = s.base; case "effort": v = s.effort; case "cookMethod": v = s.cookMethod
        case "flavorProfile": v = s.flavorProfile; default: v = nil
        }
        guard let vv = v?.trimmingCharacters(in: .whitespaces), !vv.isEmpty else { return nil }
        return vv
    }

    private func sugArray(_ kp: KeyPath<WaffledAPI.RecipeMetadataSuggestion, [String]?>,
                          current: [String], prefix: String) -> [String] {
        guard let items = suggestion?[keyPath: kp] else { return [] }
        return items.filter { v in
            !current.contains { $0.caseInsensitiveCompare(v) == .orderedSame }
                && !dismissedSug.contains("\(prefix):\(v.lowercased())")
        }
    }

    private var hasSuggestions: Bool {
        Self.scalarFields.contains { sugScalar($0.key) != nil }
            || !sugArray(\.dietary, current: dietary, prefix: "dietary").isEmpty
            || !sugArray(\.vegetables, current: vegetables, prefix: "veg").isEmpty
            || !sugArray(\.tags, current: tags, prefix: "tag").isEmpty
    }

    private func keepAllSuggestions() {
        for f in Self.scalarFields { if let v = sugScalar(f.key) { meta[f.key] = v } }
        dietary.append(contentsOf: sugArray(\.dietary, current: dietary, prefix: "dietary"))
        vegetables.append(contentsOf: sugArray(\.vegetables, current: vegetables, prefix: "veg"))
        tags.append(contentsOf: sugArray(\.tags, current: tags, prefix: "tag"))
        suggestion = nil
    }

    // MARK: photo

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        uploadingPhoto = true
        defer { uploadingPhoto = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return }
            photoPreview = image
            let up = try await api.uploadImage(image)
            storageKey = up.key
            contentType = up.contentType
            imageUrl = ""
        } catch {
            errorText = "Couldn’t upload that photo."
        }
    }

    // MARK: save

    private func buildBody() -> [String: JSONValue] {
        func str(_ s: String) -> JSONValue { let t = s.trimmingCharacters(in: .whitespaces); return t.isEmpty ? .null : .string(t) }
        func intOrNull(_ s: String) -> JSONValue { Int(s.trimmingCharacters(in: .whitespaces)).map(JSONValue.int) ?? .null }

        let ingBody: [JSONValue] = ings.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            .enumerated().map { i, g in
                var o: [String: JSONValue] = ["name": .string(g.name.trimmingCharacters(in: .whitespaces)), "sortOrder": .int(i)]
                o["amount"] = Double(g.amount.trimmingCharacters(in: .whitespaces)).map(JSONValue.double) ?? .null
                o["unit"] = str(g.unit); o["prepNote"] = str(g.prepNote); o["section"] = str(g.section)
                return .object(o)
            }
        let byId = Dictionary(uniqueKeysWithValues: ings.map { ($0.id, $0) })
        let stepBody: [JSONValue] = steps.filter { !$0.instruction.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { s in
                var lines: [String] = []
                for p in s.picks {
                    guard let g = byId[p.ingId] else { continue }
                    let name = g.name.trimmingCharacters(in: .whitespaces)
                    guard !name.isEmpty else { continue }
                    lines.append([p.amount.trimmingCharacters(in: .whitespaces), name].filter { !$0.isEmpty }.joined(separator: " "))
                }
                lines.append(contentsOf: s.extra)
                return .object(["instruction": .string(s.instruction.trimmingCharacters(in: .whitespaces)),
                                "ingredients": .array(lines.map(JSONValue.string)),
                                "timerSeconds": s.timerSeconds.map(JSONValue.int) ?? .null])
            }

        var body: [String: JSONValue] = [
            "title": .string(title.trimmingCharacters(in: .whitespaces)),
            "emoji": str(emoji),
            "servings": .int(Int(servings.trimmingCharacters(in: .whitespaces)) ?? 4),
            "prepTimeMinutes": intOrNull(prep),
            "cookTimeMinutes": intOrNull(cook),
            "cuisine": str(meta["cuisine"] ?? ""), "protein": str(meta["protein"] ?? ""),
            "mealType": str(meta["mealType"] ?? ""), "base": str(meta["base"] ?? ""),
            "effort": str(meta["effort"] ?? ""), "cookMethod": str(meta["cookMethod"] ?? ""),
            "flavorProfile": str(meta["flavorProfile"] ?? ""), "collection": str(meta["collection"] ?? ""),
            "dietary": .array(dietary.map(JSONValue.string)),
            "vegetables": .array(vegetables.map(JSONValue.string)),
            "tags": .array(tags.map(JSONValue.string)),
            "notes": str(notes),
            "ingredients": .array(ingBody),
            "steps": .array(stepBody),
        ]
        if let storageKey {
            body["storageKey"] = .string(storageKey)
            if let contentType { body["contentType"] = .string(contentType) }
        } else {
            body["imageUrl"] = str(imageUrl)
        }
        return body
    }

    private func save() async {
        guard !title.trimmingCharacters(in: .whitespaces).isEmpty, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let r: WaffledAPI.RecipeSummary
            if let id = editingId { r = try await api.saveRecipeContent(id: id, buildBody()) }
            else { r = try await api.createRecipe(buildBody()) }
            onSaved(r)
            dismiss()
        } catch {
            errorText = "Couldn’t save the recipe — please try again."
        }
    }
}

// MARK: - editor row models

struct EditIng: Identifiable, Equatable {
    let id = UUID()
    var amount = ""; var unit = ""; var name = ""; var prepNote = ""; var section = ""

    init() {}
    init(_ dto: WaffledAPI.RecipeIngredientDTO) {
        amount = dto.amount.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? ""
        unit = dto.unit ?? ""; name = dto.name; prepNote = dto.prepNote ?? ""; section = dto.section ?? ""
    }
    init(parsed p: WaffledAPI.ParsedRecipe.Ing) {
        amount = p.amount.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? ""
        unit = p.unit ?? ""; name = p.name; prepNote = p.prepNote ?? ""; section = p.section ?? ""
    }
}

struct StepPick: Identifiable, Equatable { let id = UUID(); var ingId: UUID; var amount: String }

struct EditStep: Identifiable, Equatable {
    let id = UUID()
    var instruction = ""
    var picks: [StepPick] = []
    var extra: [String] = []
    /// Total seconds for this step's optional timer; nil = no timer.
    var timerSeconds: Int?

    init() {}
    init(_ dto: WaffledAPI.RecipeStepDTO, ings: [EditIng]) {
        self.init(instruction: dto.instruction, ingredientLines: dto.ingredients, ings: ings,
                  timerSeconds: dto.timerSeconds)
    }
    /// Seed a step from saved/parsed data — match each "amount name" line back to an
    /// ingredient (best effort) so the per-step amount stays editable; unmatched lines
    /// become free extras.
    init(instruction: String, ingredientLines: [String], ings: [EditIng], timerSeconds: Int? = nil) {
        self.instruction = instruction
        self.timerSeconds = timerSeconds
        let named = ings.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            .sorted { $0.name.count > $1.name.count }   // longest name first
        for line in ingredientLines {
            let lower = line.lowercased()
            if let g = named.first(where: { lower.contains($0.name.lowercased()) }),
               let r = lower.range(of: g.name.lowercased()) {
                let amt = String(line[line.startIndex..<line.index(line.startIndex, offsetBy: lower.distance(from: lower.startIndex, to: r.lowerBound))])
                    .trimmingCharacters(in: .whitespaces)
                picks.append(StepPick(ingId: g.id, amount: amt))
            } else {
                extra.append(line)
            }
        }
    }
}

// MARK: - a small token/chip editor (chips + add field + AI suggestion chips)

struct ChipEditorField: View {
    let label: String
    @Binding var items: [String]
    let placeholder: String
    var suggestions: [String] = []
    var onAccept: (String) -> Void = { _ in }
    var onDismiss: (String) -> Void = { _ in }
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(WF.ink3)
            if !items.isEmpty {
                ChipFlow(spacing: 7, lineSpacing: 7) {
                    ForEach(items, id: \.self) { it in
                        HStack(spacing: 5) {
                            Text(it).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink)
                            Button { items.removeAll { $0 == it } } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
                            }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6).wfChip(selected: true)
                    }
                }
            }
            HStack(spacing: 8) {
                TextField(placeholder, text: $draft)
                    .font(.system(size: 14)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .onSubmit(commit)
                    .padding(.horizontal, 11).padding(.vertical, 9).wfField(fill: WF.panel)
                if !draft.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Add", action: commit).font(.system(size: 13, weight: .bold)).foregroundStyle(WF.primary)
                }
            }
            if !suggestions.isEmpty {
                ChipFlow(spacing: 7, lineSpacing: 7) {
                    ForEach(suggestions, id: \.self) { s in
                        Button { onAccept(s) } label: {
                            Label("✨ \(s)", systemImage: "plus")
                                .font(.system(size: 11.5, weight: .bold)).foregroundStyle(WF.ai)
                                .labelStyle(.titleOnly)
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(WF.ai.opacity(0.1)).clipShape(Capsule())
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func commit() {
        let v = draft.trimmingCharacters(in: .whitespaces)
        if !v.isEmpty, !items.contains(where: { $0.caseInsensitiveCompare(v) == .orderedSame }) { items.append(v) }
        draft = ""
    }
}

// MARK: - section-name input (free text + compact autocomplete)

/// A section-name header field with a compact autocomplete dropdown — the native twin of
/// the web `SectionInput`. Free-text, filtered suggestions as you type, capped + scroll;
/// tap a suggestion to choose. The dropdown shows while the field is focused.
struct SectionInput: View {
    @Binding var text: String
    let suggestions: [String]
    var autoFocus: Bool = false
    @FocusState private var focused: Bool

    private var matches: [String] {
        let q = text.trimmingCharacters(in: .whitespaces).lowercased()
        return suggestions.filter { q.isEmpty || $0.lowercased().contains(q) }.prefix(12).map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "tag").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                TextField("Section name", text: $text)
                    .font(.system(size: 13, weight: .heavy)).tracking(0.3)
                    .textInputAutocapitalization(.words).submitLabel(.done)
                    .focused($focused).onSubmit { focused = false }
            }
            .padding(.horizontal, 11).padding(.vertical, 9).wfField(fill: WF.panel)

            if focused && !matches.isEmpty {
                VStack(spacing: 0) {
                    ForEach(matches, id: \.self) { s in
                        Button {
                            text = s
                            focused = false
                        } label: {
                            HStack {
                                Text(s).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        if s != matches.last { Divider().overlay(WF.hair) }
                    }
                }
                .frame(maxHeight: 200)
                .background(WF.card)
                .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
                .padding(.top, 4)
            }
        }
        .task { if autoFocus { try? await Task.sleep(for: .milliseconds(250)); focused = true } }
    }
}

// MARK: - one ingredient row (extracted so each row is its own SwiftUI identity)

/// A single editable ingredient row: amount / unit / name / prep-note, a drag grip to
/// re-home it into another section, and up / down / delete controls (which now cross the
/// section boundary). Pulled out of `RecipeEditorView` so typing in one row doesn't
/// re-evaluate every other row — part of the monolithic-body re-render that froze the
/// keyboard. The parent owns the `[EditIng]`; this row reaches it only through closures.
/// A custom (non-text) drag payload for reordering ingredient rows. A plain `String`
/// let the rows' TextFields intercept the drop and paste the id as text (and made drops
/// unreliable). A custom UTType — declared in Waffled-Info.plist, conforming to `public.data`
/// (NOT `public.text`) — means only the row/section drop targets accept it.
extension UTType {
    static let waffledIngredientRow = UTType(exportedAs: "app.waffled.ingredient-row")
}

struct IngredientRowDrag: Transferable, Codable {
    let id: String
    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .waffledIngredientRow)
    }
}

struct IngredientRowView: View {
    @Binding var row: EditIng
    let section: String
    var focused: FocusState<RecipeEditorView.Field?>.Binding
    let canMoveUp: Bool        // a row exists above → ↑ enabled
    let canMoveDown: Bool      // a row exists below → ↓ enabled
    let isDropTarget: Bool
    let onAdvance: () -> Void
    let onUp: () -> Void
    let onDown: () -> Void
    let onDelete: () -> Void
    let onDrop: (UUID) -> Void
    let onHover: (Bool) -> Void

    var body: some View {
        let id = row.id
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                // A grip handle owns the drag — dragging from a TextField would steal the
                // text-selection gesture. Drag a row into another section to re-home it.
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                    .frame(width: 22, height: 30).contentShape(Rectangle())
                    .draggable(IngredientRowDrag(id: id.uuidString)) { dragPreview }
                TextField("2", text: $row.amount).keyboardType(.decimalPad)
                    .focused(focused, equals: .ingAmount(id))
                    .frame(width: 54).padding(8).wfField(fill: WF.panel)
                TextField("cups", text: $row.unit).submitLabel(.next).onSubmit(onAdvance)
                    .frame(width: 72).padding(8).wfField(fill: WF.panel)
                TextField("ingredient", text: $row.name)
                    .focused(focused, equals: .ingName(id))
                    .submitLabel(.next).onSubmit(onAdvance)
                    .padding(8).wfField(fill: WF.panel)
            }
            HStack(spacing: 6) {
                TextField("diced (optional)", text: $row.prepNote).submitLabel(.next).onSubmit(onAdvance)
                    .padding(8).wfField(fill: WF.panel)
                // Arrows cross section boundaries: moving past the top/bottom of a run makes
                // the row adopt the adjacent section (web's "adopt the section you land
                // after"), so repeated ↓ walks a row down and into the next section.
                EditorRowControls(up: canMoveUp, down: canMoveDown, onUp: onUp, onDown: onDown, onDelete: onDelete)
            }
        }
        .padding(.bottom, 2)
        .background(isDropTarget ? WF.primary.opacity(0.06) : .clear)
        // Drop ONTO a row → the dragged row adopts this row's section and lands just before
        // it (precise positioning within / into a section).
        .dropDestination(for: IngredientRowDrag.self) { items, _ in
            guard let raw = items.first?.id, let dragged = UUID(uuidString: raw), dragged != id else { return false }
            onDrop(dragged)
            return true
        } isTargeted: { onHover($0) }
    }

    private var dragPreview: some View {
        let name = row.name.trimmingCharacters(in: .whitespaces)
        return HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal").font(.system(size: 13, weight: .bold))
            Text(name.isEmpty ? "ingredient" : name)
                .font(.system(size: 14, weight: .semibold)).lineLimit(1)
        }
        .foregroundStyle(WF.ink)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(WF.card).clipShape(Capsule())
        .overlay(Capsule().strokeBorder(WF.primary.opacity(0.4), lineWidth: 1))
    }
}

// MARK: - one method step (extracted so each step is its own SwiftUI identity)

/// A plain, value-typed snapshot of a named ingredient (id + name + the default amount to
/// seed a step pick). Passing these as `let` values — instead of re-filtering the live
/// `ings` array inside every step's body — keeps per-keystroke work cheap (the editor's
/// whole body re-runs on each keystroke; this stops it amplifying across every step row).
struct NamedIngredient: Identifiable, Equatable {
    let id: UUID
    let name: String
    /// "amount unit" prefilled when this ingredient is first tagged in a step.
    var defaultAmount: String = ""
}

/// One method step. Extracted into its own `View` struct so a keystroke in this step (or in
/// another card entirely) only re-evaluates THIS row's body — not every other step's
/// TextField + ChipFlow tag UI. The monolithic editor body re-running all of those on every
/// keystroke was the keyboard-freeze amplifier (same class as the chores new-chore sheet).
struct MethodStepRow: View {
    let index: Int
    @Binding var step: EditStep
    let named: [NamedIngredient]
    let total: Int
    let onUp: () -> Void
    let onDown: () -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("\(index + 1)").font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink2)
                    .frame(width: 26, height: 26).background(WF.panel).clipShape(Circle())
                Spacer()
                EditorRowControls(up: index > 0, down: index < total - 1,
                                  onUp: onUp, onDown: onDown, onDelete: onDelete)
            }
            TextField("Describe this step…", text: $step.instruction, axis: .vertical)
                .font(.system(size: 15)).lineLimit(2...8)
                .padding(10).wfField(fill: WF.panel)
            StepTagSection(step: $step, named: named, onAdd: togglePick, onRemove: removePick)
            stepTimer
        }
    }

    private func togglePick(_ g: NamedIngredient) {
        if let i = step.picks.firstIndex(where: { $0.ingId == g.id }) {
            step.picks.remove(at: i)
        } else {
            step.picks.append(StepPick(ingId: g.id, amount: g.defaultAmount))
        }
    }

    private func removePick(_ ingId: UUID) { step.picks.removeAll { $0.ingId == ingId } }

    /// Per-step timer control. Collapsed: a dashed "⏱ Add timer" affordance. Expanded:
    /// editable minutes + seconds (0–59) and a filled "⏱ m:ss" pill with a clear button.
    @ViewBuilder private var stepTimer: some View {
        let total = step.timerSeconds ?? 0
        if total > 0 {
            HStack(spacing: 10) {
                Text("⏱ \(CookTimer.mmss(total))")
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(WF.primaryD)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .background(WF.primary.opacity(0.12)).clipShape(Capsule())

                HStack(spacing: 4) {
                    TextField("0", value: timerMin, format: .number)
                        .keyboardType(.numberPad).multilineTextAlignment(.center)
                        .font(.system(size: 14, weight: .semibold)).frame(width: 42)
                        .padding(.vertical, 6).wfField(fill: WF.card)
                    Text("min").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    TextField("0", value: timerSec, format: .number)
                        .keyboardType(.numberPad).multilineTextAlignment(.center)
                        .font(.system(size: 14, weight: .semibold)).frame(width: 42)
                        .padding(.vertical, 6).wfField(fill: WF.card)
                    Text("sec").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer()
                Button { step.timerSeconds = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
                }.buttonStyle(.plain)
            }
        } else {
            Button { step.timerSeconds = 60 } label: {
                Label("Add timer", systemImage: "timer")
                    .font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.primaryD)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .overlay(Capsule().stroke(style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
                        .foregroundStyle(WF.primaryD.opacity(0.5)))
            }.buttonStyle(.plain)
        }
    }

    private var timerMin: Binding<Int> {
        Binding(
            get: { (step.timerSeconds ?? 0) / 60 },
            set: { m in
                let s = (step.timerSeconds ?? 0) % 60
                let t = max(0, m) * 60 + s
                step.timerSeconds = t > 0 ? t : nil
            }
        )
    }

    private var timerSec: Binding<Int> {
        Binding(
            get: { (step.timerSeconds ?? 0) % 60 },
            set: { s in
                let m = (step.timerSeconds ?? 0) / 60
                let t = m * 60 + min(59, max(0, s))
                step.timerSeconds = t > 0 ? t : nil
            }
        )
    }
}

/// The shared up / down / delete control cluster (moved out of `RecipeEditorView` so the
/// extracted `MethodStepRow` can reuse it without re-evaluating the parent's body).
struct EditorRowControls: View {
    let up: Bool, down: Bool
    let onUp: () -> Void, onDown: () -> Void, onDelete: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button(action: onUp) { icon("arrow.up") }.disabled(!up).buttonStyle(.plain)
            Button(action: onDown) { icon("arrow.down") }.disabled(!down).buttonStyle(.plain)
            Button(action: onDelete) {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.primaryD)
                    .frame(width: 30, height: 30).background(WF.primaryD.opacity(0.1)).clipShape(RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain)
        }
    }

    private func icon(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink2)
            .frame(width: 30, height: 30).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - per-step "tag ingredient" (pills + popover)

/// Per-step ingredient tagging — the native twin of the web `StepIngredients`. Tagged
/// ingredients show as green "name · amount" pills; "+ Tag ingredient" opens a sheet that
/// lists every named ingredient as a checkbox row with a per-step quantity field. Checking
/// adds a `StepPick` (default amount = the ingredient's amount); editing sets its amount.
/// Legacy free-text `extra` lines are shown as removable grey pills.
struct StepTagSection: View {
    @Binding var step: EditStep
    let named: [NamedIngredient]
    let onAdd: (NamedIngredient) -> Void
    let onRemove: (UUID) -> Void
    @State private var showPopover = false

    private static let green = WF.success

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ChipFlow(spacing: 7, lineSpacing: 7) {
                Button { showPopover = true } label: {
                    Label("Tag ingredient", systemImage: "plus")
                        .font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                        .padding(.horizontal, 11).padding(.vertical, 6)
                        .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                }.buttonStyle(.plain)

                ForEach(step.picks) { pick in
                    if let g = named.first(where: { $0.id == pick.ingId }) {
                        let amt = pick.amount.trimmingCharacters(in: .whitespaces)
                        Button { showPopover = true } label: {
                            HStack(spacing: 4) {
                                Circle().fill(Self.green).frame(width: 6, height: 6)
                                Text(g.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Self.green)
                                if !amt.isEmpty {
                                    Text("· \(amt)").font(.system(size: 12, weight: .medium)).foregroundStyle(Self.green.opacity(0.85))
                                }
                            }
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .background(Self.green.opacity(0.12)).clipShape(Capsule())
                        }.buttonStyle(.plain)
                    }
                }

                ForEach(Array(step.extra.enumerated()), id: \.offset) { ei, line in
                    HStack(spacing: 5) {
                        Text(line).font(.system(size: 12.5, weight: .medium)).foregroundStyle(WF.ink2)
                        Button { step.extra.remove(at: ei) } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
                        }.buttonStyle(.plain)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).wfChip(selected: false)
                }
            }
        }
        .sheet(isPresented: $showPopover) { popover }
    }

    private var popover: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if named.isEmpty {
                        Text("Add ingredients above first.")
                            .font(.system(size: 14)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 20)
                    } else {
                        ForEach(named) { g in tagRow(g) }
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Tag ingredients").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .primaryAction) { Button("Done") { showPopover = false }.fontWeight(.semibold) } }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder private func tagRow(_ g: NamedIngredient) -> some View {
        let pickIdx = step.picks.firstIndex { $0.ingId == g.id }
        let on = pickIdx != nil
        HStack(spacing: 10) {
            Button { on ? onRemove(g.id) : onAdd(g) } label: {
                Image(systemName: on ? "checkmark.square.fill" : "square")
                    .font(.system(size: 20)).foregroundStyle(on ? WF.primary : WF.ink3)
            }.buttonStyle(.plain)
            Text(g.name).font(.system(size: 15, weight: on ? .semibold : .regular)).foregroundStyle(WF.ink)
            Spacer(minLength: 8)
            if let pi = pickIdx {
                TextField("amt", text: $step.picks[pi].amount)
                    .font(.system(size: 13)).multilineTextAlignment(.center)
                    .frame(width: 96).padding(7).wfField(fill: WF.card)
            }
        }
        .padding(.vertical, 4)
    }
}
