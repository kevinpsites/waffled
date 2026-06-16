import SwiftUI

/// Family — the 5th-tab hub from the handoff (`screens-ios-hub.js`): a people row
/// plus a launcher grid for every overflow area. Static in Phase 0; the people row
/// becomes the first PowerSync-backed surface in Phase 1.
struct FamilyView: View {
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Family").font(NK.serif(30)).foregroundStyle(NK.ink)
                    Spacer()
                    Image(systemName: "gearshape")
                        .font(.system(size: 18)).foregroundStyle(NK.ink2)
                        .frame(width: 36, height: 36)
                        .background(NK.panel).clipShape(Circle())
                }
                .padding(.top, 8)

                peopleRow.padding(.top, 14)
                Text("Tap a person to see just their day, chores & goals.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3)
                    .padding(.top, 8).padding(.bottom, 18)

                SectionLabel(text: "Everything else").padding(.bottom, 11)
                LazyVGrid(columns: cols, spacing: 12) {
                    tile("✅", "Chores", "8 to do today", FamilyColor.wally.tint)
                    tile("🎯", "Goals", "7 active · 1 featured", Color(hex: 0xE8F0E4))
                    tile("⭐", "Rewards", "Lottie 24 · Wally 31", Color(hex: 0xFDF0D6))
                    tile("📋", "Lists", "5 lists · groceries +2", FamilyColor.kevin.tint)
                    tile("📷", "Photos", "“Lake Day” +18 new", Color(hex: 0xDFF0EF))
                    tile("⚙️", "Settings", "People, calendars, AI", NK.panel)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 110)
        }
        .background(NK.canvas)
    }

    private var peopleRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Sample.members) { m in
                    VStack(spacing: 7) {
                        Avatar(person: m.color, emoji: m.emoji, size: 46)
                            .overlay(alignment: .bottomTrailing) {
                                Circle().fill(m.color.solid)
                                    .frame(width: 14, height: 14)
                                    .overlay(Circle().stroke(NK.card, lineWidth: 2))
                            }
                        Text(m.name).font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink)
                        Text(m.sub).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                    .frame(width: 64)
                }
                VStack(spacing: 7) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold)).foregroundStyle(NK.ink3)
                        .frame(width: 46, height: 46)
                        .background(NK.panel)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(NK.hair, style: StrokeStyle(lineWidth: 2, dash: [3])))
                    Text("Add").font(.system(size: 10.5, weight: .bold)).foregroundStyle(NK.ink3)
                }
                .frame(width: 64)
            }
        }
    }

    private func tile(_ emoji: String, _ name: String, _ sub: String, _ accent: Color) -> some View {
        NookCard(padding: 15) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    Text(emoji).font(.system(size: 21))
                        .frame(width: 42, height: 42)
                        .background(accent)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(NK.ink3)
                }
                Text(name).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink).padding(.top, 11)
                Text(sub).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3).padding(.top, 2)
            }
        }
    }
}

#Preview { FamilyView() }
