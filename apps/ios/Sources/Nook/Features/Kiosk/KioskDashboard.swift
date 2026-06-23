import SwiftUI

/// The iPad family-display dashboard — Phase 2.
///
/// A landscape, large-type wall view: a clock/date header, a week agenda, and the
/// family's meals, chores, goals & grocery at a glance. It reuses the exact data the
/// iPhone `TodayView` uses (`DashboardModel` + `SyncManager` + `NookAPI`), just
/// re-laid-out big for across-the-room reading. See `apps/ios/IPAD_ROADMAP.md`.
struct KioskDashboard: View {
    @Environment(SyncManager.self) private var sync

    @State private var dash = DashboardModel()
    @State private var goals: [NookAPI.Goal] = []
    @State private var weather: NookAPI.Weather?

    private var tz: TimeZone { sync.householdTz }
    private var todayKey: String { Agenda.todayKey(tz) }

    /// Upcoming events grouped by day, starting today — the agenda column.
    private var week: [(day: String, items: [SyncedEvent])] {
        Array(Agenda.upcoming(sync.events, from: todayKey, tz: tz).prefix(7))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 22) {
            agendaColumn
                .frame(maxWidth: .infinity)
            VStack(spacing: 22) {
                tonightCard
                choresCard
            }
            .frame(maxWidth: .infinity)
            VStack(spacing: 22) {
                goalsCard
                groceryCard
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 40)
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(NK.canvas)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .task { await sync.loadIdentity() }
        .task(id: "\(tz.identifier)|\(sync.choresRev)|\(sync.groceryRev)|\(sync.mealsRev)") {
            await dash.load(todayKey: todayKey)
        }
        .task(id: sync.goalsRev) { goals = (try? await NookAPI().goalsIn(listId: nil)) ?? [] }
        .task { weather = try? await NookAPI().weather() }
    }

    // MARK: header (date · clock · weather)

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(greetingPhrase).font(NK.serif(40)).foregroundStyle(NK.ink)
                Text(DateFmt.string(Date(), "EEEE, MMMM d", tz))
                    .font(.system(size: 19, weight: .semibold)).foregroundStyle(NK.ink2)
            }
            Spacer()
            if let w = weather, w.configured, let t = w.tempF {
                Text("\(w.emoji ?? "") \(Int(t.rounded()))°")
                    .font(.system(size: 30, weight: .semibold)).foregroundStyle(NK.ink2)
                    .padding(.trailing, 8)
            }
            clock
        }
        .padding(.horizontal, 40)
        .padding(.top, 26).padding(.bottom, 18)
        .frame(maxWidth: .infinity)
        .background(NK.canvas)
    }

    /// A live clock that re-renders on the minute.
    private var clock: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(DateFmt.string(ctx.date, "h:mm", tz))
                    .font(NK.serif(56)).foregroundStyle(NK.ink)
                Text(DateFmt.string(ctx.date, "a", tz))
                    .font(.system(size: 20, weight: .bold)).foregroundStyle(NK.ink3)
            }
        }
    }

    private var greetingPhrase: String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        switch cal.component(.hour, from: Date()) {
        case 5..<12:  return "Good morning"
        case 12..<17: return "Good afternoon"
        default:      return "Good evening"
        }
    }

    // MARK: agenda column

    private var agendaColumn: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 0) {
                sectionTitle("This week")
                if week.isEmpty {
                    Text("Nothing scheduled.")
                        .font(.system(size: 18)).foregroundStyle(NK.ink3)
                        .padding(.vertical, 20)
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 18) {
                            ForEach(week, id: \.day) { group in
                                VStack(alignment: .leading, spacing: 10) {
                                    Text(dayLabel(group.day))
                                        .font(.system(size: 14, weight: .heavy)).tracking(0.6)
                                        .foregroundStyle(NK.ink3)
                                    ForEach(group.items) { ev in kioskEventRow(ev) }
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
            RoundedRectangle(cornerRadius: 99)
                .fill(Color(hexString: ev.colorHex) ?? NK.ink3)
                .frame(width: 5, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(ev.title).font(.system(size: 21, weight: .semibold)).foregroundStyle(NK.ink).lineLimit(1)
                Text(timeText(ev)).font(.system(size: 15)).foregroundStyle(NK.ink3)
            }
            Spacer(minLength: 8)
            if let emoji = ev.emoji {
                Avatar(colorHex: ev.colorHex, emoji: emoji, size: 38)
            }
        }
    }

    private func timeText(_ ev: SyncedEvent) -> String {
        if ev.allDay { return "All day" }
        if let d = ev.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }

    /// "Today" / "Tomorrow" / "Wed · Jun 25" for a YYYY-MM-DD key.
    private func dayLabel(_ key: String) -> String {
        if key == todayKey { return "TODAY" }
        if key == Agenda.todayKey(tz, now: Date().addingTimeInterval(86_400)) { return "TOMORROW" }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = tz
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: key) else { return key }
        return DateFmt.string(d, "EEEE · MMM d", tz).uppercased()
    }

    // MARK: tonight's dinner

    @ViewBuilder private var tonightCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 12) {
                sectionTitle("Tonight's dinner")
                if let meal = dash.tonight {
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
                } else {
                    Text(dash.loaded ? "No dinner planned" : "Loading…")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(NK.ink3)
                        .padding(.vertical, 14)
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

    // MARK: chores

    private var choresCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionTitle("Family chores")
                HStack(spacing: -10) {
                    ForEach(dash.chores.prefix(5)) { p in
                        Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 44)
                    }
                    Spacer(minLength: 0)
                    if dash.choreTotal > 0 {
                        Text("★ \(dash.choreStars)").font(.system(size: 20, weight: .heavy)).foregroundStyle(NK.gold)
                    }
                }
                if dash.choreTotal > 0 {
                    ProgressBar(value: Double(dash.choreDone) / Double(dash.choreTotal),
                                tint: NK.primary, track: NK.primary.opacity(0.18))
                    Text("\(dash.choreDone) of \(dash.choreTotal) done today")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink3)
                } else {
                    Text(dash.loaded ? "No chores today" : "Loading…")
                        .font(.system(size: 16)).foregroundStyle(NK.ink3)
                }
            }
        }
    }

    // MARK: goals

    @ViewBuilder private var goalsCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionTitle("Goals")
                if let g = featuredGoal {
                    let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
                    HStack(spacing: 10) {
                        Text(g.emoji ?? "🎯").font(.system(size: 26))
                        Text(g.title).font(.system(size: 20, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
                        Spacer(minLength: 6)
                        if g.streakDays >= 2 {
                            Text("🔥 \(g.streakDays)").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink2)
                        }
                    }
                    if let target = g.target, target > 0 {
                        ProgressBar(value: frac, tint: Color(hex: 0x2BA45F), track: Color(hex: 0x2BA45F).opacity(0.18))
                        Text("\(goalFmt(g.totalProgress)) of \(goalFmt(target))\(g.unit.map { " \($0)" } ?? "")")
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                } else {
                    Text(goals.isEmpty ? "No goals yet" : "Loading…")
                        .font(.system(size: 16)).foregroundStyle(NK.ink3)
                }
            }
        }
    }

    private var featuredGoal: NookAPI.Goal? {
        goals.first { $0.isFeatured } ?? goals.first
    }

    private func goalFmt(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }

    // MARK: grocery

    private var groceryCard: some View {
        KioskCard {
            VStack(alignment: .leading, spacing: 6) {
                sectionTitle("Grocery")
                Text("\(dash.groceryRemaining)").font(.system(size: 44, weight: .bold)).foregroundStyle(NK.ink)
                Text(dash.groceryRemaining == 1 ? "item to buy" : "items to buy")
                    .font(.system(size: 16)).foregroundStyle(NK.ink3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: building blocks

    private func sectionTitle(_ text: String) -> some View {
        Text(text).font(.system(size: 15, weight: .heavy)).tracking(0.6).foregroundStyle(NK.ink2)
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
