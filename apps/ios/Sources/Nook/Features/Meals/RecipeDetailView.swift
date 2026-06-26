import SwiftUI

/// Full-screen recipe detail: hero, title + metadata/tag chips, a cooked tally, a
/// Cook button, the ingredient list with a servings scaler, an "on hand" banner,
/// the numbered method steps (each with an add/edit note), and your-notes. Tags
/// and notes are editable from the phone (read-modify-write the recipe's overrides
/// blob — see `NookAPI.updateRecipe`). Mirrors the kiosk `RecipeView`.
struct RecipeDetailView: View {
    let model: RecipesModel

    @State private var recipe: NookAPI.RecipeSummary
    @State private var ingredients: [NookAPI.RecipeIngredientDTO] = []
    @State private var steps: [NookAPI.RecipeStepDTO] = []
    @State private var loading = true
    @State private var error = false
    @State private var servings: Int?
    @State private var cookedMessage: String?
    @State private var userNotesDraft = ""
    @State private var editing = false
    @State private var cookMode = false
    @State private var stepNoteEdit: StepNoteEdit?

    private let api = NookAPI()

    /// When true, jump straight into Cook Mode once the steps load (the iPad Today
    /// card's "Cook Mode" button uses this). Default false — normal callers unaffected.
    let autoCook: Bool

    init(summary: NookAPI.RecipeSummary, model: RecipesModel, autoCook: Bool = false) {
        self.model = model
        self.autoCook = autoCook
        _recipe = State(initialValue: summary)
        _userNotesDraft = State(initialValue: summary.userNotes ?? "")
    }

    private var r: NookAPI.RecipeSummary { recipe }
    private var baseServings: Int { max(1, r.servings ?? 4) }
    private var currentServings: Int { servings ?? baseServings }
    private var ratio: Double { Double(currentServings) / Double(baseServings) }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        ScrollView {
            detailContent.padding(16).padding(.bottom, 110)   // clear the floating tab bar
        }
        .background(NK.canvas)
        .navigationTitle(r.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { toggleFavorite() } label: {
                    Image(systemName: r.isFavorite ? "heart.fill" : "heart")
                        .foregroundStyle(r.isFavorite ? NK.primary : NK.ink2)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { editing = true } label: { Label("Edit recipe", systemImage: "pencil") }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(NK.ink2) }
            }
        }
        .task {
            await loadDetail()
            if autoCook, !steps.isEmpty { cookMode = true }
        }
        .fullScreenCover(isPresented: $editing) {
            RecipeEditorView(mode: .edit(NookAPI.RecipeDetailDTO(recipe: recipe, ingredients: ingredients, steps: steps))) { updated in
                recipe = updated
                model.apply(updated)
                Task { await loadDetail() }
            }
        }
        .fullScreenCover(isPresented: $cookMode) {
            CookModeView(title: r.title, steps: steps, ingredients: ingredients) { markCooked() }
        }
        .sheet(item: $stepNoteEdit) { edit in
            StepNoteSheet(stepNumber: edit.step, note: noteFor(edit.step)) { text in
                saveStepNote(step: edit.step, note: text)
            }
        }
    }

    /// iPhone: one column. iPad: hero/header/cook full width, then ingredients (left)
    /// alongside method + notes (right) — like the web recipe screen, no long scroll.
    @ViewBuilder private var detailContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            hero
            header
            if !steps.isEmpty { cookButton }
            cookedRow
            if loading && ingredients.isEmpty && steps.isEmpty {
                NookLoading(top: 30)
            } else if error {
                Text("Couldn’t load this recipe.").font(.system(size: 14)).foregroundStyle(NK.ink3)
                    .frame(maxWidth: .infinity).padding(.vertical, 20)
            } else if isKiosk {
                HStack(alignment: .top, spacing: 20) {
                    VStack(spacing: 16) {
                        if !ingredients.isEmpty { ingredientsCard; onHandBanner }
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                    VStack(spacing: 16) {
                        if !steps.isEmpty { methodCard }
                        notesCard
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                }
            } else {
                if !ingredients.isEmpty { ingredientsCard; onHandBanner }
                if !steps.isEmpty { methodCard }
                notesCard
            }
        }
    }

    // MARK: sections

    private var hero: some View {
        ZStack {
            RecipeGradient.forCategory(r.category)
            if let urlStr = r.imageUrl, let url = URL(string: urlStr) {
                AsyncImage(url: url) { $0.resizable().scaledToFill() }
                placeholder: { Text(r.emoji ?? RecipeGradient.emoji(r.category)).font(.system(size: 64)) }
            } else {
                Text(r.emoji ?? RecipeGradient.emoji(r.category)).font(.system(size: 64))
            }
        }
        .frame(height: 190).frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(r.title).font(NK.serif(26, .bold)).foregroundStyle(NK.ink)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 14) {
                if let t = r.cookTimeMinutes { metaItem("🕐", "\(t) min") }
                metaItem("🍽️", "Serves \(baseServings)")
                if !steps.isEmpty { metaItem("🪜", "\(steps.count) steps") }
                if let s = r.sourceName { metaItem("📖", s) }
            }

            if !tagChips.isEmpty {
                ChipFlow(spacing: 7, lineSpacing: 7) {
                    ForEach(tagChips) { TagChip(chip: $0) }
                }
            }
        }
    }

    private func metaItem(_ icon: String, _ text: String) -> some View {
        Text("\(icon) \(text)").font(.system(size: 13, weight: .medium)).foregroundStyle(NK.ink2).lineLimit(1)
    }

    private var cookButton: some View {
        Button { cookMode = true } label: {
            HStack(spacing: 7) {
                Text("👨‍🍳").font(.system(size: 16))
                Text("Cook mode").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .background(NK.ink).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var cookedRow: some View {
        HStack {
            if let msg = cookedMessage {
                Text(msg).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.primary)
            } else {
                Text(r.cookedCount > 0 ? "👨‍🍳 Cooked \(r.cookedCount)×" : "Not cooked yet")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(NK.ink3)
            }
            Spacer()
            Button { markCooked() } label: {
                Text("✓ Mark cooked").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink)
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(NK.panel).clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private var ingredientsCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Ingredients").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                    Spacer()
                    servingsScaler
                }
                ForEach(ingredients) { ing in
                    ingredientRow(ing)
                    if ing.id != ingredients.last?.id { Divider().background(NK.hair) }
                }
            }
        }
    }

    private var servingsScaler: some View {
        HStack(spacing: 10) {
            Text("Servings").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
            Button { servings = max(1, currentServings - 1) } label: { scalerGlyph("minus") }
            Text("\(currentServings)").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).frame(minWidth: 18)
            Button { servings = currentServings + 1 } label: { scalerGlyph("plus") }
        }
    }

    private func scalerGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink)
            .frame(width: 26, height: 26).background(NK.panel).clipShape(Circle())
    }

    private func ingredientRow(_ ing: NookAPI.RecipeIngredientDTO) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(amountText(ing)).font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(NK.ink2).frame(width: 62, alignment: .trailing)
            VStack(alignment: .leading, spacing: 2) {
                Text(ing.sub ?? nameText(ing)).font(.system(size: 15)).foregroundStyle(NK.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let sub = ing.sub {
                    Text("↺ instead of \(ing.name)").font(.system(size: 12)).foregroundStyle(NK.ink3)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func amountText(_ ing: NookAPI.RecipeIngredientDTO) -> String {
        guard let amt = ing.amount else { return "" }
        let n = RecipeAmount.format(amt * ratio)
        return n.isEmpty ? "" : n + (ing.unit.map { " \($0)" } ?? "")
    }
    private func nameText(_ ing: NookAPI.RecipeIngredientDTO) -> String {
        if let note = ing.prepNote, !note.isEmpty { return "\(ing.name), \(note)" }
        return ing.name
    }

    private var onHandBanner: some View {
        let onHand = ingredients.filter { $0.isStaple }.count
        let total = ingredients.count
        let missing = ingredients.filter { !$0.isStaple }.map(\.name)
        let subtitle: String = {
            if missing.isEmpty { return "You’ve got everything — happy cooking." }
            let shown = missing.prefix(4).joined(separator: ", ")
            return "Need \(missing.count): \(shown)\(missing.count > 4 ? "…" : "")"
        }()
        return HStack(alignment: .top, spacing: 11) {
            Text("✦").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ai)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(onHand) of \(total) ingredient\(total == 1 ? "" : "s") already on hand")
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink)
                Text(subtitle).font(.system(size: 12)).foregroundStyle(NK.ink2)
            }
            Spacer(minLength: 0)
        }
        .padding(14).background(NK.ai.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
    }

    private var methodCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 16) {
                Text("Method").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                ForEach(steps) { step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(step.stepNumber)").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                            .frame(width: 28, height: 28).background(NK.panel).clipShape(Circle())
                        VStack(alignment: .leading, spacing: 7) {
                            Text(step.instruction).font(.system(size: 15)).foregroundStyle(NK.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            if !step.ingredients.isEmpty {
                                ChipFlow(spacing: 6, lineSpacing: 6) {
                                    ForEach(step.ingredients, id: \.self) { ig in
                                        Text(ig).font(.system(size: 12, weight: .medium))
                                            .foregroundStyle(Color(hex: 0x167A4A))
                                            .padding(.horizontal, 9).padding(.vertical, 4)
                                            .background(Color(hex: 0x167A4A).opacity(0.12)).clipShape(Capsule())
                                    }
                                }
                            }
                            if let note = noteFor(step.stepNumber) {
                                Text("📝 \(note)").font(.system(size: 13)).foregroundStyle(NK.ink2)
                            }
                            Button { stepNoteEdit = StepNoteEdit(step: step.stepNumber) } label: {
                                Text(noteFor(step.stepNumber) == nil ? "＋ Add note" : "Edit note")
                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ai)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var notesCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("📝 Your notes").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                ZStack(alignment: .topLeading) {
                    if userNotesDraft.isEmpty {
                        Text("e.g. doubles well · use less salt · the kids love this one…")
                            .font(.system(size: 14)).foregroundStyle(NK.ink3)
                            .padding(.horizontal, 5).padding(.vertical, 8)
                    }
                    TextEditor(text: $userNotesDraft).font(.system(size: 14)).foregroundStyle(NK.ink)
                        .frame(minHeight: 70).scrollContentBackground(.hidden)
                }
                .padding(.horizontal, 9).padding(.vertical, 3)
                .background(NK.card2).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))

                if userNotesDraft != (r.userNotes ?? "") {
                    Button { saveNotes() } label: {
                        Text("Save notes").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 9)
                            .background(NK.primary).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }

                if let recipeNotes = r.notes, !recipeNotes.isEmpty {
                    DisclosureGroup {
                        Text(recipeNotes).font(.system(size: 13)).foregroundStyle(NK.ink2)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                    } label: {
                        Text("Recipe notes (from the source)").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink2)
                    }
                    .tint(NK.ink2)
                }
            }
        }
    }

    // MARK: tag chips

    private var tagChips: [TagChip.Chip] {
        var out: [TagChip.Chip] = []
        if let c = r.collection { out.append(.init(text: "📁 \(c)", style: .collection)) }
        if let c = r.cuisine { out.append(.init(text: "🌍 \(c)", style: .plain)) }
        if let m = r.mealType { out.append(.init(text: m.replacingOccurrences(of: "-", with: " "), style: .plain)) }
        if let p = r.protein { out.append(.init(text: "🥩 \(p)", style: .plain)) }
        if let b = r.base { out.append(.init(text: "🍚 \(b)", style: .plain)) }
        if let cm = r.cookMethod { out.append(.init(text: "🍳 \(cm)", style: .plain)) }
        if let e = r.effort { out.append(.init(text: "⏱️ \(e)", style: .plain)) }
        for d in r.dietary ?? [] { out.append(.init(text: d, style: .dietary)) }
        for v in r.vegetables ?? [] { out.append(.init(text: "🥬 \(v)", style: .veg)) }
        for t in r.tags ?? [] { out.append(.init(text: "#\(t)", style: .soft)) }
        return out
    }

    // MARK: data + actions

    private func noteFor(_ step: Int) -> String? {
        if let n = recipe.overrides?.stepNotes?[String(step)], !n.isEmpty { return n }
        return steps.first { $0.stepNumber == step }?.note
    }

    private func loadDetail() async {
        loading = true
        do {
            let d = try await api.recipeDetail(id: recipe.id)
            recipe = d.recipe
            ingredients = d.ingredients
            steps = d.steps
            if userNotesDraft.isEmpty { userNotesDraft = d.recipe.userNotes ?? "" }
            self.error = false
        } catch { self.error = true }
        loading = false
    }

    private func toggleFavorite() {
        let next = !recipe.isFavorite
        recipe = recipe.withFavorite(next)
        Task {
            do { let updated = try await api.setRecipeFavorite(id: recipe.id, isFavorite: next); apply(updated) }
            catch { recipe = recipe.withFavorite(!next) }
        }
    }

    private func markCooked() {
        Task {
            guard let updated = try? await api.markRecipeCooked(id: recipe.id) else { return }
            apply(updated)
            withAnimation { cookedMessage = "Marked as cooked — nice work." }
        }
    }

    private func saveNotes() {
        let text = userNotesDraft
        Task {
            if let updated = try? await api.updateRecipe(id: recipe.id, userNotes: text) { apply(updated) }
        }
    }

    private func saveStepNote(step: Int, note: String) {
        var ov = recipe.overrides ?? .init()
        var notes = ov.stepNotes ?? [:]
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { notes[String(step)] = nil } else { notes[String(step)] = trimmed }
        ov.stepNotes = notes.isEmpty ? nil : notes
        patchOverrides(ov)
    }

    private func patchOverrides(_ ov: NookAPI.RecipeOverrides) {
        Task {
            if let updated = try? await api.updateRecipe(id: recipe.id, overrides: ov) { apply(updated) }
        }
    }

    /// Adopt a freshly-patched summary into local state + the library list.
    private func apply(_ updated: NookAPI.RecipeSummary) {
        recipe = updated
        model.apply(updated)
    }

    private struct StepNoteEdit: Identifiable { let step: Int; var id: Int { step } }
}

/// Whole-number + common-fraction amount formatting (½ ¼ ¾ ⅓ ⅔), shared by the
/// detail screen and cook mode.
enum RecipeAmount {
    static func format(_ n: Double) -> String {
        guard n > 0 else { return "" }
        let whole = Int(n.rounded(.down))
        let cents = Int(((n - Double(whole)) * 100).rounded())
        let glyph: String?
        switch cents {
        case 50: glyph = "½"
        case 25: glyph = "¼"
        case 75: glyph = "¾"
        case 33: glyph = "⅓"
        case 67: glyph = "⅔"
        default: glyph = nil
        }
        if let g = glyph { return whole > 0 ? "\(whole)\(g)" : g }
        if cents == 0 || cents == 100 { return "\(Int(n.rounded()))" }
        return String(format: "%g", (n * 100).rounded() / 100)
    }
}

/// A metadata pill on the recipe detail — plain, or tinted for dietary/veg/collection/tag.
struct TagChip: View {
    struct Chip: Identifiable, Hashable {
        let text: String
        let style: Style
        var id: String { "\(style)-\(text)" }
    }
    enum Style { case plain, collection, dietary, veg, soft }
    let chip: Chip

    var body: some View {
        Text(chip.text).font(.system(size: 12, weight: .bold))
            .foregroundStyle(fg)
            .padding(.horizontal, 11).padding(.vertical, 5)
            .background(bg)
            .overlay(chip.style == .soft ? Capsule().strokeBorder(NK.hair, lineWidth: 1) : nil)
            .clipShape(Capsule())
    }

    private var fg: Color {
        switch chip.style {
        case .plain: return NK.ink2
        case .collection: return Color(hex: 0x1559B8)
        case .dietary: return NK.ai
        case .veg: return Color(hex: 0x167A4A)
        case .soft: return NK.ink3
        }
    }
    private var bg: Color {
        switch chip.style {
        case .plain: return NK.panel
        case .collection: return Color(hex: 0x1559B8).opacity(0.12)
        case .dietary: return NK.ai.opacity(0.12)
        case .veg: return Color(hex: 0x167A4A).opacity(0.12)
        case .soft: return .clear
        }
    }
}

/// A small editor for one method step's note.
struct StepNoteSheet: View {
    @Environment(\.dismiss) private var dismiss
    let stepNumber: Int
    @State private var text: String
    @FocusState private var focused: Bool
    let onSave: (String) -> Void

    init(stepNumber: Int, note: String?, onSave: @escaping (String) -> Void) {
        self.stepNumber = stepNumber
        self.onSave = onSave
        _text = State(initialValue: note ?? "")
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: "Note for step \(stepNumber)")
                TextEditor(text: $text).font(.system(size: 16)).foregroundStyle(NK.ink)
                    .focused($focused)
                    .frame(minHeight: 120).scrollContentBackground(.hidden)
                    .padding(10).background(NK.card2)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                Spacer()
            }
            .onAppear { focused = true }
            .padding(20).background(NK.canvas)
            .navigationTitle("Step note").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(text); dismiss() }.fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.height(280), .medium])
    }
}

/// A lightweight tags + dietary editor — add/remove free tags, toggle common
/// dietary flags. Not a full metadata editor; just the bits worth doing on a phone.
struct TagsEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var tags: [String]
    @State private var dietary: Set<String>
    @State private var newTag = ""
    let onSave: ([String], [String]) -> Void

    private static let common = ["vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free", "keto", "paleo", "low-carb"]

    init(tags: [String], dietary: [String], onSave: @escaping ([String], [String]) -> Void) {
        _tags = State(initialValue: tags)
        _dietary = State(initialValue: Set(dietary))
        self.onSave = onSave
    }

    private var dietaryOptions: [String] {
        Array(Set(Self.common).union(dietary)).sorted()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Tags")
                        ChipFlow(spacing: 7, lineSpacing: 7) {
                            ForEach(tags, id: \.self) { t in
                                Button { tags.removeAll { $0 == t } } label: {
                                    HStack(spacing: 5) {
                                        Text("#\(t)").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink)
                                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(NK.ink3)
                                    }
                                    .padding(.horizontal, 11).padding(.vertical, 6)
                                    .background(NK.panel).clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        HStack(spacing: 8) {
                            TextField("Add a tag…", text: $newTag)
                                .font(.system(size: 15)).textInputAutocapitalization(.never)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .background(NK.card2).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                                .onSubmit(addTag)
                            Button(action: addTag) {
                                Image(systemName: "plus").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                                    .frame(width: 38, height: 38).background(NK.primary).clipShape(Circle())
                            }
                            .buttonStyle(.plain).disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Dietary")
                        ChipFlow(spacing: 7, lineSpacing: 7) {
                            ForEach(dietaryOptions, id: \.self) { d in
                                let on = dietary.contains(d)
                                Button { if on { dietary.remove(d) } else { dietary.insert(d) } } label: {
                                    Text(d).font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(on ? NK.ai : NK.ink2)
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(on ? NK.ai.opacity(0.12) : NK.card2)
                                        .overlay(Capsule().strokeBorder(on ? NK.ai.opacity(0.5) : NK.hair, lineWidth: 1))
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("Tags & dietary").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(tags, Array(dietary).sorted()); dismiss() }.fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func addTag() {
        let t = newTag.trimmingCharacters(in: .whitespaces).lowercased()
        guard !t.isEmpty, !tags.contains(t) else { newTag = ""; return }
        tags.append(t); newTag = ""
    }
}

private extension NookAPI.RecipeSummary {
    /// A copy with a flipped favorite flag — for optimistic UI before the PATCH lands.
    func withFavorite(_ value: Bool) -> NookAPI.RecipeSummary {
        NookAPI.RecipeSummary(
            id: id, title: title, emoji: emoji, category: category, prepTimeMinutes: prepTimeMinutes,
            cookTimeMinutes: cookTimeMinutes, servings: servings, imageUrl: imageUrl, sourceName: sourceName,
            isFavorite: value, cookedCount: cookedCount, lastCookedAt: lastCookedAt, mealType: mealType,
            protein: protein, base: base, cuisine: cuisine, effort: effort, cookMethod: cookMethod,
            flavorProfile: flavorProfile,
            dietary: dietary, vegetables: vegetables, collection: collection, tags: tags,
            addedTags: addedTags, notes: notes, userNotes: userNotes, overrides: overrides)
    }
}
