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

    func create(name: String, emoji: String) async {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return }
        do {
            _ = try await api.addList(name: n, emoji: emoji.isEmpty ? nil : emoji)
            await load()
        } catch { self.error = true }
    }
}

struct ListsIndexView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = ListsIndexModel()
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var creatingList = false

    /// Fire the headless deep-link at most once per process — the index view is
    /// recreated when you pop back to it, so a per-view flag would re-fire and trap
    /// you on the detail screen.
    private static var didDeepLink = false

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                AICaptureBar(placeholder: "Add milk & eggs to groceries…",
                             onTap: { dictateOnOpen = false; showCapture = true },
                             onMic: { dictateOnOpen = true; showCapture = true })
                    .padding(.bottom, 4)
                if !model.lists.isEmpty || model.loading {
                    SectionLabel(text: "Your lists").frame(maxWidth: .infinity, alignment: .leading)
                }
                if model.lists.isEmpty && !model.loading {
                    Text(model.error ? "Couldn’t load your lists." : "No lists yet — add one with ＋.")
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
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creatingList = true } label: { Image(systemName: "plus") }
            }
        }
        .task {
            await model.load()
            deepLinkIfNeeded()
        }
        .refreshable { await model.load() }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $creatingList) {
            NewListSheet { name, emoji in Task { await model.create(name: name, emoji: emoji) } }
        }
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
    /// list's detail once per process, after the index has loaded.
    private func deepLinkIfNeeded() {
        guard !Self.didDeepLink, let want = DemoHooks.openList?.lowercased() else { return }
        if let match = model.lists.first(where: {
            $0.listType.lowercased() == want || $0.name.lowercased() == want
        }) {
            Self.didDeepLink = true
            path.append(.list(match))
        }
    }
}

/// New custom list — name + optional emoji. NK-styled.
struct NewListSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreate: (String, String) -> Void
    @State private var name = ""
    @State private var emoji = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "List name")
                        TextField("Camping gear", text: $name)
                            .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.words)
                            .padding(.horizontal, 13).padding(.vertical, 12)
                            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Emoji")
                        TextField("📝", text: $emoji)
                            .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
                            .frame(width: 60).padding(.vertical, 12)
                            .background(NK.card).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                            .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("New list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { onCreate(name, emoji.trimmingCharacters(in: .whitespaces)); dismiss() }
                        .fontWeight(.semibold).disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.height(200), .medium])
    }
}
