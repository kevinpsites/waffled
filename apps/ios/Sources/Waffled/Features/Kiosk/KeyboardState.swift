import SwiftUI
import UIKit

/// The REAL on-screen keyboard overlap, tracked from UIKit's
/// `keyboardWillChangeFrame` end-frames and converted into the app window's
/// coordinate space (so Split View / Slide Over / Stage Manager windows measure
/// against their own bounds, not the physical screen).
///
/// Why it exists: on iPad in landscape, the keyboard safe-area inset SwiftUI's
/// automatic avoidance applies is ~170pt SHORT of the docked keyboard's true height
/// (the accessory + predictive rows go uncounted), so bottom-pinned chrome — the
/// grocery list's "Add item" bar — landed under the keys and "disappeared" while
/// typing. The kiosk lists page instead lifts its add bar by the measured shortfall:
/// see `ListDetailView.kioskBody` (render-time `.offset` by `barShift`, plus a
/// matching List content margin so the last rows stay scrollable). Any future
/// bottom-pinned input on a kiosk surface can reuse this the same way.
@Observable @MainActor final class KeyboardState {
    static let shared = KeyboardState()

    /// Points of the app window's height the docked keyboard currently covers
    /// (0 = hidden or floating).
    private(set) var overlap: CGFloat = 0
    /// The docked keyboard's top edge in the window's coordinate space — the same
    /// space as SwiftUI's `.global` frames — or nil when it isn't covering anything.
    private(set) var topInWindow: CGFloat? = nil

    /// How much of `container` (the app window's bounds) the keyboard's end-frame
    /// covers, measured from the keyboard's top edge. A frame narrower than the
    /// container is the iPad floating mini keyboard (or a split half) hovering over
    /// content — it doesn't dock, so it must not push the layout up. A docked
    /// keyboard always spans at least the window's width (in Split View it converts
    /// wider, since it spans the whole screen).
    nonisolated static func overlap(container: CGRect, keyboard: CGRect) -> CGFloat {
        guard keyboard.width >= container.width else { return 0 }
        return max(0, container.maxY - keyboard.minY)
    }

    /// How far a bottom-pinned bar whose (unshifted) bottom edge sits at
    /// `columnBottom` must ride up to clear a keyboard whose top edge is at
    /// `keyboardTop` — both in window coordinates. 0 when there's no keyboard, the
    /// column hasn't been measured yet, or the system's own avoidance already put
    /// the bar above the keys (the fix self-corrects wherever iPadOS gets it right).
    nonisolated static func barShift(columnBottom: CGFloat, keyboardTop: CGFloat?) -> CGFloat {
        guard let keyboardTop, columnBottom > 0 else { return 0 }
        return max(0, columnBottom - keyboardTop)
    }

    private init() {
        // Headless verification: WAFFLED_FAKE_KB_TOP=<windowY> pretends a docked
        // keyboard's top edge sits at that window-space Y, so landscape lift behavior
        // can be screenshot without the Simulator's flaky programmatic focus.
        if let fake = AppConfig.env("WAFFLED_FAKE_KB_TOP").flatMap(Double.init) {
            topInWindow = CGFloat(fake)
        }
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification,
                       object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated { self?.update(from: note) }
        }
        nc.addObserver(forName: UIResponder.keyboardWillHideNotification,
                       object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.set(overlap: 0, top: nil, duration: 0.25) }
        }
    }

    private func update(from note: Notification) {
        guard let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let window = UIApplication.shared.connectedScenes
                  .compactMap({ $0 as? UIWindowScene })
                  .flatMap(\.windows)
                  .first(where: \.isKeyWindow)
        else { return }
        // The notification's frame is in screen coordinates; the app window may not
        // cover the screen (Split View / Stage Manager), so convert before comparing.
        let inWindow = window.coordinateSpace.convert(end, from: window.screen.coordinateSpace)
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let new = Self.overlap(container: window.bounds, keyboard: inWindow)
        set(overlap: new, top: new > 0 ? window.bounds.maxY - new : nil, duration: duration)
    }

    private func set(overlap new: CGFloat, top: CGFloat?, duration: Double) {
        guard new != overlap || top != topInWindow else { return }
        withAnimation(.easeOut(duration: max(0.1, duration))) {
            overlap = new
            topInWindow = top
        }
    }
}
