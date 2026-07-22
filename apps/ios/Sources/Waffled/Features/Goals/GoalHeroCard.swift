import SwiftUI

/// The Today "Family Goal" hero card, shared by iPhone (`kiosk == false`) and the iPad
/// family display (`kiosk == true`, larger type). A green gradient card with the featured
/// goal's progress ring, each participant's contribution bar, a prominent "Log progress"
/// button, and a switcher that opens the shared grouped goal picker (My goals / shared
/// groups / other). Self-contained: it owns the log + picker sheets and the progress write,
/// so both screens get inline logging + goal-switching from one implementation.
///
/// `goal` is the featured goal (nil → empty state). `selectedId` is the pinned goal id
/// ("" = auto/featured). The caller persists the pin (`onPin`), opens the goal detail
/// (`onOpen`) / the Goals page (`onSeeAll`), and refreshes its goals after a log (`onLogged`).
struct GoalHeroCard: View {
    var kiosk = false
    let goal: WaffledAPI.Goal?
    let goals: [WaffledAPI.Goal]
    let goalsLoaded: Bool
    let myPersonId: String?
    let selectedId: String
    var onOpen: (WaffledAPI.Goal) -> Void = { _ in }
    var onSeeAll: () -> Void = {}
    var onPin: (String) -> Void = { _ in }
    var onLogged: () -> Void = {}

    @State private var logGoal: WaffledAPI.Goal?
    @State private var showingPicker = false

    private static let heroGreen = LinearGradient(colors: [Color(hex: 0x2BA86B), Color(hex: 0x1C8A56)],
                                                  startPoint: .topLeading, endPoint: .bottomTrailing)
    private static let heroGreenInk = Color(hex: 0x1C8A56)

    var body: some View {
        Group { if let g = goal { hero(g) } else { emptyCard } }
            .sheet(item: $logGoal) { g in
                GoalLogSheet(goal: g) { amount, hours, minutes, ids, note, loggedOn in
                    Task {
                        try? await WaffledAPI().logGoalProgress(goalId: g.id, amount: amount, personIds: ids,
                                                                note: note, loggedOn: loggedOn, hours: hours, minutes: minutes)
                        onLogged()
                    }
                }
            }
            .sheet(isPresented: $showingPicker) {
                TodayGoalPickerSheet(goals: goals, myPersonId: myPersonId, selectedId: selectedId) { onPin($0) }
            }
    }

    // MARK: hero

    private func hero(_ g: WaffledAPI.Goal) -> some View {
        VStack(alignment: .leading, spacing: kiosk ? 18 : 13) {
            HStack {
                Text("Family Goal")
                    .font(.system(size: kiosk ? 14 : 12, weight: .heavy)).tracking(0.5)
                    .foregroundStyle(.white.opacity(0.9))
                Spacer()
                Button(action: onSeeAll) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: kiosk ? 15 : 13, weight: .bold)).foregroundStyle(.white.opacity(0.9))
                }
                .buttonStyle(.plain)
            }
            body(g)
        }
        .padding(kiosk ? 22 : 15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.heroGreen)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .wfShadow1()
        // The card body opens the goal's detail; the inner Buttons/Menu (chevron, Log,
        // switcher) sit above this gesture so they keep their own actions.
        .contentShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .onTapGesture { onOpen(g) }
    }

    private func body(_ g: WaffledAPI.Goal) -> some View {
        let frac = g.target.map { $0 > 0 ? min(g.totalProgress / $0, 1) : 0 } ?? 0
        let maxProg = max(1, g.participants.map(\.progress).max() ?? 1)
        let ring: CGFloat = kiosk ? 116 : 78
        return VStack(alignment: .leading, spacing: kiosk ? 18 : 13) {
            HStack(alignment: .center, spacing: kiosk ? 18 : 13) {
                GoalRing(value: frac, size: ring, lineWidth: kiosk ? 10 : 8, stroke: .white, track: .white.opacity(0.25)) {
                    VStack(spacing: 1) {
                        Text(goalFmt(g.totalProgress)).font(.system(size: kiosk ? 24 : 17, weight: .heavy)).foregroundStyle(.white)
                            .lineLimit(1).minimumScaleFactor(0.5)
                        if g.target != nil {
                            Text("of \(goalFmt(g.target))\(g.unit.map { " \($0)" } ?? "")")
                                .font(.system(size: kiosk ? 11 : 9, weight: .bold)).foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1).minimumScaleFactor(0.7)
                        }
                    }
                    .frame(width: kiosk ? 80 : 54)
                }
                VStack(alignment: .leading, spacing: kiosk ? 6 : 4) {
                    Text("\(g.emoji ?? "🎯") \(g.title)")
                        .font(WF.serif(kiosk ? 26 : 19)).foregroundStyle(.white).lineLimit(3).minimumScaleFactor(0.7)
                    if g.streakDays > 0 {
                        Text("🔥 \(g.streakDays)-day streak")
                            .font(.system(size: kiosk ? 15 : 12.5, weight: .bold)).foregroundStyle(.white.opacity(0.9))
                    }
                }
                Spacer(minLength: 0)
            }
            if !g.participants.isEmpty {
                VStack(spacing: kiosk ? 10 : 8) {
                    ForEach(g.participants, id: \.personId) { contribRow($0, max: maxProg, unit: g.unit) }
                }
            }
            Button { logGoal = g } label: {
                Label("Log \(g.unit ?? "progress")", systemImage: "plus.circle.fill")
                    .font(.system(size: kiosk ? 17 : 15, weight: .bold)).foregroundStyle(Self.heroGreenInk)
                    .frame(maxWidth: .infinity).padding(.vertical, kiosk ? 14 : 11)
                    .background(.white).clipShape(Capsule())
            }
            .buttonStyle(.plain)
            if goals.count > 1 { switcher }
        }
    }

    private func contribRow(_ p: WaffledAPI.Goal.Participant, max: Double, unit: String?) -> some View {
        HStack(spacing: kiosk ? 12 : 10) {
            Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: kiosk ? 32 : 26)
            VStack(alignment: .leading, spacing: kiosk ? 5 : 4) {
                HStack {
                    Text(p.name).font(.system(size: kiosk ? 15 : 13, weight: .bold)).foregroundStyle(.white)
                    Spacer()
                    Text("\(goalFmt(p.progress))\(p.target.map { " / \(goalFmt($0))" } ?? "")\(unit.map { " \($0)" } ?? "")")
                        .font(.system(size: kiosk ? 14 : 12, weight: .heavy)).foregroundStyle(.white)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.25))
                        Capsule().fill(.white)
                            .frame(width: geo.size.width * (max > 0 ? min(p.progress / max, 1) : 0))
                    }
                }
                .frame(height: kiosk ? 8 : 6)
            }
        }
    }

    private var switcher: some View {
        Button { showingPicker = true } label: {
            HStack(spacing: 7) {
                Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: kiosk ? 13 : 12, weight: .semibold))
                Text("Show a different goal").font(.system(size: kiosk ? 14 : 13, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity).padding(.vertical, kiosk ? 11 : 9)
            .background(.white.opacity(0.16)).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.4), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: empty

    @ViewBuilder private var emptyCard: some View {
        let content = VStack(alignment: .leading, spacing: kiosk ? 18 : 10) {
            HStack {
                Text("Family Goal").font(.system(size: kiosk ? 16 : 12.5, weight: kiosk ? .heavy : .bold)).foregroundStyle(WF.ink2)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: kiosk ? 15 : 12, weight: .bold)).foregroundStyle(WF.ink3)
            }
            Text(goalsLoaded ? "No goals yet — add one on the Goals page." : "Loading…")
                .font(.system(size: kiosk ? 17 : 13, weight: kiosk ? .regular : .semibold)).foregroundStyle(WF.ink3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, kiosk ? 12 : 0)
        }
        Button(action: onSeeAll) {
            if kiosk { KioskCard { content } } else { WaffledCard(padding: 15) { content } }
        }
        .buttonStyle(.plain)
    }
}
