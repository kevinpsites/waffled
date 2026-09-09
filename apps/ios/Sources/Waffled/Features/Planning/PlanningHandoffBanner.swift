import SwiftUI

/// EVERYTHING SOMEBODY SENT TO THIS STEP, in one box at the top of it.
///
/// THE SHELL OWNS THIS, NOT THE TEN STEPS — the box is identical everywhere, the shell already
/// refetches after every write, and each step's own affordances are what act on what is in it.
/// Two GROUPED halves take different answers: parked notes (free text, tagged for a step) and
/// routed loose ends (which carry a verb only — routing wrote nothing, so there is no bookkeeping
/// to answer). See docs/product/weekly-planning-plan.md § "The parked-note handoff…".
///
/// The caller must give this an `.id(step.key)` (the shell does): `hidden` and `made` are per-row
/// local state and a step change has to start them empty.
enum PlanningHandoffWords {
    static func of(_ note: WaffledAPI.PlanningStepHandoff, edited: [String: String]) -> String {
        edited[note.id] ?? note.note
    }
}

struct PlanningHandoffBanner: View {
    let step: WaffledAPI.PlanningStep
    /// EVERY route step 1 wrote this session, not just this step's — the box filters to its own
    /// step. The array lives on the **looseEnds** step's row, so only the shell can pass it across.
    let routes: [WaffledAPI.LooseEndRoute]
    let busy: Bool
    let verb: PlanningHandoffVerb?
    let resolve: (_ id: String, _ action: String) async -> Bool

    var steps: [WaffledAPI.PlanningStep] = []

    ///
    /// RETURNS THE REFUSAL, NOT A BOOL — the reachable failures carry the useful half ("a note
    /// is at most 500 characters"), and nil ⇒ the server took it. NO SESSION ID, deliberately:
    /// `updateParkedItem` repairs every OPEN trail that names the note.
    var update: (_ id: String, _ note: String?, _ stepKey: String??) async -> String? = { id, note, stepKey in
        do {
            _ = try await WaffledAPI().updatePlanningParkedNote(id: id, note: note, stepKey: stepKey)
            return nil
        } catch {
            return APIErrorText.message(for: error, fallback: LooseEndCopy.writeFailed)
        }
    }

    @State private var working: String?
    @State private var editing: String?
    @State private var edited: [String: String] = [:]
    @State private var loadedSteps: [WaffledAPI.PlanningStep] = []
    @State private var editError: String?
    @State private var hidden: Set<String> = []
    @State private var made: Set<String> = []

    /// `?? []` on purpose: a payload missing the field must cost the banner, never the session
    /// screen — the shell is the one view with no error boundary above it.
    private var notes: [WaffledAPI.PlanningStepHandoff] {
        (step.parked ?? []).filter { !hidden.contains($0.id) }
    }

    private func words(_ note: WaffledAPI.PlanningStepHandoff) -> String {
        PlanningHandoffWords.of(note, edited: edited)
    }

    private var tags: [PlanningParkedTag] {
        (steps.isEmpty ? loadedSteps : steps)
            .filter { $0.available && $0.key != "looseEnds" }
            .map { PlanningParkedTag(stepKey: $0.key, label: $0.title) }
    }

    private var sent: [WaffledAPI.LooseEndRoute] {
        PlanningRouteSeed.sentHere(
            to: step.key, in: routes, parked: step.parked, settled: made)
    }

    var body: some View {
        if !notes.isEmpty || !sent.isEmpty { card }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !notes.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    heading("📌", notes.count == 1
                            ? "You parked this for right here"
                            : "You parked \(notes.count) things for right here")
                    ForEach(notes) { note in noteRow(note) }
                }
            }
            if !sent.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    heading("➡️", sent.count == 1
                            ? "You sent this here from loose ends"
                            : "You sent \(sent.count) things here from loose ends")
                    ForEach(sent, id: \.id) { route in sentRow(route) }
                }
            }
        }
        .padding(14)
        .background(WF.gold.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: WF.rLG, style: .continuous)
                .strokeBorder(WF.gold.opacity(0.30), lineWidth: 1))
        .task(id: editing) {
            guard editing != nil, steps.isEmpty, loadedSteps.isEmpty else { return }
            loadedSteps = (try? await WaffledAPI().weeklyPlanning())?.steps ?? []
        }
    }

    private func heading(_ emoji: String, _ text: String) -> some View {
        HStack(spacing: 7) {
            Text(emoji).font(.system(size: 14))
            Text(text)
                .font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - A parked note

    @ViewBuilder private func noteRow(_ note: WaffledAPI.PlanningStepHandoff) -> some View {
        if editing == note.id {
            PlanningParkedNoteEditor(
                note: words(note),
                stepKey: step.key,
                tags: tags,
                busy: busy,
                errorMessage: editError,
                onCancel: {
                    editing = nil
                    editError = nil
                },
                onSave: { text, stepKey in
                    if let refusal = await update(note.id, text, stepKey) {
                        editError = refusal
                        return false
                    }
                    editError = nil
                    if let text { edited[note.id] = text }
                    if case .some(let moved) = stepKey, moved != step.key { hidden.insert(note.id) }
                    return true
                })
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text(words(note))
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let byline = note.byline, !byline.isEmpty {
                    Text(byline).font(.system(size: 11.5)).foregroundStyle(WF.ink3)
                }
                actions(for: note)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func actions(for note: WaffledAPI.PlanningStepHandoff) -> some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            if let verb {
                answerButton(verb.label, tint: WF.primary, filled: true, key: note.id) {
                    // The id is captured HERE rather than in a field, so a second composer
                    // opened before the first reports back cannot settle the wrong note.
                    // THE EDITED WORDS, not the stored ones: `note.note` would discard the
                    // correction at the one moment the note becomes a real thing.
                    verb.run(words(note)) { created in
                        // A CANCELLED composer settles nothing: ticking the note off would
                        // throw away the only record that it still needs doing.
                        guard created else { return }
                        answer(note.id, "done")
                    }
                }
            }
            answerButton(verb == nil ? "Handled" : "Already handled", tint: WF.ink2, filled: false, key: note.id) {
                answer(note.id, "done")
            }
            answerButton("Edit", tint: WF.ink2, filled: false, key: note.id) {
                editError = nil
                editing = note.id
            }
            answerButton("Drop it", tint: WF.danger, filled: false, key: note.id) {
                answer(note.id, "drop")
            }
        }
    }

    // MARK: - A routed loose end

    private func sentRow(_ route: WaffledAPI.LooseEndRoute) -> some View {
        let key = PlanningRouteSeed.key(route)
        return VStack(alignment: .leading, spacing: 8) {
            Text(route.title.isEmpty ? "Something you sent here" : route.title)
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(LooseEndCopy.kindLabel(route.kind))
                .font(.system(size: 11.5)).foregroundStyle(WF.ink3)
            if let verb {
                answerButton(verb.label, tint: WF.primary, filled: true, key: key) {
                    verb.run(route.title) { created in
                        guard created else { return }
                        made.insert(key)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Shared chrome

    private func answerButton(
        _ label: String, tint: Color, filled: Bool,
        key: String, action: @escaping () -> Void
    ) -> some View {
        WaffledPillButton(
            label: label, tint: tint, filled: filled,
            disabled: busy, working: working == key, action: action)
    }

    private func answer(_ id: String, _ action: String) {
        guard working == nil else { return }
        working = id
        Task {
            let took = await resolve(id, action)
            if took { hidden.insert(id) }
            working = nil
        }
    }
}
