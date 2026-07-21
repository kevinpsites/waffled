import Foundation
import Testing
@testable import Waffled

// Which rail / bottom-bar tile lights up for the current kiosk page. A page opened
// from the More grid (unpinned Goals, Lists, Chores, Pantry, Photos…) has no tile of
// its own — the More tile must light up for it, instead of the rail showing no
// selection at all (the bug: open Goals from More → nothing highlighted anywhere).
struct KioskRailHighlightTests {
    /// The out-of-the-box rail: Meals + Family pinned.
    private let defaultPins: [KioskNav] = [.meals, .family]

    @Test func ownTileHighlightsForDirectSelection() {
        #expect(KioskRail.isHighlighted(.calendar, selection: .calendar, pinned: defaultPins))
        #expect(KioskRail.isHighlighted(.meals, selection: .meals, pinned: defaultPins))
        #expect(!KioskRail.isHighlighted(.more, selection: .meals, pinned: defaultPins))
        #expect(!KioskRail.isHighlighted(.today, selection: .calendar, pinned: defaultPins))
    }

    @Test func moreLightsUpForOverflowPages() {
        for overflow: KioskNav in [.goals, .lists, .tasks, .pantry, .photos, .rewards] {
            #expect(KioskRail.isHighlighted(.more, selection: overflow, pinned: defaultPins),
                    "More should light for \(overflow) when it isn't pinned")
            #expect(!KioskRail.isHighlighted(.today, selection: overflow, pinned: defaultPins))
        }
    }

    @Test func pinnedPageLightsItsOwnTileNotMore() {
        let pins: [KioskNav] = [.goals, .meals]
        #expect(KioskRail.isHighlighted(.goals, selection: .goals, pinned: pins))
        #expect(!KioskRail.isHighlighted(.more, selection: .goals, pinned: pins))
    }

    @Test func moreGridItselfHighlightsMore() {
        #expect(KioskRail.isHighlighted(.more, selection: .more, pinned: defaultPins))
    }

    @Test func fixedTilesNeverFallThroughToMore() {
        #expect(KioskRail.isHighlighted(.settings, selection: .settings, pinned: defaultPins))
        #expect(!KioskRail.isHighlighted(.more, selection: .settings, pinned: defaultPins))
        #expect(!KioskRail.isHighlighted(.more, selection: .today, pinned: defaultPins))
        #expect(!KioskRail.isHighlighted(.more, selection: .calendar, pinned: defaultPins))
    }
}
