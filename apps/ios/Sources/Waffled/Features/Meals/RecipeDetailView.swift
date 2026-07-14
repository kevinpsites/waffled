import SwiftUI

/// Full-screen recipe detail: hero, title + metadata/tag chips, a cooked tally, a
/// Cook button, the ingredient list with a servings scaler, an "on hand" banner,
/// the numbered method steps (each with an add/edit note), and your-notes. Tags
/// and notes are editable from the phone (read-modify-write the recipe's overrides
/// blob — see `WaffledAPI.updateRecipe`). Mirrors the kiosk `RecipeView`.
struct RecipeDetailView: View {
    let model: RecipesModel
    @Environment(\.dismiss) private var dismiss
    /// Cook Mode is presented from the app root off this store (so it survives
    /// backgrounding); the Cook button just hands it the loaded recipe.
    @Environment(CookSessionStore.self) private var cook

    @State private var recipe: WaffledAPI.RecipeSummary
    @State private var ingredients: [WaffledAPI.RecipeIngredientDTO] = []
    @State private var steps: [WaffledAPI.RecipeStepDTO] = []
    @State private var loading = true
    @State private var error = false
    @State private var servings: Int?
    @State private var cookedMessage: String?
    @State private var confirmingDelete = false
    /// Redesign: tags collapse to 3 + "+N more"; the on-hand banner adds the missing
    /// ingredients to the grocery list.
    @State private var tagsExpanded = false
    @State private var groceryAdded = false
    /// Local check-off (like the web) — tick ingredients as you shop/cook; not persisted.
    @State private var checkedIngredients: Set<String> = []
    @State private var scheduling = false
    @State private var userNotesDraft = ""
    @State private var editing = false
    @State private var stepNoteEdit: StepNoteEdit?
    @State private var subEdit: SubEdit?
    @State private var cookMatches: [WaffledAPI.RecipeMatch] = []
    @State private var showCookSheet = false

    private let api = WaffledAPI()

    /// When true, jump straight into Cook Mode once the steps load (the iPad Today
    /// card's "Cook Mode" button uses this). Default false — normal callers unaffected.
    let autoCook: Bool

    init(summary: WaffledAPI.RecipeSummary, model: RecipesModel, autoCook: Bool = false) {
        self.model = model
        self.autoCook = autoCook
        _recipe = State(initialValue: summary)
        _userNotesDraft = State(initialValue: summary.userNotes ?? "")
    }

    private var r: WaffledAPI.RecipeSummary { recipe }
    private var baseServings: Int { max(1, r.servings ?? 4) }
    private var currentServings: Int { servings ?? baseServings }
    private var ratio: Double { Double(currentServings) / Double(baseServings) }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        ScrollView {
            detailContent.padding(16).padding(.bottom, 110)   // clear the floating tab bar
        }
        .background(WF.canvas)
        .navigationTitle(r.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { toggleFavorite() } label: {
                    Image(systemName: r.isFavorite ? "heart.fill" : "heart")
                        .foregroundStyle(r.isFavorite ? WF.primary : WF.ink2)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { scheduling = true } label: { Label("Schedule…", systemImage: "calendar") }
                    Button { editing = true } label: { Label("Edit recipe", systemImage: "pencil") }
                    Button(role: .destructive) { confirmingDelete = true } label: {
                        Label("Delete recipe", systemImage: "trash")
                    }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(WF.ink2) }
            }
        }
        .task {
            await loadDetail()
            if autoCook, !steps.isEmpty { startCookMode() }
        }
        .fullScreenCover(isPresented: $editing) {
            RecipeEditorView(mode: .edit(WaffledAPI.RecipeDetailDTO(recipe: recipe, ingredients: ingredients, steps: steps))) { updated in
                recipe = updated
                model.apply(updated)
                Task { await loadDetail() }
            }
        }
        .confirmationDialog("Delete this recipe?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete recipe", role: .destructive) { deleteRecipe() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes “\(r.title)” from your recipe library. This can’t be undone.")
        }
        .sheet(item: $stepNoteEdit) { edit in
            StepNoteSheet(stepNumber: edit.step, note: noteFor(edit.step)) { text in
                saveStepNote(step: edit.step, note: text)
            }
        }
        .sheet(item: $subEdit) { edit in
            IngredientSubSheet(ingredientName: edit.name, sub: edit.current) { text in
                saveSub(name: edit.name, value: text)
            }
        }
        .sheet(isPresented: $showCookSheet) {
            CookConfirmSheet(title: recipe.title, matches: cookMatches) { n in
                if n > 0 { withAnimation { cookedMessage = "Marked as cooked — pantry updated." } }
            }
        }
        .sheet(isPresented: $scheduling) {
            RecipeScheduleSheet(title: r.title, recipeId: recipe.id) { label in
                withAnimation { cookedMessage = "Scheduled for \(label)." }
            }
            .presentationDetents([.medium, .large])
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
                WaffledLoading(top: 30)
            } else if error {
                Text("Couldn’t load this recipe.").font(.system(size: 14)).foregroundStyle(WF.ink3)
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
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(r.title).font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 14) {
                // Prep + cook broken out here (the library card shows the combined total).
                if let p = r.prepTimeMinutes { metaItem("🔪", "\(p) min prep") }
                if let c = r.cookTimeMinutes { metaItem("🔥", "\(c) min cook") }
                metaItem("🍽️", "Serves \(baseServings)")
                if !steps.isEmpty { metaItem("🪜", "\(steps.count) steps") }
                if let s = r.sourceName { metaItem("📖", s) }
            }

            tagsSection
        }
    }

    /// Progressive disclosure: show 3 tags + a "+N more" toggle, with #hashtags on a
    /// quiet muted line beneath — so the tags stop shouting over the recipe.
    @ViewBuilder private var tagsSection: some View {
        let all = chipTags
        let shown = tagsExpanded ? all : Array(all.prefix(3))
        let overflow = all.count - shown.count
        if !all.isEmpty || !hashtags.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if !all.isEmpty {
                    ChipFlow(spacing: 7, lineSpacing: 7) {
                        ForEach(shown) { TagChip(chip: $0) }
                        if overflow > 0 || tagsExpanded {
                            Button { withAnimation(.easeInOut(duration: 0.2)) { tagsExpanded.toggle() } } label: {
                                Text(tagsExpanded ? "Show less" : "+\(overflow) more")
                                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                                    .padding(.horizontal, 11).padding(.vertical, 6)
                                    .overlay(Capsule().strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                                        .foregroundStyle(WF.hair))
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if !hashtags.isEmpty {
                    Text(hashtags.map { "#\($0)" }.joined(separator: " · "))
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func metaItem(_ icon: String, _ text: String) -> some View {
        Text("\(icon) \(text)").font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink2).lineLimit(1)
    }

    /// The one primary action — a prominent black pill, the first thing your eye lands on
    /// after the title/tags.
    private var cookButton: some View {
        Button { startCookMode() } label: {
            HStack(spacing: 9) {
                Text("👨‍🍳").font(.system(size: 18))
                Text("Cook Mode").font(.system(size: 16.5, weight: .heavy)).foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 16)
            .background(WF.ink).clipShape(Capsule())
            .shadow(color: .black.opacity(0.18), radius: 12, y: 5)
        }
        .buttonStyle(.plain)
    }

    private var cookedRow: some View {
        HStack {
            if let msg = cookedMessage {
                Text(msg).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.primary)
            } else {
                Text(r.cookedCount > 0 ? "👨‍🍳 Cooked \(r.cookedCount)×" : "Not cooked yet")
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink3)
            }
            Spacer()
            Button { markCooked() } label: {
                Text("✓ Mark cooked").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                    .padding(.horizontal, 13).padding(.vertical, 8)
                    .background(WF.panel).clipShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private var ingredientsCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Ingredients").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                    Spacer()
                    servingsScaler
                }
                ForEach(ingredients) { ing in
                    ingredientRow(ing)
                    if ing.id != ingredients.last?.id { Divider().background(WF.hair) }
                }
            }
        }
    }

    private var servingsScaler: some View {
        HStack(spacing: 10) {
            Text("Servings").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink3)
            Button { servings = max(1, currentServings - 1) } label: { scalerGlyph("minus") }
            Text("\(currentServings)").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).frame(minWidth: 18)
            Button { servings = currentServings + 1 } label: { scalerGlyph("plus") }
        }
    }

    private func scalerGlyph(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink)
            .frame(width: 26, height: 26).background(WF.panel).clipShape(Circle())
    }

    private func ingredientRow(_ ing: WaffledAPI.RecipeIngredientDTO) -> some View {
        let sub = subFor(ing)
        let checked = checkedIngredients.contains(ing.id)
        return HStack(alignment: .top, spacing: 11) {
            Button { toggleChecked(ing.id) } label: {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20)).foregroundStyle(checked ? WF.primary : WF.ink3.opacity(0.55))
            }
            .buttonStyle(.plain)
            // Tapping the amount/name also toggles — bigger target, like the web row.
            Button { toggleChecked(ing.id) } label: {
                HStack(alignment: .top, spacing: 12) {
                    Text(amountText(ing)).font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(WF.ink2).frame(width: 58, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sub ?? nameText(ing)).font(.system(size: 15)).foregroundStyle(WF.ink)
                            .strikethrough(checked, color: WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                        if sub != nil {
                            Text("↺ instead of \(ing.name)").font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { subEdit = SubEdit(name: ing.name, current: sub) } label: {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(sub != nil ? WF.ai : WF.ink3)
                    .frame(width: 30, height: 30)
                    .background(sub != nil ? WF.ai.opacity(0.12) : WF.panel)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .opacity(checked ? 0.6 : 1)
    }

    private func toggleChecked(_ id: String) {
        if checkedIngredients.contains(id) { checkedIngredients.remove(id) }
        else { checkedIngredients.insert(id) }
    }

    private func amountText(_ ing: WaffledAPI.RecipeIngredientDTO) -> String {
        guard let amt = ing.amount else { return "" }
        let n = RecipeAmount.format(amt * ratio)
        return n.isEmpty ? "" : n + (ing.unit.map { " \($0)" } ?? "")
    }
    private func nameText(_ ing: WaffledAPI.RecipeIngredientDTO) -> String {
        if let note = ing.prepNote, !note.isEmpty { return "\(ing.name), \(note)" }
        return ing.name
    }

    /// One quiet line in card tone: how many are on hand + what's missing, with a single
    /// "Add to grocery" action for the rest — instead of a loud two-line block.
    private var onHandBanner: some View {
        let onHand = ingredients.filter { $0.isStaple }.count
        let total = ingredients.count
        let missing = ingredients.filter { !$0.isStaple }.map(\.name)
        let tail: String = {
            if missing.isEmpty { return " on hand — you’ve got everything" }
            let shown = missing.prefix(3).joined(separator: ", ")
            let extra = missing.count > 3 ? " +\(missing.count - 3) more" : ""
            return " on hand — need \(shown)\(extra)"
        }()
        return HStack(spacing: 11) {
            ZStack {
                Circle().fill(WF.ai)
                Image(systemName: "sparkles").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
            }
            .frame(width: 28, height: 28)
            (Text("\(onHand) of \(total)").font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ai)
                + Text(tail).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink2))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if !missing.isEmpty {
                Button { addMissingToGrocery(missing) } label: {
                    Text(groceryAdded ? "Added ✓" : "Add to grocery")
                        .font(.system(size: 12.5, weight: .heavy)).foregroundStyle(WF.primaryD)
                }
                .buttonStyle(.plain).disabled(groceryAdded)
            }
        }
        .padding(13)
        .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func addMissingToGrocery(_ names: [String]) {
        groceryAdded = true
        Task {
            for name in names { try? await api.addGroceryItem(name: name) }
            withAnimation { cookedMessage = "Added \(names.count) to your grocery list." }
        }
    }

    private var methodCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 16) {
                Text("Method").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                ForEach(steps) { step in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(step.stepNumber)").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 28, height: 28).background(WF.panel).clipShape(Circle())
                        VStack(alignment: .leading, spacing: 7) {
                            Text(step.instruction).font(.system(size: 15)).foregroundStyle(WF.ink)
                                .fixedSize(horizontal: false, vertical: true)
                            if !step.ingredients.isEmpty || (step.timerSeconds ?? 0) > 0 {
                                HStack(spacing: 12) {
                                    if !step.ingredients.isEmpty {
                                        (Text("Uses: ").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                                            + Text(step.ingredients.joined(separator: ", ")).font(.system(size: 12.5)).foregroundStyle(WF.ink3))
                                            .lineLimit(1).truncationMode(.tail)
                                    }
                                    Spacer(minLength: 0)
                                    if let secs = step.timerSeconds, secs > 0 {
                                        HStack(spacing: 4) {
                                            Image(systemName: "clock").font(.system(size: 11, weight: .bold))
                                            Text(CookTimer.mmss(secs)).font(.system(size: 12, weight: .bold))
                                        }
                                        .foregroundStyle(WF.ink2).fixedSize()
                                    }
                                }
                            }
                            if let note = noteFor(step.stepNumber) {
                                Text("📝 \(note)").font(.system(size: 13)).foregroundStyle(WF.ink2)
                            }
                            Button { stepNoteEdit = StepNoteEdit(step: step.stepNumber) } label: {
                                Text(noteFor(step.stepNumber) == nil ? "＋ Add note" : "Edit note")
                                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ai)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private var notesCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("📝 Your notes").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                ZStack(alignment: .topLeading) {
                    if userNotesDraft.isEmpty {
                        Text("e.g. doubles well · use less salt · the kids love this one…")
                            .font(.system(size: 14)).foregroundStyle(WF.ink3)
                            .padding(.horizontal, 5).padding(.vertical, 8)
                    }
                    TextEditor(text: $userNotesDraft).font(.system(size: 14)).foregroundStyle(WF.ink)
                        .frame(minHeight: 70).scrollContentBackground(.hidden)
                }
                .padding(.horizontal, 9).padding(.vertical, 3)
                .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))

                if userNotesDraft != (r.userNotes ?? "") {
                    Button { saveNotes() } label: {
                        Text("Save notes").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 9)
                            .background(WF.primary).clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }

                if let recipeNotes = r.notes, !recipeNotes.isEmpty {
                    DisclosureGroup {
                        Text(recipeNotes).font(.system(size: 13)).foregroundStyle(WF.ink2)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                    } label: {
                        Text("Recipe notes (from the source)").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                    }
                    .tint(WF.ink2)
                }
            }
        }
    }

    // MARK: tag chips

    /// The displayable chips (favorites + New lead, then metadata + veg + dietary), most
    /// meaningful first so the 3 shown before "+N more" are the useful ones. Free-text
    /// #hashtags are split out to `hashtags` and shown as a quiet line instead.
    private var chipTags: [TagChip.Chip] {
        var out: [TagChip.Chip] = []
        // Favorite stays the heart in the toolbar (no redundant tag); New leads the row.
        if r.cookedCount == 0 { out.append(.init(text: "🆕 New", style: .new)) }
        if let e = r.effort { out.append(.init(text: "⏱️ \(e)", style: .plain)) }
        for v in r.vegetables ?? [] { out.append(.init(text: "🥬 \(v)", style: .veg)) }
        if let c = r.collection { out.append(.init(text: "📁 \(c)", style: .collection)) }
        if let c = r.cuisine { out.append(.init(text: "🌍 \(c)", style: .plain)) }
        if let m = r.mealType { out.append(.init(text: m.replacingOccurrences(of: "-", with: " "), style: .plain)) }
        if let p = r.protein { out.append(.init(text: "🥩 \(p)", style: .plain)) }
        if let b = r.base { out.append(.init(text: "🍚 \(b)", style: .plain)) }
        if let cm = r.cookMethod { out.append(.init(text: "🍳 \(cm)", style: .plain)) }
        for d in r.dietary ?? [] { out.append(.init(text: d, style: .dietary)) }
        return out
    }

    private var hashtags: [String] { r.tags ?? [] }

    // MARK: data + actions

    private func noteFor(_ step: Int) -> String? {
        if let n = recipe.overrides?.stepNotes?[String(step)], !n.isEmpty { return n }
        return steps.first { $0.stepNumber == step }?.note
    }

    /// The current substitution for an ingredient, read from the authoritative
    /// overrides blob (keyed by the same lowercased name the server uses) so it
    /// reflects an edit immediately — and a *cleared* sub correctly shows nothing.
    private func subFor(_ ing: WaffledAPI.RecipeIngredientDTO) -> String? {
        let key = ing.name.trimmingCharacters(in: .whitespaces).lowercased()
        if let s = recipe.overrides?.subs?[key], !s.isEmpty { return s }
        return nil
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

    /// Hand the loaded recipe to the app-level cook session, which presents Cook Mode
    /// from the root (durable across backgrounding).
    private func startCookMode() {
        guard !steps.isEmpty else { return }
        cook.start(id: recipe.id, title: r.title, steps: steps, ingredients: ingredients)
    }

    private func markCooked() {
        Task {
            guard let updated = try? await api.markRecipeCooked(id: recipe.id) else { return }
            apply(updated)
            withAnimation { cookedMessage = "Marked as cooked — nice work." }
            // If the pantry has on-hand items this recipe likely used, offer to update it.
            if let m = try? await api.pantryForRecipe(recipeId: recipe.id), !m.isEmpty {
                cookMatches = m
                showCookSheet = true
            }
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

    private func saveSub(name: String, value: String) {
        var ov = recipe.overrides ?? .init()
        var subs = ov.subs ?? [:]
        let key = name.trimmingCharacters(in: .whitespaces).lowercased()
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { subs[key] = nil } else { subs[key] = trimmed }
        ov.subs = subs.isEmpty ? nil : subs
        patchOverrides(ov)
    }

    private func patchOverrides(_ ov: WaffledAPI.RecipeOverrides) {
        Task {
            if let updated = try? await api.updateRecipe(id: recipe.id, overrides: ov) { apply(updated) }
        }
    }

    /// Adopt a freshly-patched summary into local state + the library list.
    private func apply(_ updated: WaffledAPI.RecipeSummary) {
        recipe = updated
        model.apply(updated)
    }

    /// Delete the recipe, drop it from the library, and pop back to it.
    private func deleteRecipe() {
        Task {
            do {
                try await api.deleteRecipe(id: r.id)
                model.remove(id: r.id)
                dismiss()
            } catch {
                withAnimation { cookedMessage = "Couldn’t delete the recipe. Try again." }
            }
        }
    }

    private struct StepNoteEdit: Identifiable { let step: Int; var id: Int { step } }
    private struct SubEdit: Identifiable { let name: String; let current: String?; var id: String { name } }
}

/// Schedule a recipe onto a day + meal slot (this/next week), mirroring the web
/// ScheduleModal — a meal-type picker + a week you can page through + a 7-day grid.
/// Tapping a day plans it via `/api/meals/plan` and dismisses.
struct RecipeScheduleSheet: View {
    let title: String
    let recipeId: String
    var onScheduled: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    private let api = WaffledAPI()
    @State private var meal = "dinner"
    @State private var weekOffset = 0
    @State private var savingDay: String?

    private static let meals = ["breakfast", "lunch", "dinner", "snack"]
    private static let ymdFmt: DateFormatter = {
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f
    }()

    private var weekStart: Date {
        let cal = Cal.current
        let today = cal.startOfDay(for: Date())
        let sunday = cal.date(byAdding: .day, value: -(cal.component(.weekday, from: today) - 1), to: today)!
        return cal.date(byAdding: .day, value: weekOffset * 7, to: sunday)!
    }
    private var days: [Date] { (0..<7).compactMap { Cal.current.date(byAdding: .day, value: $0, to: weekStart) } }
    private var weekLabel: String {
        if weekOffset == 0 { return "This week" }
        if weekOffset == 1 { return "Next week" }
        return weekStart.formatted(.dateTime.month(.abbreviated).day())
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Schedule").font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink3).tracking(0.4)
                    Text(title).font(WF.serif(22, .bold)).foregroundStyle(WF.ink).lineLimit(2)
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel(text: "Meal")
                    Picker("", selection: $meal) {
                        ForEach(Self.meals, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }

                HStack {
                    Button { weekOffset = max(0, weekOffset - 1) } label: {
                        Image(systemName: "chevron.left").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 34, height: 34).background(WF.panel).clipShape(Circle())
                    }.buttonStyle(.plain).disabled(weekOffset == 0).opacity(weekOffset == 0 ? 0.4 : 1)
                    Text(weekLabel).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        .frame(maxWidth: .infinity)
                    Button { weekOffset += 1 } label: {
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                            .frame(width: 34, height: 34).background(WF.panel).clipShape(Circle())
                    }.buttonStyle(.plain)
                }

                HStack(spacing: 6) {
                    ForEach(days, id: \.self) { day in dayButton(day) }
                }

                Spacer(minLength: 0)
            }
            .padding(20)
            .background(WF.canvas)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func dayButton(_ day: Date) -> some View {
        let key = Self.ymdFmt.string(from: day)
        let saving = savingDay == key
        return Button { schedule(day) } label: {
            VStack(spacing: 3) {
                Text(String(day.formatted(.dateTime.weekday(.abbreviated)).prefix(2)).uppercased())
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(saving ? .white : WF.ink3)
                Text(day.formatted(.dateTime.day())).font(WF.serif(17, .bold)).foregroundStyle(saving ? .white : WF.ink)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 10)
            .background(saving ? FamilyColor.wally.solid : WF.card2)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(savingDay != nil)
    }

    private func schedule(_ day: Date) {
        guard savingDay == nil else { return }
        let key = Self.ymdFmt.string(from: day)
        savingDay = key
        Task {
            do {
                try await api.planMeal(date: key, mealType: meal, recipeId: recipeId, title: nil)
                onScheduled("\(day.formatted(.dateTime.weekday(.wide))) \(meal)")
                dismiss()
            } catch {
                savingDay = nil
            }
        }
    }
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
    enum Style { case plain, collection, dietary, veg, soft, new }
    let chip: Chip

    var body: some View {
        Text(chip.text).font(.system(size: 12, weight: .bold))
            .foregroundStyle(fg)
            .padding(.horizontal, 11).padding(.vertical, 5)
            .background(bg)
            .overlay(chip.style == .soft ? Capsule().strokeBorder(WF.hair, lineWidth: 1) : nil)
            .clipShape(Capsule())
    }

    private var fg: Color {
        switch chip.style {
        case .plain: return WF.ink2
        case .collection: return Color(hex: 0x1559B8)
        case .dietary: return WF.ai
        case .veg: return Color(hex: 0x167A4A)
        case .soft: return WF.ink3
        case .new: return WF.primary
        }
    }
    private var bg: Color {
        switch chip.style {
        case .plain: return WF.panel
        case .collection: return Color(hex: 0x1559B8).opacity(0.12)
        case .dietary: return WF.ai.opacity(0.12)
        case .veg: return Color(hex: 0x167A4A).opacity(0.12)
        case .soft: return .clear
        case .new: return WF.primary.opacity(0.12)
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
                TextEditor(text: $text).font(.system(size: 16)).foregroundStyle(WF.ink)
                    .focused($focused)
                    .frame(minHeight: 120).scrollContentBackground(.hidden)
                    .padding(10).background(WF.card2)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                Spacer()
            }
            .onAppear { focused = true }
            .padding(20).background(WF.canvas)
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

/// A small editor for one ingredient's substitution ("use X instead"). Writes the
/// recipe's `overrides.subs` blob — the same field the web kiosk edits, so it flows
/// straight into the substitution-aware grocery build. Empty = use the original.
struct IngredientSubSheet: View {
    @Environment(\.dismiss) private var dismiss
    let ingredientName: String
    @State private var text: String
    @FocusState private var focused: Bool
    let onSave: (String) -> Void

    init(ingredientName: String, sub: String?, onSave: @escaping (String) -> Void) {
        self.ingredientName = ingredientName
        self.onSave = onSave
        _text = State(initialValue: sub ?? "")
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Substitute for \(ingredientName)")
                TextField("e.g. olive oil", text: $text)
                    .font(.system(size: 16)).foregroundStyle(WF.ink)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .padding(14).background(WF.card2)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                    .onSubmit { onSave(text); dismiss() }
                Text("Swaps this ingredient in the recipe and on the grocery list. Leave empty to use the original.")
                    .font(.system(size: 12)).foregroundStyle(WF.ink3)
                if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button { onSave(""); dismiss() } label: {
                        Text("↺ Use the original (\(ingredientName))")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ai)
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .onAppear { focused = true }
            .padding(20).background(WF.canvas)
            .navigationTitle("Substitution").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(text); dismiss() }.fontWeight(.semibold)
                }
            }
        }
        .presentationDetents([.height(300), .medium])
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
                                        Text("#\(t)").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
                                    }
                                    .padding(.horizontal, 11).padding(.vertical, 6)
                                    .background(WF.panel).clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        HStack(spacing: 8) {
                            TextField("Add a tag…", text: $newTag)
                                .font(.system(size: 15)).textInputAutocapitalization(.never)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                                .onSubmit(addTag)
                            Button(action: addTag) {
                                Image(systemName: "plus").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                                    .frame(width: 38, height: 38).background(WF.primary).clipShape(Circle())
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
                                        .foregroundStyle(on ? WF.ai : WF.ink2)
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(on ? WF.ai.opacity(0.12) : WF.card2)
                                        .overlay(Capsule().strokeBorder(on ? WF.ai.opacity(0.5) : WF.hair, lineWidth: 1))
                                        .clipShape(Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
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

private extension WaffledAPI.RecipeSummary {
    /// A copy with a flipped favorite flag — for optimistic UI before the PATCH lands.
    func withFavorite(_ value: Bool) -> WaffledAPI.RecipeSummary {
        WaffledAPI.RecipeSummary(
            id: id, title: title, emoji: emoji, category: category, prepTimeMinutes: prepTimeMinutes,
            cookTimeMinutes: cookTimeMinutes, servings: servings, imageUrl: imageUrl, sourceName: sourceName,
            isFavorite: value, cookedCount: cookedCount, lastCookedAt: lastCookedAt, mealType: mealType,
            protein: protein, base: base, cuisine: cuisine, effort: effort, cookMethod: cookMethod,
            flavorProfile: flavorProfile,
            dietary: dietary, vegetables: vegetables, collection: collection, tags: tags,
            addedTags: addedTags, notes: notes, userNotes: userNotes, overrides: overrides)
    }
}
