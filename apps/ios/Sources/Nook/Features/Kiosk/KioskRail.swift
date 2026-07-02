import SwiftUI

/// Per-device customization for the iPad nav rail (`KioskShell`) and its "More" hub
/// (`KioskMoreView`). The user pins **up to 5** destinations between the always-on
/// Today/Calendar (top) and the always-pinned More + Settings (bottom); everything
/// choosable-but-unpinned falls into the "More" grid.
///
/// Storage is **per device** via `@AppStorage("nook.kioskRailItems")` — a comma-joined
/// list of `KioskNav` rawValues — matching the other per-display prefs in
/// `KioskDashboard` (`nook.kioskDashLayout`, `nook.kioskGoalId`). Because it's a plain
/// UserDefaults string, any view that reads the same `@AppStorage` key re-renders when
/// the picker mutates it, so the rail and More grid update live.
enum KioskRail {
    /// The UserDefaults key for the ordered, comma-joined pinned rawValues.
    static let storageKey = "nook.kioskRailItems"

    /// Max user-pinned items (on top of the always-pinned Today/Calendar/More/Settings).
    static let maxItems = 5

    /// The destinations the user may pin — the rail/More universe minus the fixed
    /// Today/Calendar (always top) and More/Settings (always bottom). familyNight is
    /// intentionally absent: it has no standalone iPad page, only a Today card.
    static let choosable: [KioskNav] = [.meals, .tasks, .rewards, .goals, .lists, .pantry, .family, .photos]

    /// The out-of-the-box rail so a fresh install looks like the old fixed rail
    /// (`[.today, .calendar, .meals, .family, .more]`): Meals + Family pinned.
    static let defaultItems: [KioskNav] = [.meals, .family]

    /// The stored raw string's default (comma-joined rawValues).
    static var defaultRaw: String { defaultItems.map(\.rawValue).joined(separator: ",") }

    /// Parse a stored comma-joined string into a valid, de-duped, capped list of
    /// choosable items (drops anything unknown / not choosable / beyond the cap).
    static func parse(_ raw: String) -> [KioskNav] {
        var seen = Set<KioskNav>()
        var out: [KioskNav] = []
        for token in raw.split(separator: ",") {
            guard let nav = KioskNav(rawValue: token.trimmingCharacters(in: .whitespaces)),
                  choosable.contains(nav), !seen.contains(nav) else { continue }
            seen.insert(nav)
            out.append(nav)
            if out.count >= maxItems { break }
        }
        return out
    }

    /// Serialize a list of pinned items back into the stored comma-joined string.
    static func serialize(_ items: [KioskNav]) -> String {
        items.map(\.rawValue).joined(separator: ",")
    }

    /// Whether an optional module is enabled for a nav destination (Today/Calendar/
    /// Family/Photos/More/Settings are core and never gated). Shared by the rail, the
    /// More grid, and the picker so they all agree on what's reachable.
    @MainActor
    static func moduleEnabled(_ nav: KioskNav, sync: SyncManager) -> Bool {
        switch nav {
        case .tasks: return sync.module(.chores)
        case .rewards: return sync.rewardsOn
        case .goals: return sync.module(.goals)
        case .meals: return sync.module(.meals)
        case .lists: return sync.module(.lists)
        case .pantry: return sync.module(.pantry)
        default: return true
        }
    }

    /// The user-pinned destinations to show on the rail (between Today/Calendar and
    /// More), filtered to enabled modules. Disabling a pinned item's module simply
    /// drops it here without touching storage.
    @MainActor
    static func pinned(raw: String, sync: SyncManager) -> [KioskNav] {
        parse(raw).filter { moduleEnabled($0, sync: sync) }
    }

    /// The overflow destinations for the "More" grid: every enabled choosable
    /// destination that is NOT currently pinned to the rail. So pinning Goals removes
    /// it from More; unpinning drops it back in.
    @MainActor
    static func overflow(raw: String, sync: SyncManager) -> [KioskNav] {
        let pinnedSet = Set(parse(raw))
        return choosable.filter { !pinnedSet.contains($0) && moduleEnabled($0, sync: sync) }
    }
}

/// The Display & Kiosk picker for the iPad rail: check which destinations pin to the
/// rail (up to `KioskRail.maxItems`), drag to reorder the pinned ones. Writes back to
/// `@AppStorage(KioskRail.storageKey)`, so the live rail + More grid update at once.
struct KioskRailPickerCard: View {
    @Environment(SyncManager.self) private var sync
    @AppStorage(KioskRail.storageKey) private var railItemsRaw = KioskRail.defaultRaw

    /// The current pins, in stored order (module-gated dropped items are simply not shown).
    private var pinned: [KioskNav] { KioskRail.parse(railItemsRaw) }

    /// The choosable destinations whose module is enabled — the rows we render.
    private var rows: [KioskNav] {
        KioskRail.choosable.filter { KioskRail.moduleEnabled($0, sync: sync) }
    }

    /// Pinned items in order first, then the rest (so reorder targets the pinned block).
    private var ordered: [KioskNav] {
        let pins = pinned.filter(rows.contains)
        let rest = rows.filter { !pins.contains($0) }
        return pins + rest
    }

    private var pinnedCount: Int { pinned.filter(rows.contains).count }
    private var atCap: Bool { pinnedCount >= KioskRail.maxItems }

    var body: some View {
        NookCard(padding: 0) {
            VStack(spacing: 0) {
                header
                Rectangle().fill(NK.hair).frame(height: 1)
                if rows.isEmpty {
                    Text("No optional pages are enabled. Turn on modules in Settings → Modules to pin them here.")
                        .font(.system(size: 13)).foregroundStyle(NK.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                } else {
                    // Fixed-height, scroll-disabled List so drag-to-reorder works while
                    // living inside the settings ScrollView.
                    List {
                        ForEach(ordered) { row($0) }
                            .onMove(perform: move)
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .scrollDisabled(true)
                    .environment(\.editMode, .constant(.active))
                    .frame(height: CGFloat(ordered.count) * 56 + 6)
                }
            }
        }
    }

    private var header: some View {
        HStack {
            Text("On the rail").font(.system(size: 13, weight: .heavy))
                .tracking(0.4).foregroundStyle(NK.ink2)
            Spacer()
            Text("\(pinnedCount) of \(KioskRail.maxItems)")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(atCap ? NK.primary : NK.ink3)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private func row(_ nav: KioskNav) -> some View {
        let isPinned = pinned.contains(nav)
        // A pinned item can always be unpinned; an unpinned one only when below the cap.
        let selectable = isPinned || !atCap
        return Button {
            toggle(nav)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: nav.icon).font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(isPinned ? NK.primary : NK.ink3).frame(width: 26)
                Text(nav.label).font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(selectable ? NK.ink : NK.ink3)
                Spacer()
                Image(systemName: isPinned ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(isPinned ? NK.primary : NK.hair)
            }
            .contentShape(Rectangle())
            .opacity(selectable ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(!selectable)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(NK.hair)
        .moveDisabled(!isPinned)
    }

    private func toggle(_ nav: KioskNav) {
        var pins = pinned.filter(rows.contains)
        if let i = pins.firstIndex(of: nav) {
            pins.remove(at: i)
        } else if pins.count < KioskRail.maxItems {
            pins.append(nav)
        }
        railItemsRaw = KioskRail.serialize(pins)
    }

    /// Reorder within the pinned block. `ordered` is pins + unpinned rest, so only
    /// moves that stay inside the pinned prefix change the stored order.
    private func move(from source: IndexSet, to destination: Int) {
        var pins = pinned.filter(rows.contains)
        let count = pins.count
        // Clamp the drop so an item never lands past the pinned block.
        guard let first = source.first, first < count else { return }
        let dest = min(destination, count)
        pins.move(fromOffsets: source, toOffset: dest)
        railItemsRaw = KioskRail.serialize(pins)
    }
}
