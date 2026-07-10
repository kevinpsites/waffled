import SwiftUI

/// The iPad Today page — the web-parity family dashboard (Phase 2 expansion).
///
/// Three columns mirroring the web `Today`: the week agenda · tonight's dinner +
/// this week's dinners · per-person chores + the grocery list. Cards **link to the
/// right rail page** via `navigate`, and drill-ins (event detail, recipe, cook mode)
/// open as sheets. See `apps/ios/IPAD_ROADMAP.md`.
struct KioskDashboard: View {
    @Environment(SyncManager.self) private var sync

    /// Switch the shell's nav rail to another page (injected by `KioskShell`).
    var navigate: (KioskNav) -> Void = { _ in }

    @State private var model = KioskTodayModel()
    @State private var recipes = RecipesModel()
    @State private var countdowns = CountdownsModel()
    @State private var pantry = PantryModel()
    @State private var familyNight = FamilyNightModel()
    @State private var addCountdown = false
    @State private var detailEvent: SyncedEvent?
    @State private var recipeTarget: RecipeTarget?
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    /// Pinned alert banners (web/phone parity): the parent approval queue and the
    /// goal-calendar review queue. Both open their focused screen as a page sheet.
    @State private var approvals = ApprovalsModel()
    @State private var reviewRecap: [WaffledAPI.GoalRecapItem] = []
    @State private var reviewSuggestions: [WaffledAPI.GoalSuggestionItem] = []
    @State private var showApprovals = false
    @State private var showReview = false
    /// Quick-add field on the Today grocery card.
    @State private var groceryDraft = ""
    @FocusState private var groceryFocused: Bool
    /// The chosen Today layout (persisted) — see `DashLayout`.
    @AppStorage("waffled.kioskDashLayout") private var layoutRaw = DashLayout.balanced.rawValue
    private var layout: DashLayout { DashLayout(rawValue: layoutRaw) ?? .balanced }

    /// Goal-focused preset: which goal is pinned to the wall (persisted). Empty = auto
    /// (featured → whole-family → first). A picker on the card lets the family switch it.
    @AppStorage("waffled.kioskGoalId") private var kioskGoalId = ""
    @State private var logGoal: WaffledAPI.Goal?

    /// The goal the Goal-focused layout features: the pinned one if it still exists, else
    /// the featured goal, else a whole-family goal, else the first goal.
    private var kioskGoal: WaffledAPI.Goal? {
        if !kioskGoalId.isEmpty, let g = model.goals.first(where: { $0.id == kioskGoalId }) { return g }
        if let f = model.goals.first(where: { $0.isSpotlight ?? false }) ?? model.goals.first(where: { $0.isFeatured }) { return f }
        let everyone = Set(sync.members.map(\.id))
        if everyone.count > 1,
           let fam = model.goals.first(where: { everyone.isSubset(of: Set($0.participants.map(\.personId))) }) {
            return fam
        }
        return model.goals.first
    }

    private var tz: TimeZone { sync.householdTz }
    private var todayKey: String { Agenda.todayKey(tz) }

    private var week: [(day: String, items: [SyncedEvent])] {
        Array(Agenda.upcoming(sync.events, from: todayKey, tz: tz).prefix(7))
    }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        VStack(spacing: 10) {
            banners
            dashColumns
        }
        .padding(.horizontal, 40)
        // Tight top gap below the header (which already has its own .bottom padding); the
        // first element — approval bar, review bar, or just the columns — sits right under
        // it. Generous bottom padding stays for scroll breathing room.
        .padding(.top, 2)
        .padding(.bottom, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(WF.canvas)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .task { await sync.loadIdentity() }
        .task { await countdowns.load() }
        // Pantry card data (only when the module's on; no dedicated sync bus, so a
        // single load on appear — same as countdowns).
        // Key these to modulesRev: the flags often load *after* first appear, so a plain
        // .task would read the module as off and never fetch. Re-running on modulesRev
        // means they load as soon as the household's module state is known.
        .task(id: sync.modulesRev) { if sync.module(.pantry) { await pantry.load() } }
        .task(id: sync.modulesRev) { if sync.module(.familyNight) { await familyNight.load() } }
        // Per-domain reloads: each fires on appear (initial load) and only when its own
        // bus bumps — so a grocery toggle no longer reloads chores + meals + weather.
        .task(id: "\(tz.identifier)|\(sync.choresRev)") { await model.loadChores() }
        .task(id: "\(tz.identifier)|\(sync.mealsRev)") { await model.loadMeals(todayKey: todayKey) }
        .task(id: "\(tz.identifier)|\(sync.groceryRev)") { await model.loadGrocery() }
        .task(id: tz.identifier) { await model.loadWeather() }
        .task(id: sync.goalsRev) { await model.loadGoals() }
        // Pinned-banner queues: approvals refresh on chore/reward actions; the review
        // queue refreshes whenever a review/goal action bumps the goals bus.
        .task(id: "\(sync.choresRev)|\(sync.rewardsRev)") { await approvals.load() }
        .task(id: sync.goalsRev) {
            let api = WaffledAPI()
            async let r = try? await api.goalRecap()
            async let s = try? await api.goalSuggestions()
            reviewRecap = await r ?? []
            reviewSuggestions = await s ?? []
        }
        .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
        .sheet(item: $logGoal) { g in
            GoalLogSheet(goal: g) { amount, ids, note, loggedOn in
                Task {
                    try? await WaffledAPI().logGoalProgress(goalId: g.id, amount: amount, personIds: ids, note: note, loggedOn: loggedOn)
                    await model.loadGoals()
                    sync.touchGoals()
                }
            }
        }
        // The full recipe page, not a cramped iPad page-sheet — open it full-screen with
        // a Close button (matches the phone, which pushes the same view).
        .fullScreenCover(item: $recipeTarget) { t in
            NavigationStack {
                RecipeDetailView(summary: t.summary, model: recipes, autoCook: t.cook)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button { recipeTarget = nil } label: {
                                Image(systemName: "xmark").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink2)
                            }
                        }
                    }
            }
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $addCountdown) {
            AddCountdownSheet { title, date, emoji in await countdowns.add(title: title, date: date, emoji: emoji) }
        }
        .sheet(isPresented: $showApprovals) {
            NavigationStack { ApprovalsView() }.modifier(KioskSheetPresentation(kiosk: isKiosk))
        }
        .sheet(isPresented: $showReview) {
            NavigationStack { ReviewEventsView(path: .constant([])) }.modifier(KioskSheetPresentation(kiosk: isKiosk))
        }
    }

    // MARK: pinned alert banners

    /// Gold "N to approve" + purple "N to review · M to link" — the same alerts the
    /// phone/web pin atop Today. Each renders only when it has work and opens its
    /// focused queue as a page sheet. Hidden entirely (no gap) when both are empty.
    @ViewBuilder private var banners: some View {
        // Gate each bar by its module: approvals with chores, the goal-recap review
        // bar with goals (calendar itself is never gated).
        let showApprovalsBar = sync.module(.chores) && sync.canApprove && !approvals.isEmpty
        let showReviewBar = sync.module(.goals) && (!reviewRecap.isEmpty || !reviewSuggestions.isEmpty)
        if showApprovalsBar || showReviewBar {
            VStack(spacing: 12) {
                if showApprovalsBar {
                    Button { showApprovals = true } label: { approvalsBanner }.buttonStyle(.plain)
                }
                if showReviewBar {
                    Button { showReview = true } label: { reviewBanner }.buttonStyle(.plain)
                }
            }
        }
    }

    private var approvalsBanner: some View {
        let red = approvals.redemptions.map { "\($0.personName ?? "Someone")’s \($0.title)" }
        let ch = approvals.chores.map { "\($0.personName ?? "Someone")’s \($0.choreTitle)" }
        let preview = (red + ch).prefix(3).joined(separator: " · ")
        return HStack(spacing: 14) {
            Image(systemName: "checkmark.seal.fill").font(.system(size: 20, weight: .bold)).foregroundStyle(.white)
                .frame(width: 44, height: 44).background(WF.gold)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(approvals.total == 1 ? "1 thing waiting for your OK" : "\(approvals.total) things waiting for your OK")
                    .font(.system(size: 18, weight: .heavy)).foregroundStyle(WF.ink)
                Text(preview.isEmpty ? "Your OK awards the stars." : "\(preview) — your OK awards the stars.")
                    .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink3).lineLimit(1)
            }
            Spacer(minLength: 10)
            bannerCTA("Review", tint: WF.primary)
        }
        .padding(16)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.gold.opacity(0.35), lineWidth: 1))
        .wfShadow1()
    }

    private var reviewBanner: some View {
        let nR = reviewRecap.count, nS = reviewSuggestions.count
        let titles = reviewRecap.map(\.title) + reviewSuggestions.map(\.title)
        let preview = titles.prefix(3).joined(separator: " · ")
        return HStack(spacing: 14) {
            Image(systemName: "sparkles").font(.system(size: 20, weight: .bold)).foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(LinearGradient(colors: [WF.ai2, WF.ai], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(reviewTitle(nR, nS)).font(.system(size: 18, weight: .heavy)).foregroundStyle(WF.ink)
                Text(preview.isEmpty ? "Each ties to a goal." : "\(preview) — each ties to a goal.")
                    .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(WF.ink3).lineLimit(1)
            }
            Spacer(minLength: 10)
            bannerCTA("Review & log", tint: WF.primary)
        }
        .padding(16)
        .background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.ai.opacity(0.3), lineWidth: 1))
        .wfShadow1()
    }

    private func bannerCTA(_ label: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Text(label).font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(tint).clipShape(Capsule())
    }

    private func reviewTitle(_ nR: Int, _ nS: Int) -> String {
        if nR > 0 && nS > 0 { return "\(nR) to review · \(nS) to link" }
        if nR > 0 { return nR == 1 ? "1 event to log" : "\(nR) events to log" }
        return nS == 1 ? "1 event might count" : "\(nS) events might count"
    }

    // MARK: columns (preset layouts)

    // Each column scrolls its own overflow within the fixed dashboard height, so a long
    // grocery/chore stack stays reachable instead of being clipped off the bottom.
    private var agendaCol: some View {
        VStack(spacing: 22) {
            agendaColumn
            if countdowns.loaded { kioskCountdownsCard }
            // Pantry rides here (content-sized cards), gated by the household "show on
            // Today" toggle — so turning it off in Settings → Pantry hides it, matching web.
            if sync.module(.pantry), pantry.loaded, pantry.showOnToday { kioskPantryCard }
        }
    }

    /// Family Night card under the agenda column (iPad Today). Shows the upcoming
    /// gathering's date + agenda, with a per-part person picker that overrides this
    /// week's rotation (managed at its source — Settings → Family Night — for day/agenda).
    @ViewBuilder private func kioskFamilyNightCard(_ v: WaffledAPI.FamilyNightView) -> some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text("🏡 Family Night").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                    Spacer(minLength: 6)
                    Text(FamilyNightFormat.dateLabel(v.next.date))
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                if v.members.isEmpty {
                    Text("Add family members to start rotating the agenda.")
                        .font(.system(size: 15)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                } else {
                    ForEach(v.next.assignments) { a in
                        HStack(spacing: 12) {
                            Text(a.emoji).font(.system(size: 22))
                            Text(a.label).font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer(minLength: 8)
                            Menu {
                                ForEach(v.members) { m in
                                    Button {
                                        Task { await familyNight.assign(partId: a.partId, personId: m.id) }
                                    } label: {
                                        if m.id == a.personId { Label(m.name, systemImage: "checkmark") } else { Text(m.name) }
                                    }
                                }
                                if a.personId != nil {
                                    Divider()
                                    Button(role: .destructive) {
                                        Task { await familyNight.assign(partId: a.partId, personId: nil) }
                                    } label: { Label("Clear", systemImage: "xmark") }
                                }
                            } label: {
                                if let name = a.personName {
                                    HStack(spacing: 7) {
                                        if let m = v.members.first(where: { $0.id == a.personId }) {
                                            Avatar(colorHex: m.color, emoji: m.emoji ?? "🙂", size: 26)
                                        }
                                        Text(name).font(.system(size: 15, weight: .semibold))
                                            .foregroundStyle(a.suggested ? WF.ink3 : WF.ink)
                                    }
                                } else {
                                    Text("Pick").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ai)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// Compact countdowns card under the agenda column (iPad Today). Standalone items can
    /// be added (header "+ Add") and removed (row ✕) right here; events/birthdays are
    /// managed at their source (the event editor's countdown toggle · a member's birthday).
    @ViewBuilder private var kioskCountdownsCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Text("Countdowns").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                    Spacer(minLength: 6)
                    Button { addCountdown = true } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus").font(.system(size: 12, weight: .bold))
                            Text("Add").font(.system(size: 14, weight: .semibold))
                        }.foregroundStyle(WF.ai)
                    }.buttonStyle(.plain)
                }
                if countdowns.items.isEmpty {
                    Text("Nothing to count down to yet — add a trip; birthdays are automatic.")
                        .font(.system(size: 15)).foregroundStyle(WF.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                } else {
                    ForEach(countdowns.items.prefix(4)) { c in
                        HStack(spacing: 12) {
                            Text(c.emoji ?? "📅").font(.system(size: 22))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.title).font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                                Text(CountdownFormat.dateLabel(c.date)).font(.system(size: 13)).foregroundStyle(WF.ink3)
                            }
                            Spacer(minLength: 8)
                            Text(CountdownFormat.label(c.daysLeft, sleeps: countdowns.sleeps))
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(c.daysLeft <= 7 ? WF.primaryD : WF.ink2)
                            if c.isStandalone {
                                Button { Task { await countdowns.remove(c) } } label: {
                                    Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(WF.ink3)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    if countdowns.items.count > 4 {
                        Text("+\(countdowns.items.count - 4) more").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
            }
        }
    }
    // Center column: tonight + this week's dinners, then Family Night (the evening
    // gathering pairs with the meal plan). Scrolls its own overflow.
    private var mealsCol: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 22) {
                tonightCard
                weekDinnersCard
                if sync.module(.familyNight), let v = familyNight.view { kioskFamilyNightCard(v) }
            }
            .padding(.bottom, 8)
        }
    }
    // Chores sized to content; the grocery card fills the rest and scrolls its own
    // (full) list internally so it stays reachable. Grocery must be the *last* fill
    // element here — the pantry card lives in the agenda column so it can't crush it.
    private var choreGroceryCol: some View {
        VStack(spacing: 22) {
            choresCard
            groceryCard
        }
    }

    /// Compact pantry card under the chores/grocery column (iPad Today). Surfaces the
    /// items needing attention — use-soon (expiring ≤ 3 days / past) first, then merely
    /// running-low. Taps into the Pantry page. Mirrors the phone `PantryTodayCard`.
    @ViewBuilder private var kioskPantryCard: some View {
        let soon = pantry.onHand.filter { pantry.isSoon($0) }
            .sorted { (pantry.days($0) ?? .max) < (pantry.days($1) ?? .max) }
        let low = pantry.onHand.filter { pantry.isLow($0) && !pantry.isSoon($0) }.sorted { $0.name < $1.name }
        let attention = soon + low
        Button { navigate(.pantry) } label: {
            KioskCard {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Text("🥫 Pantry").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                        Spacer(minLength: 6)
                        Text(soon.isEmpty ? "\(pantry.onHand.count) on hand" : "\(pantry.onHand.count) on hand · \(soon.count) soon")
                            .font(.system(size: 13)).foregroundStyle(WF.ink3)
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                    if pantry.onHand.isEmpty {
                        pantryEmpty("Nothing logged yet — add what’s on hand.")
                    } else if attention.isEmpty {
                        pantryEmpty("All fresh — nothing to use up soon.")
                    } else {
                        ForEach(attention.prefix(5)) { kioskPantryRow($0) }
                        if attention.count > 5 {
                            Text("+\(attention.count - 5) more").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func pantryEmpty(_ text: String) -> some View {
        Text(text).font(.system(size: 15)).foregroundStyle(WF.ink3)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
    }

    private func kioskPantryRow(_ item: WaffledAPI.PantryItem) -> some View {
        HStack(spacing: 12) {
            Text(PantryFood.emoji(for: item.name)).font(.system(size: 22))
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                let qty = [item.amount, item.unit].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
                if !qty.isEmpty { Text(qty).font(.system(size: 13)).foregroundStyle(WF.ink3) }
            }
            Spacer(minLength: 8)
            if pantry.isSoon(item), let d = pantry.days(item) {
                Text(d < 0 ? "Expired" : d == 0 ? "Today" : "\(d) day\(d == 1 ? "" : "s")")
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(Color(hex: 0xB8860B))
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(Color(hex: 0xFBF0D5)).clipShape(Capsule())
            } else {
                Text("Low").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.primaryD)
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(WF.primaryD.opacity(0.12)).clipShape(Capsule())
            }
        }
    }

    // Concrete columns per layout (no AnyView — type erasure would stop SwiftUI from
    // diffing the three columns, forcing all of them to rebuild on every render). The
    // GeometryReader only supplies the width for the proportional `.frame`s.
    private static let colSpacing: CGFloat = 22

    @ViewBuilder private func dashRow(_ avail: CGFloat) -> some View {
        switch layout {
        case .balanced:
            let u = avail / 3
            HStack(alignment: .top, spacing: Self.colSpacing) {
                agendaCol.frame(width: u); mealsCol.frame(width: u); choreGroceryCol.frame(width: u)
            }
        case .agenda:
            let u = avail / (1.7 + 0.95 + 0.95)
            HStack(alignment: .top, spacing: Self.colSpacing) {
                agendaCol.frame(width: u * 1.7); mealsCol.frame(width: u * 0.95); choreGroceryCol.frame(width: u * 0.95)
            }
        case .meals:
            let u = avail / (1.5 + 1 + 1)
            HStack(alignment: .top, spacing: Self.colSpacing) {
                mealsCol.frame(width: u * 1.5); agendaCol.frame(width: u); choreGroceryCol.frame(width: u)
            }
        case .goal:
            let u = avail / (1.5 + 1 + 1)
            HStack(alignment: .top, spacing: Self.colSpacing) {
                goalCol.frame(width: u * 1.5); agendaCol.frame(width: u); choreGroceryCol.frame(width: u)
            }
        }
    }

    // MARK: goal column (Goal-focused layout)

    private var goalCol: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 22) {
                goalCard
                // Use the column's headroom for tonight's dinner — or the week's dinners
                // when nothing's planned for tonight.
                if model.tonight != nil { tonightCard } else { weekDinnersCard }
            }
            .padding(.bottom, 8)
        }
    }

    // The featured-goal green, identical to the Goals page hero.
    private static let heroGreen = LinearGradient(colors: [Color(hex: 0x2BA86B), Color(hex: 0x1C8A56)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing)
    private static let heroGreenInk = Color(hex: 0x1C8A56)

    @ViewBuilder private var goalCard: some View {
        if let g = kioskGoal {
            // A green hero card, matching the Goals page — white type on the gradient.
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Family Goal").font(.system(size: 14, weight: .heavy)).tracking(0.5)
                        .foregroundStyle(.white.opacity(0.9))
                    Spacer()
                    Button { navigate(.goals) } label: {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(.white.opacity(0.9))
                    }
                    .buttonStyle(.plain)
                }
                goalFocusBody(g)
            }
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Self.heroGreen)
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .wfShadow1()
        } else {
            KioskCard {
                VStack(alignment: .leading, spacing: 18) {
                    cardHeader("Family Goal", chevron: true) { navigate(.goals) }
                    Text(model.loaded ? "No goals yet — add one on the Goals page." : "Loading…")
                        .font(.system(size: 17)).foregroundStyle(WF.ink3).padding(.vertical, 12)
                }
            }
        }
    }

    /// The featured goal, big: a progress ring, title, each participant's bar, a prominent
    /// "Log progress" button, and (when there's more than one goal) a switcher.
    @ViewBuilder private func goalFocusBody(_ g: WaffledAPI.Goal) -> some View {
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        let maxProg = max(1, g.participants.map(\.progress).max() ?? 1)
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center, spacing: 18) {
                GoalRing(value: frac, size: 116, lineWidth: 10, stroke: .white, track: .white.opacity(0.25)) {
                    // Constrain the inner text well inside the ring so a long total
                    // (e.g. "333.5") never crowds the stroke.
                    VStack(spacing: 1) {
                        Text(goalFmt(g.totalProgress)).font(.system(size: 24, weight: .heavy)).foregroundStyle(.white)
                            .lineLimit(1).minimumScaleFactor(0.5)
                        if g.target != nil {
                            Text("of \(goalFmt(g.target))\(g.unit.map { " \($0)" } ?? "")")
                                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1).minimumScaleFactor(0.7)
                        }
                    }
                    .frame(width: 80)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(g.emoji ?? "🎯") \(g.title)")
                        .font(WF.serif(26)).foregroundStyle(.white).lineLimit(3).minimumScaleFactor(0.7)
                    if g.streakDays > 0 {
                        Text("🔥 \(g.streakDays)-day streak")
                            .font(.system(size: 15, weight: .bold)).foregroundStyle(.white.opacity(0.9))
                    }
                }
                Spacer(minLength: 0)
            }
            if !g.participants.isEmpty {
                VStack(spacing: 10) {
                    ForEach(g.participants, id: \.personId) { goalContribRow($0, max: maxProg, unit: g.unit) }
                }
            }
            Button { logGoal = g } label: {
                Label("Log \(g.unit ?? "progress")", systemImage: "plus.circle.fill")
                    .font(.system(size: 17, weight: .bold)).foregroundStyle(Self.heroGreenInk)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(.white).clipShape(Capsule())
            }
            .buttonStyle(.plain)
            if model.goals.count > 1 { goalSwitcher(current: g) }
        }
    }

    /// One participant's progress bar inside the green goal card (white on green).
    private func goalContribRow(_ p: WaffledAPI.Goal.Participant, max: Double, unit: String?) -> some View {
        HStack(spacing: 12) {
            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 32)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(p.name).font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    Spacer()
                    Text("\(goalFmt(p.progress))\(p.target.map { " / \(goalFmt($0))" } ?? "")\(unit.map { " \($0)" } ?? "")")
                        .font(.system(size: 14, weight: .heavy)).foregroundStyle(.white)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.25))
                        Capsule().fill(.white)
                            .frame(width: geo.size.width * (max > 0 ? min(p.progress / max, 1) : 0))
                    }
                }
                .frame(height: 8)
            }
        }
    }

    /// A compact switcher so the family can pin a different goal to the wall. Picking one
    /// also re-asserts the goal layout, so the dashboard never drifts off the goal view.
    private func goalSwitcher(current: WaffledAPI.Goal) -> some View {
        Menu {
            Button { pinGoal("") } label: {
                Label("Auto (featured)", systemImage: kioskGoalId.isEmpty ? "checkmark" : "sparkles")
            }
            ForEach(model.goals) { g in
                Button { pinGoal(g.id) } label: {
                    if kioskGoalId == g.id { Label("\(g.emoji ?? "🎯") \(g.title)", systemImage: "checkmark") }
                    else { Text("\(g.emoji ?? "🎯") \(g.title)") }
                }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 13, weight: .semibold))
                Text("Show a different goal").font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, 11)
            .background(.white.opacity(0.16)).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.4), lineWidth: 1))
        }
    }

    /// Pin a goal to the wall (empty = auto) and re-assert the goal layout, so picking a
    /// goal from the card can never drift the dashboard off the goal-focused view.
    private func pinGoal(_ id: String) {
        kioskGoalId = id
        layoutRaw = DashLayout.goal.rawValue
    }

    private var dashColumns: some View {
        GeometryReader { geo in
            dashRow(max(0, geo.size.width - Self.colSpacing * 2))
                .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
        }
    }

    // MARK: header (greeting + capture bar, then date · time · weather)

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 14) {
                Text(greetingPhrase).font(WF.serif(40)).foregroundStyle(WF.ink)
                Spacer(minLength: 12)
                layoutMenu
                AICaptureBar(onTap: { dictateOnOpen = false; showCapture = true },
                             onMic: { dictateOnOpen = true; showCapture = true })
                    .frame(maxWidth: 400)
            }
            dateLine
        }
        .padding(.horizontal, 40).padding(.top, 22).padding(.bottom, 10)
        .frame(maxWidth: .infinity)
        .background(WF.canvas)
    }

    /// Date · time · weather on one line, ticking on the minute.
    private var dateLine: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            HStack(spacing: 10) {
                Text(DateFmt.string(Date(), "EEEE, MMMM d", tz))
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink2)
                dot
                Text(DateFmt.string(ctx.date, "h:mm a", tz))
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink2)
                if let w = model.weather, w.configured, let t = w.tempF {
                    dot
                    Text("\(w.emoji ?? "") \(Int(t.rounded()))°")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink2)
                }
            }
        }
    }

    private var dot: some View { Text("·").font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink3) }

    /// The Today-layout switcher (Balanced / Agenda / Meals).
    private var layoutMenu: some View {
        Menu {
            ForEach(DashLayout.allCases, id: \.self) { l in
                Button { layoutRaw = l.rawValue } label: {
                    Label(l.label, systemImage: layout == l ? "checkmark" : l.icon)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.3.group").font(.system(size: 13, weight: .semibold))
                Text(layout.label).font(.system(size: 14, weight: .bold))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
            }
            .foregroundStyle(WF.ink2)
            .padding(.horizontal, 13).padding(.vertical, 9)
            .background(WF.card).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
        }
    }

    private var greetingPhrase: String { DateFmt.greeting(tz) }

    // MARK: agenda column

    private var agendaColumn: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 0) {
                cardHeader("This week", chevron: true) { navigate(.calendar) }
                    .padding(.bottom, 4)
                if week.isEmpty {
                    Text("Nothing scheduled.").font(.system(size: 18)).foregroundStyle(WF.ink3).padding(.vertical, 20)
                } else {
                    ScrollView(showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(week, id: \.day) { group in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(dayLabel(group.day))
                                        .font(.system(size: 14, weight: .heavy)).tracking(0.6).foregroundStyle(WF.ink3)
                                    ForEach(group.items) { ev in
                                        Button { detailEvent = ev } label: { kioskEventRow(ev) }.buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func kioskEventRow(_ ev: SyncedEvent) -> some View {
        HStack(spacing: 14) {
            RoundedRectangle(cornerRadius: 99).fill(Color(hexString: ev.colorHex) ?? WF.ink3).frame(width: 5, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(ev.title).font(.system(size: 21, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                Text(timeText(ev)).font(.system(size: 15)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 8)
            if let emoji = ev.emoji { Avatar(colorHex: ev.colorHex, emoji: emoji, size: 38) }
        }
        .contentShape(Rectangle())
    }

    private func timeText(_ ev: SyncedEvent) -> String {
        if ev.allDay { return "All day" }
        if let d = ev.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }

    private func dayLabel(_ key: String) -> String {
        if key == todayKey { return "TODAY" }
        if key == Agenda.todayKey(tz, now: Date().addingTimeInterval(86_400)) { return "TOMORROW" }
        guard let d = Self.dateFromKey(key, tz) else { return key }
        return DateFmt.string(d, "EEEE · MMM d", tz).uppercased()
    }

    // MARK: tonight's dinner (+ recipe / cook-mode buttons)

    @ViewBuilder private var tonightCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeader("Tonight's dinner", chevron: false)
                if let meal = model.tonight {
                    HStack(spacing: 16) {
                        RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                            .fill(LinearGradient(colors: meal.eatingOut
                                                    ? [Color(hex: 0xD9E7F6), Color(hex: 0xBCD0E9)]
                                                    : [Color(hex: 0xF6D9C6), Color(hex: 0xE9B596)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 84, height: 84)
                            .overlay(Text(meal.emoji).font(.system(size: 40)))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(meal.title).font(WF.serif(26)).foregroundStyle(WF.ink).lineLimit(2)
                            if let sub = mealSubtitle(meal) {
                                Text(sub).font(.system(size: 15)).foregroundStyle(WF.ink3)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    if let summary = meal.recipeSummary {
                        HStack(spacing: 12) {
                            secondaryButton("View recipe") { recipeTarget = .init(summary: summary, cook: false) }
                            primaryButton("👨‍🍳 Cook Mode") { recipeTarget = .init(summary: summary, cook: true) }
                        }
                    }
                } else {
                    Text(model.loaded ? "No dinner planned" : "Loading…")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(WF.ink3).padding(.vertical, 14)
                }
            }
        }
    }

    private func mealSubtitle(_ meal: TonightMeal) -> String? {
        if meal.eatingOut { return "No cooking tonight 🎉" }
        var parts: [String] = []
        if let m = meal.cookTimeMinutes { parts.append("🕐 \(m) min") }
        if let s = meal.servings { parts.append("serves \(s)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: this week's dinners

    @ViewBuilder private var weekDinnersCard: some View {
        if !model.weekDinners.isEmpty {
            KioskCard {
                VStack(alignment: .leading, spacing: 12) {
                    cardHeader("This week's dinners", trailing: "\(model.weekDinners.count) planned", chevron: true) {
                        navigate(.meals)
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(model.weekDinners.prefix(6).enumerated()), id: \.element.id) { idx, entry in
                            Button { navigate(.meals) } label: { dinnerRow(entry) }.buttonStyle(.plain)
                            if idx < min(model.weekDinners.count, 6) - 1 {
                                Rectangle().fill(WF.hair2).frame(height: 1)
                            }
                        }
                    }
                }
            }
        }
    }

    private func dinnerRow(_ e: WaffledAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 12) {
            Text(Self.dayShort(e.date, tz)).font(.system(size: 14, weight: .heavy))
                .foregroundStyle(WF.ink3).frame(width: 42, alignment: .leading)
            Text(e.recipe?.emoji ?? "🍽️").font(.system(size: 22))
            Text(e.displayTitle).font(.system(size: 17, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
        }
        .padding(.vertical, 11).contentShape(Rectangle())
    }

    // MARK: family chores (per-person)

    private var choresCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 14) {
                cardHeader("Family Chores", trailing: "Today", chevron: true) { navigate(.tasks) }
                if model.chores.isEmpty {
                    Text(model.loaded ? "No chores today" : "Loading…")
                        .font(.system(size: 16)).foregroundStyle(WF.ink3).padding(.vertical, 8)
                } else {
                    VStack(spacing: 16) {
                        // Each person row opens the Chores page too, not just the header —
                        // tapping anyone in the card is a natural "show me chores" gesture.
                        ForEach(model.chores) { p in
                            Button { navigate(.tasks) } label: { personChoreRow(p) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private func personChoreRow(_ p: WaffledAPI.PersonChoresDTO) -> some View {
        let tint = Color(hexString: p.colorHex) ?? WF.primary
        let frac = p.total > 0 ? Double(p.done) / Double(p.total) : 0
        return HStack(spacing: 14) {
            ZStack {
                Circle().stroke(tint.opacity(0.22), lineWidth: 3).frame(width: 46, height: 46)
                Circle().trim(from: 0, to: frac)
                    .stroke(tint, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 46, height: 46)
                Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 36)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name).font(.system(size: 18, weight: .bold)).foregroundStyle(WF.ink)
                Text("\(p.done) of \(p.total) done").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 6)
            Text("★ \(p.stars)").font(.system(size: 17, weight: .heavy)).foregroundStyle(WF.gold)
        }
        .contentShape(Rectangle())   // the whole row (incl. the spacer gap) is tappable
    }

    // MARK: grocery (named list + checkboxes)

    private var groceryCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 12) {
                cardHeader("Grocery", trailing: "\(model.groceryActive.count) to buy", chevron: true) { navigate(.lists) }
                if model.groceryActive.isEmpty {
                    Text(model.loaded ? "All bought ✓" : "Loading…")
                        .font(.system(size: 16)).foregroundStyle(WF.ink3).padding(.vertical, 8)
                    Spacer(minLength: 0)
                } else {
                    // The full list scrolls within the card; the add row below stays pinned.
                    ScrollView(showsIndicators: false) {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(model.groceryActive.enumerated()), id: \.element.id) { idx, item in
                                groceryRow(item)
                                if idx < model.groceryActive.count - 1 {
                                    Rectangle().fill(WF.hair2).frame(height: 1)
                                }
                            }
                        }
                    }
                }
                groceryAddRow
            }
        }
    }

    /// Inline "add to grocery" field — type an item and hit return (or Add) without
    /// leaving Today.
    private var groceryAddRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "plus.circle.fill").font(.system(size: 22))
                .foregroundStyle(groceryDraft.isEmpty ? WF.ink3 : WF.primary)
            TextField("Add an item", text: $groceryDraft)
                .font(.system(size: 17)).foregroundStyle(WF.ink)
                .focused($groceryFocused)
                .submitLabel(.done)
                .onSubmit(addGroceryItem)
            if !groceryDraft.isEmpty {
                Button("Add", action: addGroceryItem)
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(WF.primary)
                    .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 11)
        .overlay(alignment: .top) { Rectangle().fill(WF.hair2).frame(height: 1) }
    }

    private func addGroceryItem() {
        let name = groceryDraft
        groceryDraft = ""
        groceryFocused = true   // keep the keyboard up for rapid entry
        Task { await model.addGrocery(name) }
    }

    private func groceryRow(_ item: WaffledAPI.ListItemDTO) -> some View {
        Button {
            Task { await model.toggleGrocery(item.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22)).foregroundStyle(item.checked ? WF.primary : WF.ink3)
                Text(item.name).font(.system(size: 17)).foregroundStyle(item.checked ? WF.ink3 : WF.ink)
                    .strikethrough(item.checked, color: WF.ink3).lineLimit(1)
                Spacer(minLength: 6)
                if let q = item.quantity, !q.isEmpty {
                    Text(q).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                }
            }
            .padding(.vertical, 11).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: building blocks

    /// A card header. When `action` is set, the whole header is a button (with a
    /// chevron) that links to the relevant rail page.
    @ViewBuilder
    private func cardHeader(_ title: String, trailing: String? = nil, chevron: Bool, action: (() -> Void)? = nil) -> some View {
        let content = HStack(spacing: 8) {
            Text(title).font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
            Spacer(minLength: 6)
            if let trailing { Text(trailing).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3) }
            if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3) }
        }
        .contentShape(Rectangle())
        if let action {
            Button(action: action) { content }.buttonStyle(.plain)
        } else {
            content
        }
    }

    private func primaryButton(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(WF.primary).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func secondaryButton(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: date helpers

    static func dateFromKey(_ key: String, _ tz: TimeZone) -> Date? {
        // Called per meal-plan row — route through the cached formatter (POSIX + gregorian).
        DateFmt.date(key, "yyyy-MM-dd", tz)
    }

    static func dayShort(_ key: String, _ tz: TimeZone) -> String {
        guard let d = dateFromKey(key, tz) else { return "" }
        return DateFmt.string(d, "EEE", tz)
    }

    /// Identifies the recipe sheet target (and whether to jump into Cook Mode).
    struct RecipeTarget: Identifiable {
        let summary: WaffledAPI.RecipeSummary
        let cook: Bool
        var id: String { (summary.id) + (cook ? "-cook" : "") }
    }
}

/// REST-backed state for the iPad Today page — chores, tonight + this-week dinners,
/// the named grocery list (with optimistic check-off), and weather. Mirrors what the
/// web `Today` shows; reuses the same `WaffledAPI` endpoints as the iPhone dashboard.
@MainActor
@Observable
final class KioskTodayModel {
    var chores: [WaffledAPI.PersonChoresDTO] = []
    var tonight: TonightMeal?
    var weekDinners: [WaffledAPI.WeekEntryDTO] = []
    var grocery: [WaffledAPI.ListItemDTO] = []
    var weather: WaffledAPI.Weather?
    var goals: [WaffledAPI.Goal] = []
    var loaded = false

    private let api = WaffledAPI()

    /// Just-checked items linger here ~2s before dropping off, so a tap reads as
    /// "crossed out, then settles" instead of vanishing instantly (matches the Lists page).
    private var settling: Set<String> = []

    var choreDone: Int { chores.reduce(0) { $0 + $1.done } }
    var choreTotal: Int { chores.reduce(0) { $0 + $1.total } }
    var groceryActive: [WaffledAPI.ListItemDTO] { grocery.filter { !$0.checked || settling.contains($0.id) } }

    /// Full initial load — runs each domain in parallel. Per-domain methods below let
    /// the view refresh just the domain whose `rev` bumped (e.g. a grocery toggle
    /// reloads only grocery, not chores + meals + weather).
    func load(todayKey: String) async {
        async let a: () = loadChores()
        async let b: () = loadMeals(todayKey: todayKey)
        async let c: () = loadGrocery()
        async let d: () = loadWeather()
        async let e: () = loadGoals()
        _ = await (a, b, c, d, e)
        loaded = true
    }

    func loadGoals() async {
        goals = (try? await api.goalsIn(listId: nil)) ?? []
    }

    func loadChores() async {
        chores = ((try? await api.choresToday()) ?? []).filter { $0.total > 0 }
        loaded = true
    }

    func loadMeals(todayKey: String) async {
        let dinners = ((try? await api.mealsWeek(start: todayKey)) ?? []).filter { $0.mealType == "dinner" }
        tonight = dinners.first(where: { $0.date == todayKey }).map { TonightMeal($0) }
        weekDinners = dinners.sorted { $0.date < $1.date }
    }

    func loadGrocery() async {
        grocery = (try? await api.groceryBoard())?.items ?? []
    }

    func loadWeather() async {
        weather = try? await api.weather()
    }

    /// Quick-add a grocery item from the Today card, then refresh the list. Uses the
    /// "grocery" list slug (same one `groceryBoard()` resolves).
    func addGrocery(_ name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        try? await api.addListItem(listId: "grocery", name: trimmed, quantity: nil)
        await loadGrocery()
    }

    /// Optimistically toggle a grocery item, reverting on failure. A check-off stays
    /// visible (crossed out) for ~2s before settling off the list — same as Lists.
    func toggleGrocery(_ id: String) async {
        guard let idx = grocery.firstIndex(where: { $0.id == id }) else { return }
        let target = !grocery[idx].checked
        withAnimation { grocery[idx].checked = target }
        if target { settling.insert(id); scheduleSettle(id) } else { settling.remove(id) }
        do { try await api.patchListItem(id: id, checked: target) }
        catch {
            if let i = grocery.firstIndex(where: { $0.id == id }) { withAnimation { grocery[i].checked = !target } }
            settling.remove(id)
        }
    }

    private func scheduleSettle(_ id: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            // Only settle if it's still checked (the user may have toggled it back).
            if self.grocery.first(where: { $0.id == id })?.checked == true {
                withAnimation { _ = self.settling.remove(id) }
            }
        }
    }
}

/// The iPad Today preset layouts — same cards, re-weighted columns so each gives its
/// focus more space (the user picks one in the dashboard header switcher).
enum DashLayout: String, CaseIterable {
    case balanced, agenda, meals, goal
    var label: String {
        switch self {
        case .balanced: return "Balanced"
        case .agenda: return "Agenda-focused"
        case .meals: return "Meals-focused"
        case .goal: return "Goal-focused"
        }
    }
    var icon: String {
        switch self {
        case .balanced: return "rectangle.split.3x1"
        case .agenda: return "list.bullet.rectangle"
        case .meals: return "fork.knife"
        case .goal: return "target"
        }
    }
}

/// A large, kiosk-scaled card surface (the wall-display twin of `WaffledCard`).
struct KioskCard<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            .wfShadow1()
    }
}

#Preview(traits: .landscapeLeft) {
    KioskDashboard()
        .environment(SyncManager())
}
