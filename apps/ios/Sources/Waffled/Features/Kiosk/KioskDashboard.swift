import SwiftUI

/// The iPad Today page — the web-parity family dashboard (Phase 2 expansion).
///
/// Three columns mirroring the web `Today`: the week agenda · tonight's dinner +
/// this week's dinners · per-person chores + the grocery list. Cards **link to the
/// right rail page** via `navigate`, and drill-ins (event detail, recipe, cook mode)
/// open as sheets. See `apps/ios/IPAD_ROADMAP.md`.
struct KioskDashboard: View {
    @Environment(SyncManager.self) private var sync
    /// Cook Mode is presented app-level (from `RootView`) off this store. Because this
    /// page opens the recipe as a `.fullScreenCover`, that root cover would otherwise
    /// queue behind it — so we dismiss the recipe cover the moment a cook starts.
    @Environment(CookSessionStore.self) private var cook

    /// Switch the shell's nav rail to another page (injected by `KioskShell`).
    var navigate: (KioskNav) -> Void = { _ in }
    /// Open one goal's detail on the Goals page (injected by `KioskShell`, which owns
    /// the Goals navigation path) — tapping the Family Goal card body lands on the
    /// goal itself, not just the Goals index.
    var openGoal: (WaffledAPI.Goal) -> Void = { _ in }

    @State private var model = KioskTodayModel()
    @State private var recipes = RecipesModel()
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
    /// Quick-add on the Today grocery card opens a half-sheet — the OS keeps its field
    /// above the keyboard natively (no bottom-pinned bar to lift, which fought the iPad
    /// keyboard and, when we tried to lift it, looped/crashed in portrait).
    @State private var groceryAddSheet = false
    /// The chosen Today layout (persisted) — see `DashLayout`.
    @AppStorage("waffled.kioskDashLayout") private var layoutRaw = DashLayout.balanced.rawValue
    private var layout: DashLayout { DashLayout(rawValue: layoutRaw) ?? .balanced }

    /// Goal-focused preset: which goal is pinned to the wall (persisted). Empty = auto
    /// (featured → whole-family → first). A picker on the card lets the family switch it.
    @AppStorage("waffled.kioskGoalId") private var kioskGoalId = ""

    /// The card's pick order as a pure function (tested in KioskGoalPickTests): pinned
    /// if it still exists → Spotlight → Pinned tier (isFeatured) → a whole-family goal
    /// (multi-member households) → the first goal.
    nonisolated static func featuredGoal(_ goals: [WaffledAPI.Goal], pinnedId: String,
                                         memberIds: Set<String>) -> WaffledAPI.Goal? {
        if !pinnedId.isEmpty, let g = goals.first(where: { $0.id == pinnedId }) { return g }
        if let f = goals.first(where: { $0.isSpotlight ?? false }) ?? goals.first(where: { $0.isFeatured }) { return f }
        if memberIds.count > 1,
           let fam = goals.first(where: { memberIds.isSubset(of: Set($0.participants.map(\.personId))) }) {
            return fam
        }
        return goals.first
    }

    /// The goal the Goal-focused layout features — see `featuredGoal` for the pick order.
    private var kioskGoal: WaffledAPI.Goal? {
        Self.featuredGoal(model.goals, pinnedId: kioskGoalId, memberIds: Set(sync.members.map(\.id)))
    }

    private var tz: TimeZone { sync.householdTz }
    private var todayKey: String { Agenda.todayKey(tz) }

    private var week: [(day: String, items: [SyncedEvent])] {
        Array(Agenda.upcoming(byDay: sync.eventsByDay, from: todayKey).prefix(7))
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
        // Per-domain reloads: each fires on appear (initial load) and only when its own
        // bus bumps — so a grocery toggle no longer reloads chores + meals + weather.
        .task(id: "\(tz.identifier)|\(sync.choresRev)") { await model.loadChores() }
        .task(id: "\(tz.identifier)|\(sync.mealsRev)") { await model.loadMeals(todayKey: todayKey) }
        .task(id: "\(tz.identifier)|\(sync.groceryRev)") { await model.loadGrocery() }
        .task(id: tz.identifier) { await model.loadWeather() }
        .task(id: sync.goalsRev) {
            await model.loadGoals()
            // Headless check of the card-tap wiring: launched onto Today with
            // WAFFLED_OPEN_GOAL=1, "tap" the Family Goal card once goals are in.
            if DemoHooks.openGoal, DemoHooks.kioskPage == "today", let g = kioskGoal { openGoal(g) }
        }
        // Open the grocery add sheet for verification (the Today twin of the Lists
        // page's WAFFLED_FOCUS_ADD hook).
        .task {
            if DemoHooks.focusAdd, DemoHooks.kioskPage == "today" {
                try? await Task.sleep(for: .seconds(2))
                groceryAddSheet = true
            }
        }
        // Day rollover on the always-on display: sleep to just past each
        // household-tz midnight, then refetch the day-scoped domains so the wall
        // iPad doesn't keep showing yesterday's dinner and chores.
        .task(id: tz.identifier) {
            while !Task.isCancelled {
                let wait = Agenda.secondsUntilNextDay(after: Date(), tz: tz)
                try? await Task.sleep(for: .seconds(wait))
                guard !Task.isCancelled else { return }
                async let c: () = model.loadChores()
                async let m: () = model.loadMeals(todayKey: todayKey)
                _ = await (c, m)
            }
        }
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
        // Starting a cook (Cook button / auto-cook) closes this recipe cover so the
        // app-root Cook Mode cover presents immediately instead of queueing behind it.
        // Cook Mode is durable (survives backgrounding); closing it lands back on Today.
        .onChange(of: cook.isActive) { _, active in
            if active { recipeTarget = nil }
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
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
                Text(reviewRecapTitle(nR, nS)).font(.system(size: 18, weight: .heavy)).foregroundStyle(WF.ink)
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


    // MARK: columns (preset layouts)

    // Each column scrolls its own overflow within the fixed dashboard height, so a long
    // grocery/chore stack stays reachable instead of being clipped off the bottom.
    private var agendaCol: some View {
        VStack(spacing: 22) {
            agendaColumn
            CountdownsCard(kiosk: true)
            // Pantry (shared card; it hides itself when the household's "show on Today"
            // toggle is off, matching web).
            if sync.module(.pantry) { PantryTodayCard(kiosk: true) { navigate(.pantry) } }
        }
    }


    // Center column: tonight + this week's dinners, then Family Night (the evening
    // gathering pairs with the meal plan). Scrolls its own overflow.
    private var mealsCol: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 22) {
                tonightCard
                weekDinnersCard
                if sync.module(.familyNight) { FamilyNightCard(kiosk: true) }
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

    /// The featured-goal hero (shared with the iPhone Today card). Picking a goal in its
    /// switcher pins it to the wall; logging refreshes the goals + bus.
    @ViewBuilder private var goalCard: some View {
        GoalHeroCard(kiosk: true, goal: kioskGoal, goals: model.goals, goalsLoaded: model.goalsLoaded,
                     myPersonId: sync.currentPersonId, householdMemberIds: Set(sync.members.map(\.id)),
                     selectedId: kioskGoalId,
                     onOpen: { openGoal($0) }, onSeeAll: { navigate(.goals) }, onPin: { pinGoal($0) },
                     onLogged: { Task { await model.loadGoals(); sync.touchGoals() } })
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
                    Text(model.mealsLoaded ? "No dinner planned" : "Loading…")
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
                    Text(model.choresLoaded ? "No chores today" : "Loading…")
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
                    Text(model.groceryLoaded ? "All bought ✓" : "Loading…")
                        .font(.system(size: 16)).foregroundStyle(WF.ink3).padding(.vertical, 8)
                    Spacer(minLength: 0)
                } else {
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
                // Add opens a half-sheet — the OS floats its text field above the keyboard,
                // so there's no bottom-pinned bar to lift (which fought the iPad keyboard and
                // looped/crashed when we tried to lift it).
                Button { groceryAddSheet = true } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "plus.circle.fill").font(.system(size: 22)).foregroundStyle(WF.primary)
                        Text("Add an item").font(.system(size: 17)).foregroundStyle(WF.ink3)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 11)
                    .overlay(alignment: .top) { Rectangle().fill(WF.hair2).frame(height: 1) }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $groceryAddSheet) {
            AddGroceryItemSheet { name in await model.addGrocery(name) }
        }
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
    /// Tonight's dinner + the 7-day strip, derived together from one meals fetch so
    /// a failed refresh keeps (or a successful one replaces) them as a unit.
    struct Meals: Sendable {
        var tonight: TonightMeal?
        var week: [WaffledAPI.WeekEntryDTO] = []
    }

    // Each domain lives in a shared `RestDomain` (same layer as the phone's
    // DashboardModel): per-domain loaded flags — a fast fetch can't flash the
    // slower cards' empty states — and keep-prior-values-on-failure, so a network
    // blip on the always-on display never blanks it to "All bought ✓" /
    // "No dinner planned" / "No goals yet" while data exists.
    private let choresD = RestDomain<[WaffledAPI.PersonChoresDTO]>([])
    private let mealsD = RestDomain<Meals>(Meals())
    private let groceryD = RestDomain<[WaffledAPI.ListItemDTO]>([])
    private let goalsD = RestDomain<[WaffledAPI.Goal]>([])

    var chores: [WaffledAPI.PersonChoresDTO] { choresD.value }
    var tonight: TonightMeal? { mealsD.value.tonight }
    var weekDinners: [WaffledAPI.WeekEntryDTO] { mealsD.value.week }
    var grocery: [WaffledAPI.ListItemDTO] {
        get { groceryD.value }
        set { groceryD.value = newValue }   // optimistic check-off mutates in place
    }
    var goals: [WaffledAPI.Goal] { goalsD.value }
    var weather: WaffledAPI.Weather?

    var choresLoaded: Bool { choresD.loaded }
    var mealsLoaded: Bool { mealsD.loaded }
    var groceryLoaded: Bool { groceryD.loaded }
    var goalsLoaded: Bool { goalsD.loaded }

    /// Injectable for the unit tests (nil on failure, like DashboardModel);
    /// defaults hit `WaffledAPI`. `api` remains for the grocery mutations.
    private let fetchChores: @Sendable () async -> [WaffledAPI.PersonChoresDTO]?
    private let fetchMeals: @Sendable (String) async -> [WaffledAPI.WeekEntryDTO]?
    private let fetchGrocery: @Sendable () async -> [WaffledAPI.ListItemDTO]?
    private let fetchGoals: @Sendable () async -> [WaffledAPI.Goal]?
    private let fetchWeather: @Sendable () async -> WaffledAPI.Weather?

    init(fetchChores: (@Sendable () async -> [WaffledAPI.PersonChoresDTO]?)? = nil,
         fetchMeals: (@Sendable (String) async -> [WaffledAPI.WeekEntryDTO]?)? = nil,
         fetchGrocery: (@Sendable () async -> [WaffledAPI.ListItemDTO]?)? = nil,
         fetchGoals: (@Sendable () async -> [WaffledAPI.Goal]?)? = nil,
         fetchWeather: (@Sendable () async -> WaffledAPI.Weather?)? = nil) {
        let api = WaffledAPI()
        self.fetchChores = fetchChores ?? { try? await api.choresToday() }
        self.fetchMeals = fetchMeals ?? { try? await api.mealsWeek(start: $0) }
        self.fetchGrocery = fetchGrocery ?? { (try? await api.groceryBoard())?.items }
        self.fetchGoals = fetchGoals ?? { try? await api.goalsIn(listId: nil) }
        self.fetchWeather = fetchWeather ?? { try? await api.weather() }
    }

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
    }

    func loadGoals() async {
        goalsD.apply(await fetchGoals())
    }

    func loadChores() async {
        choresD.apply(await fetchChores().map { $0.filter { $0.total > 0 } })
    }

    func loadMeals(todayKey: String) async {
        mealsD.apply(await fetchMeals(todayKey).map { entries in
            let dinners = entries.filter { $0.mealType == "dinner" }
            return Meals(tonight: dinners.first(where: { $0.date == todayKey }).map(TonightMeal.init),
                         week: dinners.sorted { $0.date < $1.date })
        })
    }

    func loadGrocery() async {
        groceryD.apply(await fetchGrocery())
    }

    func loadWeather() async {
        if let w = await fetchWeather() { weather = w }
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

/// Add items to the grocery list from the Today card — a half-sheet whose text field the
/// OS keeps above the keyboard (so there's no bottom-pinned bar to lift). Return adds the
/// item and keeps the keyboard up for rapid entry; swipe down or Done to close.
struct AddGroceryItemSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (_ name: String) async -> Void

    @State private var draft = ""
    @State private var addedCount = 0
    @FocusState private var focused: Bool

    private var canAdd: Bool { !draft.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField("e.g. Milk", text: $draft)
                    .font(.system(size: 18, weight: .semibold))
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(add)
                    .padding(.horizontal, 15).padding(.vertical, 14)
                    .frame(maxWidth: .infinity, alignment: .leading).wfField()
                if addedCount > 0 {
                    Text("Added \(addedCount) item\(addedCount == 1 ? "" : "s") — keep typing, or swipe down when done.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .background(WF.canvas)
            .navigationTitle("Add to grocery").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Add", action: add).fontWeight(.semibold).disabled(!canAdd) }
            }
        }
        .presentationDetents([.height(210), .medium])
        .task { focused = true }
    }

    private func add() {
        let name = draft.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        draft = ""; addedCount += 1; focused = true
        Task { await onAdd(name) }
    }
}

#Preview(traits: .landscapeLeft) {
    KioskDashboard()
        .environment(SyncManager())
}
