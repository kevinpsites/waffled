import Foundation
import Testing
@testable import Waffled

// The gap computation is the one piece of the Apple Health sync with real logic that's
// easy to get subtly wrong. syncHealth keeps a per-goal "synced-through" high-water mark
// and, each run, re-syncs exactly the days between there and today (plus a short re-check
// tail, bounded by a cap) — so opening the app once after any absence catches up every
// missed day.
@Suite struct HealthSyncGapTests {
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

    private func gap(_ mark: Date?, _ today: Date, _ cal: Calendar, cap: Int = 90, tail: Int = 2) -> [String] {
        HealthKitBridge.daysToSync(syncedThrough: mark, today: today, cap: cap, recheckTail: tail, calendar: cal).map(\.key)
    }

    @Test func noMarkReturnsTheCapWindowNewestFirst() {
        let cal = chicago
        let keys = gap(nil, at("2026-07-08 14:30", cal), cal)   // fresh install / never synced
        #expect(keys.count == 90)
        #expect(keys.first == "2026-07-08")
        #expect(keys.last == "2026-04-10")   // 90 days inclusive of today
    }

    @Test func markTodayReturnsOnlyTheRecheckTail() {
        let cal = chicago
        // Already synced through today → just re-check the last 2 days for late Watch data.
        #expect(gap(at("2026-07-08 09:00", cal), at("2026-07-08 14:30", cal), cal) == ["2026-07-08", "2026-07-07"])
    }

    @Test func twoWeekAbsenceSyncsEveryMissedDay() {
        let cal = chicago
        // Synced through Jun 24, gone two weeks → catch up Jun 23 … Jul 8 (16 days incl. tail).
        let keys = gap(at("2026-06-24 12:00", cal), at("2026-07-08 14:30", cal), cal)
        #expect(keys.count == 16)
        #expect(keys.first == "2026-07-08")
        #expect(keys.last == "2026-06-23")
    }

    @Test func markOlderThanCapClampsToCap() {
        let cal = chicago
        let keys = gap(at("2026-01-01 00:00", cal), at("2026-07-08 14:30", cal), cal)
        #expect(keys.count == 90)
        #expect(keys.last == "2026-04-10")
    }

    @Test func markInTheFutureFallsBackToToday() {
        let cal = chicago
        #expect(gap(at("2026-07-20 00:00", cal), at("2026-07-08 14:30", cal), cal) == ["2026-07-08"])
    }

    @Test func eachKeyMatchesItsPairedLocalStartOfDay() {
        let cal = chicago
        let f = DateFormatter()
        f.calendar = cal; f.timeZone = cal.timeZone
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"
        for (day, key) in HealthKitBridge.daysToSync(syncedThrough: nil, today: at("2026-07-08 14:30", cal), cap: 5, recheckTail: 2, calendar: cal) {
            #expect(f.string(from: day) == key)
            #expect(cal.startOfDay(for: day) == day)
        }
    }
}
