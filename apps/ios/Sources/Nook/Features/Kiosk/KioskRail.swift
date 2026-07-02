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

/// The Display & Kiosk picker for the iPad rail. Two sections: **On the rail** — the
/// pinned destinations, every row drag-to-reorder + remove; and **Add to the rail** —
/// the unpinned enabled pages, tap ⊕ to pin (up to `KioskRail.maxItems`). Writes back
/// to `@AppStorage(KioskRail.storageKey)`, so the live rail + More grid update at once.
///
/// Two lists (not one with `moveDisabled`): mixing movable + non-movable rows in a
/// single `List` renders drag handles unreliably when pins change, so the pinned block
/// is its own all-movable list.
struct KioskRailPickerCard: View {
    @Environment(SyncManager.self) private var sync
    @AppStorage(KioskRail.storageKey) private var railItemsRaw = KioskRail.defaultRaw

    /// The pinned destinations in stored order, filtered to enabled modules.
    private var pinned: [KioskNav] {
        KioskRail.parse(railItemsRaw).filter { KioskRail.moduleEnabled($0, sync: sync) }
    }
    /// Enabled choosable pages that aren't pinned — the "add" list.
    private var available: [KioskNav] {
        let pins = Set(pinned)
        return KioskRail.choosable.filter { !pins.contains($0) && KioskRail.moduleEnabled($0, sync: sync) }
    }
    private var atCap: Bool { pinned.count >= KioskRail.maxItems }

    var body: some View {
        VStack(spacing: 14) {
            NookCard(padding: 0) {
                VStack(spacing: 0) {
                    sectionHeader("On the rail", trailing: "\(pinned.count) of \(KioskRail.maxItems)",
                                  tint: atCap ? NK.primary : NK.ink3)
                    Rectangle().fill(NK.hair).frame(height: 1)
                    if pinned.isEmpty {
                        infoRow("Nothing pinned yet — Today and Calendar are always on the rail; add pages below.")
                    } else {
                        // Fixed-height, scroll-disabled List so drag-to-reorder + swipe/
                        // edit-remove work while nested in the settings ScrollView. Every
                        // row is movable, so every row gets a drag handle.
                        List {
                            ForEach(pinned) { pinnedRow($0) }
                                .onMove(perform: move)
                                .onDelete(perform: delete)
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                        .scrollDisabled(true)
                        .environment(\.editMode, .constant(.active))
                        .frame(height: CGFloat(pinned.count) * 56 + 6)
                    }
                }
            }

            if !available.isEmpty {
                NookCard(padding: 0) {
                    VStack(spacing: 0) {
                        sectionHeader("Add to the rail", trailing: atCap ? "Rail full" : nil,
                                      tint: NK.ink3)
                        Rectangle().fill(NK.hair).frame(height: 1)
                        ForEach(Array(available.enumerated()), id: \.element) { idx, nav in
                            if idx > 0 { Rectangle().fill(NK.hair).frame(height: 1).padding(.leading, 54) }
                            availableRow(nav)
                        }
                    }
                }
            } else if pinned.isEmpty {
                Text("No optional pages are enabled. Turn on modules in Settings → Modules to pin them here.")
                    .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func sectionHeader(_ title: String, trailing: String?, tint: Color) -> some View {
        HStack {
            Text(title).font(.system(size: 13, weight: .heavy)).tracking(0.4).foregroundStyle(NK.ink2)
            Spacer()
            if let trailing { Text(trailing).font(.system(size: 13, weight: .bold)).foregroundStyle(tint) }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private func infoRow(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(NK.ink3)
            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
    }

    /// A pinned row — the system supplies the drag handle (edit mode) + swipe/edit remove.
    private func pinnedRow(_ nav: KioskNav) -> some View {
        HStack(spacing: 12) {
            Image(systemName: nav.icon).font(.system(size: 17, weight: .semibold))
                .foregroundStyle(NK.primary).frame(width: 26)
            Text(nav.label).font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
            Spacer()
        }
        .contentShape(Rectangle())
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(NK.hair)
    }

    /// An unpinned row — tap ⊕ (or the row) to pin, disabled at the cap.
    private func availableRow(_ nav: KioskNav) -> some View {
        Button { pin(nav) } label: {
            HStack(spacing: 12) {
                Image(systemName: nav.icon).font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(NK.ink3).frame(width: 26)
                Text(nav.label).font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(atCap ? NK.ink3 : NK.ink)
                Spacer()
                Image(systemName: "plus.circle.fill").font(.system(size: 20))
                    .foregroundStyle(atCap ? NK.hair : NK.primary)
            }
            .contentShape(Rectangle())
            .opacity(atCap ? 0.5 : 1)
            .padding(.horizontal, 16).padding(.vertical, 13)
        }
        .buttonStyle(.plain).disabled(atCap)
    }

    // MARK: mutations (write the pinned order back to @AppStorage)

    private func move(from source: IndexSet, to destination: Int) {
        var pins = pinned
        pins.move(fromOffsets: source, toOffset: destination)
        railItemsRaw = KioskRail.serialize(pins)
    }

    private func delete(at offsets: IndexSet) {
        var pins = pinned
        pins.remove(atOffsets: offsets)
        railItemsRaw = KioskRail.serialize(pins)
    }

    private func pin(_ nav: KioskNav) {
        guard !atCap else { return }
        var pins = pinned
        guard !pins.contains(nav) else { return }
        pins.append(nav)
        railItemsRaw = KioskRail.serialize(pins)
    }
}
