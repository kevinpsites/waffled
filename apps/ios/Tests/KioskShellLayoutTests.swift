import Foundation
import SwiftUI
import Testing
@testable import Waffled

// The iPad shell picks its layout (portrait bottom bar vs landscape side rail) from
// the FULL container size — safe-area insets added back — so the on-screen keyboard,
// which arrives as a large *bottom safe-area inset*, can't flip a portrait iPad into
// the landscape layout mid-typing (that flip rebuilt the page and dropped the text
// being typed into the grocery list's add bar). See KioskShell.isPortrait.
@Suite struct KioskShellLayoutTests {

    /// 11" iPad portrait, no keyboard: plainly portrait.
    @Test func portraitWithoutKeyboard() {
        #expect(KioskShell.isPortrait(
            size: CGSize(width: 820, height: 1136),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0)))
    }

    /// 11" iPad portrait with the keyboard up: the keyboard shrinks the safe-area
    /// height (1180 − 24 − 460 = 696) BELOW the width — the old bare height > width
    /// check flipped to landscape here. The full-size check must stay portrait.
    @Test func portraitKeepsLayoutWhileKeyboardIsUp() {
        let size = CGSize(width: 820, height: 696)
        let safeArea = EdgeInsets(top: 24, leading: 0, bottom: 460, trailing: 0)
        #expect(size.height < size.width)   // the regression trigger
        #expect(KioskShell.isPortrait(size: size, safeArea: safeArea))
    }

    /// Landscape, no keyboard: plainly landscape.
    @Test func landscapeWithoutKeyboard() {
        #expect(!KioskShell.isPortrait(
            size: CGSize(width: 1180, height: 776),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0)))
    }

    /// Landscape with the keyboard up stays landscape.
    @Test func landscapeKeepsLayoutWhileKeyboardIsUp() {
        #expect(!KioskShell.isPortrait(
            size: CGSize(width: 1180, height: 396),
            safeArea: EdgeInsets(top: 24, leading: 0, bottom: 400, trailing: 0)))
    }
}
