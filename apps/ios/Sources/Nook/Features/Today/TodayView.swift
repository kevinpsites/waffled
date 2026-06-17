import SwiftUI

/// Today — the home surface. Mock-faithful to the handoff `ios-home.png`:
/// greeting + capture bar, today's agenda, tonight's meal, chores + grocery.
/// Static sample data in Phase 0; PowerSync-backed in Phase 1+.
struct TodayView: View {
    @Environment(SyncManager.self) private var sync
    @State private var dash = DashboardModel()
    @State private var editingEvent: SyncedEvent?
    /// Jump to a Family hub destination (Chores, Lists…) from a summary card.
    var openFamily: (HubRoute) -> Void = { _ in }
    /// Jump to the Calendar tab (from the agenda card).
    var openCalendar: () -> Void = {}

    private var todays: [SyncedEvent] {
        Agenda.forDay(sync.events, day: Agenda.todayKey(sync.householdTz), tz: sync.householdTz)
    }

    private var greetingMember: SyncedMember? {
        sync.members.first { ($0.memberType ?? "") == "adult" } ?? sync.members.first
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
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                greeting
                AICaptureBar()
                    .padding(.bottom, 2)
                todayCard
                tonightCard
                HStack(spacing: 12) {
                    Button { openFamily(.chores) } label: { choresCard }.buttonStyle(.plain)
                    Button { openFamily(.lists) } label: { groceryCard }.buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .padding(.bottom, 110)   // clear the floating tab bar
        }
        .background(NK.canvas)
        .refreshable { await dash.load(todayKey: Agenda.todayKey(sync.householdTz)) }
        .task(id: sync.householdTz) {
            await dash.load(todayKey: Agenda.todayKey(sync.householdTz))
        }
        .sheet(item: $editingEvent) { ev in
            EventEditSheet(event: ev, initialDate: ev.startsAt ?? Date())
        }
    }

    // MARK: greeting row
    private var greeting: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(greetingDate)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(NK.ink2)
                Text(greetingPhrase)
                    .font(NK.serif(30))
                    .foregroundStyle(NK.ink)
            }
            Spacer()
            if let m = greetingMember {
                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 46)
            } else {
                Avatar(person: .kelly, emoji: "🦊", size: 46)
            }
        }
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
        }
    }

    private var groceryCard: some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Grocery").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                Text("\(dash.groceryRemaining)").font(.system(size: 26, weight: .bold)).foregroundStyle(NK.ink)
                Text(dash.groceryRemaining == 1 ? "item to buy" : "items to buy")
                    .font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
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

#Preview { TodayView().environment(SyncManager()) }
