import Foundation
import Testing
@testable import Waffled

/// The household's `week_start` only arrives on a sync tick, so a cold launch has a
/// window where nothing knows it. These lock the remembered-across-launches behaviour
/// that closes it. Mirrors `GoalViewPreferenceTests`' throwaway-suite pattern so no
/// test writes into the real standard defaults.
@Suite struct HouseholdWeekStartStoreTests {
    private func freshDefaults(_ name: String) -> UserDefaults {
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    /// Deliberately `nil` rather than `.sunday`: "we have never synced" and "this
    /// household starts on Sunday" are different facts, and only the caller gets to
    /// decide that the first one falls back to the second.
    @Test func loadsNilWhenNothingSaved() {
        let d = freshDefaults("test.weekstart.empty")
        #expect(HouseholdWeekStartStore.load(defaults: d) == nil)
    }

    @Test func roundTripsMonday() {
        let d = freshDefaults("test.weekstart.monday")
        HouseholdWeekStartStore.save(.monday, defaults: d)
        #expect(HouseholdWeekStartStore.load(defaults: d) == .monday)
    }

    /// Saving Sunday has to be distinguishable from having saved nothing — otherwise a
    /// household that really is Sunday never records that it synced, and the "no stored
    /// value" branch can't be tested honestly.
    @Test func roundTripsSunday() {
        let d = freshDefaults("test.weekstart.sunday")
        HouseholdWeekStartStore.save(.sunday, defaults: d)
        #expect(HouseholdWeekStartStore.load(defaults: d) == .sunday)
    }

    @Test func overwritesAPreviousValue() {
        let d = freshDefaults("test.weekstart.overwrite")
        HouseholdWeekStartStore.save(.monday, defaults: d)
        HouseholdWeekStartStore.save(.sunday, defaults: d)
        #expect(HouseholdWeekStartStore.load(defaults: d) == .sunday)
    }

    /// Junk in the store is not a reason to claim a week start. `HouseholdWeekStart`'s
    /// own `init(raw:)` is lenient by design (free text off a synced row), but a
    /// *persisted* value we wrote ourselves is either one of the two rawValues or it is
    /// corrupt — and corrupt should read as "we don't know", not as Sunday.
    @Test func ignoresAnUnrecognisedStoredValue() {
        let d = freshDefaults("test.weekstart.junk")
        d.set("tuesday", forKey: HouseholdWeekStartStore.key)
        #expect(HouseholdWeekStartStore.load(defaults: d) == nil)
    }

    /// The app's UserDefaults keys use the dot form (`waffled.theme`,
    /// `waffled.screensaverMotion`); a colon key here would be the odd one out.
    @Test func usesTheAppsKeyConvention() {
        #expect(HouseholdWeekStartStore.key == "waffled.householdWeekStart")
    }
}
