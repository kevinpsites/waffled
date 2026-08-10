import Foundation
import Testing
@testable import Waffled

struct WaffledBiteStatusTests {
    private static let now = ISO8601DateFormatter().date(from: "2026-07-23T12:00:00Z")!

    @Test func offlineWhenNeverSeen() {
        #expect(WaffledBiteStatus.isOnline(lastSeenAt: nil, now: Self.now) == false)
    }

    @Test func onlineWhenSeenRightNow() {
        let iso = ISO8601DateFormatter().string(from: Self.now)
        #expect(WaffledBiteStatus.isOnline(lastSeenAt: iso, now: Self.now) == true)
    }

    @Test func onlineJustUnderThreshold() {
        let seen = Self.now.addingTimeInterval(-(WaffledBiteStatus.offlineAfterSec - 1))
        let iso = ISO8601DateFormatter().string(from: seen)
        #expect(WaffledBiteStatus.isOnline(lastSeenAt: iso, now: Self.now) == true)
    }

    @Test func offlineJustOverThreshold() {
        let seen = Self.now.addingTimeInterval(-(WaffledBiteStatus.offlineAfterSec + 1))
        let iso = ISO8601DateFormatter().string(from: seen)
        #expect(WaffledBiteStatus.isOnline(lastSeenAt: iso, now: Self.now) == false)
    }

    @Test func offlineOnUnparseableTimestamp() {
        #expect(WaffledBiteStatus.isOnline(lastSeenAt: "not-a-date", now: Self.now) == false)
    }
}
