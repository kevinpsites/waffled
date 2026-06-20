import SwiftUI

/// Today — the home surface. Mock-faithful to the handoff `ios-home.png`:
/// greeting + capture bar, today's agenda, tonight's meal, chores + grocery.
/// Static sample data in Phase 0; PowerSync-backed in Phase 1+.
struct TodayView: View {
    @Environment(SyncManager.self) private var sync
    @State private var dash = DashboardModel()
    @State private var recipes = RecipesModel()   // backs a recipe pushed from tonight's card
    @State private var editingEvent: SyncedEvent?
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var scrolled = false   // cards have scrolled under the header → lift it
    @State private var weather: NookAPI.Weather?
    /// Goal-calendar review queue counts, for the "review events" entry card.
    @State private var reviewRecap: [NookAPI.GoalRecapItem] = []
    @State private var reviewSuggestions: [NookAPI.GoalSuggestionItem] = []
    /// Household goals (featured-first), for the Today goals card.
    @State private var goals: [NookAPI.Goal] = []
    /// Which goal the card highlights: "mine" (the logged-in member's) or "family"
    /// (a whole-family goal). Per-device preference; defaults to mine.
    @AppStorage("nook.todayGoalScope") private var goalScope = "mine"
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

    private var greetingDate: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US"); f.timeZone = sync.householdTz
        f.dateFormat = "EEEE, MMM d"
        return f.string(from: Date())
    }

    private var greetingPhrase: String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = sync.householdTz
        switch cal.component(.hour, from: Date()) {
        case 5..<12:  return "Good morning"
        case 12..<17: return "Good afternoon"
        default:      return "Good evening"
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !reviewRecap.isEmpty || !reviewSuggestions.isEmpty {
                        Button { path.append(.reviewEvents) } label: { reviewCard }.buttonStyle(.plain)
                    }
                    todayCard
                    if let summary = dash.tonight?.recipeSummary {
                        Button { path.append(.recipe(summary)) } label: { tonightCard }.buttonStyle(.plain)
                    } else {
                        tonightCard
                    }
                    HStack(spacing: 12) {
                        Button { path.append(.chores) } label: { choresCard }.buttonStyle(.plain)
                        Button { path.append(.list(grocerySummary)) } label: { groceryCard }.buttonStyle(.plain)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    goalsCard
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
            .background(NK.canvas)
            // Greeting + capture bar stay pinned; the cards scroll under them.
            .safeAreaInset(edge: .top, spacing: 0) { stickyHeader }
            .toolbar(.hidden, for: .navigationBar)   // Today draws its own greeting header
            .navigationDestination(for: HubRoute.self) { route in
                HubDestination(route: route, path: $path, recipes: recipes)
            }
            .refreshable { await dash.load(todayKey: Agenda.todayKey(sync.householdTz)) }
            // Reload when the tz is known and whenever a capture commit bumps a domain.
            .task(id: "\(sync.householdTz.identifier)|\(sync.choresRev)|\(sync.groceryRev)|\(sync.mealsRev)") {
                await dash.load(todayKey: Agenda.todayKey(sync.householdTz))
            }
            .task { weather = try? await NookAPI().weather() }
            // Load the goal-calendar review queues for the entry card (refreshes
            // whenever a review action bumps the goals bus).
            .task { await sync.loadIdentity() }
            .task(id: sync.goalsRev) {
                let api = NookAPI()
                async let r = try? await api.goalRecap()
                async let s = try? await api.goalSuggestions()
                async let g = try? await api.goalsIn(listId: nil)
                reviewRecap = await r ?? []
                reviewSuggestions = await s ?? []
                goals = await g ?? []
            }
            .sheet(item: $editingEvent) { ev in
                EventEditSheet(event: ev, initialDate: ev.startsAt ?? Date())
            }
            .sheet(isPresented: $showCapture) {
                CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
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
        .background(NK.canvas)
        .shadow(color: .black.opacity(scrolled ? 0.06 : 0), radius: 6, y: 4)
    }

    // MARK: greeting row
    private var greeting: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 8) {
                    Text(greetingDate)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(NK.ink2)
                    if let w = weather, w.configured, let t = w.tempF {
                        Text("\(w.emoji ?? "") \(Int(t.rounded()))°")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(NK.ink3)
                    }
                }
                Text(greetingPhrase)
                    .font(NK.serif(30))
                    .foregroundStyle(NK.ink)
            }
            Spacer()
            if let m = greetingMember {
                Button { path.append(.person(m.id)) } label: {
                    Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 46)
                }
                .buttonStyle(.plain)
            } else {
                Avatar(person: .kelly, emoji: "🦊", size: 46)
            }
        }
    }

    // MARK: review-events entry card (goal-calendar bridge)

    /// "N to review · M to link" — a purple-tinted card that opens the review
    /// screen. Purple signals these are goal-progress confirmations.
    private var reviewCard: some View {
        let nR = reviewRecap.count, nS = reviewSuggestions.count
        return HStack(spacing: 13) {
            Image(systemName: "sparkles").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(LinearGradient(colors: [NK.ai2, NK.ai], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(reviewTitle(nR, nS)).font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink)
                Text(reviewSubtitle).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3).lineLimit(1)
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 14, weight: .heavy)).foregroundStyle(NK.ai)
        }
        .padding(14)
        .background(NK.ai.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.ai.opacity(0.22), lineWidth: 1))
    }

    private func reviewTitle(_ nR: Int, _ nS: Int) -> String {
        if nR > 0 && nS > 0 { return "\(nR) to review · \(nS) to link" }
        if nR > 0 { return nR == 1 ? "1 event to log" : "\(nR) events to log" }
        return nS == 1 ? "1 event might count" : "\(nS) events might count"
    }

    private var reviewSubtitle: String {
        let titles = reviewRecap.map(\.title) + reviewSuggestions.map(\.title)
        let preview = titles.prefix(3).joined(separator: " · ")
        return preview.isEmpty ? "Tap to review & add to goals" : preview
    }

    // MARK: today's agenda (live from the local mirror)
    private var todayCard: some View {
        NookCard(padding: 17) {
            VStack(alignment: .leading, spacing: 0) {
                Button(action: openCalendar) {
                    HStack(spacing: 6) {
                        Text("Today").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                        Spacer()
                        Text("\(todays.count) event\(todays.count == 1 ? "" : "s")")
                            .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.bottom, 4)

                if todays.isEmpty {
                    Button(action: openCalendar) {
                        Text("Nothing scheduled today.")
                            .font(.system(size: 14)).foregroundStyle(NK.ink3)
                            .padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    ForEach(Array(todays.enumerated()), id: \.element.id) { idx, ev in
                        Button { editingEvent = ev } label: {
                            EventRow(event: ev, tz: sync.householdTz)
                                .padding(.vertical, 11).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if idx < todays.count - 1 {
                            Rectangle().fill(NK.hair2).frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    // MARK: tonight's meal (split media card, live from the meal plan)
    @ViewBuilder private var tonightCard: some View {
        if let meal = dash.tonight {
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
                        .foregroundStyle(FamilyColor.lottie.solid)
                    Text(meal.title)
                        .font(NK.serif(18)).foregroundStyle(NK.ink)
                    if let sub = mealSubtitle(meal) {
                        Text(sub).font(.system(size: 12)).foregroundStyle(NK.ink3)
                    }
                }
                .padding(.horizontal, 15).padding(.vertical, 13)
                Spacer(minLength: 0)
            }
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .nkShadow1()
        } else if dash.loaded {
            NookCard(padding: 15) {
                HStack(spacing: 12) {
                    Text("🍽️").font(.system(size: 28))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No dinner planned").font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink)
                        Text("Add one from the capture bar").font(.system(size: 12.5)).foregroundStyle(NK.ink3)
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

    // MARK: chores + grocery summary (live)

    /// A synthetic grocery list so the Today grocery card opens the board directly
    /// (ListDetailView loads the grocery board by type, not by id).
    private var grocerySummary: NookAPI.ListSummary {
        NookAPI.ListSummary(id: "grocery", name: "Grocery", emoji: "🛒",
                            listType: "grocery", itemCount: dash.groceryRemaining)
    }

    // MARK: goals card (featured goal + a shortcut to all goals)

    /// The headline goal to surface, honoring the user's scope preference. "Mine"
    /// prefers a goal the logged-in member is in; "Family" prefers a whole-family
    /// goal. Either way featured wins within the bucket, and we never get stuck — a
    /// sub-group goal (e.g. kids-only) only shows if nothing better exists.
    private var featuredGoal: NookAPI.Goal? {
        // The token-resolved person if we have it, else the greeting member (first adult).
        let me = sync.currentPersonId ?? greetingMember?.id
        let everyone = Set(sync.members.map(\.id))
        // "Mine" = a goal that's solo to me (my personal list), not a shared/group goal.
        func isMine(_ g: NookAPI.Goal) -> Bool {
            guard let me else { return false }
            return Set(g.participants.map(\.personId)) == [me]
        }
        // "Family" = a goal the whole household shares.
        func isFamily(_ g: NookAPI.Goal) -> Bool {
            everyone.count > 1 && everyone.isSubset(of: Set(g.participants.map(\.personId)))
        }
        let mineFirst: [(NookAPI.Goal) -> Bool] = [
            { isMine($0) && $0.isFeatured }, { isMine($0) },
            { isFamily($0) && $0.isFeatured }, { isFamily($0) },
        ]
        let familyFirst: [(NookAPI.Goal) -> Bool] = [
            { isFamily($0) && $0.isFeatured }, { isFamily($0) },
            { isMine($0) && $0.isFeatured }, { isMine($0) },
        ]
        let order = goalScope == "family" ? familyFirst : mineFirst
        for matches in order { if let g = goals.first(where: matches) { return g } }
        return goals.first { $0.isFeatured } ?? goals.first
    }

    private static let goalGreen = Color(hex: 0x2BA45F)

    /// A full-width card showing the featured goal's progress (taps into that goal),
    /// with a "See all" shortcut to the goals hub.
    @ViewBuilder private var goalsCard: some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text("Goals").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                    scopeMenu
                    Spacer()
                    Button { path.append(.goals) } label: {
                        HStack(spacing: 3) {
                            Text("See all").font(.system(size: 12, weight: .semibold))
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                        }
                        .foregroundStyle(NK.ai)
                    }
                    .buttonStyle(.plain)
                }
                if let g = featuredGoal {
                    Button { path.append(.goal(g)) } label: { featuredGoalRow(g) }.buttonStyle(.plain)
                } else {
                    Button { path.append(.goals) } label: {
                        Text(dash.loaded ? "Set a family goal →" : "Loading…")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// A small pill-menu to switch the card between the logged-in member's goal and a
    /// whole-family goal. Only shown when there's more than one goal to choose from.
    @ViewBuilder private var scopeMenu: some View {
        if goals.count > 1 {
            Menu {
                Button { goalScope = "mine" } label: {
                    Label("My featured goal", systemImage: goalScope == "mine" ? "checkmark" : "person")
                }
                Button { goalScope = "family" } label: {
                    Label("Family featured goal", systemImage: goalScope == "family" ? "checkmark" : "person.3")
                }
            } label: {
                HStack(spacing: 3) {
                    Text(goalScope == "family" ? "Family" : "Mine").font(.system(size: 11, weight: .bold))
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                }
                .foregroundStyle(NK.ink3)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(NK.panel)
                .clipShape(Capsule())
            }
        }
    }

    private func featuredGoalRow(_ g: NookAPI.Goal) -> some View {
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        return VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Text(g.emoji ?? "🎯").font(.system(size: 20))
                Text(g.title).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                if g.isFeatured { Text("⭐").font(.system(size: 11)) }
                Spacer(minLength: 6)
                if g.streakDays >= 2 {
                    Text("🔥 \(g.streakDays)").font(.system(size: 11, weight: .bold)).foregroundStyle(NK.ink2)
                }
            }
            if let target = g.target, target > 0 {
                ProgressBar(value: frac, tint: Self.goalGreen, track: Self.goalGreen.opacity(0.18))
                (Text("\(goalFmt(g.totalProgress)) ").foregroundStyle(NK.ink).bold()
                 + Text("of \(goalFmt(target))\(g.unit.map { " \($0)" } ?? "")").foregroundStyle(NK.ink3))
                    .font(.system(size: 12))
            } else if g.streakDays > 0 {
                Text("\(g.streakDays)-day streak").font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var choresCard: some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Family chores").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                HStack(spacing: -8) {
                    ForEach(dash.chores.prefix(3)) { p in
                        Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 30)
                    }
                    if dash.chores.isEmpty {
                        Avatar(person: .lottie, emoji: "🦄", size: 30).opacity(0.35)
                    }
                    Spacer(minLength: 0)
                }
                if dash.choreTotal > 0 {
                    ProgressBar(value: Double(dash.choreDone) / Double(dash.choreTotal),
                                tint: NK.primary, track: NK.primary.opacity(0.18))
                    (Text("\(dash.choreDone) of \(dash.choreTotal) · ").foregroundStyle(NK.ink3)
                     + Text("★ \(dash.choreStars)").foregroundStyle(NK.gold).bold())
                        .font(.system(size: 12.5))
                } else {
                    Text(dash.loaded ? "No chores today" : "Loading…")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var groceryCard: some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Grocery").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                Text("\(dash.groceryRemaining)").font(.system(size: 26, weight: .bold)).foregroundStyle(NK.ink)
                Text(dash.groceryRemaining == 1 ? "item to buy" : "items to buy")
                    .font(.system(size: 12)).foregroundStyle(NK.ink3)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

}

/// Thin rounded progress bar used in the summary cards.
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

#Preview { TodayView(path: .constant([])).environment(SyncManager()) }
