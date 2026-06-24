import SwiftUI

/// The AI "Plan my week ✨" flow. A short config (meal · days · who you're cooking
/// for · keep-in-mind · use-up) → `POST /api/meals/plan-week` → a review of the
/// per-night cards you curate the way the web kiosk does: **lock** a night you like,
/// **swap** to let the AI re-roll one night, manually **pick** a recipe, or
/// **reshuffle** every unlocked night. Nothing is saved until you tap Add; then each
/// card is applied via `SyncManager.setMealPlan` and the grocery list is rebuilt.
struct PlanWeekSheet: View {
    let start: String
    let weekLabel: String
    /// The seven days of the week being planned (in household order, Sun→Sat).
    let weekDays: [Date]
    /// Household size — labels the "whole family" cooking-for option.
    let familySize: Int
    /// The Recipes library, reused by the manual-pick sheet.
    let recipes: RecipesModel
    /// Called after suggestions are applied, so the planner reloads.
    let onApplied: () -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case config, loading, review, empty, failed }
    private let mealTypes = ["breakfast", "lunch", "dinner"]

    @State private var phase: Phase = .config
    @State private var mealType = "dinner"
    @State private var selectedDays: Set<String> = []   // ymd; seeded Mon–Fri on appear
    @State private var cookingFor = 0                    // 0 ⇒ whole family
    @State private var keepInMind = ""
    @State private var useUp: [String] = []
    @State private var useUpInput = ""
    @State private var suggestions: [NookAPI.PlanCardDTO] = []
    @State private var locked: Set<String> = []          // dates the user won't reshuffle
    @State private var rejected: Set<String> = []         // dish titles shuffled away (kept out)
    @State private var draftingDates: Set<String> = []    // nights being (re)drafted
    @State private var redrafting = false                 // a reshuffle/swap is in flight
    @State private var pickTarget: PickTarget?            // manual-pick sheet
    @State private var via: String?
    @State private var errorMessage: String?
    @State private var notice: String?                    // transient re-roll feedback
    @State private var applying = false
    @State private var dragOverDate: String?              // review card under a drag

    private let api = NookAPI()

    struct PickTarget: Identifiable { let date: String; var id: String { date } }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        NavigationStack {
            content
                .background(NK.canvas)
                .navigationTitle("Plan my week").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
        .task { seedDaysIfNeeded() }
        .sheet(item: $pickTarget) { target in
            RecipePickerSheet(model: recipes) { recipe in pickRecipe(date: target.date, recipe) }
        }
    }

    /// iPad: a wide two-column sheet — requirements on the left, the AI-drafted meals
    /// on the right (web-style). iPhone: the sequential config → result phases.
    @ViewBuilder private var content: some View {
        if isKiosk {
            HStack(spacing: 0) {
                configView.frame(width: 300)
                Divider()
                kioskResultPane.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            phaseView
        }
    }

    @ViewBuilder private var phaseView: some View {
        switch phase {
        case .config: configView
        case .loading: loadingView
        case .review: reviewView
        case .empty: PlanMessageView(emoji: "🎉", title: "Every night this week is already planned.", subtitle: "Nothing to suggest — you’re all set.")
        case .failed: PlanMessageView(emoji: "😕", title: "Couldn’t plan the week", subtitle: errorMessage ?? "The AI provider didn’t respond. Try again.", onRetry: { phase = .config })
        }
    }

    @ViewBuilder private var kioskResultPane: some View {
        switch phase {
        case .config:
            VStack(spacing: 12) {
                Text("✨").font(.system(size: 40))
                Text("Draft your week").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                Text("Set the meal, days, and any notes on the left, then tap Plan my week.")
                    .font(.system(size: 13)).foregroundStyle(NK.ink3)
                    .multilineTextAlignment(.center).padding(.horizontal, 40)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading: loadingView
        case .review: reviewView
        case .empty: PlanMessageView(emoji: "🎉", title: "Every night this week is already planned.", subtitle: "Nothing to suggest — you’re all set.")
        case .failed: PlanMessageView(emoji: "😕", title: "Couldn’t plan the week", subtitle: errorMessage ?? "The AI provider didn’t respond. Try again.", onRetry: { phase = .config })
        }
    }

    /// Default to weekdays (Mon–Fri), matching the web kiosk.
    private func seedDaysIfNeeded() {
        guard selectedDays.isEmpty else { return }
        for d in weekDays where (2...6).contains(cal.component(.weekday, from: d)) {
            selectedDays.insert(ymd(d))
        }
    }

    // MARK: config

    private var configView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Tell Nook the guardrails — it drafts the meals and the grocery list in one go.")
                        .font(.system(size: 14)).foregroundStyle(NK.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    // Plan which meal?
                    NookCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Plan which meal?").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                            HStack(spacing: 0) {
                                ForEach(mealTypes, id: \.self) { m in
                                    Button { mealType = m } label: {
                                        Text(m.capitalized)
                                            .font(.system(size: 14, weight: mealType == m ? .bold : .medium))
                                            .foregroundStyle(mealType == m ? NK.ink : NK.ink3)
                                            .frame(maxWidth: .infinity).padding(.vertical, 9)
                                            .background(
                                                mealType == m
                                                    ? AnyView(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).fill(NK.card)
                                                        .shadow(color: .black.opacity(0.06), radius: 3, y: 1))
                                                    : AnyView(Color.clear))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(3).background(NK.panel)
                            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                        }
                    }

                    // Which days?
                    NookCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Which days?").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                            HStack(spacing: 6) {
                                ForEach(weekDays, id: \.self) { d in dayChip(d) }
                            }
                        }
                    }

                    // Cooking for
                    NookCard(padding: 14) {
                        HStack {
                            Text("Cooking for").font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Spacer()
                            Menu {
                                Button { cookingFor = 0 } label: { Text("\(familySize) · whole family") }
                                ForEach(1...8, id: \.self) { n in
                                    Button { cookingFor = n } label: { Text("\(n)") }
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Text(cookingForLabel).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink3)
                                }
                                .padding(.horizontal, 14).padding(.vertical, 9)
                                .background(NK.panel).clipShape(Capsule())
                            }
                        }
                    }

                    // Use up first
                    UseUpCard(items: $useUp, input: $useUpInput)

                    // Keep in mind
                    NookCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Keep in mind").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink)
                            TextField("e.g. Lottie skips spicy · Tue & Thu are busy — keep under 30 min",
                                      text: $keepInMind, axis: .vertical)
                                .font(.system(size: 14)).lineLimit(2...4)
                                .padding(.horizontal, 12).padding(.vertical, 10)
                                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                        }
                    }
                }
                .padding(20)
            }
            suggestBar
        }
    }

    private var suggestBar: some View {
        VStack(spacing: 0) {
            Divider().background(NK.hair)
            Button { Task { await suggest() } } label: {
                Text("✨ Plan my week").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(selectedDays.isEmpty ? NK.ink3 : NK.ai)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(selectedDays.isEmpty)
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(NK.canvas)
    }

    private func dayChip(_ d: Date) -> some View {
        let key = ymd(d)
        // 3-letter weekday (Sun/Mon/…) to match the Plan-my-month selector exactly.
        return WeekdayToggleChip(label: DateFmt.string(d, "EEE", sync.householdTz), isOn: selectedDays.contains(key)) {
            if selectedDays.contains(key) { selectedDays.remove(key) } else { selectedDays.insert(key) }
        }
    }

    /// Fold a half-typed use-up entry into the chips (used before drafting). Mirrors
    /// `UseUpCard`'s own add logic so a pending input isn't lost on Plan.
    private func addUseUp() {
        let v = useUpInput.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, !useUp.contains(v), useUp.count < 12 else { useUpInput = ""; return }
        useUp.append(v); useUpInput = ""
    }

    private var cookingForLabel: String {
        cookingFor == 0 ? "\(familySize) · whole family" : "\(cookingFor)"
    }

    // MARK: loading

    private var loadingView: some View {
        PlanLoadingView(title: "Drafting your week…",
                        subtitle: "Asking the kitchen AI — this can take a moment on a local model.")
    }

    // MARK: review

    private var reviewView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 10) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Here’s your week").font(NK.serif(17, .bold)).foregroundStyle(NK.ink)
                            if let via { Text("Drafted via \(viaLabel(via))")
                                .font(.system(size: 11, weight: .semibold)).foregroundStyle(NK.ink3) }
                        }
                        Spacer()
                        Button { Task { await reshuffle() } } label: {
                            HStack(spacing: 6) {
                                if redrafting && draftingDates.count > 1 {
                                    ProgressView().controlSize(.small).tint(NK.ai)
                                } else { Text("✨").font(.system(size: 13)) }
                                Text(redrafting && draftingDates.count > 1 ? "Reshuffling…" : "Reshuffle")
                                    .font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ai)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(NK.ai.opacity(0.10)).clipShape(Capsule())
                        }
                        .buttonStyle(.plain).disabled(redrafting || unlockedDates.isEmpty)
                    }
                    if let notice {
                        HStack(spacing: 7) {
                            Image(systemName: "info.circle.fill").font(.system(size: 12))
                            Text(notice).font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(NK.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(NK.primary.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                    }
                    if isKiosk {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 12, alignment: .top)],
                                  alignment: .leading, spacing: 12) {
                            ForEach(suggestions) { card in suggestionCard(card) }
                        }
                    } else {
                        ForEach(suggestions) { card in suggestionCard(card) }
                    }
                    Text("Lock the nights you love, swap or pick the rest.")
                        .font(.system(size: 12)).foregroundStyle(NK.ink3)
                        .frame(maxWidth: .infinity, alignment: .center).padding(.top, 2)
                }
                .padding(16)
            }
            applyBar
        }
    }

    private var unlockedDates: [String] { suggestions.map(\.date).filter { !locked.contains($0) } }

    private func suggestionCard(_ card: NookAPI.PlanCardDTO) -> some View {
        let isLocked = locked.contains(card.date)
        let busy = draftingDates.contains(card.date)
        return VStack(spacing: 10) {
            HStack(spacing: 12) {
                Text(card.emoji ?? "🍽️").font(.system(size: 26))
                    .frame(width: 46, height: 46).background(RecipeGradient.forCategory(card.mealType))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(weekday(card.date)).font(.system(size: 11, weight: .heavy)).tracking(0.5).foregroundStyle(NK.ink3)
                    Text(card.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                        .lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        if let m = card.minutes { PlanTag(text: "🕐 \(m)m") }
                        PlanTag(text: card.recipeId != nil ? "📖 From library" : "✨ New dish")
                    }
                    if let note = card.note, !note.isEmpty {
                        Text(note).font(.system(size: 12)).foregroundStyle(NK.ink3).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            Divider().background(NK.hair)
            HStack(spacing: 8) {
                PlanActionChip(icon: "arrow.triangle.2.circlepath", label: "Swap") { Task { await swap(card) } }
                    .disabled(redrafting || isLocked)
                PlanActionChip(icon: "book", label: "Pick") { pickTarget = PickTarget(date: card.date) }
                    .disabled(redrafting || isLocked)
                Spacer()
                Button { toggleLock(card.date) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: isLocked ? "lock.fill" : "lock.open")
                            .font(.system(size: 12, weight: .bold))
                        Text(isLocked ? "Locked" : "Lock").font(.system(size: 12, weight: .bold)).lineLimit(1).fixedSize()
                    }
                    .foregroundStyle(isLocked ? .white : NK.ink2)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(isLocked ? NK.primary : NK.panel).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(13)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(isLocked ? NK.primary.opacity(0.45) : NK.hair, lineWidth: 1))
        .overlay {
            if busy {
                RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).fill(NK.card.opacity(0.7))
                    .overlay(ProgressView().controlSize(.small).tint(NK.ai))
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isLocked)
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(dragOverDate == card.date ? NK.ai : .clear, lineWidth: 2))
        .draggable(card.date) { PlanCardDragPreview(card: card) }
        .dropDestination(for: String.self) { items, _ in
            guard let s = items.first else { return false }
            swapCards(s, card.date); return true
        } isTargeted: { over in dragOverDate = over ? card.date : (dragOverDate == card.date ? nil : dragOverDate) }
    }

    /// Swap the meals on two review nights (keeps each card's date).
    private func swapCards(_ srcDate: String, _ tgtDate: String) {
        guard srcDate != tgtDate,
              !locked.contains(srcDate), !locked.contains(tgtDate),   // locked nights don't move
              let i = suggestions.firstIndex(where: { $0.date == srcDate }),
              let j = suggestions.firstIndex(where: { $0.date == tgtDate }) else { return }
        let a = suggestions[i], b = suggestions[j]
        suggestions[i] = NookAPI.PlanCardDTO(date: a.date, mealType: a.mealType, title: b.title, recipeId: b.recipeId,
                                             emoji: b.emoji, minutes: b.minutes, servings: b.servings, note: b.note)
        suggestions[j] = NookAPI.PlanCardDTO(date: b.date, mealType: b.mealType, title: a.title, recipeId: a.recipeId,
                                             emoji: a.emoji, minutes: a.minutes, servings: a.servings, note: a.note)
    }

    private var applyBar: some View {
        VStack(spacing: 0) {
            Divider().background(NK.hair)
            Button { Task { await apply() } } label: {
                HStack(spacing: 8) {
                    if applying { ProgressView().controlSize(.small).tint(.white) }
                    Text(applying ? "Adding…" : "Add \(suggestions.count) & build list")
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(suggestions.isEmpty ? NK.ink3 : NK.ai)
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(suggestions.isEmpty || applying || redrafting)
            .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .background(NK.canvas)
    }

    // MARK: actions

    private func suggest() async {
        addUseUp()   // fold any half-typed entry into the chips
        await draft(dates: selectedDays.sorted(), avoid: Array(rejected), full: true)
    }

    /// Draft (or re-draft) the given nights. `full` drives the whole-screen loading
    /// state for the first run; partial re-drafts (swap/reshuffle) keep the review
    /// up and show a per-night spinner instead. Results merge into `suggestions`.
    ///
    /// Weak local models sometimes echo a dish that's *in* the avoid list (so a swap
    /// would change nothing) or skip a requested night. We repair both client-side:
    /// any night the model can't give a fresh, non-duplicate dish for is filled from
    /// the household's own recipe library, so a swap/reshuffle always moves.
    private func draft(dates: [String], avoid: [String], full: Bool) async {
        guard !dates.isEmpty else { return }
        notice = nil
        if full { phase = .loading } else { redrafting = true; draftingDates = Set(dates) }
        defer { redrafting = false; draftingDates = [] }
        do {
            let result = try await api.planWeek(
                start: start, mealType: mealType, dates: dates,
                cookingFor: cookingFor > 0 ? cookingFor : nil,
                keepInMind: keepInMind, useUp: Array(useUp.prefix(12)), avoidTitles: avoid)
            via = result.via
            if let err = result.error, result.suggestions.isEmpty {
                errorMessage = friendly(err); if full { phase = .failed }
                return
            }

            let prior = suggestions
            let avoidSet = Set(avoid.map(normTitle))
            var byDate: [String: NookAPI.PlanCardDTO] = [:]
            for c in result.suggestions where dates.contains(c.date) { byDate[c.date] = c }
            // Off-limits: dishes on nights we're keeping, plus everything avoided —
            // so each night stays distinct.
            var used = Set(suggestions.filter { !dates.contains($0.date) }.map { normTitle($0.title) })
                .union(avoidSet)

            var resolved: [NookAPI.PlanCardDTO] = []
            for date in dates.sorted() {
                let m = byDate[date]
                if let m, !used.contains(normTitle(m.title)) {
                    resolved.append(m); used.insert(normTitle(m.title))
                } else if let fb = libraryFallback(date: date, used: used) {
                    resolved.append(fb); used.insert(normTitle(fb.title))
                } else if let m {
                    resolved.append(m); used.insert(normTitle(m.title))   // nothing fresher available
                }
            }

            guard !resolved.isEmpty else { if full { phase = .empty }; return }
            let kept = suggestions.filter { !dates.contains($0.date) }
            suggestions = (kept + resolved).sorted { $0.date < $1.date }
            phase = .review

            if !full {
                let changed = resolved.contains { new in
                    prior.first { $0.date == new.date }.map { normTitle($0.title) != normTitle(new.title) } ?? true
                }
                if !changed { notice = "No fresh options left for that night — tap Pick to choose any recipe." }
            }
        } catch {
            errorMessage = "The AI provider didn’t respond. Check your connection and try again."
            if full { phase = .failed }
        }
    }

    /// Normalize a title for de-duping (mirrors the server's matcher).
    private func normTitle(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }

    /// A library recipe whose title isn't already used/avoided this week, as a card.
    private func libraryFallback(date: String, used: Set<String>) -> NookAPI.PlanCardDTO? {
        guard let r = recipes.recipes.first(where: { !used.contains(normTitle($0.title)) }) else { return nil }
        return NookAPI.PlanCardDTO(
            date: date, mealType: mealType, title: r.title, recipeId: r.id, emoji: r.emoji,
            minutes: r.cookTimeMinutes, servings: cookingFor > 0 ? cookingFor : familySize,
            note: "From your library")
    }

    /// Re-roll every unlocked night, keeping locked picks and steering away from
    /// dishes already shown (so they don't reappear).
    private func reshuffle() async {
        let dates = unlockedDates.sorted()
        for c in suggestions where dates.contains(c.date) { rejected.insert(c.title) }
        let lockedTitles = suggestions.filter { locked.contains($0.date) }.map(\.title)
        await draft(dates: dates, avoid: Array(rejected) + lockedTitles, full: false)
    }

    /// Re-roll a single night.
    private func swap(_ card: NookAPI.PlanCardDTO) async {
        rejected.insert(card.title)
        let others = suggestions.filter { $0.date != card.date }.map(\.title)
        await draft(dates: [card.date], avoid: Array(rejected) + others, full: false)
    }

    /// Replace a night with a hand-picked library recipe.
    private func pickRecipe(date: String, _ r: NookAPI.RecipeSummary) {
        if let old = suggestions.first(where: { $0.date == date }) { rejected.insert(old.title) }
        let card = NookAPI.PlanCardDTO(
            date: date, mealType: mealType, title: r.title, recipeId: r.id, emoji: r.emoji,
            minutes: r.cookTimeMinutes, servings: cookingFor > 0 ? cookingFor : familySize, note: "Your pick")
        suggestions = suggestions.map { $0.date == date ? card : $0 }.sorted { $0.date < $1.date }
        notice = nil
        pickTarget = nil
    }

    private func toggleLock(_ date: String) {
        if locked.contains(date) { locked.remove(date) } else { locked.insert(date) }
    }

    private func apply() async {
        applying = true
        for card in suggestions {
            _ = await sync.setMealPlan(date: card.date, mealType: card.mealType,
                                       recipeId: card.recipeId,
                                       title: card.recipeId == nil ? card.title : nil)
        }
        // "& build list" — rebuild the grocery list from the newly planned week.
        await sync.rebuildGroceryFromWeek(weekStart: start)
        applying = false
        onApplied()
        dismiss()
    }

    // MARK: date helpers

    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = sync.householdTz; return c
    }
    private func ymd(_ d: Date) -> String { DateFmt.string(d, "yyyy-MM-dd", sync.householdTz) }
    /// Narrow weekday: S M T W T F S

    // MARK: helpers

    private func friendly(_ err: String) -> String {
        err == "AIUnavailable" || err == "No AI provider configured"
            ? "No AI provider is set up. Choose one in Settings → AI & capture."
            : err
    }
    private func viaLabel(_ v: String) -> String {
        switch v { case "anthropic": return "Claude"; case "openai": return "OpenAI"
        case "ollama", "local": return "local AI"; default: return v }
    }
    private func weekday(_ ymd: String) -> String {
        guard let d = DateFmt.date(ymd, "yyyy-MM-dd", sync.householdTz) else { return ymd }
        return DateFmt.string(d, "EEE MMM d", sync.householdTz).uppercased()
    }
}
