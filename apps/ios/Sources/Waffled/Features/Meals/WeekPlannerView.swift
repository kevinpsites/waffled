import SwiftUI

/// The weekly meal planner — a day-by-day view of what's planned, with the ability
/// to plan, change, or clear a dinner. Tapping a planned recipe opens its detail.
/// Reads `GET /api/meals/week`; writes via `SyncManager.setMealPlan/clearMealPlan`
/// (which bump `mealsRev` so the Today card and Recipes screen stay in sync).
/// On iPhone a horizontal flick pages between weeks (shared `HorizontalSwipe`), and
/// dragging a meal to another day updates optimistically via `MealPlanSwap`.
struct WeekPlannerView: View {
    let recipes: RecipesModel
    @Binding var path: [MealsRoute]
    @Environment(SyncManager.self) private var sync

    @State private var entries: [WaffledAPI.WeekEntryDTO] = []
    @State private var weekOffset = 0
    @State private var loading = true
    @State private var picking: PlanTarget?
    @State private var planningWeek = false
    /// A drag-and-drop the server rejected — shows the dismissible banner.
    @State private var swapError: String?
    /// One in-flight discipline for the optimistic drops: every reload path (`mealsRev`
    /// bumps, week paging, pull-to-refresh) asks the gate first, so a half-committed
    /// swap can never be fetched over the optimistic/rolled-back entries, and the last
    /// drop to settle replays exactly one reload.
    @State private var gate = MealPlanSwap.Gate()
    /// The day card currently under a drag (highlighted as the drop target).
    @State private var dropTargetDay: String?
    /// iPad grid: which "date|mealType" cell is under a drag, and whether all meal
    /// rows show (vs. dinner only) — mirrors the web "All meals / Dinners" toggle.
    @State private var dropTargetSlot: String?
    @State private var showAllMeals = true

    private let mealSlots = ["breakfast", "lunch", "dinner", "snack"]
    private var visibleSlots: [String] { showAllMeals ? mealSlots : ["dinner"] }

    private let api = WaffledAPI()

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
        .background(WF.canvas)
        .task { await load(); autoPlanOnceIfNeeded() }
        // Both reload triggers go through the gate: mid-drop they'd fetch the
        // half-committed server state, so they're deferred and replayed on settle.
        .onChange(of: weekOffset) { _, _ in if gate.shouldReloadNow() { Task { await load() } } }
        .onChange(of: sync.mealsRev) { _, _ in if gate.shouldReloadNow() { Task { await load() } } }
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
                swapErrorBanner
                if hasEmptyNight { planWeekButton }
                ForEach(days, id: \.self) { day in dayCard(day) }
            }
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 110)
        }
        .refreshable { if gate.shouldReloadNow() { await load() } }
        // Horizontal flick steps a week (matching the Chores day list and Calendar).
        // simultaneousGesture (not gesture) so vertical scrolling and dragging a meal
        // still work; HorizontalSwipe returns nil for small or mostly-vertical drags.
        .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded(handleWeekSwipe))
    }

    /// Horizontal flick on the phone list → step a week. Shares `HorizontalSwipe` with
    /// the calendar/chores steppers so the thresholds stay in sync; the header chevrons
    /// and "Jump to this week" keep working unchanged.
    private func handleWeekSwipe(_ value: DragGesture.Value) {
        guard let dir = HorizontalSwipe.step(value) else { return }
        withAnimation { weekOffset += dir }
    }

    // MARK: iPad — meal-type × day grid (web-like)

    private var kioskWeek: some View {
        VStack(spacing: 12) {
            kioskWeekHeader
            swapErrorBanner
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Color.clear.frame(width: rowLabelWidth)
                    ForEach(days, id: \.self) { day in kioskDayHeader(day).frame(maxWidth: .infinity) }
                }
                // Fixed height — Color.clear is otherwise height-greedy and balloons the
                // header row (very visible in the single-row "Dinners" view).
                .frame(height: 56)
                ForEach(visibleSlots, id: \.self) { slot in
                    HStack(alignment: .top, spacing: 8) {
                        Text(slotLabel(slot)).font(.system(size: 13, weight: .heavy))
                            .foregroundStyle(WF.ink2).frame(width: rowLabelWidth, alignment: .leading)
                        ForEach(days, id: \.self) { day in kioskSlotCell(day: day, slot: slot) }
                    }
                    // Cap each meal row so a single-row "Dinners" view doesn't balloon to
                    // the full page height; multiple rows still share the space evenly.
                    .frame(maxWidth: .infinity, maxHeight: 220)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var rowLabelWidth: CGFloat { 76 }

    private var kioskWeekHeader: some View {
        HStack(spacing: 12) {
            // Plan CTA leads, matching the Month view's header so the button doesn't
            // jump position when switching Week ⇄ Month.
            if hasEmptyNight {
                Button { planningWeek = true } label: {
                    HStack(spacing: 6) {
                        Text("✨").font(.system(size: 14))
                        Text("Plan my week").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(WF.ai).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Picker("", selection: $showAllMeals.animation()) {
                Text("All meals").tag(true)
                Text("Dinners").tag(false)
            }
            .pickerStyle(.segmented).frame(width: 220)
            Spacer()
            Button { withAnimation { weekOffset -= 1 } } label: { weekChevron("chevron.left") }
            VStack(spacing: 1) {
                Text(weekTitle).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                if weekOffset != 0 {
                    Button("Jump to this week") { withAnimation { weekOffset = 0 } }
                        .font(.system(size: 11, weight: .semibold)).tint(WF.primary)
                }
            }
            .frame(minWidth: 130)
            Button { withAnimation { weekOffset += 1 } } label: { weekChevron("chevron.right") }
        }
    }

    private func weekChevron(_ s: String) -> some View {
        Image(systemName: s).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
            .frame(width: 34, height: 34).background(WF.card).clipShape(Circle())
            .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
    }

    private func kioskDayHeader(_ day: Date) -> some View {
        let isToday = ymd(day) == ymd(Date())
        return VStack(spacing: 1) {
            Text(weekday(day)).font(.system(size: 12, weight: .heavy)).foregroundStyle(isToday ? WF.primary : WF.ink2)
            Text(fmt(day, "d")).font(.system(size: 13, weight: .bold))
                .foregroundStyle(isToday ? .white : WF.ink)
                .frame(width: 26, height: 26)
                .background(isToday ? WF.primary : Color.clear).clipShape(Circle())
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
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
            .strokeBorder(dropTargetSlot == cellId ? WF.primary : .clear, lineWidth: 2))
        .dropDestination(for: MealSlotDrag.self) { items, _ in
            guard let p = items.first else { return false }
            return moveMeal(srcDate: p.date, srcSlot: p.mealType, dstDate: ds, dstSlot: slot)
        } isTargeted: { over in
            dropTargetSlot = over ? cellId : (dropTargetSlot == cellId ? nil : dropTargetSlot)
        }
    }

    private func kioskMealCard(_ e: WaffledAPI.WeekEntryDTO) -> some View {
        VStack(spacing: 4) {
            if let emoji = e.recipe?.emoji { Text(emoji).font(.system(size: 22)) }
            Text(e.displayTitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                .multilineTextAlignment(.center).lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(8)
        .background(WF.ai.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(alignment: .topLeading) {
            Button {
                Task { _ = await sync.clearMealPlan(date: e.date, mealType: e.mealType); await load() }
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WF.ink3)
                    .frame(width: 20, height: 20).background(WF.card).clipShape(Circle())
            }
            .buttonStyle(.plain).padding(5)
        }
        .contentShape(Rectangle())
        .onTapGesture { open(e) }
        .draggable(MealSlotDrag(date: e.date, mealType: e.mealType)) { entryDragPreview(e) }
    }

    private func kioskEmptyCell(date: String, slot: String) -> some View {
        Button { picking = PlanTarget(date: date, mealType: slot) } label: {
            Image(systemName: "plus").font(.system(size: 17)).foregroundStyle(WF.ink3)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(WF.card.opacity(0.35))
                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(WF.hair))
                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var planWeekButton: some View {
        Button { planningWeek = true } label: {
            HStack(spacing: 7) {
                Text("✨").font(.system(size: 15))
                Text("Plan my week").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(WF.ai).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: header

    private var weekHeader: some View {
        HStack {
            Button { withAnimation { weekOffset -= 1 } } label: {
                Image(systemName: "chevron.left").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 36, height: 36).background(WF.card).clipShape(Circle())
            }
            .buttonStyle(.plain)
            Spacer()
            VStack(spacing: 1) {
                Text(weekTitle).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                if weekOffset != 0 {
                    Button("Jump to this week") { withAnimation { weekOffset = 0 } }
                        .font(.system(size: 12, weight: .semibold)).tint(WF.primary)
                }
            }
            Spacer()
            Button { withAnimation { weekOffset += 1 } } label: {
                Image(systemName: "chevron.right").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 36, height: 36).background(WF.card).clipShape(Circle())
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
        return WaffledCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(weekday(day)).font(.system(size: 13, weight: .heavy)).tracking(0.6)
                        .foregroundStyle(isToday || dropTargetDay == ds ? WF.primary : WF.ink2)
                    Text(dayNumber(day)).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    if isToday {
                        Text("TODAY").font(.system(size: 10, weight: .heavy)).foregroundStyle(WF.primary)
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(WF.primary.opacity(0.12)).clipShape(Capsule())
                    }
                    Spacer()
                }
                // Interleave meals chronologically (iPhone): for each primary slot show
                // the planned entry if there is one, otherwise a "Plan <Slot>" add button.
                // So "Plan Breakfast / Plan Lunch / Dinner" reads in meal order, not entries-
                // then-buttons.
                ForEach(["breakfast", "lunch", "dinner"], id: \.self) { slot in
                    if let entry = dayEntries.first(where: { $0.mealType == slot }) {
                        entryRow(entry)
                    } else {
                        planButton(date: ds, mealType: slot, label: "Plan \(slotLabel(slot))")
                    }
                }
                // Snacks aren't a primary add-slot, but an existing snack (or any other
                // non-primary meal_type) still renders after dinner, in slot order.
                ForEach(dayEntries.filter { !["breakfast", "lunch", "dinner"].contains($0.mealType) }) { entry in
                    entryRow(entry)
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
            .strokeBorder(dropTargetDay == ds ? WF.primary : .clear, lineWidth: 2))
        .dropDestination(for: MealSlotDrag.self) { items, _ in
            guard let p = items.first else { return false }
            return moveMeal(srcDate: p.date, srcSlot: p.mealType, dstDate: ds, dstSlot: p.mealType)
        } isTargeted: { over in
            dropTargetDay = over ? ds : (dropTargetDay == ds ? nil : dropTargetDay)
        }
    }

    private func entryRow(_ e: WaffledAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 11) {
            // Plain (not a Button) so .draggable can claim the long-press; tap still
            // opens the recipe. Drag this meal onto another day to swap that slot.
            HStack(spacing: 11) {
                Text(e.recipe?.emoji ?? "🍽️").font(.system(size: 22))
                    .frame(width: 40, height: 40)
                    .background(RecipeGradient.forCategory(e.recipe?.category ?? e.mealType))
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(e.displayTitle).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
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
            .draggable(MealSlotDrag(date: e.date, mealType: e.mealType)) { entryDragPreview(e) }
            Menu {
                Button { picking = PlanTarget(date: e.date, mealType: e.mealType) } label: {
                    Label("Change", systemImage: "arrow.triangle.2.circlepath")
                }
                Button(role: .destructive) {
                    Task { _ = await sync.clearMealPlan(date: e.date, mealType: e.mealType); await load() }
                } label: { Label("Remove", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink3)
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
            .foregroundStyle(WF.ink2)
            .frame(maxWidth: .infinity).padding(.vertical, 11)
            .background(WF.card2)
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3])).foregroundStyle(WF.hair))
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func meta(_ t: String) -> some View {
        Text(t).font(.system(size: 12, weight: .medium)).foregroundStyle(WF.ink3)
    }
    private func metaTag(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
            .padding(.horizontal, 7).padding(.vertical, 2).background(WF.panel).clipShape(Capsule())
    }

    // MARK: drag-to-swap

    private func entryDragPreview(_ e: WaffledAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 5) {
            Text(e.recipe?.emoji ?? "🍽️").font(.system(size: 14))
            Text(e.displayTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(WF.card).clipShape(Capsule()).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
    }

    /// Drop handler for both layouts (day card + iPad grid cell). Swaps the two slots in
    /// `entries` immediately — the meal lands the moment the finger lifts — then commits
    /// the writes in the background (meal plans are REST-only, no PowerSync local write
    /// to lean on), in `MealPlanSwap.writes`' loss-safe order: the dragged meal is
    /// upserted into the target slot FIRST (its own row untouched), and only then is the
    /// source slot rewritten — so a failure between the writes leaves the dragged meal
    /// planned twice (recoverable), never zero times. On any failure a compensating
    /// write best-effort-restores the target slot, the banner shows, and the entries
    /// either roll back locally (sole in-flight drop, server untouched) or are refetched
    /// from server truth by the settle reload the `gate` replays.
    private func moveMeal(srcDate: String, srcSlot: String, dstDate: String, dstSlot: String) -> Bool {
        guard let swapped = MealPlanSwap.apply(entries, srcDate: srcDate, srcSlot: srcSlot,
                                               dstDate: dstDate, dstSlot: dstSlot),
              let plan = MealPlanSwap.writes(entries, srcDate: srcDate, srcSlot: srcSlot,
                                             dstDate: dstDate, dstSlot: dstSlot) else { return false }
        let snapshot = entries
        let week = ymd(weekStart)
        withAnimation { entries = swapped; swapError = nil }
        gate.begin()
        Task {
            var failed = false
            // 1. Dragged meal → target slot. A failure here means the server never
            //    changed (this op doesn't touch the meal's own row).
            if await perform(plan.ordered[0]) {
                // 2. Rewrite the source slot (displaced meal back, or clear on a move).
                if !(await perform(plan.ordered[1])) {
                    failed = true
                    // The dragged meal now exists in both slots. Best-effort restore of
                    // the target slot returns the server to its exact pre-drag state;
                    // if even this fails, the duplicate is visible and fixable — the
                    // meal is never lost.
                    _ = await perform(plan.compensation)
                }
            } else {
                failed = true
            }

            if failed {
                swapError = "Couldn't move that meal. Check your connection and try again."
                if gate.mayApplyResult, ymd(weekStart) == week {
                    // Sole in-flight drop and no reload was deferred behind it: the
                    // server never changed, so the snapshot is a true rollback.
                    withAnimation { entries = snapshot }
                } else {
                    // Overlapping drops / a half-committed server: don't guess — let
                    // the settle reload fetch server truth.
                    gate.requestSettleReload()
                }
            }
            // Settle LAST (after rollback), so no reload can slip in between the
            // decrement and the entries write. The replayed load doubles as the
            // success-path reconcile — our own mealsRev bumps queued it.
            if gate.finish() { await load() }
        }
        return true
    }

    /// Execute one planned write against the server (upsert, or clear when empty).
    private func perform(_ op: MealPlanSwap.Op) async -> Bool {
        if let e = op.entry {
            return await sync.setMealPlan(date: op.date, mealType: op.mealType,
                                          recipeId: e.recipeId,
                                          title: e.recipeId == nil ? (e.title ?? e.displayTitle) : nil,
                                          cookPersonId: e.cook?.personId)
        }
        return await sync.clearMealPlan(date: op.date, mealType: op.mealType)
    }

    /// A dismissible inline error for a drag-and-drop that the server rejected — the
    /// shared `DismissibleErrorBanner` (same surface as the Chores proof banner).
    @ViewBuilder
    private var swapErrorBanner: some View {
        if let msg = swapError {
            DismissibleErrorBanner(message: msg) { withAnimation { swapError = nil } }
        }
    }

    // MARK: actions

    private func open(_ e: WaffledAPI.WeekEntryDTO) {
        guard let rid = e.recipeId else { return }   // free-text meals have no detail
        let seed = recipes.recipes.first { $0.id == rid }
            ?? .placeholder(id: rid, title: e.recipe?.title ?? e.displayTitle, emoji: e.recipe?.emoji,
                            category: e.recipe?.category, cookTimeMinutes: e.recipe?.cookTimeMinutes,
                            servings: e.recipe?.servings)
        path.append(.recipe(seed))
    }

    private func load() async {
        loading = true
        // Keep what's shown on a failed fetch (e.g. offline right after a rolled-back
        // drop, or paging with no connection) instead of blanking the week —
        // pull-to-refresh retries.
        if let fresh = try? await api.mealsWeek(start: ymd(weekStart)) { entries = fresh }
        loading = false
    }

    /// Verification-only: open the plan sheet once when WAFFLED_PLAN_WEEK=1. One-shot so
    /// it never re-opens on tab re-entry; no-op on a real device (env unset).
    private static var didAutoPlan = false
    private func autoPlanOnceIfNeeded() {
        guard DemoHooks.planWeek, !Self.didAutoPlan else { return }
        Self.didAutoPlan = true
        planningWeek = true
    }

    // MARK: date helpers

    private var cal: Calendar {
        Cal.gregorian(sync.householdTz)
    }
    private var weekStart: Date {
        let base = Cal.weekStart(Date(), sync.householdTz)   // honors live first-day-of-week
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
    let onPick: (WaffledAPI.RecipeSummary) -> Void
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
