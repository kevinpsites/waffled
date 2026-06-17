import SwiftUI

/// Family — the 5th-tab hub from the handoff (`screens-ios-hub.js`): a people row
/// plus a launcher grid for every overflow area. Static in Phase 0; the people row
/// becomes the first PowerSync-backed surface in Phase 1.
struct FamilyView: View {
    @Environment(SyncManager.self) private var sync
    @State private var hub = FamilyHubModel()
    @Binding var path: [HubRoute]
    @State private var showSync = false
    @State private var ranDemo = false
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack(path: $path) {
            hubContent
                .navigationDestination(for: HubRoute.self, destination: destination)
        }
    }

    private var hubContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("Family").font(NK.serif(30)).foregroundStyle(NK.ink)
                    Spacer()
                    Button { showSync = true } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.system(size: 16)).foregroundStyle(NK.ink2)
                            .frame(width: 36, height: 36)
                            .background(NK.panel).clipShape(Circle())
                            .overlay(alignment: .topTrailing) {
                                Circle().fill(syncDotColor).frame(width: 9, height: 9)
                                    .overlay(Circle().stroke(NK.canvas, lineWidth: 1.5))
                            }
                    }
                    .buttonStyle(.plain)
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
                    tile("✅", "Chores", hub.choresSubtitle, FamilyColor.wally.tint, .chores)
                    tile("🎯", "Goals", hub.goalsSubtitle, Color(hex: 0xE8F0E4), .goals)
                    tile("⭐", "Rewards", hub.rewardsSubtitle, Color(hex: 0xFDF0D6), .rewards)
                    tile("📋", "Lists", hub.listsSubtitle, FamilyColor.kevin.tint, .lists)
                    tile("📷", "Photos", hub.photosSubtitle, Color(hex: 0xDFF0EF), .photos)
                    tile("⚙️", "Settings", "People, calendars, AI", NK.panel, .settings)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 110)
        }
        .background(NK.canvas)
        .toolbar(.hidden, for: .navigationBar)   // the screen draws its own "Family" header
        .refreshable { await hub.load() }
        .task { await hub.load() }
        .sheet(isPresented: $showSync) { SyncStatusView() }
        .onAppear(perform: runDemoHooksIfSet)
    }

    private static func route(for name: String) -> HubRoute? {
        switch name {
        case "chores": return .chores
        case "goals": return .goals
        case "rewards": return .rewards
        case "lists": return .lists
        case "photos": return .photos
        case "settings": return .settings
        default: return nil
        }
    }

    /// Tile destinations: Lists is built out; the rest are live-summary placeholders.
    @ViewBuilder private func destination(_ route: HubRoute) -> some View {
        switch route {
        case .lists:           ListsIndexView(path: $path)
        case let .list(list):  ListDetailView(list: list)
        case .chores:          ChoresView()
        case .goals:           GoalsView(path: $path)
        case let .goal(goal):  GoalDetailView(goal: goal, path: $path)
        case let .person(id):  PersonView(personId: id, path: $path)
        case .rewards:         HubPlaceholder(emoji: "⭐", title: "Rewards", summary: hub.rewardsSubtitle)
        case .photos:          HubPlaceholder(emoji: "📷", title: "Photos", summary: hub.photosSubtitle)
        case .settings:        HubPlaceholder(emoji: "⚙️", title: "Settings", summary: "People, calendars, AI")
        }
    }

    /// Headless demo driver (no-op unless NOOK_* env is set) — see DemoHooks.
    private func runDemoHooksIfSet() {
        if DemoHooks.openSync { showSync = true }
        if let hub = DemoHooks.openHub, let route = Self.route(for: hub) { path = [route] }
        guard DemoHooks.addEvent, !ranDemo else { return }
        ranDemo = true
        Task {
            for _ in 0..<40 {
                if !sync.members.isEmpty { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            await sync.addTestEvent()
        }
    }

    // Live from the local SQLite mirror once synced; the static sample until then,
    // so the design still reads pre-sync.
    private var peopleRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if sync.members.isEmpty {
                    ForEach(Sample.members) { m in
                        personChip(name: m.name, sub: m.sub, dot: m.color.solid) {
                            Avatar(person: m.color, emoji: m.emoji, size: 46)
                        }
                    }
                } else {
                    ForEach(sync.members) { m in
                        Button { path.append(.person(m.id)) } label: {
                            personChip(name: m.name,
                                       sub: m.memberType?.capitalized ?? "",
                                       dot: Color(hexString: m.colorHex) ?? NK.ink3) {
                                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 46)
                            }
                        }
                        .buttonStyle(.plain)
                    }
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

    private func personChip<A: View>(name: String, sub: String, dot: Color,
                                     @ViewBuilder avatar: () -> A) -> some View {
        VStack(spacing: 7) {
            avatar()
                .overlay(alignment: .bottomTrailing) {
                    Circle().fill(dot)
                        .frame(width: 14, height: 14)
                        .overlay(Circle().stroke(NK.card, lineWidth: 2))
                }
            Text(name).font(.system(size: 12.5, weight: .bold)).foregroundStyle(NK.ink)
            Text(sub).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(NK.ink3)
        }
        .frame(width: 64)
    }

    private var syncDotColor: Color {
        switch sync.status {
        case .connected: return FamilyColor.wally.solid
        case .connecting: return NK.gold
        case .offline, .idle: return NK.ink3
        }
    }

    private func tile(_ emoji: String, _ name: String, _ sub: String, _ accent: Color, _ route: HubRoute) -> some View {
        NavigationLink(value: route) {
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
        .buttonStyle(.plain)
    }
}

#Preview { FamilyView(path: .constant([])).environment(SyncManager()) }
