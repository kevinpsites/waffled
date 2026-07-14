import SwiftUI

/// Shared horizontal-flick → step direction for the date steppers (Chores day list,
/// Calendar month/day grid, kiosk calendar). These were verbatim copies of the same tuned
/// thresholds and forward/back logic in three places and would drift; keep them here.
enum HorizontalSwipe {
    /// Maps a drag to a step: `+1` for a forward flick (swipe **left** = next), `-1` for
    /// back (swipe **right** = previous), or `nil` when the flick is too small or too
    /// vertical to count (so it doesn't fight a vertical ScrollView).
    static func step(_ value: DragGesture.Value) -> Int? {
        let dx = value.translation.width, dy = value.translation.height
        guard abs(dx) > 50, abs(dx) > abs(dy) * 1.5 else { return nil }
        return dx < 0 ? 1 : -1
    }
}
