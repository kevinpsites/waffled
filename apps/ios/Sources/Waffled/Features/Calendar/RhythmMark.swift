import SwiftUI

/// The 🔁 marker on a calendar event that belongs to a rhythm.
///
/// A scheduling-shape rhythm books an ordinary calendar event and points it back at
/// itself (`events.rhythm_id`), so there is no rhythm entity to draw — only a marker
/// saying this slot is somebody's rhythm. A glyph before the title, never a badge and
/// never a second chip: the event is still just an event.
///
/// Deliberately NOT follow-through language (no "done", no "on track", no streak).
/// Getting the opportunity onto the calendar IS the outcome, and we never ask whether it
/// happened — that is the line between a rhythm and a goal.
///
/// Mirrors the web's `RhythmMark` (apps/web/src/kiosk/components/RhythmMark.tsx), down
/// to the glyph, so the two platforms read identically.
enum RhythmMark {
    static let glyph = "🔁"

    /// What the glyph means, spelled out. VoiceOver reads the emoji as "repeat button",
    /// which is the *recurrence* meaning we're specifically not claiming — so every
    /// surface that shows the glyph passes a label through instead.
    static let meaning = "part of a rhythm"

    /// The event detail's line, word-for-word the web's. Booking-shaped on purpose:
    /// "keeps a rhythm", never "kept up" or "done" — the slot existing IS the outcome.
    static let detailLine = "This slot keeps a rhythm"

    /// A title with the glyph in front of it.
    ///
    /// Two of the kiosk's chips are a bare `Text` with padding and a background chained
    /// onto it, so there is nowhere to put a sibling view without changing where the
    /// chip's background lands. Those take the glyph in the string; everywhere with a
    /// real `HStack` uses ``RhythmEventMark`` instead.
    static func prefixed(_ title: String, isRhythm: Bool) -> String {
        isRhythm ? "\(glyph) \(title)" : title
    }

    static func accessibilityLabel(_ title: String, isRhythm: Bool) -> String {
        isRhythm ? "\(title), \(meaning)" : title
    }
}

/// The marker as a view, for the surfaces that lay their title out in an `HStack`.
/// Renders nothing at all for an ordinary event.
///
/// Not to be confused with ``RhythmGlyph``, which draws a *rhythm's own* emoji in the
/// register (🗓️ / 🔁 by shape). This marks an EVENT as belonging to one.
struct RhythmEventMark: View {
    let event: SyncedEvent
    /// Month cells and all-day pills run at 11pt; the agenda rows at 15–16pt.
    var size: CGFloat = 12

    var body: some View {
        if event.isRhythm {
            Text(RhythmMark.glyph)
                .font(.system(size: size))
                .accessibilityLabel(RhythmMark.meaning)
        }
    }
}
