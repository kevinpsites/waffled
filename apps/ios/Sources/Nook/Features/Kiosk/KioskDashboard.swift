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
    @State private var detailEvent: SyncedEvent?
    @State private var recipeTarget: RecipeTarget?
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    /// Pinned alert banners (web/phone parity): the parent approval queue and the
    /// goal-calendar review queue. Both open their focused screen as a page sheet.
    @State private var approvals = ApprovalsModel()
    @State private var reviewRecap: [NookAPI.GoalRecapItem] = []
    @State private var reviewSuggestions: [NookAPI.GoalSuggestionItem] = []
    @State private var showApprovals = false
    @State private var showReview = false
    /// Quick-add field on the Today grocery card.
    @State private var groceryDraft = ""
    @FocusState private var groceryFocused: Bool
    /// The chosen Today layout (persisted) — see `DashLayout`.
    @AppStorage("nook.kioskDashLayout") private var layoutRaw = DashLayout.balanced.rawValue
    private var layout: DashLayout { DashLayout(rawValue: layoutRaw) ?? .balanced }

    private var tz: TimeZone { sync.householdTz }
    private var todayKey: String { Agenda.todayKey(tz) }

    private var week: [(day: String, items: [SyncedEvent])] {
        Array(Agenda.upcoming(sync.events, from: todayKey, tz: tz).prefix(7))
    }

    private var isKiosk: Bool { DeviceExperience.current == .kiosk }

    var body: some View {
        VStack(spacing: 14) {
            banners
            dashColumns
        }
        .padding(.horizontal, 40)
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(NK.canvas)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .task { await sync.loadIdentity() }
        // Per-domain reloads: each fires on appear (initial load) and only when its own
        // bus bumps — so a grocery toggle no longer reloads chores + meals + weather.
        .task(id: "\(tz.identifier)|\(sync.choresRev)") { await model.loadChores() }
        .task(id: "\(tz.identifier)|\(sync.mealsRev)") { await model.loadMeals(todayKey: todayKey) }
        .task(id: "\(tz.identifier)|\(sync.groceryRev)") { await model.loadGrocery() }
        .task(id: tz.identifier) { await model.loadWeather() }
        // Pinned-banner queues: approvals refresh on chore/reward actions; the review
        // queue refreshes whenever a review/goal action bumps the goals bus.
        .task(id: "\(sync.choresRev)|\(sync.rewardsRev)") { await approvals.load() }
        .task(id: sync.goalsRev) {
            let api = NookAPI()
            async let r = try? await api.goalRecap()
            async let s = try? await api.goalSuggestions()
            reviewRecap = await r ?? []
            reviewSuggestions = await s ?? []
        }
        .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
        .sheet(item: $recipeTarget) { t in
            NavigationStack { RecipeDetailView(summary: t.summary, model: recipes, autoCook: t.cook) }
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
        if (sync.isParent && !approvals.isEmpty) || !reviewRecap.isEmpty || !reviewSuggestions.isEmpty {
            VStack(spacing: 12) {
                if sync.isParent && !approvals.isEmpty {
                    Button { showApprovals = true } label: { approvalsBanner }.buttonStyle(.plain)
                }
                if !reviewRecap.isEmpty || !reviewSuggestions.isEmpty {
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
                .frame(width: 44, height: 44).background(NK.gold)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(approvals.total == 1 ? "1 thing waiting for your OK" : "\(approvals.total) things waiting for your OK")
                    .font(.system(size: 18, weight: .heavy)).foregroundStyle(NK.ink)
                Text(preview.isEmpty ? "Your OK awards the stars." : "\(preview) — your OK awards the stars.")
                    .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(NK.ink3).lineLimit(1)
            }
            Spacer(minLength: 10)
            bannerCTA("Review", tint: NK.primary)
        }
        .padding(16)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.gold.opacity(0.35), lineWidth: 1))
        .nkShadow1()
    }

    private var reviewBanner: some View {
        let nR = reviewRecap.count, nS = reviewSuggestions.count
        let titles = reviewRecap.map(\.title) + reviewSuggestions.map(\.title)
        let preview = titles.prefix(3).joined(separator: " · ")
        return HStack(spacing: 14) {
            Image(systemName: "sparkles").font(.system(size: 20, weight: .bold)).foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(LinearGradient(colors: [NK.ai2, NK.ai], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(reviewTitle(nR, nS)).font(.system(size: 18, weight: .heavy)).foregroundStyle(NK.ink)
                Text(preview.isEmpty ? "Each ties to a goal." : "\(preview) — each ties to a goal.")
                    .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(NK.ink3).lineLimit(1)
            }
            Spacer(minLength: 10)
            bannerCTA("Review & log", tint: NK.primary)
        }
        .padding(16)
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.ai.opacity(0.3), lineWidth: 1))
        .nkShadow1()
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
    private var agendaCol: some View { agendaColumn }
    private var mealsCol: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 22) { tonightCard; weekDinnersCard }.padding(.bottom, 8)
        }
    }
    // Chores sized to content; the grocery card fills the rest and scrolls its own
    // (full) list internally so it stays reachable without an outer page scroll.
    private var choreGroceryCol: some View {
        VStack(spacing: 22) { choresCard; groceryCard }
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
        }
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
                Text(greetingPhrase).font(NK.serif(40)).foregroundStyle(NK.ink)
                Spacer(minLength: 12)
                layoutMenu
                AICaptureBar(onTap: { dictateOnOpen = false; showCapture = true },
                             onMic: { dictateOnOpen = true; showCapture = true })
                    .frame(maxWidth: 400)
            }
            dateLine
        }
        .padding(.horizontal, 40).padding(.top, 22).padding(.bottom, 16)
        .frame(maxWidth: .infinity)
        .background(NK.canvas)
    }

    /// Date · time · weather on one line, ticking on the minute.
    private var dateLine: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            HStack(spacing: 10) {
                Text(DateFmt.string(Date(), "EEEE, MMMM d", tz))
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(NK.ink2)
                dot
                Text(DateFmt.string(ctx.date, "h:mm a", tz))
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(NK.ink2)
                if let w = model.weather, w.configured, let t = w.tempF {
                    dot
                    Text("\(w.emoji ?? "") \(Int(t.rounded()))°")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(NK.ink2)
                }
            }
        }
    }

    private var dot: some View { Text("·").font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink3) }

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
            .foregroundStyle(NK.ink2)
            .padding(.horizontal, 13).padding(.vertical, 9)
            .background(NK.card).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(NK.hair, lineWidth: 1))
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
                    Text("Nothing scheduled.").font(.system(size: 18)).foregroundStyle(NK.ink3).padding(.vertical, 20)
                } else {
                    ScrollView(showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(week, id: \.day) { group in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(dayLabel(group.day))
                                        .font(.system(size: 14, weight: .heavy)).tracking(0.6).foregroundStyle(NK.ink3)
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
            RoundedRectangle(cornerRadius: 99).fill(Color(hexString: ev.colorHex) ?? NK.ink3).frame(width: 5, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(ev.title).font(.system(size: 21, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                Text(timeText(ev)).font(.system(size: 15)).foregroundStyle(NK.ink3)
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
                        RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                            .fill(LinearGradient(colors: meal.eatingOut
                                                    ? [Color(hex: 0xD9E7F6), Color(hex: 0xBCD0E9)]
                                                    : [Color(hex: 0xF6D9C6), Color(hex: 0xE9B596)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 84, height: 84)
                            .overlay(Text(meal.emoji).font(.system(size: 40)))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(meal.title).font(NK.serif(26)).foregroundStyle(NK.ink).lineLimit(2)
                            if let sub = mealSubtitle(meal) {
                                Text(sub).font(.system(size: 15)).foregroundStyle(NK.ink3)
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
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(NK.ink3).padding(.vertical, 14)
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
                                Rectangle().fill(NK.hair2).frame(height: 1)
                            }
                        }
                    }
                }
            }
        }
    }

    private func dinnerRow(_ e: NookAPI.WeekEntryDTO) -> some View {
        HStack(spacing: 12) {
            Text(Self.dayShort(e.date, tz)).font(.system(size: 14, weight: .heavy))
                .foregroundStyle(NK.ink3).frame(width: 42, alignment: .leading)
            Text(e.recipe?.emoji ?? "🍽️").font(.system(size: 22))
            Text(e.displayTitle).font(.system(size: 17, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
            Spacer(minLength: 6)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3)
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
                        .font(.system(size: 16)).foregroundStyle(NK.ink3).padding(.vertical, 8)
                } else {
                    VStack(spacing: 16) {
                        ForEach(model.chores) { p in personChoreRow(p) }
                    }
                }
            }
        }
    }

    private func personChoreRow(_ p: NookAPI.PersonChoresDTO) -> some View {
        let tint = Color(hexString: p.colorHex) ?? NK.primary
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
                Text(p.name).font(.system(size: 18, weight: .bold)).foregroundStyle(NK.ink)
                Text("\(p.done) of \(p.total) done").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
            }
            Spacer(minLength: 6)
            Text("★ \(p.stars)").font(.system(size: 17, weight: .heavy)).foregroundStyle(NK.gold)
        }
    }

    // MARK: grocery (named list + checkboxes)

    private var groceryCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 12) {
                cardHeader("Grocery", trailing: "\(model.groceryActive.count) to buy", chevron: true) { navigate(.lists) }
                if model.groceryActive.isEmpty {
                    Text(model.loaded ? "All bought ✓" : "Loading…")
                        .font(.system(size: 16)).foregroundStyle(NK.ink3).padding(.vertical, 8)
                    Spacer(minLength: 0)
                } else {
                    // The full list scrolls within the card; the add row below stays pinned.
                    ScrollView(showsIndicators: false) {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(model.groceryActive.enumerated()), id: \.element.id) { idx, item in
                                groceryRow(item)
                                if idx < model.groceryActive.count - 1 {
                                    Rectangle().fill(NK.hair2).frame(height: 1)
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
                .foregroundStyle(groceryDraft.isEmpty ? NK.ink3 : NK.primary)
            TextField("Add an item", text: $groceryDraft)
                .font(.system(size: 17)).foregroundStyle(NK.ink)
                .focused($groceryFocused)
                .submitLabel(.done)
                .onSubmit(addGroceryItem)
            if !groceryDraft.isEmpty {
                Button("Add", action: addGroceryItem)
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(NK.primary)
                    .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 11)
        .overlay(alignment: .top) { Rectangle().fill(NK.hair2).frame(height: 1) }
    }

    private func addGroceryItem() {
        let name = groceryDraft
        groceryDraft = ""
        groceryFocused = true   // keep the keyboard up for rapid entry
        Task { await model.addGrocery(name) }
    }

    private func groceryRow(_ item: NookAPI.ListItemDTO) -> some View {
        Button {
            Task { await model.toggleGrocery(item.id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22)).foregroundStyle(item.checked ? NK.primary : NK.ink3)
                Text(item.name).font(.system(size: 17)).foregroundStyle(item.checked ? NK.ink3 : NK.ink)
                    .strikethrough(item.checked, color: NK.ink3).lineLimit(1)
                Spacer(minLength: 6)
                if let q = item.quantity, !q.isEmpty {
                    Text(q).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
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
            Text(title).font(.system(size: 16, weight: .heavy)).foregroundStyle(NK.ink)
            Spacer(minLength: 6)
            if let trailing { Text(trailing).font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3) }
            if chevron { Image(systemName: "chevron.right").font(.system(size: 13, weight: .bold)).foregroundStyle(NK.ink3) }
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
                .background(NK.primary).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func secondaryButton(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: date helpers

    static func dateFromKey(_ key: String, _ tz: TimeZone) -> Date? {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = tz
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: key)
    }

    static func dayShort(_ key: String, _ tz: TimeZone) -> String {
        guard let d = dateFromKey(key, tz) else { return "" }
        return DateFmt.string(d, "EEE", tz)
    }

    /// Identifies the recipe sheet target (and whether to jump into Cook Mode).
    struct RecipeTarget: Identifiable {
        let summary: NookAPI.RecipeSummary
        let cook: Bool
        var id: String { (summary.id) + (cook ? "-cook" : "") }
    }
}

/// REST-backed state for the iPad Today page — chores, tonight + this-week dinners,
/// the named grocery list (with optimistic check-off), and weather. Mirrors what the
/// web `Today` shows; reuses the same `NookAPI` endpoints as the iPhone dashboard.
@MainActor
@Observable
final class KioskTodayModel {
    var chores: [NookAPI.PersonChoresDTO] = []
    var tonight: TonightMeal?
    var weekDinners: [NookAPI.WeekEntryDTO] = []
    var grocery: [NookAPI.ListItemDTO] = []
    var weather: NookAPI.Weather?
    var loaded = false

    private let api = NookAPI()

    /// Just-checked items linger here ~2s before dropping off, so a tap reads as
    /// "crossed out, then settles" instead of vanishing instantly (matches the Lists page).
    private var settling: Set<String> = []

    var choreDone: Int { chores.reduce(0) { $0 + $1.done } }
    var choreTotal: Int { chores.reduce(0) { $0 + $1.total } }
    var groceryActive: [NookAPI.ListItemDTO] { grocery.filter { !$0.checked || settling.contains($0.id) } }

    /// Full initial load — runs each domain in parallel. Per-domain methods below let
    /// the view refresh just the domain whose `rev` bumped (e.g. a grocery toggle
    /// reloads only grocery, not chores + meals + weather).
    func load(todayKey: String) async {
        async let a: () = loadChores()
        async let b: () = loadMeals(todayKey: todayKey)
        async let c: () = loadGrocery()
        async let d: () = loadWeather()
        _ = await (a, b, c, d)
        loaded = true
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
    case balanced, agenda, meals
    var label: String {
        switch self {
        case .balanced: return "Balanced"
        case .agenda: return "Agenda-focused"
        case .meals: return "Meals-focused"
        }
    }
    var icon: String {
        switch self {
        case .balanced: return "rectangle.split.3x1"
        case .agenda: return "list.bullet.rectangle"
        case .meals: return "fork.knife"
        }
    }
}

/// A large, kiosk-scaled card surface (the wall-display twin of `NookCard`).
struct KioskCard<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
            .nkShadow1()
    }
}

#Preview {
    KioskDashboard()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
