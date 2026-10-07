import SwiftUI

/// The Today "Lists" card — pins ONE of the household's custom lists so the
/// hardware run / packing list sits on Today next to everything else.
///
/// Which list is pinned is a per-DEVICE choice (`@AppStorage`), not household config:
/// the kitchen iPad and a phone want different lists up, and the pinned Today goal
/// (`waffled.todayGoalId`) already makes exactly this call. It is also what keeps
/// this card out of the layout enum — the saved layout stores the single key `lists`
/// and the *content* is chosen here, so no `list:<uuid>` key ever has to be validated
/// server-side or reaped when its list is deleted.
///
/// Mirrors the web's `ListCard` (apps/web/src/kiosk/components/ListCard.tsx).
struct TodayListCard: View {
    /// Open the pinned list's full detail.
    var onOpen: (WaffledAPI.ListSummary) -> Void

    @Environment(SyncManager.self) private var sync
    @AppStorage("waffled.todayListPick") private var pick = ""

    @State private var lists: [WaffledAPI.ListSummary] = []
    @State private var items: [WaffledAPI.ListItemDTO] = []
    @State private var loaded = false
    /// The lists fetch failed — "no lists yet" is a claim about the household, so it
    /// must not be made when we simply couldn't ask.
    @State private var failed = false
    /// Ticked locally so the row leaves immediately — the card only ever shows
    /// unfinished items, so there is nothing to strike through and wait on.
    @State private var done: Set<String> = []

    /// The grocery board has its own Today card; offering it here too would be two
    /// cards fighting over one list. Templates aren't lists you shop from.
    private var pickable: [WaffledAPI.ListSummary] {
        lists.filter { $0.listType != "grocery" && $0.listType != "template" }
    }

    /// A pinned list that has since been deleted must not leave the card blank and
    /// stuck, so an unknown pick falls back to whatever the household still has.
    private var active: WaffledAPI.ListSummary? {
        pickable.first { $0.id == pick } ?? pickable.first
    }

    private var open: [WaffledAPI.ListItemDTO] {
        items.filter { !$0.checked && !done.contains($0.id) }
    }

    var body: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 10) {
                header
                content
            }
        }
        // Keyed on the refresh signal, not a bare `.task`: SwiftUI runs a bare one
        // once per appearance, so this card sat on launch-time data through every
        // pull-to-refresh. See SyncManager.refreshRev.
        .task(id: sync.refreshRev) { await load() }
        .onChange(of: sync.listsRev) { _, _ in Task { await load() } }
        .onChange(of: pick) { _, _ in Task { await loadItems() } }
    }

    @ViewBuilder private var header: some View {
        HStack(spacing: 8) {
            Button {
                if let active { onOpen(active) }
            } label: {
                HStack(spacing: 6) {
                    Text(active.map { "\($0.emoji ?? "📝") \($0.name)" } ?? "Lists")
                        .font(WF.serif(17, .semibold)).foregroundStyle(WF.ink)
                        .lineLimit(1)
                    if active != nil {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(active == nil)

            Spacer(minLength: 8)

            // Only worth a switcher when there's something to switch to.
            if pickable.count > 1 {
                Menu {
                    ForEach(pickable) { l in
                        Button {
                            pick = l.id
                        } label: {
                            Label("\(l.emoji ?? "📝") \(l.name)", systemImage: l.id == active?.id ? "checkmark" : "")
                        }
                    }
                } label: {
                    Image(systemName: "arrow.left.arrow.right.circle")
                        .font(.system(size: 17)).foregroundStyle(WF.ink2)
                }
                .accessibilityLabel("Which list")
            }
        }
    }

    @ViewBuilder private var content: some View {
        if pickable.isEmpty {
            Text(!loaded ? "Loading…"
                 : failed ? "Couldn't load your lists — pull to refresh or sign in again."
                 : "No lists yet — make one in Lists and it'll show up here.")
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
        } else if open.isEmpty {
            Text(loaded ? "All done here. 🎉" : "Loading…")
                .font(.system(size: 13)).foregroundStyle(WF.ink3)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(open) { item in
                    Button { check(item) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "circle")
                                .font(.system(size: 17)).foregroundStyle(WF.ink3)
                            Text(item.quantity.map { "\(item.name) (\($0))" } ?? item.name)
                                .font(.system(size: 14, weight: .medium)).foregroundStyle(WF.ink)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func check(_ item: WaffledAPI.ListItemDTO) {
        done.insert(item.id)
        Task {
            do {
                try await WaffledAPI().patchListItem(id: item.id, checked: true)
                sync.bumpLists()
            } catch {
                done.remove(item.id) // put it back — the tick didn't take
            }
        }
    }

    private func load() async {
        if let fetched = try? await WaffledAPI().listSummaries() {
            lists = fetched
            failed = false
        } else {
            failed = true
        }
        await loadItems()
        loaded = true
    }

    private func loadItems() async {
        guard let active else { items = []; return }
        done = []
        items = (try? await WaffledAPI().listItems(listId: active.id)) ?? []
    }
}
