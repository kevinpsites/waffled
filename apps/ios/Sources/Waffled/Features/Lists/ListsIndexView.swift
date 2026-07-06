import SwiftUI
import Observation

/// The Lists index — every list in the household (Grocery, packing lists, …). The
/// first built-out hub destination; tapping a list opens its detail.
@MainActor
@Observable
final class ListsIndexModel {
    private(set) var lists: [WaffledAPI.ListSummary] = []
    private(set) var loading = true
    private(set) var error = false

    private let api = WaffledAPI()

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

    /// Create a list and return it (so the caller can open it), reloading the index.
    /// Reloads **regardless** of the create response — the row may have been created
    /// even if decoding the reply hiccuped (so the new list still shows without a
    /// manual pull-to-refresh).
    func create(name: String, emoji: String) async -> WaffledAPI.ListSummary? {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return nil }
        var created: WaffledAPI.ListSummary?
        do { created = try await api.addList(name: n, emoji: emoji.isEmpty ? nil : emoji) }
        catch { self.error = true }
        await load()
        return created
    }

    /// Rename a list / change its emoji, then reload the index.
    func update(_ list: WaffledAPI.ListSummary, name: String, emoji: String) async {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return }
        do { _ = try await api.updateList(id: list.id, name: n, emoji: emoji.isEmpty ? "" : emoji) }
        catch { self.error = true }
        await load()
    }

    /// Optimistic delete; restore on failure.
    func delete(_ list: WaffledAPI.ListSummary) async {
        let snapshot = lists
        withAnimation { lists.removeAll { $0.id == list.id } }
        do { try await api.deleteList(id: list.id) }
        catch { lists = snapshot; self.error = true }
    }

    /// The household's saved templates (for the "Apply template" picker).
    func templates() async -> [WaffledAPI.ListSummary] {
        (try? await api.listTemplates()) ?? []
    }

    /// Apply a template → a fresh custom list (everything unchecked), reloading the
    /// index so the new list shows in the rail. Returns it so the caller can open it.
    func apply(template: WaffledAPI.ListSummary, name: String? = nil) async -> WaffledAPI.ListSummary? {
        let n = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        var created: WaffledAPI.ListSummary?
        do { created = try await api.applyListTemplate(templateId: template.id, name: (n?.isEmpty == false) ? n : nil) }
        catch { self.error = true }
        await load()
        return created
    }

    /// Delete a saved template (a hidden `list_type='template'` list). Optimistic
    /// callers drop it from their local copy; this just fires the soft-delete.
    func deleteTemplate(_ tpl: WaffledAPI.ListSummary) async {
        do { try await api.deleteList(id: tpl.id) } catch { self.error = true }
    }
}

struct ListsIndexView: View {
    @Binding var path: [HubRoute]
    @Environment(SyncManager.self) private var sync
    @State private var model = ListsIndexModel()
    @State private var showCapture = false
    @State private var dictateOnOpen = false
    @State private var creatingList = false
    @State private var editing: WaffledAPI.ListSummary?

    /// Fire the headless deep-link at most once per process — the index view is
    /// recreated when you pop back to it, so a per-view flag would re-fire and trap
    /// you on the detail screen.
    private static var didDeepLink = false

    var body: some View {
        // A List (native swipe → Edit + Delete). The bottom content margin clears the
        // custom floating tab bar so the last list is reachable (it's an overlay, not
        // in the safe area, so the List doesn't inset for it on its own).
        List {
            AICaptureBar(placeholder: "Add milk & eggs to groceries…",
                         onTap: { dictateOnOpen = false; showCapture = true },
                         onMic: { dictateOnOpen = true; showCapture = true })
                .listRowInsets(EdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18))
                .listRowBackground(Color.clear).listRowSeparator(.hidden)

            if !model.lists.isEmpty {
                SectionLabel(text: "Your lists")
                    .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 2, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if model.loading && model.lists.isEmpty {
                WaffledLoading(top: 40)
                    .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 8, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if model.lists.isEmpty {
                WaffledEmptyState(
                    emoji: model.error ? "😕" : "🗒️",
                    title: model.error ? "Couldn’t load your lists" : "No lists yet",
                    message: model.error ? "Pull to refresh to try again." : "Add one with the ＋ button.")
                    .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 8, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(model.lists) { list in
                Button { path.append(.list(list)) } label: { row(list) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 5, leading: 18, bottom: 5, trailing: 18))
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        // Grocery is auto-built (can't be renamed/deleted); everything else
                        // gets Edit + Delete.
                        if list.listType.lowercased() != "grocery" {
                            Button(role: .destructive) { Task { await model.delete(list) } } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button { editing = list } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                            .tint(WF.ai)
                        }
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .contentMargins(.bottom, 100, for: .scrollContent)
        .background(WF.canvas)
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
        .onChange(of: sync.listsRev) { _, _ in Task { await model.load() } }
        .sheet(item: $editing) { list in
            EditListSheet(list: list) { name, emoji in
                Task { await model.update(list, name: name, emoji: emoji) }
            }
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet(autoDictate: dictateOnOpen).presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $creatingList) {
            NewListSheet(
                loadTemplates: { await model.templates() },
                onCreate: { name, emoji in Task { _ = await model.create(name: name, emoji: emoji) } },
                onApply: { tpl, name in Task { _ = await model.apply(template: tpl, name: name) } },
                onDeleteTemplate: { tpl in await model.deleteTemplate(tpl) })
        }
    }

    private func row(_ list: WaffledAPI.ListSummary) -> some View {
        WaffledCard(padding: 15) {
            HStack(spacing: 13) {
                WaffledEmojiTile(emoji: list.emoji ?? "📝")
                Text(list.name).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                Spacer(minLength: 8)
                Text("\(list.itemCount)").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3.opacity(0.55))
            }
        }
    }

    /// Headless verification: WAFFLED_OPEN_LIST=grocery (or a list name) pushes that
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

/// New list — name + optional emoji, with an inline "Or start from a template"
/// picker (mirrors the web New-list modal). You **type a name, optionally pick a
/// template, then tap Create** — a template is a selection, not an immediate action
/// (so no accidental list on every tap). Picking a template pre-fills the name if
/// you haven't typed one; long-press a template to delete it.
struct NewListSheet: View {
    @Environment(\.dismiss) private var dismiss
    let loadTemplates: () async -> [WaffledAPI.ListSummary]
    let onCreate: (String, String) -> Void
    let onApply: (WaffledAPI.ListSummary, String) -> Void
    let onDeleteTemplate: (WaffledAPI.ListSummary) async -> Void

    @State private var name = ""
    @State private var emoji = ""
    @State private var templates: [WaffledAPI.ListSummary] = []
    @State private var selectedTemplateId: String?
    @FocusState private var nameFocused: Bool

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var selectedTemplate: WaffledAPI.ListSummary? { templates.first { $0.id == selectedTemplateId } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "List name")
                            TextField("Camping gear", text: $name)
                                .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.words)
                                .focused($nameFocused)
                                .submitLabel(.done)
                                .padding(.horizontal, 13).padding(.vertical, 12)
                                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                                    .strokeBorder(nameFocused ? WF.primary : WF.hair, lineWidth: nameFocused ? 2 : 1))
                        }
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Emoji")
                            TextField("📝", text: $emoji)
                                .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
                                .frame(width: 60).padding(.vertical, 12)
                                .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                                .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                        }
                    }

                    if !templates.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Or start from a template")
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink3)
                            ChipFlow(spacing: 8, lineSpacing: 8) {
                                ForEach(templates) { tpl in templateChip(tpl) }
                            }
                            Text("Tap to select · long-press to delete")
                                .font(.system(size: 11, weight: .medium)).foregroundStyle(WF.ink3)
                        }
                    }

                    Button {
                        if let tpl = selectedTemplate { onApply(tpl, trimmedName) }
                        else { onCreate(trimmedName, emoji.trimmingCharacters(in: .whitespaces)) }
                        dismiss()
                    } label: {
                        Text(selectedTemplate == nil ? "Create list" : "Create from template")
                            .font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 15)
                            .background(trimmedName.isEmpty ? WF.ink3 : WF.primary)
                            .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(trimmedName.isEmpty)
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("New list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            templates = await loadTemplates()
            // Land in the name field so you can just start typing.
            try? await Task.sleep(for: .milliseconds(300)); nameFocused = true
        }
    }

    private func templateChip(_ tpl: WaffledAPI.ListSummary) -> some View {
        let selected = tpl.id == selectedTemplateId
        return Button {
            if selected {
                selectedTemplateId = nil
            } else {
                selectedTemplateId = tpl.id
                if trimmedName.isEmpty { name = tpl.name }   // pre-fill so you can just hit Create
            }
        } label: {
            HStack(spacing: 8) {
                Text(tpl.emoji ?? "📑").font(.system(size: 15))
                Text(tpl.name).font(.system(size: 15, weight: .bold))
                    .foregroundStyle(selected ? .white : WF.ink).lineLimit(1)
                if selected { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white) }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(selected ? WF.primary : WF.card).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(selected ? Color.clear : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(role: .destructive) {
                if selectedTemplateId == tpl.id { selectedTemplateId = nil }
                withAnimation { templates.removeAll { $0.id == tpl.id } }
                Task { await onDeleteTemplate(tpl) }
            } label: { Label("Delete template", systemImage: "trash") }
        }
    }
}

/// Rename a list / change its emoji (the swipe "Edit" action). PATCHes on Save.
struct EditListSheet: View {
    @Environment(\.dismiss) private var dismiss
    let list: WaffledAPI.ListSummary
    let onSave: (String, String) -> Void
    @State private var name: String
    @State private var emoji: String
    @FocusState private var nameFocused: Bool

    init(list: WaffledAPI.ListSummary, onSave: @escaping (String, String) -> Void) {
        self.list = list; self.onSave = onSave
        _name = State(initialValue: list.name)
        _emoji = State(initialValue: list.emoji ?? "")
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "List name")
                        TextField("List name", text: $name)
                            .font(.system(size: 16, weight: .semibold)).textInputAutocapitalization(.words)
                            .focused($nameFocused).submitLabel(.done)
                            .padding(.horizontal, 13).padding(.vertical, 12)
                            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                                .strokeBorder(nameFocused ? WF.primary : WF.hair, lineWidth: nameFocused ? 2 : 1))
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Emoji")
                        TextField("📝", text: $emoji)
                            .font(.system(size: 16, weight: .semibold)).multilineTextAlignment(.center)
                            .frame(width: 60).padding(.vertical, 12)
                            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                            .onChange(of: emoji) { _, v in if v.count > 2 { emoji = String(v.prefix(2)) } }
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle("Edit list").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(trimmedName, emoji.trimmingCharacters(in: .whitespaces)); dismiss() }
                        .fontWeight(.semibold).disabled(trimmedName.isEmpty)
                }
            }
        }
        .presentationDetents([.height(210), .medium])
        .task { try? await Task.sleep(for: .milliseconds(300)); nameFocused = true }
    }
}
