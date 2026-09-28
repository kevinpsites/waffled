import SwiftUI

/// Today card for Weekly Planning — the nudge, and the way back into a half-done week.
///
/// Three states and nothing else: session due (today IS the household's session day with no
/// session for the week ahead), part-planned ("4 of 9 steps decided", what makes a week
/// somebody stepped out of findable from Today), and decided (one quiet line). Everything
/// else is `EmptyView`; it also hides when `showOnToday` is off.
struct PlanningTodayCard: View {
    var kiosk = false
    /// Where tapping goes. The card does not navigate itself: Today and the Family hub host it
    /// in different `NavigationStack`s.
    var onOpen: () -> Void = {}

    @Environment(SyncManager.self) private var sync
    @State private var model = PlanningModel()

    private enum Prompt: Equatable {
        case due            // today is the session day and nothing is started
        case inProgress     // a session is open
        case decided        // the session is saved
        case quiet          // nothing worth a card
    }

    var body: some View {
        Group {
            if prompt == .quiet {
                // A ZERO-SIZE REAL VIEW, NOT `EmptyView`. `prompt` is `.quiet` until the first
                // fetch lands, so this branch is taken on mount — and with `EmptyView` SwiftUI
                // materialises no view, a `.task` has nothing to attach to, and the card needed
                // data to become visible while only loading data once visible. It still takes
                // the stack's spacing, which is why this card is appended LAST on Today.
                Color.clear.frame(width: 0, height: 0)
            } else {
                Button(action: onOpen) {
                    Group {
                        if kiosk { KioskCard { cardBody } } else { WaffledCard(padding: 15) { cardBody } }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        // Keyed on the refresh signal, not a bare `.task` — see SyncManager.refreshRev. It must
        // stay attached in BOTH branches, or a session started elsewhere can't appear.
        .task(id: sync.refreshRev) { await model.load() }
    }

    private var prompt: Prompt {
        // Nothing decided until the first fetch lands: a card that flashed "session due" and
        // then vanished is worse than one that appears a beat late.
        guard let view = model.view, view.config.showOnToday else { return .quiet }
        if let session = view.session {
            return session.isCompleted ? .decided : .inProgress
        }
        return isSessionDayToday(view.config.dayOfWeek) ? .due : .quiet
    }

    /// 0 = Sunday … 6 = Saturday in the HOUSEHOLD's zone, so a device a day ahead of the house
    /// doesn't move the prompt. `Calendar.component(.weekday)` is 1-based from Sunday.
    private func isSessionDayToday(_ dayOfWeek: Int) -> Bool {
        let weekday = Cal.gregorian(sync.householdTz).component(.weekday, from: Date()) - 1
        return weekday == ((dayOfWeek % 7) + 7) % 7
    }

    @ViewBuilder private var cardBody: some View {
        VStack(alignment: .leading, spacing: kiosk ? 10 : 8) {
            HStack(spacing: 8) {
                Text("🗓️ Weekly planning")
                    .font(kiosk ? .system(size: 16, weight: .heavy) : .system(size: 12.5, weight: .bold))
                    .foregroundStyle(kiosk ? WF.ink : WF.ink2)
                Spacer(minLength: 6)
                Text(model.weekLabel)
                    .font(.system(size: kiosk ? 13 : 12)).foregroundStyle(WF.ink3)
                Image(systemName: "chevron.right")
                    .font(.system(size: kiosk ? 13 : 12, weight: kiosk ? .bold : .semibold))
                    .foregroundStyle(WF.ink3)
            }
            Text(headline)
                .font(.system(size: kiosk ? 19 : 15, weight: .bold)).foregroundStyle(WF.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(detail)
                .font(.system(size: kiosk ? 15 : 13)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            if prompt == .inProgress, model.runnable.count > 0 {
                ProgressBar(value: model.progress, tint: WF.primary, track: WF.hair, height: kiosk ? 7 : 5)
                    .padding(.top, 2)
            }
        }
    }

    private var headline: String {
        switch prompt {
        case .due:        return "\(model.sessionDayName)’s session"
        case .inProgress: return "The week is part-planned"
        case .decided:    return "The week is decided"
        case .quiet:      return ""
        }
    }

    private var detail: String {
        let total = model.runnable.count
        switch prompt {
        case .due:
            return "\(total) \(total == 1 ? "step" : "steps"). Jump anywhere, leave whenever the week is decided."
        case .inProgress:
            return "\(model.settledCount) of \(total) steps decided — pick it up whenever."
        case .decided:
            return model.savedAtLabel.map { "Saved \($0)." } ?? "Saved."
        case .quiet:
            return ""
        }
    }
}
