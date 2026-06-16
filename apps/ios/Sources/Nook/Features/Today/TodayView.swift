import SwiftUI

/// Today — the home surface. Mock-faithful to the handoff `ios-home.png`:
/// greeting + capture bar, today's agenda, tonight's meal, chores + grocery.
/// Static sample data in Phase 0; PowerSync-backed in Phase 1+.
struct TodayView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                greeting
                AICaptureBar()
                    .padding(.bottom, 2)
                todayCard
                tonightCard
                HStack(spacing: 12) {
                    choresCard
                    groceryCard
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .padding(.bottom, 110)   // clear the floating tab bar
        }
        .background(NK.canvas)
    }

    // MARK: greeting row
    private var greeting: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(Sample.greetingDate)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(NK.ink2)
                Text("Good afternoon")
                    .font(NK.serif(30))
                    .foregroundStyle(NK.ink)
            }
            Spacer()
            Avatar(person: .kelly, emoji: "🦊", size: 46)
        }
    }

    // MARK: today's agenda
    private var todayCard: some View {
        NookCard(padding: 17) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Today").font(.system(size: 17, weight: .bold)).foregroundStyle(NK.ink)
                    Spacer()
                    Text("\(Sample.todaysAgenda.count) events")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                }
                .padding(.bottom, 4)

                ForEach(Array(Sample.todaysAgenda.enumerated()), id: \.element.id) { idx, item in
                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 99).fill(item.owner.solid)
                            .frame(width: 4, height: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                            Text(item.time).font(.system(size: 12)).foregroundStyle(NK.ink3)
                        }
                        Spacer()
                        Avatar(person: item.owner, emoji: emoji(item.owner), size: 30)
                    }
                    .padding(.vertical, 11)
                    if idx < Sample.todaysAgenda.count - 1 {
                        Rectangle().fill(NK.hair2).frame(height: 1)
                    }
                }
            }
        }
    }

    // MARK: tonight's meal (split media card)
    private var tonightCard: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [Color(hex: 0xF6D9C6), Color(hex: 0xE9B596)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .frame(width: 104)
                .overlay(Text("🍝").font(.system(size: 36)))
            VStack(alignment: .leading, spacing: 4) {
                Text("TONIGHT")
                    .font(.system(size: 11, weight: .heavy)).tracking(0.5)
                    .foregroundStyle(FamilyColor.lottie.solid)
                Text("Ravioli & Sausage Bake")
                    .font(NK.serif(18)).foregroundStyle(NK.ink)
                Text("🕐 35 min · serves 5")
                    .font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
            .padding(.horizontal, 15).padding(.vertical, 13)
            Spacer(minLength: 0)
        }
        .background(NK.card)
        .clipShape(RoundedRectangle(cornerRadius: NK.rLG, style: .continuous))
        .nkShadow1()
    }

    // MARK: chores + grocery summary
    private var choresCard: some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Lottie's chores").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                HStack(spacing: 8) {
                    Avatar(person: .lottie, emoji: "🦄", size: 30)
                    ProgressBar(value: 0.83, tint: FamilyColor.lottie.solid, track: FamilyColor.lottie.tint)
                }
                (Text("5 of 6 · ").foregroundStyle(NK.ink3)
                 + Text("★ 24").foregroundStyle(NK.gold).bold())
                    .font(.system(size: 12.5))
            }
        }
    }

    private var groceryCard: some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Grocery").font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink2)
                Text("10").font(.system(size: 26, weight: .bold)).foregroundStyle(NK.ink)
                Text("items · auto-built").font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
        }
    }

    private func emoji(_ c: FamilyColor) -> String {
        Sample.members.first { $0.color == c }?.emoji ?? "🙂"
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

#Preview { TodayView() }
