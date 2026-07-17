import SwiftUI

/// "Cook from your pantry" — a sidebar card in the Pantry surface (gated behind the meals
/// module) that opens a modal mirroring the web kiosk. Five sections: a "Plan my week"
/// banner (AI planner seeded with soon-to-expire names), "Tonight · no cooking" leftovers
/// (Ate it / Plan into a slot), "You have everything" (recipes makeable now → detail /
/// Cook), "You have the main" (on-hand proteins → protein-filtered library + near-makeable
/// recipes + grocery add), and "Use up soon" chips. `ready`/`mains` come from
/// `/api/pantry/cookable`; the leftovers + use-soon buckets are computed on-device.

// MARK: - Entry card (embedded in PantryView)

struct CookFromPantryCard: View {
    @Environment(SyncManager.self) private var sync
    let model: PantryModel

    @State private var ready: [WaffledAPI.CookReady] = []
    @State private var mains: [WaffledAPI.CookMain] = []
    @State private var loaded = false
    @State private var open = false

    private var meals: [WaffledAPI.PantryItem] { model.onHand.filter { $0.isMeal == true } }
    private var useSoon: [WaffledAPI.PantryItem] { model.onHand.filter { model.isSoon($0) } }
    private var empty: Bool { ready.isEmpty && mains.isEmpty && meals.isEmpty && useSoon.isEmpty }

    var body: some View {
        Group {
            if sync.module(.meals) && !(loaded && empty) {
                card
            }
        }
        .task { await loadCookable() }
        .sheet(isPresented: $open) {
            CookFromPantrySheet(items: model.onHand, ready: ready, mains: mains) { await model.load() }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("🍳 Cook from your pantry").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink)
            Text(summary).font(.system(size: 12)).foregroundStyle(WF.ink3)
            Button { open = true } label: {
                Text("Plan from pantry").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(WF.primary).clipShape(Capsule())
            }.buttonStyle(.plain).padding(.top, 2)
        }
        .padding(12)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private var summary: String {
        var parts: [String] = []
        if !ready.isEmpty { parts.append("\(ready.count) ready") }
        if !mains.isEmpty { parts.append("\(mains.count) main\(mains.count == 1 ? "" : "s")") }
        let toUse = meals.count + useSoon.count
        if toUse > 0 { parts.append("\(toUse) to use up") }
        return parts.isEmpty ? "See what you can make" : parts.joined(separator: " · ")
    }

    private func loadCookable() async {
        guard sync.module(.meals) else { return }
        if let c = try? await WaffledAPI().pantryCookable() { ready = c.ready; mains = c.mains }
        loaded = true
    }
}

// MARK: - The modal

struct CookFromPantrySheet: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    /// Cook Mode presents app-level (from `RootView`); this sheet would otherwise block
    /// that cover, so it dismisses itself the moment a cook starts (auto-cook here).
    @Environment(CookSessionStore.self) private var cook
    let items: [WaffledAPI.PantryItem]
    let ready: [WaffledAPI.CookReady]
    let mains: [WaffledAPI.CookMain]
    let onChanged: () async -> Void

    @State private var model = RecipesModel()
    @State private var path = NavigationPath()
    @State private var plannedMap: [String: String] = [:]   // title(lowercased) → ymd
    @State private var eaten: Set<String> = []
    @State private var added: Set<String> = []              // recipeIds whose missing were added
    @State private var planFor: String?                     // item id with an open plan picker
    @State private var planDate = Date()
    @State private var planMeal = "dinner"
    @State private var planningWeek = false

    /// A recipe push that can request Cook Mode (autoCook) straight away.
    private struct RecipeNav: Hashable { let summary: WaffledAPI.RecipeSummary; let cook: Bool }
    private struct ProteinFilter: Hashable { let protein: String }
    private static let mealTypes = ["breakfast", "lunch", "dinner", "snack"]

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    planBanner
                    if !leftovers.isEmpty { tonightSection }
                    if !ready.isEmpty { readySection }
                    if !mains.isEmpty { mainsSection }
                    if !loose.isEmpty { useSoonSection }
                    if leftovers.isEmpty && ready.isEmpty && mains.isEmpty && loose.isEmpty {
                        Text("Nothing to cook from just yet. Add what’s on hand.")
                            .font(.system(size: 14)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity).padding(.vertical, 30)
                    }
                }
                .padding(18).padding(.bottom, 30)
            }
            .background(WF.canvas)
            .navigationTitle("Cook from your pantry").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: RecipeNav.self) { RecipeDetailView(summary: $0.summary, model: model, autoCook: $0.cook) }
            .navigationDestination(for: ProteinFilter.self) { RecipesLibraryView(model: model, initialProtein: $0.protein) }
        }
        .task { await model.load(); await loadPlanned() }
        // Auto-cook pushes a recipe here then starts a cook; close this sheet so the
        // app-root Cook Mode cover isn't queued behind it.
        .onChange(of: cook.isActive) { _, active in
            if active { dismiss() }
        }
        .sheet(isPresented: $planningWeek) {
            PlanWeekSheet(start: ymd(weekStart), weekLabel: weekTitle, weekDays: weekDays,
                          familySize: max(1, sync.members.count), recipes: model,
                          seedUseUp: Array(useSoonNames.prefix(12))) {
                Task { await onChanged() }
            }
        }
    }

    // MARK: derived buckets

    private func isSoon(_ i: WaffledAPI.PantryItem) -> Bool {
        guard let d = PantryExpiry.daysUntil(i.expiresOn, tz: sync.householdTz) else { return false }
        return d <= 3
    }
    private var leftovers: [WaffledAPI.PantryItem] { items.filter { $0.isMeal == true && !eaten.contains($0.id) } }
    private var useSoonNames: [String] { items.filter(isSoon).map(\.name) }
    private var mainNames: Set<String> { Set(mains.compactMap { $0.item?.name }) }
    private var loose: [WaffledAPI.PantryItem] {
        items.filter { $0.isMeal != true && isSoon($0) && !mainNames.contains($0.name) }
    }

    // MARK: (1) Plan my week

    private var planBanner: some View {
        Button { planningWeek = true } label: {
            HStack(spacing: 12) {
                Text("✨").font(.system(size: 22))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Plan my week").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text(useSoonNames.isEmpty ? "Build your dinners with AI"
                         : "Builds your week & uses up \(useSoonNames.count) before they spoil")
                        .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(14)
            .background(WF.ai.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
        }.buttonStyle(.plain)
    }

    // MARK: (2) Tonight · no cooking

    private var tonightSection: some View {
        section("🕘 Tonight · no cooking", "Ready to eat") {
            ForEach(leftovers) { m in tonightCard(m) }
        }
    }

    private func tonightCard(_ m: WaffledAPI.PantryItem) -> some View {
        let heat = m.location.lowercased().contains("freez")
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                CachedImage(m.imageUrl) { Text("🍱").font(.system(size: 22)) }
                    .frame(width: 40, height: 40).background(WF.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text(m.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                    HStack(spacing: 6) {
                        badge(heat ? "Heat & serve" : "Ready to eat", WF.primary)
                        if let e = expiryNote(m) { badge(e, WF.warn) }
                    }
                }
                Spacer(minLength: 0)
                VStack(spacing: 6) {
                    Button { Task { await ateIt(m) } } label: { pill("Ate it", filled: false) }.buttonStyle(.plain)
                    Button { tapPlan(m) } label: { pill(planLabel(m), filled: plannedDate(m) != nil) }.buttonStyle(.plain)
                }
            }
            if planFor == m.id { planPicker(m) }
        }
        .padding(11)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private func planPicker(_ m: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: 8) {
            Picker("", selection: $planMeal) {
                ForEach(Self.mealTypes, id: \.self) { Text($0.capitalized).tag($0) }
            }.pickerStyle(.menu).tint(WF.ink)
            DatePicker("", selection: $planDate, in: Date()..., displayedComponents: .date).labelsHidden().tint(WF.primary)
            Spacer()
            Button { Task { await planItem(m) } } label: {
                Text("Add").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 7).background(WF.primary).clipShape(Capsule())
            }.buttonStyle(.plain)
        }
        .padding(.top, 2)
    }

    // MARK: (3) You have everything

    private var readySection: some View {
        section("✓ You have everything", "Nothing to buy") {
            ForEach(ready) { r in readyCard(r) }
        }
    }

    private func readyCard(_ r: WaffledAPI.CookReady) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button { push(r.recipeId, r.title, r.emoji, cook: false) } label: {
                    Text(r.emoji ?? "🍽️").font(.system(size: 22))
                        .frame(width: 40, height: 40).background(WF.panel)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }.buttonStyle(.plain)
                Text(r.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Spacer(minLength: 0)
                Button { push(r.recipeId, r.title, r.emoji, cook: true) } label: {
                    Text("Cook").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 7).background(WF.primary).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
            if let e = r.expiringItem { Text("Uses \(e) due soon").font(.system(size: 12)).foregroundStyle(WF.warn) }
            if !r.have.isEmpty {
                ChipFlow(spacing: 6, lineSpacing: 6) {
                    ForEach(r.have, id: \.self) { h in
                        Text("✓ \(h)").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.success)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(WF.success.opacity(0.12)).clipShape(Capsule())
                    }
                }
            }
        }
        .padding(11)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: (4) You have the main

    private var mainsSection: some View {
        section("📈 You have the main", "On-hand proteins") {
            ForEach(mains) { m in mainGroup(m) }
        }
    }

    private func mainGroup(_ m: WaffledAPI.CookMain) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { path.append(ProteinFilter(protein: m.protein)) } label: {
                HStack(spacing: 8) {
                    Text(m.item?.name ?? m.protein.capitalized).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Spacer()
                    Text("\(m.count) recipe\(m.count == 1 ? "" : "s") ›").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.primary)
                }
            }.buttonStyle(.plain)
            ForEach(m.recipes) { rec in
                HStack(spacing: 8) {
                    Button { push(rec.recipeId, rec.title, nil, cook: false) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rec.title).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                            Text("Have \(rec.have) of \(rec.total) · need \(rec.missing.count <= 1 ? (rec.missing.first ?? "—") : "\(rec.missing.count)")")
                                .font(.system(size: 11.5)).foregroundStyle(WF.ink3).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }.buttonStyle(.plain)
                    Button { Task { await addMissing(rec) } } label: {
                        pill(added.contains(rec.recipeId) ? "✓ Added" : "+ List", filled: added.contains(rec.recipeId))
                    }.buttonStyle(.plain).disabled(rec.missing.isEmpty || added.contains(rec.recipeId))
                }
            }
        }
        .padding(11)
        .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    // MARK: (5) Use up soon

    private var useSoonSection: some View {
        section("🗑 Use up soon", "Loose items") {
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(loose) { i in
                    HStack(spacing: 5) {
                        Text(i.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                        if let e = expiryNote(i) { Text(e).font(.system(size: 11, weight: .bold)).foregroundStyle(WF.warn) }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6).background(WF.panel).clipShape(Capsule())
                }
            }
        }
    }

    // MARK: building blocks

    private func section<C: View>(_ title: String, _ trailing: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                Spacer()
                Text(trailing).font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            content()
        }
    }

    private func badge(_ text: String, _ color: Color) -> some View {
        Text(text).font(.system(size: 10.5, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 2).background(color.opacity(0.14)).clipShape(Capsule())
    }
    private func pill(_ text: String, filled: Bool) -> some View {
        Text(text).font(.system(size: 12.5, weight: .bold))
            .foregroundStyle(filled ? .white : WF.ink2)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(filled ? WF.primary : WF.panel).clipShape(Capsule())
    }

    // MARK: actions

    private func push(_ id: String, _ title: String, _ emoji: String?, cook: Bool) {
        let s = WaffledAPI.RecipeSummary.placeholder(id: id, title: title, emoji: emoji, category: nil, cookTimeMinutes: nil, servings: nil)
        path.append(RecipeNav(summary: s, cook: cook))
    }

    private func ateIt(_ item: WaffledAPI.PantryItem) async {
        eaten.insert(item.id)
        _ = try? await WaffledAPI().pantryConsume([(id: item.id, mode: "used_up")])
        await onChanged()
    }

    private func addMissing(_ rec: WaffledAPI.CookMainRecipe) async {
        for name in rec.missing { _ = await sync.commitGrocery(name: name, quantity: nil) }
        added.insert(rec.recipeId)
    }

    private func tapPlan(_ m: WaffledAPI.PantryItem) {
        if plannedDate(m) != nil { dismiss(); return }   // already planned — close back to the plan
        planDate = Date(); planMeal = "dinner"
        planFor = (planFor == m.id) ? nil : m.id
    }
    private func planItem(_ item: WaffledAPI.PantryItem) async {
        let date = ymd(planDate)
        _ = await sync.setMealPlan(date: date, mealType: planMeal, recipeId: nil, title: item.name)
        plannedMap[item.name.trimmingCharacters(in: .whitespaces).lowercased()] = date
        planFor = nil
    }
    private func plannedDate(_ item: WaffledAPI.PantryItem) -> String? {
        plannedMap[item.name.trimmingCharacters(in: .whitespaces).lowercased()]
    }
    private func planLabel(_ m: WaffledAPI.PantryItem) -> String {
        guard let d = plannedDate(m) else { return "Plan" }
        return "✓ \(dayLabel(d))"
    }

    private func loadPlanned() async {
        let today = ymd(Date())
        guard let entries = try? await WaffledAPI().mealsWeek(start: today, days: 21) else { return }
        var map: [String: String] = [:]
        for e in entries {
            guard let t = e.title, e.date >= today else { continue }
            map[t.trimmingCharacters(in: .whitespaces).lowercased()] = e.date
        }
        plannedMap = map
    }

    private func expiryNote(_ i: WaffledAPI.PantryItem) -> String? {
        guard let d = PantryExpiry.daysUntil(i.expiresOn, tz: sync.householdTz) else { return nil }
        if d < 0 { return "expired" }
        if d == 0 { return "today" }
        return "\(d)d left"
    }

    // MARK: week math (mirrors WeekPlannerView)

    private var cal: Calendar { Cal.gregorian(sync.householdTz) }
    private var weekStart: Date { Cal.weekStart(Date(), sync.householdTz) }   // honors live first-day-of-week
    private var weekDays: [Date] { (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: weekStart) } }
    private var weekTitle: String {
        guard let last = weekDays.last else { return "" }
        return "\(DateFmt.string(weekStart, "MMM d", sync.householdTz)) – \(DateFmt.string(last, "MMM d", sync.householdTz))"
    }
    private func ymd(_ d: Date) -> String { DateFmt.string(d, "yyyy-MM-dd", sync.householdTz) }
    private func dayLabel(_ ymd: String) -> String {
        if ymd == self.ymd(Date()) { return "today" }
        guard let d = PantryExpiry.date(ymd) else { return "planned" }
        return DateFmt.string(d, "EEE", sync.householdTz)
    }
}
