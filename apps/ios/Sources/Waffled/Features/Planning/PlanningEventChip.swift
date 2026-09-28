import SwiftUI

/// One event as a planning step draws it: a coloured time, the title and the owner's bubble, in
/// the calendar's own chip paint (`EventPalette.chip(for:)`), so the household's solid-vs-tinted
/// style applies. Shared by the Calendar step's week and Family night's event picker.
struct PlanningEventChip: View {
    @Environment(SyncManager.self) private var sync
    let event: SyncedEvent

    var body: some View {
        let paint = sync.eventPalette.chip(for: event)
        HStack(spacing: 6) {
            Text(when)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(paint.foreground.opacity(0.8))
            Text(event.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(paint.foreground)
                .lineLimit(1)
            if let emoji = event.emoji {
                Avatar(colorHex: event.colorHex, emoji: emoji, size: 20)
            }
        }
        .padding(.leading, 10).padding(.trailing, event.emoji == nil ? 10 : 4).padding(.vertical, 4)
        // `ChipFlow` measures each chip at its natural width; a long title truncates instead of
        // pushing past the row on a phone.
        .frame(maxWidth: 220, alignment: .leading)
        .background(paint.background)
        .clipShape(Capsule())
    }

    /// "1:00 PM", or a real "All day" label.
    private var when: String {
        if event.allDay { return "All day" }
        guard let start = event.startsAt else { return "" }
        return EventTime.timeLabel(start, sync.householdTz)
    }
}
