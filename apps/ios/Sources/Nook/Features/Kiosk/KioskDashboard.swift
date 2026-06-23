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

    private var tz: TimeZone { sync.householdTz }
    private var todayKey: String { Agenda.todayKey(tz) }

    private var week: [(day: String, items: [SyncedEvent])] {
        Array(Agenda.upcoming(sync.events, from: todayKey, tz: tz).prefix(7))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 22) {
            agendaColumn.frame(maxWidth: .infinity)
            VStack(spacing: 22) { tonightCard; weekDinnersCard; Spacer(minLength: 0) }
                .frame(maxWidth: .infinity)
            VStack(spacing: 22) { choresCard; groceryCard; Spacer(minLength: 0) }
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 40)
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(NK.canvas)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .task { await sync.loadIdentity() }
        .task(id: "\(tz.identifier)|\(sync.choresRev)|\(sync.groceryRev)|\(sync.mealsRev)|\(sync.goalsRev)") {
            await model.load(todayKey: todayKey)
        }
        .sheet(item: $detailEvent) { ev in EventDetailView(event: ev) }
        .sheet(item: $recipeTarget) { t in
            NavigationStack { RecipeDetailView(summary: t.summary, model: recipes, autoCook: t.cook) }
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
    }

    // MARK: header (greeting + capture bar, then date · time · weather)

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 16) {
                Text(greetingPhrase).font(NK.serif(40)).foregroundStyle(NK.ink)
                Spacer(minLength: 12)
                AICaptureBar(onTap: { dictateOnOpen = false; showCapture = true },
                             onMic: { dictateOnOpen = true; showCapture = true })
                    .frame(maxWidth: 460)
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

    private var greetingPhrase: String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        switch cal.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }

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
                        VStack(alignment: .leading, spacing: 18) {
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
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(model.groceryActive.prefix(8).enumerated()), id: \.element.id) { idx, item in
                            groceryRow(item)
                            if idx < min(model.groceryActive.count, 8) - 1 {
                                Rectangle().fill(NK.hair2).frame(height: 1)
                            }
                        }
                    }
                    if model.groceryActive.count > 8 {
                        Button { navigate(.lists) } label: {
                            Text("+ \(model.groceryActive.count - 8) more")
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.primary)
                        }
                        .buttonStyle(.plain).padding(.top, 6)
                    }
                }
            }
        }
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

    var choreDone: Int { chores.reduce(0) { $0 + $1.done } }
    var choreTotal: Int { chores.reduce(0) { $0 + $1.total } }
    var groceryActive: [NookAPI.ListItemDTO] { grocery.filter { !$0.checked } }

    func load(todayKey: String) async {
        async let choresF = (try? await api.choresToday()) ?? []
        async let mealsF = (try? await api.mealsWeek(start: todayKey)) ?? []
        async let boardF = try? await api.groceryBoard()
        async let weatherF = try? await api.weather()
        let (c, m, b, w) = await (choresF, mealsF, boardF, weatherF)

        chores = c.filter { $0.total > 0 }
        let dinners = m.filter { $0.mealType == "dinner" }
        tonight = dinners.first(where: { $0.date == todayKey }).map { TonightMeal($0) }
        weekDinners = dinners.sorted { $0.date < $1.date }
        grocery = b?.items ?? []
        weather = w
        loaded = true
    }

    /// Optimistically toggle a grocery item, reverting on failure.
    func toggleGrocery(_ id: String) async {
        guard let idx = grocery.firstIndex(where: { $0.id == id }) else { return }
        let target = !grocery[idx].checked
        grocery[idx].checked = target
        do { try await api.patchListItem(id: id, checked: target) }
        catch { if let i = grocery.firstIndex(where: { $0.id == id }) { grocery[i].checked = !target } }
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
