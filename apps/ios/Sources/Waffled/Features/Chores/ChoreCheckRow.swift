import SwiftUI

/// A tickable chore line: tick, title, reward. Shared by the person spotlight and the
/// iPhone Today chores card. The Chores screen keeps its richer row (streaks, due labels,
/// approvals) but draws the same `ChoreTick`.
struct ChoreCheckRow: View {
    @Environment(SyncManager.self) private var sync
    let chore: WaffledAPI.ChoreInstanceDTO
    /// Side padding: 14 inside a bare list, 0 when the row already sits in a padded card.
    var inset: CGFloat = 14
    let onTap: () -> Void

    var body: some View {
        let done = chore.status == "done"
        let awaiting = chore.status == "awaiting"
        Button(action: onTap) {
            HStack(spacing: 12) {
                ChoreTick(isDone: done, isAwaiting: awaiting, needsPhoto: chore.requiresPhoto && !done && !awaiting)
                Text("\(chore.emoji.map { "\($0) " } ?? "")\(chore.choreTitle)")
                    .font(.system(size: 15, weight: .semibold))
                    .strikethrough(done, color: WF.ink3)
                    .foregroundStyle(done ? WF.ink3 : WF.ink).lineLimit(1)
                Spacer(minLength: 8)
                if chore.rewardAmount > 0 {
                    HStack(spacing: 2) {
                        Text(sync.currencySymbol(chore.rewardCurrency)).font(.system(size: 11))
                        Text("\(chore.rewardAmount)").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                    }
                }
            }
            .padding(.horizontal, inset).padding(.vertical, 9).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The chore check circle: done, waiting on a parent's OK, needs a photo to finish, up for
/// grabs, or open.
struct ChoreTick: View {
    var isDone: Bool
    var isAwaiting: Bool
    var isGrabs = false
    var needsPhoto = false

    var body: some View {
        Group {
            if isAwaiting {
                Text("⏳").font(.system(size: 16)).frame(width: 26, height: 26)
            } else if isDone {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 22)).foregroundStyle(FamilyColor.person3.solid)
            } else if needsPhoto && !isGrabs {
                Image(systemName: "camera.circle").font(.system(size: 22)).foregroundStyle(WF.primary)
            } else {
                Image(systemName: isGrabs ? "hand.raised.circle" : "circle").font(.system(size: 22))
                    .foregroundStyle(isGrabs ? WF.gold : WF.ink3)
            }
        }
        .frame(width: 30, height: 30).contentShape(Rectangle())
    }
}
