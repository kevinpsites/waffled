import SwiftUI
import UIKit

/// The REAL on-screen keyboard overlap, tracked from UIKit's
/// `keyboardWillChangeFrame` end-frames.
///
/// The kiosk shell can't use SwiftUI's automatic keyboard avoidance: on iPad in
/// landscape the keyboard safe-area inset it applies is ~170pt SHORT of the docked
/// keyboard's true height (the accessory + predictive rows go uncounted), so
/// bottom-pinned chrome — the grocery list's "Add item" bar — lands under the keys
/// and "disappears" while typing. The shell instead ignores the keyboard safe area
/// and pads its content by this measured overlap (`KioskShell.body`).
@Observable @MainActor final class KeyboardState {
    static let shared = KeyboardState()

    /// Points of screen height the keyboard currently covers (0 = no keyboard).
    private(set) var overlap: CGFloat = 0

    /// How much of `screen` the keyboard's end-frame covers, measured from the
    /// keyboard's top edge. A frame narrower than the screen is the iPad floating
    /// mini keyboard (or a split keyboard half) hovering over content — it doesn't
    /// dock, so it must not push the layout up.
    nonisolated static func overlap(screen: CGRect, keyboard: CGRect) -> CGFloat {
        guard keyboard.width >= screen.width else { return 0 }
        return max(0, screen.maxY - keyboard.minY)
    }

    private init() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification,
                       object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated { self?.update(from: note) }
        }
        nc.addObserver(forName: UIResponder.keyboardWillHideNotification,
                       object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.set(0, duration: 0.25) }
        }
    }

    private func update(from note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else { return }
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        set(Self.overlap(screen: UIScreen.main.bounds, keyboard: end), duration: duration)
    }

    private func set(_ new: CGFloat, duration: Double) {
        guard new != overlap else { return }
        withAnimation(.easeOut(duration: max(0.1, duration))) { overlap = new }
    }
}
