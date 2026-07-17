import Foundation

/// The pure debounce state machine behind the Offline banner. Brief connectivity
/// blips — PowerSync reconnects, app foregrounding, network transitions — used to
/// flash the bar for a second; this gate only admits a *sustained* outage.
///
/// Deliberately clock-free and task-free so it's deterministic under test: the
/// owner feeds it every connectivity change (and deadline re-check) with an
/// explicit `now`, and it answers with the instant to check back at, if any.
/// The owning view (`OfflineBanner`) wraps that deadline in a cancellable
/// `clock.sleep(until:)` — see `OfflineBanner.evaluate`.
///
/// Instants are `SuspendingClock` on purpose: it pauses while the process is
/// suspended, so only time the app actually observes counts toward the grace.
/// On a continuous clock, backgrounding 2s into an outage and waking 30s later
/// would resume the grace sleep already past its deadline — before PowerSync
/// gets a chance to re-emit .connected — flashing the banner on every wake.
struct OfflineBannerGate {
    /// How long the app must be continuously disconnected before the banner
    /// shows. Reconnecting at any point hides it immediately and resets the clock.
    static let gracePeriod: Duration = .seconds(10)

    private(set) var isShowingBanner = false
    /// Start of the current uninterrupted outage (nil while connected).
    private var offlineSince: SuspendingClock.Instant?

    /// Feed a connectivity event (or a deadline re-check). Returns the instant
    /// at which the caller should re-check if still disconnected, or nil when
    /// there's nothing pending (connected, or the banner is already showing).
    mutating func connectivityChanged(
        isConnected: Bool, now: SuspendingClock.Instant
    ) -> SuspendingClock.Instant? {
        guard !isConnected else {
            offlineSince = nil
            isShowingBanner = false
            return nil
        }
        let since = offlineSince ?? now
        offlineSince = since
        if now - since >= Self.gracePeriod {
            isShowingBanner = true
            return nil
        }
        return since + Self.gracePeriod
    }
}
