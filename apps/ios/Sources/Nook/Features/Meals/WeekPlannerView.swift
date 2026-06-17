import SwiftUI

/// The weekly meal planner — a day-by-day view of what's planned, with the ability
/// to plan, change, or clear a dinner. Tapping a planned recipe opens its detail.
/// Reads `GET /api/meals/week`; writes via `SyncManager.setMealPlan/clearMealPlan`
/// (which bump `mealsRev` so the Today card and Recipes screen stay in sync).
struct WeekPlannerView: View {
    let recipes: RecipesModel
    @Binding var path: [MealsRoute]
    @Environment(SyncManager.self) private var sync

    @State private var entries: [NookAPI.WeekEntryDTO] = []
    @State private var weekOffset = 0
    @State private var loading = true
    @State private var picking: PlanTarget?

    private let api = NookAPI()

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                weekHeader
                ForEach(days, id: \.self) { day in dayCard(day) }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: weekOffset) { _, _ in Task { await load() } }
        .onChange(of: sync.mealsRev) { _, _ in Task { await load() } }
        .sheet(item: $picking) { target in
            RecipePickerSheet(recipes: recipes.recipes) { recipe in
                Task {
                    _ = await sync.setMealPlan(date: target.date, mealType: target.mealType,
                                               recipeId: recipe.id, title: nil)
                    await load()
                }
            }
        }
    }

    // MARK: header

    private var weekHeader: some View {
        HStack {
            Button { withAnimation { weekOffset -= 1 } } label: {
                Image(systemName: "chevron.left").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink2)
                    .frame(width: 36, height: 36).background(NK.card).clipShape(Circle())
            }
            .buttonStyle(.plain)
            Spacer()
            VStack(spacing: 1) {
                Text(weekTitle).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                if weekOffset != 0 {
                    Button("Jump to this week") { withAnimation { weekOffset = 0 } }
                        .font(.system(size: 12, weight: .semibold)).tint(NK.primary)
                }
            }
            Spacer()
            Button { withAnimation { weekOffset += 1 } } label: {
                Image(systemName: "chevron.right").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink2)
                    .frame(width: 36, height: 36).background(NK.card).clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 4)
    }

    // MARK: a day

    private func dayCard(_ day: Date) -> some View {
        let ds = ymd(day)
        let dayEntries = entries.filter { $0.date == ds }.sorted { slotOrder($0.mealType) < slotOrder($1.mealType) }
        let isToday = ds == ymd(Date())
        return NookCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(weekday(day)).font(.system(size: 13, weight: .heavy)).tracking(0.6)
                        .foregroundStyle(isToday ? NK.primary : NK.ink2)
                    Text(dayNumber(day)).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                    if isToday {
                        Text("TODAY").font(.system(size: 10, weight: .heavy)).foregroundStyle(NK.primary)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(NK.primary.opacity(0.12)).clipShape(Capsule())
                    }
                    Spacer()
                }
                if dayEntries.isEmpty {
                    planButton(date: ds, mealType: "dinner", label: "Plan dinner")
                } else {
                    ForEach(dayEntries) { entry in entryRow(entry) }
                    if !dayEntries.contains(where: { $0.mealType == "dinner" }) {
                        planButton(date: ds, mealType: "dinner", label: "Plan dinner")
                    }
                }
            }
        }
    }

    private func entryRow(_ e: NookAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 11) {
            Button { open(e) } label: {
                HStack(spacing: 11) {
                    Text(e.recipe?.emoji ?? "🍽️").font(.system(size: 22))
                        .frame(width: 40, height: 40)
                        .background(RecipeGradient.forCategory(e.recipe?.category ?? e.mealType))
                        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(e.displayTitle).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            .lineLimit(1)
                        HStack(spacing: 8) {
                            if e.mealType != "dinner" { metaTag(slotLabel(e.mealType)) }
                            if let t = e.recipe?.cookTimeMinutes { meta("🕐 \(t)m") }
                            if let cook = e.cook?.name { meta("👩‍🍳 \(cook)") }
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            Menu {
                Button { picking = PlanTarget(date: e.date, mealType: e.mealType) } label: {
                    Label("Change", systemImage: "arrow.triangle.2.circlepath")
                }
                Button(role: .destructive) {
                    Task { _ = await sync.clearMealPlan(date: e.date, mealType: e.mealType); await load() }
                } label: { Label("Remove", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink3)
                    .frame(width: 30, height: 30)
            }
        }
    }

    private func planButton(date: String, mealType: String, label: String) -> some View {
        Button { picking = PlanTarget(date: date, mealType: mealType) } label: {
            HStack(spacing: 7) {
                Image(systemName: "plus").font(.system(size: 13, weight: .bold))
                Text(label).font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(NK.ink2)
            .frame(maxWidth: .infinity).padding(.vertical, 11)
            .background(NK.card2)
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(NK.hair))
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func meta(_ t: String) -> some View {
        Text(t).font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3)
    }
    private func metaTag(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
            .padding(.horizontal, 7).padding(.vertical, 2).background(NK.panel).clipShape(Capsule())
    }

    // MARK: actions

    private func open(_ e: NookAPI.WeekEntryDTO) {
        guard let rid = e.recipeId else { return }   // free-text meals have no detail
        let seed = recipes.recipes.first { $0.id == rid } ?? stub(e, id: rid)
        path.append(.recipe(seed))
    }

    private func load() async {
        loading = true
        entries = (try? await api.mealsWeek(start: ymd(weekStart))) ?? []
        loading = false
    }

    /// A minimal RecipeSummary for an instant detail header; the detail screen
    /// reloads the full recipe on appear.
    private func stub(_ e: NookAPI.WeekEntryDTO, id: String) -> NookAPI.RecipeSummary {
        NookAPI.RecipeSummary(
            id: id, title: e.recipe?.title ?? e.displayTitle, emoji: e.recipe?.emoji,
            category: e.recipe?.category, prepTimeMinutes: e.recipe?.prepTimeMinutes,
            cookTimeMinutes: e.recipe?.cookTimeMinutes, servings: e.recipe?.servings,
            imageUrl: e.recipe?.imageUrl, sourceName: nil, isFavorite: false, cookedCount: 0,
            lastCookedAt: nil, mealType: nil, protein: nil, base: nil, cuisine: nil, effort: nil,
            cookMethod: nil, dietary: nil, vegetables: nil, collection: nil, tags: nil,
            addedTags: nil, notes: nil, userNotes: nil, overrides: nil)
    }

    // MARK: date helpers

    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = sync.householdTz; return c
    }
    private var weekStart: Date {
        let base = cal.dateInterval(of: .weekOfYear, for: Date())?.start ?? cal.startOfDay(for: Date())
        return cal.date(byAdding: .weekOfYear, value: weekOffset, to: base) ?? base
    }
    private var days: [Date] { (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: weekStart) } }

    private func fmt(_ d: Date, _ pattern: String) -> String {
        let f = DateFormatter(); f.calendar = cal; f.timeZone = sync.householdTz; f.dateFormat = pattern
        return f.string(from: d)
    }
    private func ymd(_ d: Date) -> String { fmt(d, "yyyy-MM-dd") }
    private func weekday(_ d: Date) -> String { fmt(d, "EEE").uppercased() }
    private func dayNumber(_ d: Date) -> String { fmt(d, "MMM d") }
    private var weekTitle: String {
        guard let last = days.last else { return "" }
        return "\(fmt(weekStart, "MMM d")) – \(fmt(last, "MMM d"))"
    }

    private func slotOrder(_ s: String) -> Int {
        ["breakfast": 0, "lunch": 1, "dinner": 2, "snack": 3][s] ?? 4
    }
    private func slotLabel(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    struct PlanTarget: Identifiable {
        let date: String; let mealType: String
        var id: String { "\(date)|\(mealType)" }
    }
}

/// A searchable recipe picker (used when planning a slot). Reuses the loaded
/// library; tapping a recipe calls `onPick` and dismisses.
struct RecipePickerSheet: View {
    let recipes: [NookAPI.RecipeSummary]
    let onPick: (NookAPI.RecipeSummary) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filtered: [NookAPI.RecipeSummary] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let list = q.isEmpty ? recipes : recipes.filter {
            ($0.title + " " + ($0.cuisine ?? "") + " " + ($0.protein ?? "")).lowercased().contains(q)
        }
        return list.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered) { r in
                    Button { onPick(r); dismiss() } label: {
                        HStack(spacing: 12) {
                            Text(r.emoji ?? RecipeGradient.emoji(r.category)).font(.system(size: 22))
                                .frame(width: 40, height: 40)
                                .background(RecipeGradient.forCategory(r.category))
                                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                                    .lineLimit(1)
                                HStack(spacing: 8) {
                                    if let c = r.cuisine { Text("🌍 \(c)").font(.system(size: 12)).foregroundStyle(NK.ink3) }
                                    if let t = r.cookTimeMinutes { Text("🕐 \(t)m").font(.system(size: 12)).foregroundStyle(NK.ink3) }
                                }
                            }
                            Spacer(minLength: 0)
                        }
                    }
                    .listRowBackground(NK.card)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(NK.canvas)
            .searchable(text: $query, prompt: "Search recipes…")
            .navigationTitle("Choose a recipe").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
