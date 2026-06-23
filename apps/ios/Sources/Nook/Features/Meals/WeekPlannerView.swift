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
    @State private var planningWeek = false
    /// The day card currently under a drag (highlighted as the drop target).
    @State private var dropTargetDay: String?
    /// iPad grid: which "date|mealType" cell is under a drag, and whether all meal
    /// rows show (vs. dinner only) — mirrors the web "All meals / Dinners" toggle.
    @State private var dropTargetSlot: String?
    @State private var showAllMeals = true

    private let mealSlots = ["breakfast", "lunch", "dinner", "snack"]
    private var visibleSlots: [String] { showAllMeals ? mealSlots : ["dinner"] }

    private let api = NookAPI()

    /// Whether any night this week has no dinner — drives the "Plan my week" CTA.
    private var hasEmptyNight: Bool {
        days.contains { day in !entries.contains { $0.date == ymd(day) && $0.mealType == "dinner" } }
    }

    /// iPad lays the week as a 7-day grid of columns; iPhone keeps the vertical list.
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        Group {
            if isKiosk { kioskWeek } else { phoneWeek }
        }
        .background(NK.canvas)
        .task { await load() }
        .onChange(of: weekOffset) { _, _ in Task { await load() } }
        .onChange(of: sync.mealsRev) { _, _ in Task { await load() } }
        .sheet(item: $picking) { target in
            RecipePickerSheet(model: recipes) { recipe in
                Task {
                    _ = await sync.setMealPlan(date: target.date, mealType: target.mealType,
                                               recipeId: recipe.id, title: nil)
                    await load()
                }
            }
        }
        .sheet(isPresented: $planningWeek) {
            PlanWeekSheet(start: ymd(weekStart), weekLabel: weekTitle,
                          weekDays: days, familySize: max(1, sync.members.count),
                          recipes: recipes) {
                Task { await load() }
            }
        }
    }

    private var phoneWeek: some View {
        ScrollView {
            VStack(spacing: 12) {
                weekHeader
                if hasEmptyNight { planWeekButton }
                ForEach(days, id: \.self) { day in dayCard(day) }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 110)
        }
        .refreshable { await load() }
    }

    // MARK: iPad — meal-type × day grid (web-like)

    private var kioskWeek: some View {
        VStack(spacing: 12) {
            kioskWeekHeader
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Color.clear.frame(width: rowLabelWidth)
                    ForEach(days, id: \.self) { day in kioskDayHeader(day).frame(maxWidth: .infinity) }
                }
                ForEach(visibleSlots, id: \.self) { slot in
                    HStack(alignment: .top, spacing: 8) {
                        Text(slotLabel(slot)).font(.system(size: 13, weight: .heavy))
                            .foregroundStyle(NK.ink2).frame(width: rowLabelWidth, alignment: .leading)
                        ForEach(days, id: \.self) { day in kioskSlotCell(day: day, slot: slot) }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var rowLabelWidth: CGFloat { 76 }

    private var kioskWeekHeader: some View {
        HStack(spacing: 12) {
            Picker("", selection: $showAllMeals.animation()) {
                Text("All meals").tag(true)
                Text("Dinners").tag(false)
            }
            .pickerStyle(.segmented).frame(width: 220)
            if hasEmptyNight {
                Button { planningWeek = true } label: {
                    HStack(spacing: 6) {
                        Text("✨").font(.system(size: 14))
                        Text("Plan my week").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(NK.ai).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer()
            Button { withAnimation { weekOffset -= 1 } } label: { weekChevron("chevron.left") }
            VStack(spacing: 1) {
                Text(weekTitle).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                if weekOffset != 0 {
                    Button("This week") { withAnimation { weekOffset = 0 } }
                        .font(.system(size: 11, weight: .semibold)).tint(NK.primary)
                }
            }
            .frame(minWidth: 130)
            Button { withAnimation { weekOffset += 1 } } label: { weekChevron("chevron.right") }
        }
    }

    private func weekChevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
            .frame(width: 34, height: 34).background(NK.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(NK.hair, lineWidth: 1))
    }

    private func kioskDayHeader(_ day: Date) -> some View {
        let isToday = ymd(day) == ymd(Date())
        return VStack(spacing: 1) {
            Text(weekday(day)).font(.system(size: 12, weight: .heavy)).foregroundStyle(isToday ? NK.primary : NK.ink2)
            Text(fmt(day, "d")).font(.system(size: 13, weight: .bold))
                .foregroundStyle(isToday ? .white : NK.ink)
                .frame(width: 26, height: 26)
                .background(isToday ? NK.primary : Color.clear).clipShape(Circle())
        }
    }

    private func kioskSlotCell(day: Date, slot: String) -> some View {
        let ds = ymd(day)
        let cellId = "\(ds)|\(slot)"
        let entry = entries.first { $0.date == ds && $0.mealType == slot }
        return Group {
            if let e = entry { kioskMealCard(e) } else { kioskEmptyCell(date: ds, slot: slot) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
            .strokeBorder(dropTargetSlot == cellId ? NK.primary : .clear, lineWidth: 2))
        .dropDestination(for: String.self) { items, _ in
            guard let p = items.first else { return false }
            let parts = p.split(separator: "|")
            guard parts.count == 2, !(String(parts[0]) == ds && String(parts[1]) == slot) else { return false }
            Task { await swapSlots(srcDate: String(parts[0]), srcSlot: String(parts[1]), dstDate: ds, dstSlot: slot) }
            return true
        } isTargeted: { over in
            dropTargetSlot = over ? cellId : (dropTargetSlot == cellId ? nil : dropTargetSlot)
        }
    }

    private func kioskMealCard(_ e: NookAPI.WeekEntryDTO) -> some View {
        VStack(spacing: 4) {
            if let emoji = e.recipe?.emoji { Text(emoji).font(.system(size: 22)) }
            Text(e.displayTitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink)
                .multilineTextAlignment(.center).lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(8)
        .background(NK.ai.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        .overlay(alignment: .topLeading) {
            Button {
                Task { _ = await sync.clearMealPlan(date: e.date, mealType: e.mealType); await load() }
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(NK.ink3)
                    .frame(width: 20, height: 20).background(NK.card).clipShape(Circle())
            }
            .buttonStyle(.plain).padding(5)
        }
        .contentShape(Rectangle())
        .onTapGesture { open(e) }
        .draggable("\(e.date)|\(e.mealType)") { entryDragPreview(e) }
    }

    private func kioskEmptyCell(date: String, slot: String) -> some View {
        Button { picking = PlanTarget(date: date, mealType: slot) } label: {
            Image(systemName: "plus").font(.system(size: 17)).foregroundStyle(NK.ink3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(NK.card.opacity(0.35))
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(NK.hair))
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// Swap two slots — works across days *and* meal types (grid drag).
    private func swapSlots(srcDate: String, srcSlot: String, dstDate: String, dstSlot: String) async {
        let a = entries.first { $0.date == srcDate && $0.mealType == srcSlot }
        let b = entries.first { $0.date == dstDate && $0.mealType == dstSlot }
        await placeMeal(b, on: srcDate, mealType: srcSlot)
        await placeMeal(a, on: dstDate, mealType: dstSlot)
        await load()
    }

    private var planWeekButton: some View {
        Button { planningWeek = true } label: {
            HStack(spacing: 7) {
                Text("✨").font(.system(size: 15))
                Text("Plan my week").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(NK.ai).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
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
                        .foregroundStyle(isToday || dropTargetDay == ds ? NK.primary : NK.ink2)
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
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous)
            .strokeBorder(dropTargetDay == ds ? NK.primary : .clear, lineWidth: 2))
        .dropDestination(for: String.self) { items, _ in dropMeal(items, on: ds) } isTargeted: { over in
            dropTargetDay = over ? ds : (dropTargetDay == ds ? nil : dropTargetDay)
        }
    }

    private func entryRow(_ e: NookAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 11) {
            // Plain (not a Button) so .draggable can claim the long-press; tap still
            // opens the recipe. Drag this meal onto another day to swap that slot.
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
            .contentShape(Rectangle())
            .onTapGesture { open(e) }
            .draggable("\(e.date)|\(e.mealType)") { entryDragPreview(e) }
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

    // MARK: drag-to-swap

    private func entryDragPreview(_ e: NookAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 5) {
            Text(e.recipe?.emoji ?? "🍽️").font(.system(size: 14))
            Text(e.displayTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(NK.card).clipShape(Capsule()).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
    }

    /// Drop a dragged meal ("date|mealType") onto another day — swap that slot.
    private func dropMeal(_ items: [String], on targetDay: String) -> Bool {
        guard let payload = items.first else { return false }
        let parts = payload.split(separator: "|")
        guard parts.count == 2, String(parts[0]) != targetDay else { return false }
        Task { await swapMeal(srcDate: String(parts[0]), mealType: String(parts[1]), targetDay: targetDay) }
        return true
    }

    private func swapMeal(srcDate: String, mealType: String, targetDay: String) async {
        let a = entries.first { $0.date == srcDate && $0.mealType == mealType }
        let b = entries.first { $0.date == targetDay && $0.mealType == mealType }
        await placeMeal(b, on: srcDate, mealType: mealType)
        await placeMeal(a, on: targetDay, mealType: mealType)
        await load()
    }

    private func placeMeal(_ entry: NookAPI.WeekEntryDTO?, on date: String, mealType: String) async {
        if let e = entry {
            _ = await sync.setMealPlan(date: date, mealType: mealType,
                                       recipeId: e.recipeId, title: e.recipeId == nil ? (e.title ?? e.displayTitle) : nil,
                                       cookPersonId: e.cook?.personId)
        } else {
            _ = await sync.clearMealPlan(date: date, mealType: mealType)
        }
    }

    // MARK: actions

    private func open(_ e: NookAPI.WeekEntryDTO) {
        guard let rid = e.recipeId else { return }   // free-text meals have no detail
        let seed = recipes.recipes.first { $0.id == rid }
            ?? .placeholder(id: rid, title: e.recipe?.title ?? e.displayTitle, emoji: e.recipe?.emoji,
                            category: e.recipe?.category, cookTimeMinutes: e.recipe?.cookTimeMinutes,
                            servings: e.recipe?.servings)
        path.append(.recipe(seed))
    }

    private func load() async {
        loading = true
        entries = (try? await api.mealsWeek(start: ymd(weekStart))) ?? []
        loading = false
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

    private func fmt(_ d: Date, _ pattern: String) -> String { DateFmt.string(d, pattern, sync.householdTz) }
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

/// The "Choose a recipe" sheet for planning a slot. Reuses the full Recipes
/// library (search · sort · facet filters · card grid) in pick mode, so browsing
/// to plan feels identical to browsing to view.
struct RecipePickerSheet: View {
    let model: RecipesModel
    let onPick: (NookAPI.RecipeSummary) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            RecipesLibraryView(model: model) { recipe in
                onPick(recipe); dismiss()
            }
            .navigationTitle("Choose a recipe").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}
