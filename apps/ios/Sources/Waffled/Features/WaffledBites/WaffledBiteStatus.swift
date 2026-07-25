import Foundation

/// Whether a paired Waffled-Bite has checked in recently enough to call it "online" —
/// same 10-minute cutoff as `apps/web/src/lib/waffledBiteStatus.ts`, wider than the
/// firmware's ~4-minute token-refresh cadence (see `wb_wifi_esp32.cpp` /
/// `waffledBites.ts`'s `lastSeenAt` update) so a single missed refresh (a brief WiFi
/// blip) doesn't flash "Offline" — two misses in a row is a genuine signal.
enum WaffledBiteStatus {
    static let offlineAfterSec: TimeInterval = 10 * 60

    static func isOnline(lastSeenAt: String?, now: Date) -> Bool {
        guard let lastSeenAt, let seen = EventTime.parse(lastSeenAt) else { return false }
        return now.timeIntervalSince(seen) <= offlineAfterSec
    }
}
