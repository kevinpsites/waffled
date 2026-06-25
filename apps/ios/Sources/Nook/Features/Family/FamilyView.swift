import SwiftUI

/// Family — the 5th-tab hub from the handoff (`screens-ios-hub.js`): a people row
/// plus a launcher grid for every overflow area. Static in Phase 0; the people row
/// becomes the first PowerSync-backed surface in Phase 1.
struct FamilyView: View {
    @Environment(SyncManager.self) private var sync
    @State private var hub = FamilyHubModel()
    @State private var recipes = RecipesModel()   // backs a recipe pushed from the grocery recap
    @Binding var path: [HubRoute]
    /// Household-wide pending approvals (owned by AppRoot) — drives the per-tile badges
    /// so the Family-tab count has a visible trail down to Chores/Rewards.
    var approvals: ApprovalsModel
    @State private var showSync = false
    @State private var ranDemo = false
    private let cols = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    /// Per-tile approval counts — only shown to those who can action that queue.
    private var choreApprovals: Int { sync.can("chore.approve") ? approvals.chores.count : 0 }
    private var rewardApprovals: Int { sync.can("reward.approve") ? approvals.redemptions.count : 0 }

    var body: some View {
        NavigationStack(path: $path) {
            hubContent
                .navigationDestination(for: HubRoute.self) { route in
                    HubDestination(route: route, path: $path, recipes: recipes, hub: hub)
                }
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
                }
                .padding(.top, 8)

                peopleRow.padding(.top, 14)
                Text("Tap a person to see just their day, chores & goals.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink3)
                    .padding(.top, 8).padding(.bottom, 18)

                SectionLabel(text: "Everything else").padding(.bottom, 11)
                LazyVGrid(columns: cols, spacing: 12) {
                    tile("✅", "Chores", hub.choresSubtitle, FamilyColor.wally.tint, .chores, badge: choreApprovals)
                    tile("🎯", "Goals", hub.goalsSubtitle, Color(hex: 0xE8F0E4), .goals)
                    tile("⭐", "Rewards", hub.rewardsSubtitle, Color(hex: 0xFDF0D6), .rewards, badge: rewardApprovals)
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
        .refreshable { await hub.load(); await approvals.load() }
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
        case "display": return .settingsDisplay
        default: return nil
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

    private func tile(_ emoji: String, _ name: String, _ sub: String, _ accent: Color, _ route: HubRoute, badge: Int = 0) -> some View {
        NavigationLink(value: route) {
            NookCard(padding: 15) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top) {
                        Text(emoji).font(.system(size: 21))
                            .frame(width: 42, height: 42)
                            .background(accent)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(alignment: .topTrailing) {
                                if badge > 0 { tileBadge(badge).offset(x: 7, y: -7) }
                            }
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(NK.ink3)
                    }
                    Text(name).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink).padding(.top, 11)
                    Text(badge > 0 ? approvalSub(badge) : sub)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(badge > 0 ? NK.gold : NK.ink3).padding(.top, 2)
                }
            }
        }
        .buttonStyle(.plain)
    }

    /// "N to approve" overrides the tile's usual summary when something's waiting, so
    /// the trail from the tab badge reads all the way down.
    private func approvalSub(_ n: Int) -> String { n == 1 ? "1 to approve" : "\(n) to approve" }

    private func tileBadge(_ n: Int) -> some View {
        Text(n > 9 ? "9+" : "\(n)")
            .font(.system(size: 11, weight: .heavy)).foregroundStyle(.white)
            .padding(.horizontal, n > 9 ? 4 : 5).padding(.vertical, 1.5)
            .background(Capsule().fill(NK.gold))
            .overlay(Capsule().stroke(NK.card, lineWidth: 1.5))
            .fixedSize()
    }
}

#Preview { FamilyView(path: .constant([]), approvals: ApprovalsModel()).environment(SyncManager()) }
