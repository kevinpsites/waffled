import SwiftUI

/// Log a completion for a day that has already passed.
///
/// The completion shape's whole premise is that the clock restarts from when you
/// **actually** did it — that's what makes being late shift the next one instead of
/// stacking misses. But every control said "today", so the one thing the shape exists to
/// record was the one thing it couldn't be told. Logging Tuesday's filter change on Friday
/// silently re-anchored the next three months to Friday, and "the filter last changed on…",
/// the single fact the register is kept for, quietly became a guess.
///
/// Deliberately one field. The rhythm supplies everything else, and this is a correction,
/// not a history editor — there is no editing or deleting of past completions here.
struct BackdateCompletionSheet: View {
    let rhythm: WaffledAPI.Rhythm
    let model: RhythmsModel

    @Environment(\.dismiss) private var dismiss
    @State private var when = Date()
    @State private var saving = false
    @State private var error: String?

    /// Never later than today. A rhythm records what happened, so "I'll have done this by
    /// Christmas" isn't a claim it can take — the clock would restart from a date that
    /// hasn't arrived and the next due date would be wrong in the same direction.
    private var latest: Date { Date() }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        RhythmGlyph(rhythm)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rhythm.title).font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                            Text("The clock restarts from the day you actually did it, \(RhythmFormat.cadenceLabel(rhythm.every)).")
                                .font(.system(size: 13)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    WaffledFieldCard(title: "When did you do it?") {
                        DatePicker("When did you do it?", selection: $when, in: ...latest,
                                   displayedComponents: [.date])
                            .datePickerStyle(.compact)
                            .labelsHidden()
                    }

                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    WaffledPrimaryCTA(label: "Log it", isBusy: saving) {
                        Task { await save() }
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("Log a completion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        error = nil
        do {
            // Midday, not midnight: a date picked as local midnight can cross back over the
            // previous day once it's an instant, filing the completion under the wrong date.
            let noon = Cal.current.date(bySettingHour: 12, minute: 0, second: 0, of: when) ?? when
            try await model.markDone(rhythm.id, on: min(noon, Date()))
            dismiss()
        } catch {
            self.error = APIErrorText.message(for: error, fallback: "Couldn’t log that — try again.")
            saving = false
        }
    }
}
