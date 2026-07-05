import SwiftUI

/// The AI "Plan my month ✨" flow (mirrors the web's PlanMonth). A config of
/// guardrails — which weeknights, cooking-for, repeat rotation + gap, quick-
/// weeknight cap, leftover nights, per-weekday theme nights, use-up, keep-in-mind —
/// → `POST /api/meals/plan-month` (the server drafts a rotation pool and lays it
/// across the month) → a per-night review you curate (lock / swap / pick / skip /
/// reshuffle). Nothing saves until Add; then each night is written via
/// `SyncManager.setMealPlan` and the grocery list is rebuilt.
struct PlanMonthSheet: View {
    /// The 1st of the month being planned (yyyy-MM-dd).
    let monthStart: String
    let monthLabel: String
    let familySize: Int
    let recipes: RecipesModel
    let onApplied: () -> Void

    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    private enum Phase { case config, loading, review, empty, failed }
    static let themeOptions: [(key: String, label: String)] = [
        ("meatless", "Meatless"), ("tacos", "Taco night"), ("pizza", "Pizza night"),
        ("pasta", "Pasta night"), ("seafood", "Seafood"), ("soup", "Soup & salad"),
        ("breakfast", "Breakfast for dinner"), ("grill", "Grill night"),
        ("takeout", "Takeout"), ("leftovers", "Leftovers"),
    ]
    private static let dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    @State private var phase: Phase = .config
    @State private var weekdays: Set<Int> = [1, 2, 3, 4, 5]   // Mon–Fri
    @State private var cookingFor = 0                          // 0 ⇒ whole family
    @State private var allowRepeats = true
    @State private var repeatGapDays = 7
    @State private var quickWeeknights = false
    @State private var weeknightMax = 30
    @State private var leftovers = false
    @State private var themes: [Int: String] = [:]            // dow → theme key
    @State private var useUp: [String] = []
    @State private var useUpInput = ""
    @State private var keepInMind = ""

    @State private var suggestions: [WaffledAPI.PlanCardDTO] = []
    /// Dates that already had a dinner when the draft ran (the "was planned" nights).
    @State private var plannedDates: Set<String> = []
    /// Existing nights the user has since edited (swap/pick/drag) — these get rewritten.
    @State private var dirty: Set<String> = []
    /// Week-start keys the user has collapsed in the review.
    @State private var collapsedWeeks: Set<String> = []
    @State private var locked: Set<String> = []
    @State private var skipped: Set<String> = []
    @State private var rejected: Set<String> = []
    @State private var draftingDates: Set<String> = []
    @State private var redrafting = false
    @State private var pickTarget: PickTarget?
    @State private var via: String?
    @State private var errorMessage: String?
    @State private var notice: String?
    @State private var applying = false
    @State private var dragOverDate: String?              // review card under a drag

    private let api = WaffledAPI()
    struct PickTarget: Identifiable { let date: String; var id: String { date } }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        NavigationStack {
            content
                .background(WF.canvas)
                .navigationTitle("Plan \(monthLabel)").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .modifier(KioskSheetPresentation(kiosk: isKiosk))
        .sheet(item: $pickTarget) { target in
            RecipePickerSheet(model: recipes) { recipe in pickRecipe(date: target.date, recipe) }
        }
    }

    /// iPad: requirements (left) + the AI-drafted month (right), web-style.
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
        case .config:  configView
        case .loading: loadingView
        case .review:  reviewView
        case .empty:   PlanMessageView(emoji: "🎉", title: "Every night this month is already planned.", subtitle: "Nothing to draft — you’re set.")
        case .failed:  PlanMessageView(emoji: "😕", title: "Couldn’t plan the month", subtitle: errorMessage ?? "The AI provider didn’t respond. Try again.", onRetry: { phase = .config })
        }
    }

    @ViewBuilder private var kioskResultPane: some View {
        switch phase {
        case .config:
            VStack(spacing: 12) {
                Text("✨").font(.system(size: 40))
                Text("Draft your month").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                Text("Set your guardrails on the left, then tap Plan my month.")
                    .font(.system(size: 13)).foregroundStyle(WF.ink3)
                    .multilineTextAlignment(.center).padding(.horizontal, 40)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loading: loadingView
        case .review:  reviewView
        case .empty:   PlanMessageView(emoji: "🎉", title: "Every night this month is already planned.", subtitle: "Nothing to draft — you’re set.")
        case .failed:  PlanMessageView(emoji: "😕", title: "Couldn’t plan the month", subtitle: errorMessage ?? "The AI provider didn’t respond. Try again.", onRetry: { phase = .config })
        }
    }

    // MARK: config

    private var configView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Waffled drafts a dinner rotation for the month from your recipe library, then you tweak it.")
                        .font(.system(size: 14)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)

                    WaffledFieldCard(title: "Which days?") {
                        HStack(spacing: 6) { ForEach(0..<7, id: \.self) { weekdayChip($0) } }
                    }

                    WaffledCard(padding: 14) {
                        HStack {
                            Text("Cooking for").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer()
                            Menu {
                                Button { cookingFor = 0 } label: { Text("\(familySize) · whole family") }
                                ForEach(1...8, id: \.self) { n in Button { cookingFor = n } label: { Text("\(n)") } }
                            } label: { WaffledMenuPill(text: cookingFor == 0 ? "\(familySize) · whole family" : "\(cookingFor)") }
                        }
                    }

                    WaffledCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle(isOn: $allowRepeats.animation()) {
                                Text("Allow repeat meals (a rotation)").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            }.tint(WF.ai)
                            if allowRepeats {
                                HStack {
                                    Text("No closer than").font(.system(size: 14)).foregroundStyle(WF.ink2)
                                    Spacer()
                                    Menu {
                                        ForEach([3, 5, 7, 10, 14], id: \.self) { d in Button { repeatGapDays = d } label: { Text("\(d) days") } }
                                    } label: { WaffledMenuPill(text: "\(repeatGapDays) days") }
                                }
                            }
                        }
                    }

                    WaffledCard(padding: 14) {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle(isOn: $quickWeeknights.animation()) {
                                Text("Quick weeknights").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            }.tint(WF.ai)
                            if quickWeeknights {
                                HStack {
                                    Text("Under").font(.system(size: 14)).foregroundStyle(WF.ink2)
                                    Spacer()
                                    Menu {
                                        ForEach([20, 30, 45], id: \.self) { m in Button { weeknightMax = m } label: { Text("\(m) min") } }
                                    } label: { WaffledMenuPill(text: "\(weeknightMax) min") }
                                }
                            }
                            Toggle(isOn: $leftovers) {
                                Text("Leftover nights after a big cook").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            }.tint(WF.ai)
                        }
                    }

                    if !weekdays.isEmpty {
                        let sortedDays = weekdays.sorted()
                        WaffledFieldCard(title: "Theme nights · optional") {
                            VStack(spacing: 0) {
                                ForEach(Array(sortedDays.enumerated()), id: \.element) { idx, dow in
                                    themeRow(dow)
                                    if idx < sortedDays.count - 1 { Divider().background(WF.hair) }
                                }
                            }
                        }
                    }

                    UseUpCard(items: $useUp, input: $useUpInput)

                    WaffledFieldCard(title: "Keep in mind") {
                        TextField("e.g. school nights are hectic · no pork", text: $keepInMind, axis: .vertical)
                            .font(.system(size: 14)).lineLimit(2...4)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                    }
                }
                .padding(20)
            }
            VStack(spacing: 0) {
                Divider().background(WF.hair)
                Button { Task { await suggest() } } label: {
                    Text("✨ Plan \(monthLabel)").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(weekdays.isEmpty ? WF.ink3 : WF.ai)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                .buttonStyle(.plain).disabled(weekdays.isEmpty)
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .background(WF.canvas)
        }
    }

    private func weekdayChip(_ dow: Int) -> some View {
        WeekdayToggleChip(label: Self.dayNames[dow], isOn: weekdays.contains(dow)) {
            if weekdays.contains(dow) { weekdays.remove(dow); themes[dow] = nil } else { weekdays.insert(dow) }
        }
    }

    /// One weekday's theme picker — a plain row (the parent groups them in a single card).
    private func themeRow(_ dow: Int) -> some View {
        HStack {
            Text(Self.dayNames[dow]).font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink).frame(width: 44, alignment: .leading)
            Spacer()
            Menu {
                Button { themes[dow] = nil } label: { Text("No theme") }
                ForEach(Self.themeOptions, id: \.key) { t in Button { themes[dow] = t.key } label: { Text(t.label) } }
            } label: {
                WaffledMenuPill(text: themes[dow].flatMap { k in Self.themeOptions.first { $0.key == k }?.label } ?? "No theme")
            }
        }
        .padding(.vertical, 9)
    }

    /// Fold a half-typed use-up entry into the chips (used before drafting). Mirrors
    /// `UseUpCard`'s own add logic so a pending input isn't lost on Plan.
    private func addUseUp() {
        let v = useUpInput.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty, !useUp.contains(v), useUp.count < 12 else { useUpInput = ""; return }
        useUp.append(v); useUpInput = ""
    }

    // MARK: loading / messages

    private var loadingView: some View {
        PlanLoadingView(title: "Drafting your month…",
                        subtitle: "Asking the kitchen AI — a month can take a moment on a local model.")
    }

    // MARK: review

    private var reviewView: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 10) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Your month").font(WF.serif(17, .bold)).foregroundStyle(WF.ink)
                            Text(reviewSubtitle).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                        Spacer()
                        PlanReshuffleButton(isBusy: redrafting && draftingDates.count > 1,
                                            isDisabled: redrafting || unlockedDates.isEmpty) {
                            Task { await reshuffle() }
                        }
                    }
                    if let notice {
                        Text(notice).font(.system(size: 12, weight: .medium)).foregroundStyle(WF.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            .background(WF.primary.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                    }
                    ForEach(weekGroups, id: \.key) { group in
                        weekHeader(group)
                        if !collapsedWeeks.contains(group.key) {
                            if isKiosk {
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300, maximum: 460), spacing: 12, alignment: .top)],
                                          alignment: .leading, spacing: 12) {
                                    ForEach(group.cards) { card in suggestionCard(card) }
                                }
                            } else {
                                ForEach(group.cards) { card in suggestionCard(card) }
                            }
                        }
                    }
                    Text("Tap a week to collapse it · lock / swap / pick · drag a night onto another to swap · ✕ to skip.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3).frame(maxWidth: .infinity, alignment: .center).padding(.top, 2)
                }
                .padding(16)
            }
            applyBar
        }
    }

    private var reviewSubtitle: String {
        var parts: [String] = []
        if let via { parts.append("Drafted via \(MealPlanText.viaLabel(via))") }
        if !plannedDates.isEmpty { parts.append("\(plannedDates.count) already planned") }
        return parts.joined(separator: " · ")
    }
    private var unlockedDates: [String] { suggestions.map(\.date).filter { !locked.contains($0) } }

    /// Every month night grouped by the Sunday that starts its week, in date order.
    private var weekGroups: [(key: String, cards: [WaffledAPI.PlanCardDTO])] {
        var groups: [String: [WaffledAPI.PlanCardDTO]] = [:]
        for c in suggestions { groups[weekKey(c.date), default: []].append(c) }
        return groups.keys.sorted().map { k in (k, groups[k]!.sorted { $0.date < $1.date }) }
    }

    /// A tappable week header that collapses/expands the week's nights.
    private func weekHeader(_ group: (key: String, cards: [WaffledAPI.PlanCardDTO])) -> some View {
        let collapsed = collapsedWeeks.contains(group.key)
        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                if collapsed { collapsedWeeks.remove(group.key) } else { collapsedWeeks.insert(group.key) }
            }
        } label: {
            HStack(spacing: 7) {
                DisclosureChevron(isOpen: !collapsed)
                Text("Week of \(weekLabel(group.key))").font(.system(size: 12, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ink2)
                Spacer()
                Text("\(group.cards.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 4).padding(.top, 8).padding(.bottom, 2).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func weekKey(_ ymd: String) -> String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = sync.householdTz
        guard let d = DateFmt.date(ymd, "yyyy-MM-dd", sync.householdTz) else { return ymd }
        let weekdayIdx = cal.component(.weekday, from: d) - 1   // Sunday → 0
        let sunday = cal.date(byAdding: .day, value: -weekdayIdx, to: d) ?? d
        return DateFmt.string(sunday, "yyyy-MM-dd", sync.householdTz)
    }
    private func weekLabel(_ key: String) -> String {
        guard let d = DateFmt.date(key, "yyyy-MM-dd", sync.householdTz) else { return key }
        return DateFmt.string(d, "MMM d", sync.householdTz)
    }

    private func suggestionCard(_ card: WaffledAPI.PlanCardDTO) -> some View {
        let isLocked = locked.contains(card.date)
        var tags: [String] = []
        if let m = card.minutes { tags.append("🕐 \(m)m") }
        tags.append(card.recipeId != nil ? "📖 Library" : "✨ Special")
        if plannedDates.contains(card.date) && !dirty.contains(card.date) {
            tags.append("Was planned")
        } else if let note = card.note, !note.isEmpty {
            tags.append(note)
        }
        return MealPlanReviewCard(
            card: card,
            dayLabel: MealPlanText.weekday(card.date, sync.householdTz),
            isLocked: isLocked,
            isBusy: draftingDates.contains(card.date),
            isDragTarget: dragOverDate == card.date,
            metaTags: tags,
            belowTitleNote: nil,
            titleMultilineLeading: false,
            onSkip: { skip(card) },
            onSwap: { Task { await swap(card) } },
            onPick: { pickTarget = PickTarget(date: card.date) },
            onToggleLock: { toggleLock(card.date) },
            onDrop: { s in swapCards(s, card.date); return true },
            onDragTargetChange: { over in
                dragOverDate = over ? card.date : (dragOverDate == card.date ? nil : dragOverDate)
            },
            actionsDisabled: redrafting || isLocked)
    }

    /// Swap the meals on two review nights (keeps each card's date).
    private func swapCards(_ srcDate: String, _ tgtDate: String) {
        guard srcDate != tgtDate,
              !locked.contains(srcDate), !locked.contains(tgtDate),   // locked nights don't move
              let i = suggestions.firstIndex(where: { $0.date == srcDate }),
              let j = suggestions.firstIndex(where: { $0.date == tgtDate }) else { return }
        let a = suggestions[i], b = suggestions[j]
        suggestions[i] = WaffledAPI.PlanCardDTO(date: a.date, mealType: a.mealType, title: b.title, recipeId: b.recipeId,
                                             emoji: b.emoji, minutes: b.minutes, servings: b.servings, note: b.note)
        suggestions[j] = WaffledAPI.PlanCardDTO(date: b.date, mealType: b.mealType, title: a.title, recipeId: a.recipeId,
                                             emoji: a.emoji, minutes: a.minutes, servings: a.servings, note: a.note)
        dirty.insert(a.date); dirty.insert(b.date)
    }

    private var applyBar: some View {
        PlanApplyBar(isBusy: applying,
                     isInactive: suggestions.isEmpty,
                     isDisabled: suggestions.isEmpty || applying || redrafting,
                     label: applying ? "Saving…" : "Save month & build list") {
            Task { await apply() }
        }
    }

    // MARK: actions

    private var themesDict: [String: String] {
        Dictionary(themes.compactMap { (dow, key) in weekdays.contains(dow) ? (String(dow), key) : nil }, uniquingKeysWith: { a, _ in a })
    }

    private func suggest() async {
        addUseUp()
        await draft(dates: [], avoid: Array(rejected), full: true)
    }

    private func draft(dates: [String], avoid: [String], full: Bool) async {
        if full { phase = .loading } else { redrafting = true; draftingDates = Set(dates) }
        defer { redrafting = false; draftingDates = [] }
        do {
            let result = try await api.planMonth(
                start: monthStart,
                weekdays: full ? weekdays.sorted() : nil,
                skipDates: full ? skipped.sorted() : nil,
                dates: full ? nil : dates,
                cookingFor: cookingFor > 0 ? cookingFor : nil,
                keepInMind: keepInMind, useUp: Array(useUp.prefix(12)), avoidTitles: avoid,
                allowRepeats: allowRepeats, repeatGapDays: repeatGapDays,
                weekdayThemes: themesDict, weeknightMaxMin: quickWeeknights ? weeknightMax : nil, leftovers: leftovers)
            via = result.via
            if let err = result.error, result.suggestions.isEmpty { errorMessage = MealPlanText.friendly(err); if full { phase = .failed }; return }
            if full {
                // Show the WHOLE month: freshly-drafted empty nights + the nights
                // that were already planned (editable, badged "Was planned").
                let existing = result.existing ?? []
                plannedDates = Set(existing.map(\.date))
                dirty = []
                suggestions = (result.suggestions + existing).sorted { $0.date < $1.date }
                guard !suggestions.isEmpty else { phase = .empty; return }
                phase = .review
            } else {
                let byDate = Dictionary(result.suggestions.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
                suggestions = suggestions.map { byDate[$0.date] ?? $0 }.sorted { $0.date < $1.date }
                dirty.formUnion(dates.filter { byDate[$0] != nil })   // re-drafted existing nights are now edited
                if !dates.contains(where: { byDate[$0] != nil }) {
                    notice = "No fresh options for that night — tap Pick to choose any recipe."
                } else { notice = nil }
            }
        } catch {
            errorMessage = "The AI provider didn’t respond. Check your connection and try again."
            if full { phase = .failed }
        }
    }

    private func reshuffle() async {
        let dates = unlockedDates.sorted()
        for c in suggestions where dates.contains(c.date) { rejected.insert(c.title) }
        let lockedTitles = suggestions.filter { locked.contains($0.date) }.map(\.title)
        await draft(dates: dates, avoid: Array(rejected) + lockedTitles, full: false)
    }

    private func swap(_ card: WaffledAPI.PlanCardDTO) async {
        rejected.insert(card.title)
        await draft(dates: [card.date], avoid: Array(rejected), full: false)
    }

    private func pickRecipe(date: String, _ r: WaffledAPI.RecipeSummary) {
        if let old = suggestions.first(where: { $0.date == date }) { rejected.insert(old.title) }
        let card = WaffledAPI.PlanCardDTO(date: date, mealType: "dinner", title: r.title, recipeId: r.id, emoji: r.emoji,
                                       minutes: r.cookTimeMinutes, servings: cookingFor > 0 ? cookingFor : familySize, note: "Your pick")
        suggestions = suggestions.map { $0.date == date ? card : $0 }.sorted { $0.date < $1.date }
        dirty.insert(date); notice = nil; pickTarget = nil
    }

    private func toggleLock(_ date: String) { if locked.contains(date) { locked.remove(date) } else { locked.insert(date) } }
    /// Drop a night from the plan — removes its card; an originally-planned night
    /// gets cleared on save.
    private func skip(_ card: WaffledAPI.PlanCardDTO) {
        withAnimation { suggestions.removeAll { $0.date == card.date } }
        skipped.insert(card.date)
    }

    private func apply() async {
        applying = true
        // Write new drafts + edited existing nights; leave untouched existing nights
        // alone; clear nights that were planned before but the user skipped.
        for card in suggestions where !plannedDates.contains(card.date) || dirty.contains(card.date) {
            _ = await sync.setMealPlan(date: card.date, mealType: card.mealType,
                                       recipeId: card.recipeId, title: card.recipeId == nil ? card.title : nil)
        }
        for d in skipped where plannedDates.contains(d) {
            _ = await sync.clearMealPlan(date: d, mealType: "dinner")
        }
        await sync.rebuildGroceryFromWeek(weekStart: monthStart)
        applying = false
        onApplied()
        dismiss()
    }

}
