import Foundation
import Testing
@testable import Waffled

@Suite("Temporary access uses household calendar dates")
struct AccessEndDateTests {
    @Test("exclusive midnight recovers the same end date on opposite UTC offsets")
    func oppositeOffsets() {
        #expect(AccessEndDatePolicy.dateOnly(
            fromExpiry: "2026-06-15T10:00:00.000Z",
            householdTimeZoneIdentifier: "Pacific/Kiritimati"
        ) == "2026-06-15")
        #expect(AccessEndDatePolicy.dateOnly(
            fromExpiry: "2026-06-16T10:00:00.000Z",
            householdTimeZoneIdentifier: "Pacific/Honolulu"
        ) == "2026-06-15")
    }

    @Test("the picker round-trips a date without applying the device timezone")
    func pickerRoundTrip() {
        let date = AccessEndDatePolicy.pickerDate(from: "2026-11-01")!
        #expect(AccessEndDatePolicy.dateOnly(fromPickerDate: date) == "2026-11-01")
    }

    @Test("the minimum selectable day follows the household rather than the device")
    func householdToday() {
        let now = ISO8601DateFormatter().date(from: "2026-01-01T05:00:00Z")!
        let east = AccessEndDatePolicy.todayPickerDate(
            now: now,
            householdTimeZoneIdentifier: "Pacific/Kiritimati"
        )
        let west = AccessEndDatePolicy.todayPickerDate(
            now: now,
            householdTimeZoneIdentifier: "Pacific/Honolulu"
        )
        #expect(AccessEndDatePolicy.dateOnly(fromPickerDate: east) == "2026-01-01")
        #expect(AccessEndDatePolicy.dateOnly(fromPickerDate: west) == "2025-12-31")
    }

    @Test("editing prefers the canonical civil date after a timezone change")
    func canonicalDateSurvivesTimezoneChange() {
        // The instant was originally Denver's next midnight. Interpreting it in
        // Honolulu would produce June 14; the persisted civil date must win.
        #expect(AccessEndDatePolicy.editableDateOnly(
            accessEndsOn: "2026-06-15",
            legacyExpiry: "2026-06-16T06:00:00.000Z",
            householdTimeZoneIdentifier: "Pacific/Honolulu"
        ) == "2026-06-15")
    }
}
