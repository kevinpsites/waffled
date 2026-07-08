import SwiftUI

/// The iPad rail's "More" hub — a launcher grid for the overflow destinations that no
/// longer live directly on the (deliberately short) nav rail: Chores, Rewards, Goals,
/// Lists, Pantry, Photos. It's the wall-display twin of the phone's Family tile grid
/// (`FamilyView`), scaled up with `KioskCard`. Each tile is module-gated with the same
/// logic as the rail, and tapping one switches the shell's rail selection to that page
/// (via `navigate`) — so More is purely a jumping-off point, not its own nav stack.
struct KioskMoreView: View {
    @Environment(SyncManager.self) private var sync

    /// Switch the shell's nav rail to the tapped destination (injected by `KioskShell`).
    var navigate: (KioskNav) -> Void = { _ in }

    /// The per-device rail pins — More shows every choosable destination that is NOT
    /// pinned to the rail, so it updates live as the picker (Display & Kiosk) changes.
    @AppStorage(KioskRail.storageKey) private var railItemsRaw = KioskRail.defaultRaw

    private let cols = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
    ]

    /// The overflow destinations: enabled, choosable, and not currently pinned to the
    /// rail — see `KioskRail.overflow`.
    private var visible: [KioskNav] { KioskRail.overflow(raw: railItemsRaw, sync: sync) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                KioskPageHeader("More", "Everything else in your Waffled.")
                    .padding(.bottom, 22)

                LazyVGrid(columns: cols, spacing: 16) {
                    ForEach(visible) { tile($0) }
                }
            }
            .padding(.horizontal, 40)
            .padding(.top, 28)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WF.canvas)
    }

    private func tile(_ nav: KioskNav) -> some View {
        let d = descriptor(nav)
        return Button { navigate(nav) } label: {
            KioskCard {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top) {
                        Text(d.emoji).font(.system(size: 30))
                            .frame(width: 60, height: 60)
                            .background(d.accent)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    Text(d.title).font(WF.serif(22)).foregroundStyle(WF.ink).padding(.top, 16)
                    Text(d.subtitle)
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                        .padding(.top, 3)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func descriptor(_ nav: KioskNav) -> (emoji: String, title: String, subtitle: String, accent: Color) {
        switch nav {
        case .tasks:   return ("✅", "Chores", "Who's doing what today", FamilyColor.wally.tint)
        case .rewards: return ("⭐", "Rewards", "Stars, jars & redemptions", Color(hex: 0xFDF0D6))
        case .goals:   return ("🎯", "Goals", "What the family's working toward", Color(hex: 0xE8F0E4))
        case .lists:   return ("📋", "Lists", "Groceries, packing & to-dos", FamilyColor.kevin.tint)
        case .pantry:  return ("🥫", "Pantry", "What's on hand", Color(hex: 0xF3E8D6))
        case .photos:  return ("📷", "Photos", "The family album", Color(hex: 0xDFF0EF))
        case .meals:   return ("🍽️", "Meals", "This week's plan & recipes", Color(hex: 0xF6E7DE))
        case .family:  return ("👪", "Family", "People, spotlights & more", Color(hex: 0xEDE7F3))
        default:       return ("•", nav.label, "", WF.panel)
        }
    }
}

#Preview(traits: .landscapeLeft) {
    KioskMoreView()
        .environment(SyncManager())
}
