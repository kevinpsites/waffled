import Foundation
import CoreGraphics
import Testing
@testable import Waffled

// The kiosk shell pads its content by the REAL keyboard overlap, measured from
// `keyboardWillChangeFrame` end-frames, instead of trusting SwiftUI's keyboard
// safe-area inset — which under-reports the docked keyboard's height on iPad in
// landscape (accessory + predictive rows uncounted), leaving the grocery add bar
// buried under the keys. See KeyboardState.overlap.
@Suite struct KeyboardOverlapTests {
    let screen = CGRect(x: 0, y: 0, width: 1376, height: 1032)   // 13" iPad, landscape

    @Test func dockedKeyboardOverlapIsMeasuredFromItsTop() {
        // Full-width docked keyboard incl. accessory: top edge at y=480.
        let kb = CGRect(x: 0, y: 480, width: 1376, height: 552)
        #expect(KeyboardState.overlap(screen: screen, keyboard: kb) == 552)
    }

    @Test func hiddenKeyboardHasNoOverlap() {
        // Hide is reported as an end-frame at/below the screen's bottom edge.
        let kb = CGRect(x: 0, y: 1032, width: 1376, height: 552)
        #expect(KeyboardState.overlap(screen: screen, keyboard: kb) == 0)
    }

    @Test func floatingKeyboardDoesNotInset() {
        // The iPad floating mini keyboard is narrower than the screen and can sit
        // anywhere — it must not push the layout up.
        let kb = CGRect(x: 400, y: 500, width: 320, height: 260)
        #expect(KeyboardState.overlap(screen: screen, keyboard: kb) == 0)
    }

    @Test func hardwareKeyboardShortcutBarInsetsOnlyItsOwnHeight() {
        // With a hardware keyboard only the ~55pt shortcut strip docks at the bottom.
        let kb = CGRect(x: 0, y: 977, width: 1376, height: 55)
        #expect(KeyboardState.overlap(screen: screen, keyboard: kb) == 55)
    }

    @Test func zeroFrameHasNoOverlap() {
        #expect(KeyboardState.overlap(screen: screen, keyboard: .zero) == 0)
    }
}
