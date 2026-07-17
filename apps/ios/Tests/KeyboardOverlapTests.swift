import Foundation
import CoreGraphics
import Testing
@testable import Waffled

// The kiosk lists page lifts its add bar by the REAL keyboard overlap, measured from
// `keyboardWillChangeFrame` end-frames converted into the app window's coordinate
// space — because iPadOS's keyboard safe-area inset under-reports the docked
// landscape keyboard (accessory + predictive rows uncounted), which buried the bar
// under the keys. See `KeyboardState` and `ListDetailView.kioskBody`.
@Suite struct KeyboardOverlapTests {
    let window = CGRect(x: 0, y: 0, width: 1376, height: 1032)   // 13" iPad, landscape, fullscreen

    @Test func dockedKeyboardOverlapIsMeasuredFromItsTop() {
        // Full-width docked keyboard incl. accessory: top edge at y=480.
        let kb = CGRect(x: 0, y: 480, width: 1376, height: 552)
        #expect(KeyboardState.overlap(container: window, keyboard: kb) == 552)
    }

    @Test func hiddenKeyboardHasNoOverlap() {
        // Hide is reported as an end-frame at/below the container's bottom edge.
        let kb = CGRect(x: 0, y: 1032, width: 1376, height: 552)
        #expect(KeyboardState.overlap(container: window, keyboard: kb) == 0)
    }

    @Test func floatingKeyboardDoesNotInset() {
        // The iPad floating mini keyboard is narrower than the window and can sit
        // anywhere — it must not push the layout up.
        let kb = CGRect(x: 400, y: 500, width: 320, height: 260)
        #expect(KeyboardState.overlap(container: window, keyboard: kb) == 0)
    }

    @Test func hardwareKeyboardShortcutBarInsetsOnlyItsOwnHeight() {
        // With a hardware keyboard only the ~55pt shortcut strip docks at the bottom.
        let kb = CGRect(x: 0, y: 977, width: 1376, height: 55)
        #expect(KeyboardState.overlap(container: window, keyboard: kb) == 55)
    }

    @Test func zeroFrameHasNoOverlap() {
        #expect(KeyboardState.overlap(container: window, keyboard: .zero) == 0)
    }

    @Test func narrowWindowStillCountsAScreenWideKeyboard() {
        // Split View / Stage Manager: the app window is narrower than the screen, so
        // the screen-wide docked keyboard converts to a frame WIDER than the window
        // (negative x). It still docks — the overlap must count.
        let pane = CGRect(x: 0, y: 0, width: 678, height: 1032)
        let kb = CGRect(x: -300, y: 600, width: 1376, height: 432)
        #expect(KeyboardState.overlap(container: pane, keyboard: kb) == 432)
    }

    // MARK: bar shift — how far the add bar must ride up to clear the keys

    @Test func barBelowTheKeyboardTopRidesUpByTheDifference() {
        #expect(KeyboardState.barShift(columnBottom: 654, keyboardTop: 481) == 173)
    }

    @Test func noKeyboardMeansNoShift() {
        #expect(KeyboardState.barShift(columnBottom: 654, keyboardTop: nil) == 0)
    }

    @Test func barAlreadyAboveTheKeyboardDoesNotShift() {
        // The system's own avoidance placed the column correctly — self-corrects to 0.
        #expect(KeyboardState.barShift(columnBottom: 480, keyboardTop: 481) == 0)
    }

    @Test func unmeasuredColumnDoesNotShift() {
        #expect(KeyboardState.barShift(columnBottom: 0, keyboardTop: 481) == 0)
    }
}
