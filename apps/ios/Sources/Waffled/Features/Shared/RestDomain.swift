import Foundation
import Observation

/// One REST-backed dashboard domain: the latest fetched value plus whether a fetch
/// has completed at least once. Shared by the phone Today dashboard
/// (`DashboardModel`) and the iPad kiosk (`KioskTodayModel`) so both surfaces get
/// the same loading-state contract — locked by `RestDomainTests`:
///
/// - `loaded` flips true only after a fetch attempt completes, so a card can tell
///   "still loading" (show a placeholder) apart from "loaded and empty" (show its
///   empty state) — never flash "No goals yet" before data arrives.
/// - `apply(nil)` means the fetch failed (offline, expired token): keep the prior
///   value — never blank a card that had data — but still count as loaded so the
///   card doesn't sit on "Loading…" forever.
/// - `apply([])` — a successful empty fetch — is real data (tonight's dinner was
///   removed elsewhere) and applies.
@MainActor
@Observable
final class RestDomain<Value: Sendable> {
    /// Settable so an owner can make optimistic local mutations between fetches
    /// (e.g. the kiosk's grocery check-off).
    var value: Value
    private(set) var loaded = false

    init(_ initial: Value) {
        value = initial
    }

    /// Fold a fetch result in: nil (failure) keeps the prior value, non-nil applies
    /// even when empty; either way the domain now counts as loaded.
    func apply(_ fetched: Value?) {
        if let fetched { value = fetched }
        loaded = true
    }
}
