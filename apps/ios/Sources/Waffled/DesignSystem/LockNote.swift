import SwiftUI

/// A quiet lock-icon note on a panel fill — "here's why there's nothing to press".
///
/// Used wherever Waffled has to explain that something is read-only (a subscribed
/// feed's events, the feed editor's warning). The wording differs per site; the
/// chrome shouldn't, so it lives here rather than being re-spelled each time.
struct LockNote: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "lock").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            Text(text)
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
    }
}

/// The one explanation for a subscribed-feed event, shown anywhere the app would
/// otherwise offer Edit or Delete. Naming the source is the useful part: the fix is
/// to change it where it comes from, or to drop the feed.
extension LockNote {
    static var subscribedFeedEvent: LockNote {
        LockNote("From a subscribed calendar feed — read-only here. Change it in the calendar it comes from, or remove the feed in Settings → Calendars.")
    }
}
