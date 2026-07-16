import Testing
@testable import Waffled

// The Offline banner must not flash on brief blips (PowerSync reconnects, app
// foregrounding, network transitions). OfflineBannerGate is the pure debounce
// state machine behind it: callers feed it connectivity events with an explicit
// `now` (so tests fully control the clock) and re-check at the deadline it
// returns. Only a *sustained* outage (>= gracePeriod of continuous disconnect)
// shows the banner; any reconnect hides it immediately and resets the clock.
struct OfflineBannerGateTests {
    private let t0 = ContinuousClock().now

    @Test func gracePeriodIsTenSeconds() {
        #expect(OfflineBannerGate.gracePeriod == .seconds(10))
    }

    @Test func briefBlipNeverShows() {
        var gate = OfflineBannerGate()
        let deadline = gate.connectivityChanged(isConnected: false, now: t0)
        #expect(deadline == t0 + OfflineBannerGate.gracePeriod)
        #expect(!gate.isShowingBanner)
        // Still offline just before the deadline — stays hidden.
        _ = gate.connectivityChanged(isConnected: false, now: t0 + .seconds(9))
        #expect(!gate.isShowingBanner)
        // Reconnects inside the grace window — never shows, nothing pending.
        #expect(gate.connectivityChanged(isConnected: true, now: t0 + .seconds(9)) == nil)
        #expect(!gate.isShowingBanner)
    }

    @Test func sustainedOutageShows() {
        var gate = OfflineBannerGate()
        _ = gate.connectivityChanged(isConnected: false, now: t0)
        #expect(!gate.isShowingBanner)
        // The deadline re-check fires while still offline — banner shows.
        let after = gate.connectivityChanged(
            isConnected: false, now: t0 + OfflineBannerGate.gracePeriod)
        #expect(gate.isShowingBanner)
        #expect(after == nil)
    }

    @Test func reconnectCancelsPendingShowAndRestartsGrace() {
        var gate = OfflineBannerGate()
        _ = gate.connectivityChanged(isConnected: false, now: t0)
        _ = gate.connectivityChanged(isConnected: true, now: t0 + .seconds(6))
        // Drops again: the grace restarts from this drop, not the first one.
        let deadline = gate.connectivityChanged(isConnected: false, now: t0 + .seconds(7))
        #expect(deadline == t0 + .seconds(17))
        // 12s after the first drop, but only 5s of continuous offline — hidden.
        _ = gate.connectivityChanged(isConnected: false, now: t0 + .seconds(12))
        #expect(!gate.isShowingBanner)
        _ = gate.connectivityChanged(isConnected: false, now: t0 + .seconds(17))
        #expect(gate.isShowingBanner)
    }

    @Test func shownBannerHidesImmediatelyOnReconnect() {
        var gate = OfflineBannerGate()
        _ = gate.connectivityChanged(isConnected: false, now: t0)
        _ = gate.connectivityChanged(isConnected: false, now: t0 + .seconds(10))
        #expect(gate.isShowingBanner)
        #expect(gate.connectivityChanged(isConnected: true, now: t0 + .seconds(11)) == nil)
        #expect(!gate.isShowingBanner)
    }

    @Test func repeatedDisconnectEventsKeepTheOriginalDeadline() {
        var gate = OfflineBannerGate()
        let first = gate.connectivityChanged(isConnected: false, now: t0)
        // A second not-connected event mid-outage (e.g. offline → connecting)
        // must not push the deadline out — the outage still started at t0.
        let second = gate.connectivityChanged(isConnected: false, now: t0 + .seconds(4))
        #expect(second == first)
    }
}
