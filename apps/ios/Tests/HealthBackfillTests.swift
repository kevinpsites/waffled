import Foundation
import Testing
@testable import Waffled

// The backfill window is the one piece of the Apple Health sync with real logic that's
// easy to get subtly wrong (day boundaries, month rollover, ordering). syncHealth reads
// and re-syncs this window each run so opening the app once catches up missed days.
@Suite struct HealthBackfillTests {
    private var chicago: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }

    private func at(_ s: String, _ cal: Calendar) -> Date {
        let f = DateFormatter()
        f.calendar = cal; f.timeZone = cal.timeZone
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.date(from: s)!
    }

    @Test func windowIsNewestFirstAndIncludesToday() {
        let cal = chicago
        let keys = HealthKitBridge.backfillDays(count: 7, endingOn: at("2026-07-08 14:30", cal), calendar: cal).map(\.key)
        #expect(keys == ["2026-07-08", "2026-07-07", "2026-07-06", "2026-07-05", "2026-07-04", "2026-07-03", "2026-07-02"])
    }

    @Test func windowCrossesMonthBoundary() {
        let cal = chicago
        let keys = HealthKitBridge.backfillDays(count: 3, endingOn: at("2026-07-02 09:00", cal), calendar: cal).map(\.key)
        #expect(keys == ["2026-07-02", "2026-07-01", "2026-06-30"])
    }

    @Test func countClampsToAtLeastOne() {
        let cal = chicago
        let keys = HealthKitBridge.backfillDays(count: 0, endingOn: at("2026-07-08 00:00", cal), calendar: cal).map(\.key)
        #expect(keys == ["2026-07-08"])
    }

    @Test func eachPairedDateIsThatKeysLocalStartOfDay() {
        let cal = chicago
        let f = DateFormatter()
        f.calendar = cal; f.timeZone = cal.timeZone
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
        for (day, key) in HealthKitBridge.backfillDays(count: 4, endingOn: at("2026-07-08 14:30", cal), calendar: cal) {
            #expect(f.string(from: day) == key)
            #expect(cal.startOfDay(for: day) == day)
        }
    }
}
