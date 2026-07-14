import SwiftUI

/// One agenda row — owner color bar, title, time, owner avatar. Shared by the
/// Today and Calendar surfaces; reads a `SyncedEvent` straight from the mirror.
struct EventRow: View {
    let event: SyncedEvent
    let tz: TimeZone

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 99)
                .fill(Color(hexString: event.colorHex) ?? WF.ink3)
                .frame(width: 4, height: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.title)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    .lineLimit(1)
                Text(timeText).font(.system(size: 12)).foregroundStyle(WF.ink3)
            }
            Spacer(minLength: 8)
            if let emoji = event.emoji {
                Avatar(colorHex: event.colorHex, emoji: emoji, size: 30)
            }
        }
        // Fade events that have already ended — matches the calendar's EventCard.
        .opacity(Agenda.isPast(event, tz) ? 0.5 : 1)
    }

    private var timeText: String {
        if event.allDay { return "All day" }
        if let d = event.startsAt { return EventTime.timeLabel(d, tz) }
        return ""
    }
}
