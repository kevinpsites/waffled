import SwiftUI

/// The "Where" chip row shared by the add-by-hand editor and the scan confirm sheet:
/// the household's configured sections plus a "＋ New" chip that creates one right
/// here. You're standing at the freezer holding a bag that belongs somewhere that
/// doesn't exist yet — that shouldn't mean abandoning the add and going to Settings.
///
/// A section created here is appended to the household's pantry config (so it shows in
/// the sidebar too) and kept in local `created` state, because the parent's model won't
/// have reloaded by the time this row re-renders.
struct PantryLocationPicker: View {
    @Binding var selection: String
    let locations: [String]
    /// Called after a section is created so the parent can refresh its config.
    var onLocationsChanged: (() async -> Void)?

    @State private var created: [String] = []
    @State private var adding = false
    @State private var draft = ""
    @State private var saving = false
    @State private var failed = false
    @FocusState private var focused: Bool

    private let api = WaffledAPI()

    /// Configured sections (or the defaults), anything just created here, and the
    /// current selection if it's a stray that's in neither.
    private var choices: [String] {
        var out = locations.isEmpty ? ["Freezer", "Fridge", "Pantry"] : locations
        for c in created where !out.contains(where: { $0.caseInsensitiveCompare(c) == .orderedSame }) { out.append(c) }
        if !out.contains(where: { $0.caseInsensitiveCompare(selection) == .orderedSame }), !selection.isEmpty { out.append(selection) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: "Where")
            if adding { newSectionRow } else { chipRow }
            if failed {
                Text("Couldn’t add that section — try again.")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.danger)
            }
        }
    }

    private var chipRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(choices, id: \.self) { loc in
                    let on = loc.caseInsensitiveCompare(selection) == .orderedSame
                    Button { selection = loc } label: {
                        Text(loc).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(on ? WF.ink : WF.ink2)
                            .padding(.horizontal, 12).padding(.vertical, 7).wfChip(selected: on)
                    }.buttonStyle(.plain)
                }
                Button { failed = false; adding = true } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus").font(.system(size: 11, weight: .bold))
                        Text("New").font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(WF.primary)
                    .padding(.horizontal, 12).padding(.vertical, 7).wfChip(selected: false)
                }.buttonStyle(.plain)
            }
            .padding(.vertical, 1)
        }
    }

    private var newSectionRow: some View {
        HStack(spacing: 8) {
            TextField("New section name", text: $draft)
                .focused($focused)
                // Focus has to be set once the field is actually in the hierarchy —
                // assigning it in the same tap that flips `adding` is dropped, and the
                // row appears without a keyboard.
                .onAppear { focused = true }
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .onSubmit { create() }
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                .padding(.horizontal, 13).padding(.vertical, 10).wfField()
            Button { create() } label: {
                Text(saving ? "…" : "Add").font(.system(size: 13, weight: .bold))
                    .foregroundStyle(WF.onInk)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(WF.ink).clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(saving || draft.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(draft.trimmingCharacters(in: .whitespaces).isEmpty ? 0.45 : 1)
            Button { adding = false; draft = ""; failed = false } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    .frame(width: 32, height: 32).background(WF.panel).clipShape(Circle())
            }.buttonStyle(.plain).disabled(saving)
        }
    }

    private func create() {
        let name = draft.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !saving else { return }
        saving = true
        failed = false
        Task {
            do {
                let next = try await api.pantryAddLocation(name: name)
                let canonical = PantrySections.canonical(name, in: next)
                created.append(canonical)
                selection = canonical
                adding = false
                draft = ""
                await onLocationsChanged?()
            } catch {
                failed = true
            }
            saving = false
        }
    }
}
