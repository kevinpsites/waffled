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

    private let cols = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
    ]

    /// The overflow destinations that are currently reachable (module-gated). Photos is
    /// core and always shown; the rest follow their module toggle — mirrors the rail's
    /// `moduleEnabled` in `KioskShell`.
    private func enabled(_ nav: KioskNav) -> Bool {
        switch nav {
        case .tasks: return sync.module(.chores)
        case .rewards: return sync.rewardsOn
        case .goals: return sync.module(.goals)
        case .lists: return sync.module(.lists)
        case .pantry: return sync.module(.pantry)
        default: return true   // .photos
        }
    }

    private var visible: [KioskNav] { KioskShell.moreDestinations.filter(enabled) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                KioskPageHeader("More", "Everything else in your Nook.")
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
        .background(NK.canvas)
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
                            .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink3)
                    }
                    Text(d.title).font(NK.serif(22)).foregroundStyle(NK.ink).padding(.top, 16)
                    Text(d.subtitle)
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
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
        default:       return ("•", nav.label, "", NK.panel)
        }
    }
}

#Preview {
    KioskMoreView()
        .environment(SyncManager())
        .previewInterfaceOrientation(.landscapeLeft)
}
