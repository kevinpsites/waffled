import SwiftUI

// Weekly Planning — FIXING A NOTE THAT IS ALREADY PARKED: its words and its tag are both fixable
// here, because the only other repair would be to drop the note and type it again, and Drop is
// supposed to mean something rather than be the backspace key.
//
// ONE EDITOR, EVERY SURFACE THAT SHOWS A NOTE — step 3's board and the shell's gold box are two
// shapes of the same edit, so only the hosting row differs. Ported alongside
// `apps/web/src/kiosk/planning/ParkedNoteEditor.tsx`, deliberately the same interaction.

/// One tag a note may be re-addressed to. The label is the STEP CATALOG'S own title, so retitling
/// a step renames every chip at once.
struct PlanningParkedTag: Identifiable, Equatable, Sendable {
    let stepKey: String
    let label: String
    var hint: String? = nil

    var id: String { stepKey }
}

/// A tag chip — the park bar's, and now the editor's. `.buttonStyle(.plain)` plus an explicit
/// foreground, or a chosen chip loses its colours under a finger and reads as unselecting itself.
struct PlanningTagChip: View {
    let label: String
    let selected: Bool
    var hint: String? = nil
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(selected ? WF.aiD : WF.ink2)
                .padding(.horizontal, 11).padding(.vertical, 7)
                .wfChip(selected: selected, tint: WF.ai)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityHint(hint ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct PlanningParkedNoteEditor: View {
    let note: String
    let stepKey: String?
    /// THE TAGS THIS SURFACE OFFERS. Step 3's board hands over the park bar's list; the gold box
    /// every step the household runs, because a correction cannot be narrower than the mistake.
    let tags: [PlanningParkedTag]
    /// A write is in flight in the host — the whole editor disables with it.
    var busy: Bool = false
    /// The refusal to show, owned by the HOST (it holds the model), so a failed save leaves the
    /// editor open on what you typed.
    var errorMessage: String? = nil
    let onCancel: () -> Void
    /// ONLY WHAT MOVED. Both are "absent means leave it alone", and `stepKey` is doubly wrapped
    /// because `.some(nil)` — the real answer "No tag" — must be tellable from "only the words".
    let onSave: (_ note: String?, _ stepKey: String??) async -> Bool

    @State private var text: String = ""
    @State private var tag: String?
    @State private var saving = false
    @State private var started = false
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var disabled: Bool { busy || saving }
    /// Nothing to send is not an error — it is Cancel with extra steps.
    private var unchanged: Bool {
        trimmed == note.trimmingCharacters(in: .whitespacesAndNewlines) && tag == stepKey
    }

    /// The note's CURRENT tag is always a chip, even when this surface's list omits it — a routed
    /// note can carry a tag the park bar never offers.
    private var chips: [PlanningParkedTag] {
        guard let stepKey, !tags.contains(where: { $0.stepKey == stepKey }) else { return tags }
        return tags + [PlanningParkedTag(stepKey: stepKey, label: stepKey)]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("The note", text: $text, axis: .vertical)
                .font(.system(size: 14, weight: .semibold))
                .focused($focused)
                .lineLimit(1...4)
                .disabled(disabled)
                // The server's own cap (`parkItem`'s MAX_NOTE), so a long note is stopped here.
                .onChange(of: text) { _, next in
                    if next.count > 500 { text = String(next.prefix(500)) }
                }
                .padding(.horizontal, 11).padding(.vertical, 9)
                .wfField()
                .accessibilityLabel("Edit this note")

            ChipFlow(spacing: 6, lineSpacing: 6) {
                ForEach(chips) { t in
                    PlanningTagChip(
                        label: t.label, selected: tag == t.stepKey, hint: t.hint, disabled: disabled
                    ) { tag = t.stepKey }
                }
                PlanningTagChip(label: "No tag", selected: tag == nil, disabled: disabled) { tag = nil }
            }
            .accessibilityLabel("Which step should look at this?")

            if let errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.system(size: 12)).foregroundStyle(WF.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                WaffledPillButton(
                    label: "Save", filled: true,
                    disabled: disabled || trimmed.isEmpty, working: saving, action: save)
                WaffledPillButton(label: "Cancel", tint: WF.ink2, disabled: saving) {
                    focused = false
                    onCancel()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .wfKeyboardDoneToolbar { focused = false }
        .onAppear {
            // Once. `onAppear` fires again on a parent re-layout, and re-seeding would throw away
            // what somebody has typed since.
            guard !started else { return }
            started = true
            text = note
            tag = stepKey
            focused = true
        }
    }

    private func save() {
        guard !disabled, !trimmed.isEmpty else { return }
        if unchanged {
            focused = false
            onCancel()
            return
        }
        let nextNote = trimmed == note.trimmingCharacters(in: .whitespacesAndNewlines) ? nil : trimmed
        let nextTag: String?? = tag == stepKey ? nil : .some(tag)
        saving = true
        Task {
            let took = await onSave(nextNote, nextTag)
            saving = false
            // A refusal leaves the editor open on what you typed; the host shows the server's line.
            if took {
                focused = false
                onCancel()
            }
        }
    }
}
