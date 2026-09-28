import SwiftUI

// Weekly Planning — PARK A NOTE FROM ANY STEP, opened from the session footer's pin. The shell's
// copy of Horizon's bar with the same forward-only tags (`PlanningModel.parkTags`). Ported
// alongside `apps/web/src/kiosk/planning/ParkNoteComposer.tsx`.

struct PlanningParkNoteSheet: View {
    let tags: [PlanningParkedTag]
    /// The model's refusal line; a failed park leaves the sheet open on what was typed.
    var errorMessage: String?
    let onPark: (_ note: String, _ stepKey: String?) async -> Bool
    let onClose: () -> Void

    @State private var text = ""
    @State private var tag: String?
    @State private var saving = false
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var says: String {
        if let label = tags.first(where: { $0.stepKey == tag })?.label {
            return "Comes back at \(label), later in this session."
        }
        return "No step will raise it. It waits in the recap and at next week’s Loose ends."
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("We’re going camping, we need to pack", text: $text, axis: .vertical)
                        .font(.system(size: 15, weight: .semibold))
                        .focused($focused)
                        .lineLimit(1...4)
                        .disabled(saving)
                        // The server's own cap (`parkItem`'s MAX_NOTE).
                        .onChange(of: text) { _, next in
                            if next.count > 500 { text = String(next.prefix(500)) }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .wfField()
                        .accessibilityLabel("The note")

                    ChipFlow(spacing: 6, lineSpacing: 6) {
                        ForEach(tags) { t in
                            PlanningTagChip(label: t.label, selected: tag == t.stepKey, disabled: saving) {
                                tag = t.stepKey
                            }
                        }
                        PlanningTagChip(label: "No tag", selected: tag == nil, disabled: saving) { tag = nil }
                    }
                    .accessibilityLabel("Which step should look at this?")

                    Text(says)
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                        .fixedSize(horizontal: false, vertical: true)

                    if let errorMessage, !errorMessage.isEmpty {
                        Text(errorMessage)
                            .font(.system(size: 12)).foregroundStyle(WF.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    WaffledPillButton(
                        label: "Park it", filled: true,
                        disabled: saving || trimmed.isEmpty, working: saving, action: park)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Park a note").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onClose() }.disabled(saving)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { focused = true }
    }

    private func park() {
        guard !saving, !trimmed.isEmpty else { return }
        saving = true
        Task {
            let took = await onPark(trimmed, tag)
            saving = false
            if took { onClose() }
        }
    }
}
