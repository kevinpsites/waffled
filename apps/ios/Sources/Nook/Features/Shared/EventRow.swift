import SwiftUI

/// One agenda row — owner color bar, title, time, owner avatar. Shared by the
/// Today and Calendar surfaces; reads a `SyncedEvent` straight from the mirror.
struct EventRow: View {
    let event: SyncedEvent
    let tz: TimeZone

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 99)
                .fill(Color(hexString: event.colorHex) ?? NK.ink3)
                .frame(width: 4, height: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(NK.ink)
                    .lineLimit(1)
                Text(timeText).font(.system(size: 12)).foregroundStyle(NK.ink3)
            }
            Spacer(minLength: 8)
            if let emoji = event.emoji {
                Avatar(colorHex: event.colorHex, emoji: emoji, size: 30)
            }
        }
    }

    private var timeText: String {
        if event.allDay { return "All day" }
        if let d = event.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }
}
