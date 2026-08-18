import Foundation
import Testing
@testable import Waffled

// Retrofitted after the fact to close a gap: the 20m chip shipped with nothing pinning
// it. Its correctness rests on a three-way coupling that isn't visible from any one
// line — the chip's value, the hours/minutes it fills in, and the tolerance the
// highlight compares with. Break any one and the chip either logs 19 minutes or stops
// reading as selected, both of which look like a shrug rather than a bug.
@Suite struct GoalLogChipsTests {
    @Test func timeGoalsOfferTheShortSessionChips() {
        let labels = GoalLogChips.chips(isHours: true, unit: "hours").map(\.label)
        #expect(labels == ["20m", "30m", "1 hr", "1.5 hr"])
    }

    @Test func otherGoalsCountInTheirOwnUnit() {
        let chips = GoalLogChips.chips(isHours: false, unit: "books")
        #expect(chips.map(\.label) == ["1 books", "2 books", "3 books", "5 books"])
        #expect(chips.map(\.value) == [1, 2, 3, 5])
        // A goal with no unit just counts.
        #expect(GoalLogChips.chips(isHours: false, unit: nil).map(\.label) == ["1", "2", "3", "5"])
    }

    // The whole point: tapping 20m has to be the same as typing 0h 20m.
    @Test func twentyMinutesFillsInTwentyMinutes() {
        let chip = GoalLogChips.chips(isHours: true, unit: "hours")[0]
        let f = GoalLogChips.fields(for: chip.value)
        #expect(f == (hours: 0, minutes: 20))
        // Truncating instead of rounding here is the classic way to get 19.
        #expect(f.minutes != 19)
    }

    @Test func everyTimeChipRoundTripsThroughTheFields() {
        for chip in GoalLogChips.chips(isHours: true, unit: "hours") {
            let f = GoalLogChips.fields(for: chip.value)
            #expect(GoalLogChips.isSelected(hours: f.hours, minutes: f.minutes, chip: chip.value),
                    "\(chip.label) does not read as selected after being tapped")
        }
    }

    @Test func aDifferentDurationDoesNotLightUpTheChip() {
        let twenty = GoalLogChips.chips(isHours: true, unit: "hours")[0].value
        #expect(!GoalLogChips.isSelected(hours: 0, minutes: 19, chip: twenty))
        #expect(!GoalLogChips.isSelected(hours: 0, minutes: 21, chip: twenty))
        #expect(!GoalLogChips.isSelected(hours: 1, minutes: 20, chip: twenty))
    }

    // 20/60 is 0.3333… forever; the chip stores six decimals of it. The gap between
    // the two is what the tolerance has to absorb.
    @Test func theChipValueMatchesTypedMinutesWithinTolerance() {
        #expect(GoalLogChips.hoursForMinutes(20) == 0.333333)
        #expect(abs(GoalLogChips.hoursForMinutes(20) - 20.0 / 60) < 1e-6)
        #expect(GoalLogChips.hoursForMinutes(30) == 0.5)
    }
}
