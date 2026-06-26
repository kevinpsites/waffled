import SwiftUI
import PhotosUI

/// Create or edit a recipe — the native twin of the web `RecipeEditor`. One shared view
/// for iPhone and iPad (presented full-screen). Covers the basics, the AI-assisted Details
/// (it auto-fills cuisine/protein/tags/… from the title + ingredients + steps), the
/// ingredient rows, and the method steps — including the web's "ingredients used per step"
/// with an editable **per-step amount** (½ the soy sauce here, the rest later).
struct RecipeEditorView: View {
    enum Mode { case create; case edit(NookAPI.RecipeDetailDTO) }
    let mode: Mode
    var onSaved: (NookAPI.RecipeSummary) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    private let api = NookAPI()
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
    // AI Details auto-fill
    @State private var suggestion: NookAPI.RecipeMetadataSuggestion?
    @State private var suggesting = false
    @State private var dismissedSug: Set<String> = []
    // Keyboard focus (auto-focus the title on a new recipe; chain Return between rows)
    enum Field: Hashable { case title; case ingName(UUID) }
    @FocusState private var focused: Field?
    // Save
    @State private var saving = false
    @State private var errorText: String?

    private var editingId: String? { if case let .edit(d) = mode { return d.recipe.id }; return nil }

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

    init(mode: Mode, onSaved: @escaping (NookAPI.RecipeSummary) -> Void = { _ in }) {
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
                        Text(errorText).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.primaryD)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    basicsCard
                    detailsCard
                    ingredientsCard
                    methodCard
                }
                .padding(16)
                .padding(.bottom, 40)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .background(NK.canvas)
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
            .onChange(of: photoItem) { _, item in Task { await loadPhoto(item) } }
        }
    }

    // MARK: basics

    private var basicsCard: some View {
        NookFieldCard(title: "Basics") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .bottom, spacing: 10) {
                    field("EMOJI") {
                        TextField("🍽️", text: $emoji)
                            .font(.system(size: 22)).multilineTextAlignment(.center)
                            .frame(width: 58).padding(.vertical, 9).nkField(fill: NK.panel)
                    }
                    field("TITLE") {
                        TextField("Recipe title", text: $title)
                            .font(.system(size: 16)).focused($focused, equals: .title)
                            .submitLabel(.next).onSubmit { focused = ings.first.map { .ingName($0.id) } }
                            .padding(.horizontal, 12).padding(.vertical, 11).nkField(fill: NK.panel)
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
            .padding(.horizontal, 12).padding(.vertical, 11).nkField(fill: NK.panel)
    }

    // MARK: details (+ AI auto-fill)

    private var detailsCard: some View {
        NookFieldCard(title: "Details") {
            VStack(alignment: .leading, spacing: 14) {
                if suggesting {
                    Label("Thinking…", systemImage: "sparkles")
                        .font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ai)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else if hasSuggestions {
                    Button { keepAllSuggestions() } label: {
                        Label("Keep all suggestions", systemImage: "sparkles")
                            .font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ai)
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
                    .font(.system(size: 15)).padding(.horizontal, 11).padding(.vertical, 9).nkField(fill: NK.panel)
                if let s = sugScalar(key) {
                    HStack(spacing: 5) {
                        Button { meta[key] = s } label: {
                            Text("✨ \(s)").font(.system(size: 11.5, weight: .bold)).foregroundStyle(NK.ai)
                                .lineLimit(1).padding(.horizontal, 8).padding(.vertical, 4)
                                .background(NK.ai.opacity(0.12)).clipShape(Capsule())
                        }.buttonStyle(.plain)
                        Button { dismissedSug.insert(key) } label: {
                            Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(NK.ink3)
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
                    AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { NK.panel }
                        .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                TextField("Paste an image URL…", text: $imageUrl)
                    .font(.system(size: 14)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .padding(.horizontal, 11).padding(.vertical, 10).nkField(fill: NK.panel)
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Label(uploadingPhoto ? "…" : "Upload", systemImage: "camera")
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink)
                        .padding(.horizontal, 12).padding(.vertical, 10).background(NK.panel).clipShape(Capsule())
                }
                .disabled(uploadingPhoto)
            }
        }
    }

    // MARK: ingredients

    private var ingredientsCard: some View {
        NookFieldCard(title: "Ingredients") {
            VStack(alignment: .leading, spacing: 12) {
                ForEach($ings) { $row in ingredientRow($row) }
                Button { addIngredient() } label: {
                    Label("Add ingredient", systemImage: "plus").font(.system(size: 14, weight: .bold))
                        .foregroundStyle(NK.ink).padding(.horizontal, 13).padding(.vertical, 9)
                        .background(NK.panel).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private func ingredientRow(_ row: Binding<EditIng>) -> some View {
        let idx = ings.firstIndex { $0.id == row.id } ?? 0
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                TextField("2", text: row.amount).keyboardType(.decimalPad)
                    .frame(width: 54).padding(8).nkField(fill: NK.panel)
                TextField("cups", text: row.unit).frame(width: 72).padding(8).nkField(fill: NK.panel)
                // Return on the name jumps to the next ingredient — adding a fresh row when
                // you're on the last one — so you can keep typing a list without reaching up.
                TextField("ingredient", text: row.name)
                    .focused($focused, equals: .ingName(row.wrappedValue.id))
                    .submitLabel(.next).onSubmit { advanceIngredient(after: row.wrappedValue.id) }
                    .padding(8).nkField(fill: NK.panel)
            }
            HStack(spacing: 6) {
                TextField("diced (optional)", text: row.prepNote).padding(8).nkField(fill: NK.panel)
                TextField("section", text: row.section).frame(width: 96).padding(8).nkField(fill: NK.panel)
                rowControls(up: idx > 0, down: idx < ings.count - 1,
                            onUp: { ings.swapAt(idx, idx - 1) }, onDown: { ings.swapAt(idx, idx + 1) },
                            onDelete: { ings.removeAll { $0.id == row.wrappedValue.id } })
            }
        }
        .padding(.bottom, 2)
    }

    // MARK: method

    private var methodCard: some View {
        NookFieldCard(title: "Method") {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array($steps.enumerated()), id: \.element.id) { i, $step in stepRow(i, $step) }
                Button { steps.append(EditStep()) } label: {
                    Label("Add step", systemImage: "plus").font(.system(size: 14, weight: .bold))
                        .foregroundStyle(NK.ink).padding(.horizontal, 13).padding(.vertical, 9)
                        .background(NK.panel).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private func stepRow(_ i: Int, _ step: Binding<EditStep>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("\(i + 1)").font(.system(size: 13, weight: .heavy)).foregroundStyle(NK.ink2)
                    .frame(width: 26, height: 26).background(NK.panel).clipShape(Circle())
                Spacer()
                rowControls(up: i > 0, down: i < steps.count - 1,
                            onUp: { steps.swapAt(i, i - 1) }, onDown: { steps.swapAt(i, i + 1) },
                            onDelete: { steps.remove(at: i) })
            }
            TextField("Describe this step…", text: step.instruction, axis: .vertical)
                .font(.system(size: 15)).lineLimit(2...8)
                .padding(10).nkField(fill: NK.panel)
            stepIngredients(step)
        }
    }

    /// "Ingredients used" — toggle a recipe ingredient onto this step, then (below) set the
    /// amount used *here* (defaults to the recipe total; edit it to split across steps).
    @ViewBuilder private func stepIngredients(_ step: Binding<EditStep>) -> some View {
        let named = ings.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
        if named.isEmpty {
            Text("INGREDIENTS USED   Add ingredients above to pick them here.")
                .font(.system(size: 10.5, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink3)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("INGREDIENTS USED").font(.system(size: 10.5, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink3)
                ChipFlow(spacing: 7, lineSpacing: 7) {
                    ForEach(named) { g in
                        let on = step.wrappedValue.picks.contains { $0.ingId == g.id }
                        Button { togglePick(step, g) } label: {
                            Text(on ? g.name : "+ \(g.name)")
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(on ? NK.ink : NK.ink2)
                                .padding(.horizontal, 11).padding(.vertical, 6).nkChip(selected: on)
                        }.buttonStyle(.plain)
                    }
                }
                ForEach(step.picks) { $pick in
                    if let g = ings.first(where: { $0.id == pick.ingId }) {
                        HStack(spacing: 8) {
                            TextField("amt", text: $pick.amount)
                                .font(.system(size: 13)).frame(width: 88).padding(7).nkField(fill: NK.card)
                            Text(g.name).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(NK.ink)
                            Spacer()
                            Button { removePick(step, pick.ingId) } label: {
                                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                            }.buttonStyle(.plain)
                        }
                    }
                }
                ForEach(Array(step.wrappedValue.extra.enumerated()), id: \.offset) { ei, line in
                    HStack(spacing: 8) {
                        Text(line).font(.system(size: 13)).foregroundStyle(NK.ink2)
                        Spacer()
                        Button { step.wrappedValue.extra.remove(at: ei) } label: {
                            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: shared bits

    @ViewBuilder private func field<V: View>(_ label: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
            content()
        }
    }

    private func rowControls(up: Bool, down: Bool, onUp: @escaping () -> Void,
                             onDown: @escaping () -> Void, onDelete: @escaping () -> Void) -> some View {
        HStack(spacing: 4) {
            Button(action: onUp) { ctlIcon("arrow.up") }.disabled(!up).buttonStyle(.plain)
            Button(action: onDown) { ctlIcon("arrow.down") }.disabled(!down).buttonStyle(.plain)
            Button(action: onDelete) {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.primaryD)
                    .frame(width: 30, height: 30).background(NK.primaryD.opacity(0.1)).clipShape(RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain)
        }
    }

    private func ctlIcon(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink2)
            .frame(width: 30, height: 30).background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func metaBinding(_ key: String) -> Binding<String> {
        Binding(get: { meta[key] ?? "" }, set: { meta[key] = $0 })
    }

    /// Add an ingredient row and put the cursor in it (so "+ Add ingredient" keeps a
    /// keyboard user typing).
    private func addIngredient() {
        let new = EditIng()
        ings.append(new)
        focused = .ingName(new.id)
    }

    /// Return on an ingredient name → next row's name, appending a fresh row past the last.
    private func advanceIngredient(after id: UUID) {
        guard let i = ings.firstIndex(where: { $0.id == id }) else { return }
        if i == ings.count - 1 { addIngredient() } else { focused = .ingName(ings[i + 1].id) }
    }

    private func togglePick(_ step: Binding<EditStep>, _ g: EditIng) {
        if let i = step.wrappedValue.picks.firstIndex(where: { $0.ingId == g.id }) {
            step.wrappedValue.picks.remove(at: i)
        } else {
            let amt = [g.amount.trimmingCharacters(in: .whitespaces), g.unit.trimmingCharacters(in: .whitespaces)]
                .filter { !$0.isEmpty }.joined(separator: " ")
            step.wrappedValue.picks.append(StepPick(ingId: g.id, amount: amt))
        }
    }

    private func removePick(_ step: Binding<EditStep>, _ ingId: UUID) {
        step.wrappedValue.picks.removeAll { $0.ingId == ingId }
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

    private func sugArray(_ kp: KeyPath<NookAPI.RecipeMetadataSuggestion, [String]?>,
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
                                "ingredients": .array(lines.map(JSONValue.string))])
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
            let r: NookAPI.RecipeSummary
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
    init(_ dto: NookAPI.RecipeIngredientDTO) {
        amount = dto.amount.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? ""
        unit = dto.unit ?? ""; name = dto.name; prepNote = dto.prepNote ?? ""; section = dto.section ?? ""
    }
}

struct StepPick: Identifiable, Equatable { let id = UUID(); var ingId: UUID; var amount: String }

struct EditStep: Identifiable, Equatable {
    let id = UUID()
    var instruction = ""
    var picks: [StepPick] = []
    var extra: [String] = []

    init() {}
    /// Seed from a saved step — match each "amount name" line back to an ingredient (best
    /// effort) so the per-step amount stays editable; unmatched lines become free extras.
    init(_ dto: NookAPI.RecipeStepDTO, ings: [EditIng]) {
        instruction = dto.instruction
        let named = ings.filter { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty }
            .sorted { $0.name.count > $1.name.count }   // longest name first
        for line in dto.ingredients {
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
            Text(label).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
            if !items.isEmpty {
                ChipFlow(spacing: 7, lineSpacing: 7) {
                    ForEach(items, id: \.self) { it in
                        HStack(spacing: 5) {
                            Text(it).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink)
                            Button { items.removeAll { $0 == it } } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(NK.ink3)
                            }.buttonStyle(.plain)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6).nkChip(selected: true)
                    }
                }
            }
            HStack(spacing: 8) {
                TextField(placeholder, text: $draft)
                    .font(.system(size: 14)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .onSubmit(commit)
                    .padding(.horizontal, 11).padding(.vertical, 9).nkField(fill: NK.panel)
                if !draft.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Add", action: commit).font(.system(size: 13, weight: .bold)).foregroundStyle(NK.primary)
                }
            }
            if !suggestions.isEmpty {
                ChipFlow(spacing: 7, lineSpacing: 7) {
                    ForEach(suggestions, id: \.self) { s in
                        Button { onAccept(s) } label: {
                            Label("✨ \(s)", systemImage: "plus")
                                .font(.system(size: 11.5, weight: .bold)).foregroundStyle(NK.ai)
                                .labelStyle(.titleOnly)
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(NK.ai.opacity(0.1)).clipShape(Capsule())
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
