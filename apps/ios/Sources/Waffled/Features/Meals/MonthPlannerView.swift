import SwiftUI

/// The monthly meal planner — a 6×7 calendar grid of the month's **dinners**
/// (mirrors the web's dinner-only month view). Tapping a planned night opens its
/// recipe; tapping an empty in-month night opens the picker; long-press a planned
/// night to change or remove it. Reads `GET /api/meals/week?days=42`; writes via
/// `SyncManager.setMealPlan/clearMealPlan` (which bump `mealsRev`).
struct MonthPlannerView: View {
    let recipes: RecipesModel
    @Binding var path: [MealsRoute]
    @Environment(SyncManager.self) private var sync

    /// Any day inside the month being viewed (defaults to today).
    @State private var anchor = Date()
    @State private var entries: [WaffledAPI.WeekEntryDTO] = []
    @State private var picking: WeekPlannerView.PlanTarget?
    /// The day currently under a drag (highlighted as the drop target).
    @State private var dropTarget: String?
    @State private var planningMonth = false
    /// The planned night whose action sheet (Open / Change / Remove) is showing.
    @State private var actionTarget: WaffledAPI.WeekEntryDTO?

    private let weekdaySymbols = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
    private var columns: [GridItem] { Array(repeating: GridItem(.flexible(), spacing: 5), count: 7) }

    var body: some View {
        Group {
            if isKiosk {
                kioskMonth
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        monthHeader
                        Text("Dinners for the month · tap to add or open · drag a night onto another to swap")
                            .font(.system(size: 12, weight: .medium)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button { planningMonth = true } label: {
                            HStack(spacing: 7) {
                                Text("✨").font(.system(size: 15))
                                Text("Plan my month").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(NK.ai).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        weekdayRow
                        let byDate = dinnerByDate
                        LazyVGrid(columns: columns, spacing: 5) {
                            ForEach(gridDays, id: \.self) { day in cell(day, entry: byDate[ymd(day)]) }
                        }
                    }
                    .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 110)
                }
            }
        }
        .background(NK.canvas)
        .task { await load(); autoPlanOnceIfNeeded() }
        .refreshable { await load() }
        .onChange(of: anchor) { _, _ in Task { await load() } }
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
        .sheet(isPresented: $planningMonth) {
            PlanMonthSheet(monthStart: ymd(monthStart), monthLabel: fmt(monthStart, "MMMM"),
                           familySize: max(1, sync.members.count), recipes: recipes) {
                Task { await load() }
            }
        }
        .confirmationDialog(actionTarget?.displayTitle ?? "Dinner",
                            isPresented: Binding(get: { actionTarget != nil }, set: { if !$0 { actionTarget = nil } }),
                            titleVisibility: .visible, presenting: actionTarget) { e in
            if e.recipeId != nil { Button("Open recipe") { openRecipe(e) } }
            Button("Change") { picking = .init(date: e.date, mealType: "dinner") }
            Button("Remove", role: .destructive) {
                Task { _ = await sync.clearMealPlan(date: e.date, mealType: "dinner"); await load() }
            }
        }
    }

    /// Open a planned night's recipe (or the picker for a free-text night).
    private func openRecipe(_ e: WaffledAPI.WeekEntryDTO) {
        guard let rid = e.recipeId else { picking = .init(date: e.date, mealType: "dinner"); return }
        let seed = recipes.recipes.first { $0.id == rid }
            ?? .placeholder(id: rid, title: e.recipe?.title ?? e.displayTitle, emoji: e.recipe?.emoji,
                            category: e.recipe?.category, cookTimeMinutes: e.recipe?.cookTimeMinutes,
                            servings: e.recipe?.servings)
        path.append(.recipe(seed))
    }

    // MARK: header

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    /// Headless verification: WAFFLED_PLAN_MONTH=1 auto-opens the Plan-my-month sheet once.
    private static var didAutoPlan = false
    private func autoPlanOnceIfNeeded() {
        guard DemoHooks.planMonth, !Self.didAutoPlan else { return }
        Self.didAutoPlan = true
        planningMonth = true
    }

    /// `gridDays` chunked into calendar weeks of 7, so the iPad grid can lay equal-height
    /// rows that stretch to fill the page instead of cramming at the top.
    private var weekRows: [[Date]] {
        stride(from: 0, to: gridDays.count, by: 7).map { Array(gridDays[$0 ..< min($0 + 7, gridDays.count)]) }
    }

    /// iPad month — fills the available height (taller cells) and mirrors the week view's
    /// padded, non-scrolling layout so the action row lands in the same place on switch.
    private var kioskMonth: some View {
        let byDate = dinnerByDate   // build the lookup once, not once per cell
        return VStack(spacing: 12) {
            kioskMonthHeader
            VStack(spacing: 5) {
                weekdayRow
                ForEach(weekRows, id: \.self) { week in
                    HStack(spacing: 5) {
                        ForEach(week, id: \.self) { day in
                            cell(day, entry: byDate[ymd(day)]).frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    /// iPad: month nav + "Plan my month" on one row (matches the week view), instead of
    /// the stacked header + full-width button.
    private var kioskMonthHeader: some View {
        HStack(spacing: 12) {
            Button { planningMonth = true } label: {
                HStack(spacing: 6) {
                    Text("✨").font(.system(size: 14))
                    Text("Plan my month").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                }
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(NK.ai).clipShape(Capsule())
            }
            .buttonStyle(.plain)
            Spacer()
            Button { step(-1) } label: { monthChevron("chevron.left") }
            VStack(spacing: 1) {
                Text(fmt(anchor, "MMMM yyyy")).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                if !isCurrentMonth {
                    Button("Jump to this month") { withAnimation { anchor = Date() } }
                        .font(.system(size: 11, weight: .semibold)).tint(NK.primary)
                }
            }
            .frame(minWidth: 140)
            Button { step(1) } label: { monthChevron("chevron.right") }
        }
    }

    private func monthChevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
            .frame(width: 34, height: 34).background(NK.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(NK.hair, lineWidth: 1))
    }

    private var monthHeader: some View {
        HStack {
            Button { step(-1) } label: {
                Image(systemName: "chevron.left").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink2)
                    .frame(width: 36, height: 36).background(NK.card).clipShape(Circle())
            }
            .buttonStyle(.plain)
            Spacer()
            VStack(spacing: 1) {
                Text(fmt(anchor, "MMMM yyyy")).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                if !isCurrentMonth {
                    Button("Jump to this month") { withAnimation { anchor = Date() } }
                        .font(.system(size: 12, weight: .semibold)).tint(NK.primary)
                }
            }
            Spacer()
            Button { step(1) } label: {
                Image(systemName: "chevron.right").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink2)
                    .frame(width: 36, height: 36).background(NK.card).clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 4)
    }

    private var weekdayRow: some View {
        HStack(spacing: 5) {
            ForEach(weekdaySymbols, id: \.self) { s in
                Text(s).font(.system(size: 11, weight: .heavy)).foregroundStyle(NK.ink3)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: a day cell

    @ViewBuilder private func cell(_ day: Date, entry: WaffledAPI.WeekEntryDTO?) -> some View {
        let ds = ymd(day)
        let inMonth = cal.isDate(day, equalTo: monthStart, toGranularity: .month)
        let isToday = ds == ymd(Date())

        // The iPad cells are much taller now — scale the text up to use that room.
        let content = VStack(spacing: isKiosk ? 5 : 2) {
            HStack(spacing: 0) {
                Text(dayNum(day))
                    .font(.system(size: isKiosk ? 14 : 11, weight: isToday ? .heavy : .semibold))
                    .foregroundStyle(isToday ? NK.primary : (inMonth ? NK.ink2 : NK.ink3))
                Spacer(minLength: 0)
            }
            if let e = entry, inMonth {
                if isKiosk { Spacer(minLength: 0) }
                Text(e.recipe?.emoji ?? (isEatingOut(e) ? "🍴" : "🍽️")).font(.system(size: isKiosk ? 30 : 17))
                Text(e.displayTitle).font(.system(size: isKiosk ? 13 : 8.5, weight: .semibold)).foregroundStyle(NK.ink2)
                    .lineLimit(2).multilineTextAlignment(.center).minimumScaleFactor(0.85)
            } else if inMonth {
                Spacer(minLength: 0)
                Image(systemName: "plus").font(.system(size: isKiosk ? 16 : 11, weight: .bold)).foregroundStyle(NK.ink3.opacity(0.5))
            }
            Spacer(minLength: 0)
        }
        let highlighted = dropTarget == ds
        let visual = content
            .padding(.horizontal, 4).padding(.vertical, 5)
            .frame(maxWidth: .infinity, minHeight: isKiosk ? nil : 66,
                   maxHeight: isKiosk ? .infinity : nil, alignment: .top)
            .background(highlighted ? NK.primary.opacity(0.1) : (inMonth ? NK.card : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(highlighted || isToday ? NK.primary : NK.hair, lineWidth: highlighted || isToday ? 2 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(inMonth ? 1 : 0.4)

        if inMonth {
            // A plain tappable view (NOT a Button) so .draggable can own the
            // long-press-drag. Tapping a planned night opens a tap-based action
            // sheet (Open / Change / Remove) — no long-press menu to fight the drag.
            let interactive = visual
                .contentShape(Rectangle())
                .onTapGesture { if let e = entry { actionTarget = e } else { picking = .init(date: ds, mealType: "dinner") } }
                .dropDestination(for: String.self) { items, _ in drop(items, on: ds) } isTargeted: { over in
                    dropTarget = over ? ds : (dropTarget == ds ? nil : dropTarget)
                }
            if let e = entry {
                interactive.draggable(ds) { dragPreview(e) }
            } else {
                interactive
            }
        } else {
            visual
        }
    }

    /// A floating chip shown while dragging a night.
    private func dragPreview(_ e: WaffledAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 5) {
            Text(e.recipe?.emoji ?? (isEatingOut(e) ? "🍴" : "🍽️")).font(.system(size: 14))
            Text(e.displayTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(NK.card).clipShape(Capsule()).overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
    }

    /// Handle a dropped source day onto `target` — swap (or move) the two dinners.
    private func drop(_ items: [String], on target: String) -> Bool {
        guard let src = items.first, src != target else { return false }
        Task { await swap(src, target) }
        return true
    }

    /// Swap the dinners on two days (a move when the target is empty).
    private func swap(_ src: String, _ tgt: String) async {
        let a = dinnerByDate[src]
        let b = dinnerByDate[tgt]
        await place(b, on: src)
        await place(a, on: tgt)
        await load()
    }

    private func place(_ entry: WaffledAPI.WeekEntryDTO?, on date: String) async {
        if let e = entry {
            _ = await sync.setMealPlan(date: date, mealType: "dinner",
                                       recipeId: e.recipeId, title: e.recipeId == nil ? (e.title ?? e.displayTitle) : nil,
                                       cookPersonId: e.cook?.personId)
        } else {
            _ = await sync.clearMealPlan(date: date, mealType: "dinner")
        }
    }

    // MARK: actions


    private func load() async {
        let all = (try? await WaffledAPI().mealsWeek(start: ymd(gridStart), days: 42)) ?? []
        entries = all.filter { $0.mealType == "dinner" }
    }

    /// A free-text "eating out" night (no recipe) — show a fork instead of a plate.
    private func isEatingOut(_ e: WaffledAPI.WeekEntryDTO) -> Bool {
        guard e.recipeId == nil, let t = e.title?.lowercased() else { return false }
        return ["eat", "dining", "takeout", "take-out", "take out", "delivery", "order", "out"].contains { t.contains($0) }
    }

    // MARK: month math (Sunday-start grid, household tz)

    private var dinnerByDate: [String: WaffledAPI.WeekEntryDTO] {
        Dictionary(entries.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
    }
    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = sync.householdTz; return c
    }
    private var monthStart: Date {
        cal.date(from: cal.dateComponents([.year, .month], from: anchor)) ?? anchor
    }
    /// The Sunday on or before the 1st — top-left of the 6×7 grid.
    private var gridStart: Date {
        let weekdayIdx = cal.component(.weekday, from: monthStart) - 1   // Sunday → 0
        return cal.date(byAdding: .day, value: -weekdayIdx, to: monthStart) ?? monthStart
    }
    private var gridDays: [Date] { (0..<42).compactMap { cal.date(byAdding: .day, value: $0, to: gridStart) } }
    private var isCurrentMonth: Bool { cal.isDate(anchor, equalTo: Date(), toGranularity: .month) }

    private func step(_ months: Int) {
        if let next = cal.date(byAdding: .month, value: months, to: monthStart) {
            withAnimation { anchor = next }
        }
    }

    private func fmt(_ d: Date, _ pattern: String) -> String { DateFmt.string(d, pattern, sync.householdTz) }
    private func ymd(_ d: Date) -> String { fmt(d, "yyyy-MM-dd") }
    private func dayNum(_ d: Date) -> String { fmt(d, "d") }
}
