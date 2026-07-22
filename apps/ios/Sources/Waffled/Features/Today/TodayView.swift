import SwiftUI

/// Today — the home surface. Mock-faithful to the handoff `ios-home.png`:
/// greeting + capture bar, today's agenda, tonight's meal, chores + grocery.
/// Static sample data in Phase 0; PowerSync-backed in Phase 1+.
struct TodayView: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.scenePhase) private var scenePhase
    @State private var dash = DashboardModel()
    @State private var recipes = RecipesModel()   // backs a recipe pushed from tonight's card
    @State private var detailEvent: SyncedEvent?
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var scrolled = false   // cards have scrolled under the header → lift it
    @State private var weather: WaffledAPI.Weather?
    /// Pending approvals (reward purchases + chore check-offs), for the parent's
    /// "Needs your OK" entry card. Owned by AppRoot (like FamilyView's) so the
    /// badge, Family tab and this banner share one model — and one fetch per
    /// trigger: AppRoot reloads it at launch, on the chore/reward buses, and on
    /// return to the foreground.
    var approvals: ApprovalsModel
    /// Which goal the card highlights: "mine" (the logged-in member's) or "family"
    /// (a whole-family goal). Per-device preference; defaults to mine.
    @AppStorage("waffled.todayGoalScope") private var goalScope = "mine"
    /// A specific goal pinned to the Today card (empty = follow the My/Family spotlight scope).
    /// Per-device; falls back to the scope pick if the pinned goal is gone.
    @AppStorage("waffled.todayGoalId") private var todayGoalId = ""
    @State private var showingGoalPicker = false
    /// The resolved card layout (order + hidden) from the server, plus whether this
    /// member may edit the shared family default. Drives which cards render and how.
    @State private var cardOrder: [String] = ["agenda", "tonight", "chores", "grocery", "goals"]
    @State private var hiddenCards: Set<String> = []
    @State private var canEditFamily = false
    @State private var showCustomize = false
    /// Today's own nav stack — summary cards (and the greeting avatar) push here so
    /// Back returns to the dashboard. Uses `HubRoute` so the person spotlight,
    /// chores, grocery, and recipe all render with the shared `HubDestination`
    /// (lifted to AppRoot for re-tap-to-pop).
    @Binding var path: [HubRoute]
    /// Jump to the Calendar tab (from the agenda card).
    var openCalendar: () -> Void = {}

    private var todays: [SyncedEvent] {
        Agenda.forDay(sync.events, day: Agenda.todayKey(sync.householdTz), tz: sync.householdTz)
    }

    private var greetingMember: SyncedMember? {
        // Who you're signed in as (token-resolved), so the avatar verifies it; falls
        // back to the first adult until the identity loads.
        if let id = sync.currentPersonId, let m = sync.members.first(where: { $0.id == id }) { return m }
        return sync.members.first { ($0.memberType ?? "") == "adult" } ?? sync.members.first
    }

    private var greetingDate: String { DateFmt.string(Date(), "EEEE, MMM d", sync.householdTz) }

    private var greetingPhrase: String { DateFmt.greeting(sync.householdTz) }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Parent-only "Needs your OK" banner — gated with the chores module
                    // (no chores ⇒ nothing in the chore/reward approval queues).
                    if sync.module(.chores) { ApprovalsBanner(model: approvals) }
                    // The goal-recap review banner (calendar↔goal bridge) — gated with
                    // the goals module so it can't surface for a disabled feature.
                    if sync.module(.goals), !dash.reviewRecap.isEmpty || !dash.reviewSuggestions.isEmpty {
                        Button { path.append(.reviewEvents) } label: { reviewCard }.buttonStyle(.plain)
                    }
                    // The rest render in the user's saved order, hidden cards omitted.
                    ForEach(cardRows) { row in
                        switch row {
                        case let .single(key):
                            cardView(key)
                        case let .pair(a, b):
                            HStack(spacing: 12) { cardView(a); cardView(b) }
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 6)
                .padding(.bottom, 110)   // clear the floating tab bar
            }
            // Track whether content has scrolled off the top, so the header only
            // lifts (gets a shadow) once cards start tucking under it.
            .onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.contentInsets.top > 0.5
            } action: { _, isScrolled in
                withAnimation(.easeOut(duration: 0.2)) { scrolled = isScrolled }
            }
            .background(WF.canvas)
            // Greeting + capture bar stay pinned; the cards scroll under them.
            .safeAreaInset(edge: .top, spacing: 0) { stickyHeader }
            .toolbar(.hidden, for: .navigationBar)   // Today draws its own greeting header
            .navigationDestination(for: HubRoute.self) { route in
                HubDestination(route: route, path: $path, recipes: recipes)
            }
            .refreshable {
                // Independent endpoint batches — fetch them concurrently.
                async let d: () = dash.load(todayKey: Agenda.todayKey(sync.householdTz))
                async let g: () = dash.loadGoals()
                _ = await (d, g)
            }
            // Reload when the tz is known and whenever a capture commit bumps a domain.
            .task(id: "\(sync.householdTz.identifier)|\(sync.choresRev)|\(sync.groceryRev)|\(sync.mealsRev)") {
                await dash.load(todayKey: Agenda.todayKey(sync.householdTz))
            }
            .task { weather = try? await WaffledAPI().weather() }
            .task { await sync.loadIdentity() }
            .task { await loadLayout() }
            // Goals card + the goal-calendar review queues (refresh whenever a
            // review/log action bumps the goals bus).
            .task(id: sync.goalsRev) { await dash.loadGoals() }
            // Freshen the shared approvals model on each appearance (a tab switch
            // back to Today). Launch, the chore/reward buses, and foregrounding are
            // AppRoot's job — it owns the model — so no duplicate fetch per trigger.
            .task { await approvals.load() }
            // These cards are REST-backed (meals/chores/grocery/goals aren't synced
            // tables), so a change made elsewhere — the web app, another phone —
            // arrives silently. Refetch on return to the foreground, the same trigger
            // AppRoot uses for the approvals badge; in-app edits are already covered
            // by the `sync.*Rev` buses above. Only fires while Today is the visible
            // tab: AppRoot swaps tabs out of the hierarchy, so an offscreen Today has
            // no scenePhase observer.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task {
                    async let d: () = dash.load(todayKey: Agenda.todayKey(sync.householdTz))
                    async let g: () = dash.loadGoals()
                    _ = await (d, g)
                }
            }
            // Day rollover while the screen stays open: at (household-tz) midnight
            // "today" changes, so the dinner/chores the cards show are suddenly
            // yesterday's. Sleep to just past each midnight and refetch; the synced
            // agenda re-derives itself from the new data's render pass.
            .task(id: sync.householdTz.identifier) {
                while !Task.isCancelled {
                    let wait = Agenda.secondsUntilNextDay(after: Date(), tz: sync.householdTz)
                    try? await Task.sleep(for: .seconds(wait))
                    guard !Task.isCancelled else { return }
                    await dash.load(todayKey: Agenda.todayKey(sync.householdTz))
                }
            }
            .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
            .sheet(isPresented: $showCapture) {
                CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showCustomize) {
                CustomizeTodaySheet(order: cardOrder, hidden: hiddenCards, canEditFamily: canEditFamily,
                                    labels: Self.cardLabels) { await loadLayout() }
            }
        }
    }

    // MARK: pinned header (greeting + capture bar)

    /// The fixed top of Today: the greeting row and the capture bar. It carries an
    /// opaque canvas background so the cards scroll out of sight beneath it; a faint
    /// shadow fades in only once content has scrolled under it.
    private var stickyHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            greeting
            AICaptureBar(onTap: { dictateOnOpen = false; showCapture = true },
                         onMic: { dictateOnOpen = true; showCapture = true })
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(WF.canvas)
        .shadow(color: .black.opacity(scrolled ? 0.06 : 0), radius: 6, y: 4)
    }

    // MARK: greeting row
    private var greeting: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 8) {
                    Text(greetingDate)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(WF.ink2)
                    if let w = weather, w.configured, let t = w.tempF {
                        Text("\(w.emoji ?? "") \(Int(t.rounded()))°")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(WF.ink3)
                    }
                }
                Text(greetingPhrase)
                    .font(WF.serif(30))
                    .foregroundStyle(WF.ink)
            }
            Spacer()
            Button { showCustomize = true } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink3)
                    .frame(width: 40, height: 40)
                    .background(WF.panel).clipShape(Circle())
            }
            .buttonStyle(.plain)
            if let m = greetingMember {
                Button { path.append(.person(m.id)) } label: {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 46)
                }
                .buttonStyle(.plain)
            } else {
                Avatar(person: .person2, emoji: "🦊", size: 46)
            }
        }
    }

    // MARK: review-events entry card (goal-calendar bridge)

    /// "N to review · M to link" — a purple-tinted card that opens the review
    /// screen. Purple signals these are goal-progress confirmations.
    private var reviewCard: some View {
        let nR = dash.reviewRecap.count, nS = dash.reviewSuggestions.count
        return HStack(spacing: 13) {
            Image(systemName: "sparkles").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(LinearGradient(colors: [WF.ai2, WF.ai], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(reviewTitle(nR, nS)).font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink)
                Text(reviewSubtitle).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3).lineLimit(1)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 14, weight: .heavy)).foregroundStyle(WF.ai)
        }
        .padding(14)
        .background(WF.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.ai.opacity(0.22), lineWidth: 1))
    }

    private func reviewTitle(_ nR: Int, _ nS: Int) -> String {
        if nR > 0 && nS > 0 { return "\(nR) to review · \(nS) to link" }
        if nR > 0 { return nR == 1 ? "1 event to log" : "\(nR) events to log" }
        return nS == 1 ? "1 event might count" : "\(nS) events might count"
    }

    private var reviewSubtitle: String {
        let titles = dash.reviewRecap.map(\.title) + dash.reviewSuggestions.map(\.title)
        let preview = titles.prefix(3).joined(separator: " · ")
        return preview.isEmpty ? "Tap to review & add to goals" : preview
    }

    // MARK: today's agenda (live from the local mirror)
    private var todayCard: some View {
        WaffledCard(padding: 17) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: openCalendar) {
                    HStack(spacing: 6) {
                        Text("Today").font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                        Spacer()
                        Text("\(todays.count) event\(todays.count == 1 ? "" : "s")")
                            .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.bottom, 4)

                if todays.isEmpty {
                    Button(action: openCalendar) {
                        Text("Nothing scheduled today.")
                            .font(.system(size: 14)).foregroundStyle(WF.ink3)
                            .padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    ForEach(Array(todays.enumerated()), id: \.element.id) { idx, ev in
                        Button { detailEvent = ev } label: {
                            EventRow(event: ev, tz: sync.householdTz)
                                .padding(.vertical, 11).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if idx < todays.count - 1 {
                            Rectangle().fill(WF.hair2).frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    // MARK: tonight's meal (split media card, live from the meal plan)
    @ViewBuilder private var tonightCard: some View {
        if let meal = dash.tonight {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    LinearGradient(colors: meal.eatingOut
                                       ? [Color(hex: 0xD9E7F6), Color(hex: 0xBCD0E9)]
                                       : [Color(hex: 0xF6D9C6), Color(hex: 0xE9B596)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                        .frame(width: 104)
                        .overlay(Text(meal.emoji).font(.system(size: 36)))
                    VStack(alignment: .leading, spacing: 4) {
                        Text("TONIGHT · DINNER")
                            .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                            .foregroundStyle(FamilyColor.person4.solid)
                        Text(meal.title)
                            .font(WF.serif(18)).foregroundStyle(WF.ink)
                        if let sub = mealSubtitle(meal) {
                            Text(sub).font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }
                    .padding(.horizontal, 15).padding(.vertical, 13)
                    Spacer(minLength: 0)
                }
                // Cook Mode + View recipe (parity with the iPad card) — a planned recipe
                // opens its detail, or drops straight into Cook Mode.
                if let summary = meal.recipeSummary {
                    HStack(spacing: 10) {
                        tonightButton("View recipe", primary: false) { path.append(.recipe(summary)) }
                        tonightButton("👨‍🍳 Cook Mode", primary: true) { path.append(.recipeCook(summary)) }
                    }
                    .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 12)
                }
            }
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .wfShadow1()
        } else if dash.loaded {
            WaffledCard(padding: 15) {
                HStack(spacing: 12) {
                    Text("🍽️").font(.system(size: 28))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No dinner planned").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                        Text("Add one from the capture bar").font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    }
                    Spacer(minLength: 0)
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

    /// A tonight-card action button — primary (coral fill) for Cook Mode, outline for
    /// View recipe. Matches the app's button chrome at Today-card scale.
    private func tonightButton(_ title: String, primary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(primary ? .white : WF.ink)
                .frame(maxWidth: .infinity).padding(.vertical, 10)
                .background(primary ? WF.primary : WF.panel)
                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                    .strokeBorder(primary ? Color.clear : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: chores + grocery summary (live)

    /// A synthetic grocery list so the Today grocery card opens the board directly
    /// (ListDetailView loads the grocery board by type, not by id).
    private var grocerySummary: WaffledAPI.ListSummary {
        WaffledAPI.ListSummary(id: "grocery", name: "Grocery", emoji: "🛒",
                            listType: "grocery", itemCount: dash.groceryRemaining)
    }

    // MARK: goals card (featured goal + a shortcut to all goals)

    /// The headline goal to surface, honoring the user's scope preference. "Mine"
    /// prefers a goal the logged-in member is in; "Family" prefers a whole-family
    /// goal. Either way featured wins within the bucket, and we never get stuck — a
    /// sub-group goal (e.g. kids-only) only shows if nothing better exists.
    private var featuredGoal: WaffledAPI.Goal? {
        let goals = dash.goals
        // A specific goal pinned to the card wins, if it still exists.
        if !todayGoalId.isEmpty, let pinned = goals.first(where: { $0.id == todayGoalId }) { return pinned }
        // The token-resolved person if we have it, else the greeting member (first adult).
        let me = sync.currentPersonId ?? greetingMember?.id
        let everyone = Set(sync.members.map(\.id))
        // "Mine" = a goal that's solo to me (my personal list), not a shared/group goal.
        func isMine(_ g: WaffledAPI.Goal) -> Bool {
            guard let me else { return false }
            return Set(g.participants.map(\.personId)) == [me]
        }
        // "Family" = a goal the whole household shares.
        func isFamily(_ g: WaffledAPI.Goal) -> Bool {
            everyone.count > 1 && everyone.isSubset(of: Set(g.participants.map(\.personId)))
        }
        // Prefer the Spotlight, then a Pinned (isFeatured) goal, then any — within scope.
        func spot(_ g: WaffledAPI.Goal) -> Bool { g.isSpotlight ?? false }
        let mineFirst: [(WaffledAPI.Goal) -> Bool] = [
            { isMine($0) && spot($0) }, { isMine($0) && $0.isFeatured }, { isMine($0) },
            { isFamily($0) && spot($0) }, { isFamily($0) && $0.isFeatured }, { isFamily($0) },
        ]
        let familyFirst: [(WaffledAPI.Goal) -> Bool] = [
            { isFamily($0) && spot($0) }, { isFamily($0) && $0.isFeatured }, { isFamily($0) },
            { isMine($0) && spot($0) }, { isMine($0) && $0.isFeatured }, { isMine($0) },
        ]
        let order = goalScope == "family" ? familyFirst : mineFirst
        for matches in order { if let g = goals.first(where: matches) { return g } }
        return goals.first(where: spot) ?? goals.first { $0.isFeatured } ?? goals.first
    }

    private static let goalGreen = WF.success

    /// A full-width card showing the featured goal's progress (taps into that goal),
    /// with a "See all" shortcut to the goals hub.
    @ViewBuilder private var goalsCard: some View {
        WaffledCard(padding: 15) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text("Goals").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                    scopeMenu
                    Spacer()
                    Button { path.append(.goals) } label: {
                        HStack(spacing: 3) {
                            Text("See all").font(.system(size: 12, weight: .semibold))
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(WF.ai)
                    }
                    .buttonStyle(.plain)
                }
                if let g = featuredGoal {
                    Button { path.append(.goal(g)) } label: { featuredGoalRow(g) }.buttonStyle(.plain)
                } else {
                    // Key the empty state off the goals fetch itself — `dash.loaded`
                    // (meals/chores/grocery) usually finishes first, and used to flash
                    // "Set a family goal →" at people who have goals.
                    Button { path.append(.goals) } label: {
                        Text(dash.goalsLoaded ? "Set a family goal →" : "Loading…")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .sheet(isPresented: $showingGoalPicker) {
            TodayGoalPickerSheet(goals: dash.goals, myPersonId: sync.currentPersonId ?? greetingMember?.id, selectedId: todayGoalId) { id in todayGoalId = id }
        }
    }

    /// A small pill-menu to switch the card between the logged-in member's goal and a
    /// whole-family goal. Only shown when there's more than one goal to choose from.
    @ViewBuilder private var scopeMenu: some View {
        if dash.goals.count > 1 {
            // The pinned goal's title (if one is pinned and still exists), else the scope name.
            let pinnedTitle = todayGoalId.isEmpty ? nil : dash.goals.first { $0.id == todayGoalId }?.title
            Menu {
                Button { goalScope = "mine"; todayGoalId = "" } label: {
                    Label("My spotlight", systemImage: (todayGoalId.isEmpty && goalScope == "mine") ? "checkmark" : "person")
                }
                Button { goalScope = "family"; todayGoalId = "" } label: {
                    Label("Family spotlight", systemImage: (todayGoalId.isEmpty && goalScope == "family") ? "checkmark" : "person.3")
                }
                Divider()
                Button { showingGoalPicker = true } label: {
                    Label("Choose a goal…", systemImage: "pin")
                }
            } label: {
                HStack(spacing: 3) {
                    Text(pinnedTitle ?? (goalScope == "family" ? "Family" : "Mine"))
                        .font(.system(size: 11, weight: .bold)).lineLimit(1).frame(maxWidth: 120)
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                }
                .foregroundStyle(WF.ink3)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(WF.panel)
                .clipShape(Capsule())
            }
        }
    }

    private func featuredGoalRow(_ g: WaffledAPI.Goal) -> some View {
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(g.emoji ?? "🎯").font(.system(size: 20))
                Text(g.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                if g.isSpotlight ?? false { Text("🌟").font(.system(size: 11)) }
                else if g.isFeatured { Text("📌").font(.system(size: 11)) }
                Spacer(minLength: 6)
                if g.streakDays >= 2 {
                    Text("🔥 \(g.streakDays)").font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ink2)
                }
            }
            if let target = g.target, target > 0 {
                ProgressBar(value: frac, tint: Self.goalGreen, track: Self.goalGreen.opacity(0.18))
                (Text("\(goalFmt(g.totalProgress)) ").foregroundStyle(WF.ink).bold()
                 + Text("of \(goalFmt(target))\(g.unit.map { " \($0)" } ?? "")").foregroundStyle(WF.ink3))
                    .font(.system(size: 12))
            } else if g.streakDays > 0 {
                Text("\(g.streakDays)-day streak").font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    // MARK: layout-driven card rendering

    static let cardLabels = [
        "agenda": "Agenda", "countdowns": "Countdowns", "tonight": "Tonight's dinner",
        "chores": "Chores", "grocery": "Grocery", "goals": "Goals", "pantry": "Pantry",
        "familyNight": "Family Night",
    ]
    private static let smallCards: Set<String> = ["chores", "grocery"]

    private enum CardRow: Identifiable {
        case single(String)
        case pair(String, String)
        var id: String {
            switch self { case let .single(k): return k; case let .pair(a, b): return a + "+" + b }
        }
    }

    /// Visible cards in saved order, pairing the two small cards (chores/grocery)
    /// into a 2-up row when they're adjacent — so the default look is preserved.
    /// A card's optional-module gate (agenda is calendar-backed and never gated).
    private func moduleAllows(_ key: String) -> Bool {
        switch key {
        case "tonight": return sync.module(.meals)
        case "chores": return sync.module(.chores)
        case "grocery": return sync.module(.lists)
        case "goals": return sync.module(.goals)
        case "pantry": return sync.module(.pantry)
        case "familyNight": return sync.module(.familyNight)
        default: return true
        }
    }

    private var cardRows: [CardRow] {
        let visible = cardOrder.filter { !hiddenCards.contains($0) && moduleAllows($0) }
        var rows: [CardRow] = []
        var i = 0
        while i < visible.count {
            let k = visible[i]
            if Self.smallCards.contains(k), i + 1 < visible.count, Self.smallCards.contains(visible[i + 1]) {
                rows.append(.pair(k, visible[i + 1])); i += 2
            } else {
                rows.append(.single(k)); i += 1
            }
        }
        return rows
    }

    @ViewBuilder private func cardView(_ key: String) -> some View {
        switch key {
        case "agenda": todayCard
        case "countdowns": CountdownsCard()
        case "tonight": tonightCard
        case "chores": Button { path.append(.chores) } label: { choresCard }.buttonStyle(.plain)
        case "grocery": Button { path.append(.list(grocerySummary)) } label: { groceryCard }.buttonStyle(.plain)
        case "pantry": PantryTodayCard { path.append(.pantry) }
        case "familyNight": FamilyNightCard()
        case "goals": goalsCard
        default: EmptyView()
        }
    }

    private func loadLayout() async {
        guard let resp = try? await WaffledAPI().mobileTodayLayout() else { return }
        var order = resp.resolved.order
        // Fallback for a server whose mobile card set predates countdowns: surface the
        // card right after the agenda so it appears regardless. (A current server already
        // includes it, so the guard avoids a duplicate.)
        if !order.contains("countdowns"), !resp.resolved.hidden.contains("countdowns") {
            order.insert("countdowns", at: (order.firstIndex(of: "agenda").map { $0 + 1 }) ?? 0)
        }
        // Same fallback for pantry (a server predating the mobile pantry card omits it):
        // surface it after grocery so it appears regardless of the server's card set.
        if !order.contains("pantry"), !resp.resolved.hidden.contains("pantry") {
            order.insert("pantry", at: (order.firstIndex(of: "grocery").map { $0 + 1 }) ?? order.count)
        }
        // Same fallback for Family Night (a server predating the mobile card omits it).
        if !order.contains("familyNight"), !resp.resolved.hidden.contains("familyNight") {
            order.append("familyNight")
        }
        cardOrder = order
        hiddenCards = Set(resp.resolved.hidden)
        canEditFamily = resp.canEditFamily
    }

    private var choresCard: some View {
        WaffledCard(padding: 15) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Family chores").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                HStack(spacing: -8) {
                    ForEach(dash.chores.prefix(3)) { p in
                        Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 30)
                    }
                    if dash.chores.isEmpty {
                        Avatar(person: .person4, emoji: "🦄", size: 30).opacity(0.35)
                    }
                    Spacer(minLength: 0)
                }
                if dash.choreTotal > 0 {
                    ProgressBar(value: Double(dash.choreDone) / Double(dash.choreTotal),
                                tint: WF.primary, track: WF.primary.opacity(0.18))
                    (Text("\(dash.choreDone) of \(dash.choreTotal) · ").foregroundStyle(WF.ink3)
                     + Text("★ \(dash.choreStars)").foregroundStyle(WF.gold).bold())
                        .font(.system(size: 12.5))
                } else {
                    Text(dash.loaded ? "No chores today" : "Loading…")
                        .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var groceryCard: some View {
        WaffledCard(padding: 15) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Grocery").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                if dash.loaded {
                    Text("\(dash.groceryRemaining)").font(.system(size: 26, weight: .bold)).foregroundStyle(WF.ink)
                    Text(dash.groceryRemaining == 1 ? "item to buy" : "items to buy")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                } else {
                    // Don't claim "0 items to buy" while the count is still loading.
                    Text("Loading…").font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

}

/// Thin rounded progress bar used in the summary cards.
/// A modal goal chooser for the Today card — "Follow the spotlight" plus a scrollable
/// list of every goal (reuses the goal-card styling), instead of a long inline menu.
private struct TodayGoalPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let goals: [WaffledAPI.Goal]
    let myPersonId: String?
    let selectedId: String
    /// "" clears the pin (back to My/Family spotlight); otherwise a goal id.
    let onSelect: (String) -> Void

    @State private var lists: [WaffledAPI.GoalList] = []
    @State private var expanded: [String: Bool] = [:]
    private let api = WaffledAPI()

    private struct Group: Identifiable {
        let id: String; let title: String
        let members: [WaffledAPI.GoalList.Member]; let goals: [WaffledAPI.Goal]
    }
    /// Goals grouped by their list: My goals first, then shared groups I'm in, then the rest.
    private var groups: [Group] {
        let byId = Dictionary(lists.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func rank(_ key: String) -> Int {
            guard key != "__none__", let l = byId[key] else { return 3 }
            let ids = Set(l.members.map(\.personId))
            if let me = myPersonId, ids == [me] { return 0 }               // my personal list
            if let me = myPersonId, ids.count > 1, ids.contains(me) { return 1 } // a group I'm in
            return 2                                                        // someone else's / other
        }
        var buckets: [String: [WaffledAPI.Goal]] = [:]
        for g in goals { buckets[g.goalListId ?? "__none__", default: []].append(g) }
        return buckets.keys.sorted { a, b in
            let ra = rank(a), rb = rank(b)
            if ra != rb { return ra < rb }
            return (byId[a]?.name ?? "Other").localizedCaseInsensitiveCompare(byId[b]?.name ?? "Other") == .orderedAscending
        }.map { key in
            let l = byId[key]
            let title = key == "__none__" ? "Other goals" : (rank(key) == 0 ? "My goals" : (l?.name ?? "Goals"))
            return Group(id: key, title: title, members: l?.members ?? [], goals: buckets[key] ?? [])
        }
    }

    var body: some View {
        NavigationStack {
            // A List (not a ScrollView of Buttons) so a scroll drag never fires a row.
            List {
                autoRow
                    .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                ForEach(groups) { grp in
                    DisclosureGroup(isExpanded: Binding(get: { expanded[grp.id] ?? true }, set: { expanded[grp.id] = $0 })) {
                        ForEach(grp.goals) { g in
                            goalRow(g)
                                .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
                                .listRowSeparator(.hidden).listRowBackground(Color.clear)
                        }
                    } label: {
                        groupHeader(grp)
                    }
                    .tint(WF.ink3)
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(WF.canvas)
            .navigationTitle("Show on Today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { if lists.isEmpty { lists = (try? await api.goalLists()) ?? [] } }
        }
    }

    private func groupHeader(_ grp: Group) -> some View {
        HStack(spacing: 8) {
            if !grp.members.isEmpty {
                HStack(spacing: -6) {
                    ForEach(grp.members.prefix(4), id: \.personId) { m in
                        Text(m.avatarEmoji ?? "🙂").font(.system(size: 12))
                            .frame(width: 22, height: 22).background(WF.panel).clipShape(Circle())
                            .overlay(Circle().strokeBorder(WF.canvas, lineWidth: 1.5))
                    }
                }
            }
            Text(grp.title).font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink)
            Text("\(grp.goals.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    private var autoRow: some View {
        Button { onSelect(""); dismiss() } label: {
            HStack(spacing: 12) {
                Text("✨").font(.system(size: 20)).frame(width: 42, height: 42)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Follow the spotlight").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink)
                    Text("Auto-picks your My / Family spotlight goal").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Spacer(minLength: 0)
                if selectedId.isEmpty { Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(WF.primary) }
            }
            .padding(13).wfField()
        }
        .buttonStyle(.plain)
    }

    private func goalRow(_ g: WaffledAPI.Goal) -> some View {
        let col = GoalStyle.color(g.category)
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        return Button { onSelect(g.id); dismiss() } label: {
            HStack(spacing: 12) {
                Text(g.emoji ?? GoalStyle.emoji(g.category)).font(.system(size: 20)).frame(width: 42, height: 42)
                    .background(col.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text(g.title).font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ink).lineLimit(1)
                    Text(goalDescriptor(g)).font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3).lineLimit(1)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(WF.hair)
                            Capsule().fill(col).frame(width: geo.size.width * frac)
                        }
                    }
                    .frame(height: 6)
                }
                if selectedId == g.id { Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(WF.primary) }
            }
            .padding(13).wfField()
        }
        .buttonStyle(.plain)
    }
}

struct ProgressBar: View {
    let value: Double      // 0...1
    let tint: Color
    let track: Color
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(tint).frame(width: geo.size.width * value)
            }
        }
        .frame(height: 7)
    }
}

/// Reorder + show/hide the Today cards. Saves to the caller's own override
/// ("Just me") or, for admins, the shared family default ("Everyone").
struct CustomizeTodaySheet: View {
    @Environment(\.dismiss) private var dismiss
    let labels: [String: String]
    let canEditFamily: Bool
    let onSaved: () async -> Void

    @State private var order: [String]
    @State private var hidden: Set<String>
    @State private var scope: String        // "user" | "family"
    @State private var busy = false

    init(order: [String], hidden: Set<String>, canEditFamily: Bool,
         labels: [String: String], onSaved: @escaping () async -> Void) {
        self.labels = labels
        self.canEditFamily = canEditFamily
        self.onSaved = onSaved
        _order = State(initialValue: order)
        _hidden = State(initialValue: hidden)
        _scope = State(initialValue: "user")
    }

    var body: some View {
        NavigationStack {
            List {
                if canEditFamily {
                    Section {
                        Picker("Applies to", selection: $scope) {
                            Text("Just me").tag("user")
                            Text("Everyone").tag("family")
                        }
                        .pickerStyle(.segmented)
                    } footer: {
                        Text(scope == "family"
                             ? "Sets the default Today layout for everyone in the household."
                             : "Your own arrangement, just on this account.")
                    }
                }

                Section("Drag to reorder · toggle to show or hide") {
                    ForEach(order, id: \.self) { key in
                        HStack(spacing: 10) {
                            Text(labels[key] ?? key).font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer()
                            Toggle("", isOn: Binding(
                                get: { !hidden.contains(key) },
                                set: { on in if on { hidden.remove(key) } else { hidden.insert(key) } }
                            ))
                            .labelsHidden()
                            .tint(WF.primary)
                        }
                    }
                    .onMove { idx, dest in order.move(fromOffsets: idx, toOffset: dest) }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Customize Today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { commit { try await WaffledAPI().saveMobileTodayLayout(scope: scope, order: order, hidden: Array(hidden)) } }
                        .fontWeight(.semibold).disabled(busy)
                }
                ToolbarItem(placement: .bottomBar) {
                    Button(scope == "family" ? "Reset everyone to default" : "Reset to default", role: .destructive) {
                        commit { try await WaffledAPI().resetMobileTodayLayout(scope: scope) }
                    }
                    .disabled(busy)
                }
            }
        }
        .presentationDetents([.large])
    }

    private func commit(_ op: @escaping () async throws -> Void) {
        busy = true
        Task {
            try? await op()
            await onSaved()
            dismiss()
        }
    }
}

#Preview { TodayView(approvals: ApprovalsModel(), path: .constant([])).environment(SyncManager()) }
