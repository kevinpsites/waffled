import SwiftUI
import Observation

/// The Lists index — every list in the household (Grocery, packing lists, …). The
/// first built-out hub destination; tapping a list opens its detail.
@MainActor
@Observable
final class ListsIndexModel {
    private(set) var lists: [NookAPI.ListSummary] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = NookAPI()

    func load() async {
        loading = true
        do {
            lists = try await api.listSummaries()
            error = false
        } catch {
            self.error = true
        }
        loading = false
    }
}

struct ListsIndexView: View {
    @Binding var path: [HubRoute]
    @State private var model = ListsIndexModel()
    @State private var deepLinked = false

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                if model.lists.isEmpty && !model.loading {
                    Text(model.error ? "Couldn’t load your lists." : "No lists yet.")
                        .font(.system(size: 14)).foregroundStyle(NK.ink3)
                        .padding(.top, 24)
                }
                ForEach(model.lists) { list in
                    NavigationLink(value: HubRoute.list(list)) { row(list) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 8)
            .padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("Lists")
        .navigationBarTitleDisplayMode(.large)
        .task {
            await model.load()
            deepLinkIfNeeded()
        }
        .refreshable { await model.load() }
    }

    private func row(_ list: NookAPI.ListSummary) -> some View {
        NookCard(padding: 15) {
            HStack(spacing: 13) {
                Text(list.emoji ?? "📝").font(.system(size: 22))
                    .frame(width: 42, height: 42)
                    .background(NK.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text(list.name).font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink)
                Spacer(minLength: 8)
                Text("\(list.itemCount)").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.ink3)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
            }
        }
    }

    /// Headless verification: NOOK_OPEN_LIST=grocery (or a list name) pushes that
    /// list's detail once the index has loaded.
    private func deepLinkIfNeeded() {
        guard !deepLinked, let want = DemoHooks.openList?.lowercased() else { return }
        if let match = model.lists.first(where: {
            $0.listType.lowercased() == want || $0.name.lowercased() == want
        }) {
            deepLinked = true
            path.append(.list(match))
        }
    }
}
