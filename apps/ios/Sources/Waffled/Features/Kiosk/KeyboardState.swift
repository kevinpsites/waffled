import SwiftUI
import UIKit

/// The REAL on-screen keyboard overlap, from UIKit's `keyboardWillChangeFrame` end-frames,
/// in the app window's coordinate space (so Split View / Stage Manager measure their own).
///
/// On iPad in landscape the keyboard safe-area inset SwiftUI applies is ~170pt SHORT of the
/// docked keyboard's true height, so bottom-pinned chrome landed under the keys. Surfaces
/// lift by the measured shortfall — see `ListDetailView.kioskBody`.
@Observable @MainActor final class KeyboardState {
    static let shared = KeyboardState()

    /// Points of the window's height the docked keyboard covers (0 = hidden or floating).
    private(set) var overlap: CGFloat = 0
    /// The docked keyboard's top edge in window space — SwiftUI's `.global` space — or nil.
    private(set) var topInWindow: CGFloat? = nil

    /// How much of `container` the end-frame covers. A frame narrower than the container is
    /// the iPad floating mini keyboard: it doesn't dock, so it must not push the layout up.
    nonisolated static func overlap(container: CGRect, keyboard: CGRect) -> CGFloat {
        guard keyboard.width >= container.width else { return 0 }
        return max(0, container.maxY - keyboard.minY)
    }

    /// Whether a docked keyboard should take the phone's tab bar off screen.
    ///
    /// The bar is 64pt of chrome you cannot reach while typing. `AppRoot` reads this to drop
    /// it; a screen with its own pinned bar reads it to stop reserving `WF.fixedBarClearance`.
    /// One place, or the two copies drift into a dead gap or a control under the keys.
    nonisolated static func hidesBottomBar(overlap: CGFloat) -> Bool { overlap > 0 }

    var hidesBottomBar: Bool { Self.hidesBottomBar(overlap: overlap) }

    /// How far a bottom-pinned bar at `columnBottom` must ride up to clear a keyboard topped
    /// at `keyboardTop`. 0 with no keyboard, no measurement, or where the system got it right.
    nonisolated static func barShift(columnBottom: CGFloat, keyboardTop: CGFloat?) -> CGFloat {
        guard let keyboardTop, columnBottom > 0 else { return 0 }
        return max(0, columnBottom - keyboardTop)
    }

    private init() {
            // Headless verification: WAFFLED_FAKE_KB_TOP=<windowY> pretends a docked keyboard
            // sits there, so landscape lift can be screenshot without the Simulator's flaky
            // focus. It sets `overlap` too: with a REAL keyboard up you cannot tell "the tab
            // bar hid" from "the tab bar is behind the keyboard".
        if let fake = AppConfig.env("WAFFLED_FAKE_KB_TOP").flatMap(Double.init) {
            topInWindow = CGFloat(fake)
            let windowMaxY = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow)?.bounds.maxY
                // A positive fallback when the window isn't up yet: ANY positive value has to
                // make the docked-ness true, or the hook pretends a keyboard that covers nothing.
            overlap = max(1, (windowMaxY ?? CGFloat(fake) + 1) - CGFloat(fake))
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
        // The notification's frame is in screen coordinates and the window may not cover the
        // screen (Split View), so convert before comparing.
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
