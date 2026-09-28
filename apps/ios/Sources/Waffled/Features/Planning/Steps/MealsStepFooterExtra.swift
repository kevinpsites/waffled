import SwiftUI

/// The Meals step's extra footer control — the one step that contributes one.
///
/// "✨ Plan the rest" becomes "Undo the three" once it has filled the empty nights. It is a
/// separate view from the step body because it renders into the shell's footer, which is
/// why the state they share lives in `PlanningMealsStepStore` rather than either view's
/// `@State`.
///
/// THIS BUTTON WRITES NOTHING: it opens the shared "Plan my week" planner, and the
/// approved week is applied from there through the step's own fill endpoint.
///
/// THE PLANNER IS PRESENTED BY THE BODY, NOT FROM HERE. The shell builds the body and this
/// footer as sibling trees, so a `.sheet` hung off this view would be attached to a control
/// that disappears the moment the fill lands.
struct MealsStepFooterExtra: View {
    let props: PlanningStepProps

    /// The SAME model the body reads, resolved on every body pass. `@Observable`, so this
    /// view invalidates when the fill lands.
    private var model: PlanningMealsModel {
        PlanningMealsStepStore.shared.model(sessionId: props.sessionId, weekStart: props.weekStart)
    }

    var body: some View {
        // NO `.task` HERE: the shell rebuilds its footer on every `busy` change, so a read
        // hung off this view would re-fire through the whole session.
        //
        // WRAPPED IN A GROUP so the modifiers below attach to something that always
        // materialises — a modifier on a viewless branch is not applied at all.
        Group {
            if model.view != nil {
                if model.filled.isEmpty {
                    fillButton
                } else {
                    undoButton
                }
            }
        }
        // THE SHELL'S FOOTER HAS TO KNOW THIS STEP IS WRITING: `props.busy` flows the other
        // way, so without this Skip and the affirmative stay live and can answer the step
        // while the nights are still being written.
        .onChange(of: model.busy) { _, isBusy in props.reportBusy(isBusy) }
        // Withdrawn on the way out, or a step left mid-write leaves the NEXT step's footer
        // cold.
        .onDisappear { props.reportBusy(false) }
    }

    private var fillButton: some View {
        let empties = model.emptyDates.count
        return Button {
            // Raise the planner only; `applyPlan` writes once the family approves a week.
            model.openPlanner()
        } label: {
            HStack(spacing: 5) {
                if model.busy {
                    ProgressView().controlSize(.small).tint(WF.ai)
                } else {
                    Text("✨").font(.system(size: 13))
                }
                // Shorter than the web's "Plan the rest for me": three controls share one
                // phone-width row, and the longer label truncates mid-word.
                Text("Plan the rest")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.aiD)
                    .lineLimit(1).minimumScaleFactor(0.85)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(WF.ai.opacity(0.10)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
        // Nothing to fill is not an error, so the control states it rather than lying.
        .disabled(props.busy || model.busy || empties == 0)
        .opacity(empties == 0 ? 0.5 : 1)
        .accessibilityLabel(
            empties == 0 ? "Every night is planned" : PlanningMealsText.fillTitle(empties: empties))
    }

    private var undoButton: some View {
        Button {
            Task {
                if await model.undoTheFill(weekStart: props.weekStart) { props.refresh() }
            }
        } label: {
            HStack(spacing: 6) {
                if model.busy { ProgressView().controlSize(.small).tint(WF.ink3) }
                Text("Undo the \(PlanningMealsText.countWord(model.filled.count))")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.ink3)
                    .lineLimit(1).minimumScaleFactor(0.85)
            }
        }
        .buttonStyle(.plain)
        .disabled(props.busy || model.busy)
    }
}
