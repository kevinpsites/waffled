import Foundation
import Observation
import SwiftUI

/// Opaque identity for one authenticated REST-data lifetime. A new value is issued
/// when credentials are torn down, even when the next session happens to expose the
/// same person id.
struct RestDataScope: Hashable, Sendable {
    private let id: UUID

    init() {
        id = UUID()
    }
}

/// A REST cache boundary includes both the authenticated lifetime and its server.
/// This prevents a self-hosted server switch from retaining data when identifiers
/// happen to collide.
struct RestDataScopeKey: Hashable, Sendable {
    let scope: RestDataScope
    let apiBaseURL: String
}

/// Truthful lifecycle for data that exists only behind REST. `empty` and `ready`
/// are authoritative server responses. Every other terminal state tells the UI why
/// the value must not be presented as an authoritative empty result.
enum RestState: Equatable, Sendable {
    case loading
    case empty(updatedAt: Date)
    case ready(updatedAt: Date)
    case stale(updatedAt: Date, message: String)
    case offline(updatedAt: Date?)
    case queued(pending: Int, updatedAt: Date?)
    case conflict(message: String, updatedAt: Date?)
    case error(message: String)

    var loaded: Bool {
        if case .loading = self { return false }
        return true
    }

    /// Only these states are fresh enough to justify domain-specific empty copy such
    /// as “All caught up” or “No photos yet.”
    var isAuthoritative: Bool {
        switch self {
        case .empty, .ready: return true
        default: return false
        }
    }

    var updatedAt: Date? {
        switch self {
        case let .empty(date), let .ready(date), let .stale(date, _): return date
        case let .offline(date), let .queued(_, date), let .conflict(_, date): return date
        case .loading, .error: return nil
        }
    }

    /// Fold independently-loaded REST domains into one screen state. A partial
    /// failure is stale—not empty—when at least one sibling returned fresh data.
    static func combined(_ states: [RestState]) -> RestState {
        guard !states.isEmpty else { return .loading }
        let latest = states.compactMap(\.updatedAt).max()

        if let conflict = states.first(where: { if case .conflict = $0 { true } else { false } }),
           case let .conflict(message, date) = conflict {
            return .conflict(message: message, updatedAt: date ?? latest)
        }
        if let queued = states.first(where: { if case .queued = $0 { true } else { false } }),
           case let .queued(pending, date) = queued {
            return .queued(pending: pending, updatedAt: date ?? latest)
        }
        if states.contains(where: { if case .offline = $0 { true } else { false } }) {
            var failedDates: [Date] = []
            var hasUnknownFailureDate = false
            for state in states {
                switch state {
                case let .offline(updatedAt):
                    if let updatedAt { failedDates.append(updatedAt) }
                    else { hasUnknownFailureDate = true }
                case let .stale(updatedAt, _):
                    failedDates.append(updatedAt)
                case .error:
                    hasUnknownFailureDate = true
                default:
                    break
                }
            }
            // Offline copy wins, but its timestamp describes every failed visible
            // domain—not a fresh sibling and not merely the first offline one. An
            // unknown failure age dominates; otherwise report the oldest saved value.
            return .offline(updatedAt: hasUnknownFailureDate ? nil : failedDates.min())
        }
        let staleValues = states.compactMap { state -> (date: Date, message: String)? in
            guard case let .stale(date, message) = state else { return nil }
            return (date, message)
        }
        if let oldestStale = staleValues.min(by: { $0.date < $1.date }) {
            let messages = Set(staleValues.map(\.message))
            let hasBareError = states.contains { if case .error = $0 { true } else { false } }
            let message = messages.count == 1 && !hasBareError
                ? oldestStale.message
                : "Some data couldn’t be refreshed."
            // Fresh sibling timestamps cannot say how old this failed domain is.
            // Multiple stale domains conservatively report the oldest saved value.
            return .stale(updatedAt: oldestStale.date, message: message)
        }
        if states.contains(where: { if case .loading = $0 { true } else { false } }) {
            return .loading
        }
        if let error = states.first(where: { if case .error = $0 { true } else { false } }),
           case let .error(message) = error {
            if let latest { return .stale(updatedAt: latest, message: "Some data couldn’t be refreshed.") }
            return .error(message: message)
        }
        let date = latest ?? Date()
        return states.contains(where: { if case .ready = $0 { true } else { false } })
            ? .ready(updatedAt: date)
            : .empty(updatedAt: date)
    }
}

/// Runs optional fan-out requests without calling disabled feature endpoints. The
/// result value lets screen models apply every completed response together after
/// all active sibling requests settle.
enum RestFetch {
    static func result<Value: Sendable>(
        _ fetch: @escaping @Sendable () async throws -> Value
    ) async -> Result<Value, Error> {
        do { return .success(try await fetch()) }
        catch { return .failure(error) }
    }

    static func result<Value: Sendable>(
        when enabled: Bool,
        _ fetch: @escaping @Sendable () async throws -> Value
    ) async -> Result<Value, Error>? {
        guard enabled else { return nil }
        return await result(fetch)
    }
}

private enum RestFailureKind {
    case offline
    case other

    init(_ error: Error) {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else {
            self = .other
            return
        }
        let code = URLError.Code(rawValue: ns.code)
        switch code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
             .cannotConnectToHost, .dnsLookupFailed, .dataNotAllowed,
             .internationalRoamingOff, .timedOut:
            self = .offline
        default:
            self = .other
        }
    }
}

/// One REST-backed domain: the last confirmed value and its lifecycle. Shared by
/// the phone Today dashboard, iPad kiosk, Family hub, approvals, and Photos wall.
/// Existing optional-result callers retain their behavior while migrated surfaces
/// can classify network failures and render the full `RestState` contract:
///
/// - `loaded` flips true only after a fetch attempt completes, so a card can tell
///   "still loading" (show a placeholder) apart from "loaded and empty" (show its
///   empty state) — never flash "No goals yet" before data arrives.
/// - A failure keeps the prior value and becomes stale/offline/error rather than
///   blanking a card or pretending the result was empty.
/// - `apply([])` — a successful empty fetch — is real data (tonight's dinner was
///   removed elsewhere) and applies.
@MainActor
@Observable
final class RestDomain<Value: Sendable> {
    /// Settable so an owner can make optimistic local mutations between fetches
    /// (e.g. the kiosk's grocery check-off).
    var value: Value
    private(set) var state: RestState = .loading
    var loaded: Bool { state.loaded }

    private let isEmpty: (Value) -> Bool
    private let initialValue: Value

    init(_ initial: Value, isEmpty: @escaping (Value) -> Bool = { _ in false }) {
        value = initial
        initialValue = initial
        self.isEmpty = isEmpty
    }

    /// Drop values at an authenticated/server boundary. Ordinary reloads deliberately
    /// retain confirmed data, but it must never cross into a different household.
    func reset() {
        value = initialValue
        state = .loading
    }

    /// Fold a fetch result in: nil (failure) keeps the prior value, non-nil applies
    /// even when empty; either way the domain now counts as loaded.
    func apply(_ fetched: Value?, at date: Date = Date()) {
        guard let fetched else {
            fail(message: "Couldn’t refresh this data.")
            return
        }
        succeed(fetched, at: date)
    }

    func apply(_ result: Result<Value, Error>, at date: Date = Date()) {
        switch result {
        case let .success(fetched): succeed(fetched, at: date)
        case let .failure(error): fail(error, at: date)
        }
    }

    func beginLoading() {
        switch state {
        case .queued, .conflict: break
        default:
            if state.updatedAt == nil { state = .loading }
        }
    }

    func markQueued(_ pending: Int) {
        state = .queued(pending: max(1, pending), updatedAt: state.updatedAt)
    }

    func markConflict(_ message: String) {
        state = .conflict(message: message, updatedAt: state.updatedAt)
    }

    private func succeed(_ fetched: Value, at date: Date) {
        value = fetched
        state = isEmpty(fetched) ? .empty(updatedAt: date) : .ready(updatedAt: date)
    }

    private func fail(_ error: Error, at date: Date) {
        switch RestFailureKind(error) {
        case .offline:
            state = .offline(updatedAt: state.updatedAt)
        case .other:
            fail(message: "Couldn’t refresh this data.")
        }
    }

    private func fail(message: String) {
        if let updatedAt = state.updatedAt {
            state = .stale(updatedAt: updatedAt, message: message)
        } else {
            state = .error(message: "Couldn’t load this data. Try again.")
        }
    }
}

/// Shared in-place recovery notice. Domain screens still own their useful empty copy;
/// this view renders only non-authoritative states so a failure never masquerades as
/// an empty success.
struct RestStateNotice: View {
    let state: RestState
    var retry: (() -> Void)?

    var body: some View {
        if let notice {
            HStack(spacing: 10) {
                Image(systemName: notice.icon).font(.system(size: 14, weight: .bold))
                VStack(alignment: .leading, spacing: 2) {
                    Text(notice.title).font(.system(size: 13, weight: .bold))
                    Text(notice.message).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if notice.canRetry, let retry {
                    Button("Retry", action: retry).font(.system(size: 12, weight: .bold))
                }
            }
            .foregroundStyle(notice.tint)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(notice.tint.opacity(0.09))
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(notice.tint.opacity(0.22), lineWidth: 1))
        }
    }

    private struct Notice {
        let icon: String
        let title: String
        let message: String
        let tint: Color
        let canRetry: Bool
    }

    private var notice: Notice? {
        switch state {
        case let .stale(updatedAt, message):
            return .init(icon: "clock.arrow.circlepath", title: "Showing saved data",
                         message: "\(message) Last updated \(Self.time(updatedAt)).",
                         tint: WF.warn, canRetry: true)
        case let .offline(updatedAt):
            return .init(icon: "wifi.slash", title: "Offline",
                         message: updatedAt.map { "Showing data saved at \(Self.time($0))." }
                            ?? "Connect to load this information.",
                         tint: WF.ink2, canRetry: true)
        case let .queued(pending, _):
            return .init(icon: "arrow.triangle.2.circlepath", title: "Saved on this device",
                         message: "\(pending) change\(pending == 1 ? "" : "s") queued to sync.",
                         tint: FamilyColor.person3.solid, canRetry: false)
        case let .conflict(message, _):
            return .init(icon: "arrow.triangle.branch", title: "Needs review",
                         message: message, tint: WF.primary, canRetry: true)
        case let .error(message):
            return .init(icon: "exclamationmark.triangle", title: "Couldn’t load",
                         message: message, tint: WF.primaryD, canRetry: true)
        case .loading, .empty, .ready:
            return nil
        }
    }

    private static func time(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}
