import Foundation
import Observation
import ServiceManagement

/// "Start at login", which for a family server is most of the point: the Mac mini on the
/// shelf reboots after an update and the household expects Waffled to be there.
///
/// `SMAppService.mainApp` registers the running `.app` itself — no helper target, no
/// separate bundle id. The status is re-read on every status poll rather than once at
/// launch, because it is not ours alone to change: someone can switch Waffled off in
/// System Settings → Login Items while this menu is sitting there claiming otherwise.
///
/// The three launchd calls are injected so the whole table below can be tested without
/// registering anything with the real launchd.
@MainActor
@Observable
final class LoginItem {
    /// What the menu should draw. A value, so every rule is testable without a menu.
    enum Control: Equatable {
        /// The ordinary case: a working toggle. `note` is the last attempt's error, shown
        /// in the label — the toggle stays usable, because one refusal from launchd is
        /// very often transient and a control you cannot touch cannot be retried.
        case toggle(isOn: Bool, note: String?)
        /// Registered, but switched off by a person in System Settings. Registering again
        /// from here does nothing; opening that pane is the only thing that helps.
        case openSettings(reason: String)
        /// launchd has no record of this bundle and will not take one — nothing to offer.
        case unavailable(reason: String)
    }

    private(set) var status: SMAppService.Status
    /// The last register/unregister error. It annotates the label until the next attempt
    /// succeeds; a poll leaves it alone, so it does not vanish two seconds after the
    /// click that caused it.
    private(set) var lastAttemptError: String?

    private let readStatus: () -> SMAppService.Status
    private let register: () throws -> Void
    private let unregister: () throws -> Void

    init(status: @escaping () -> SMAppService.Status = { SMAppService.mainApp.status },
         register: @escaping () throws -> Void = { try SMAppService.mainApp.register() },
         unregister: @escaping () throws -> Void = { try SMAppService.mainApp.unregister() }) {
        self.readStatus = status
        self.register = register
        self.unregister = unregister
        self.status = status()
    }

    var isEnabled: Bool { status == .enabled }

    var control: Control {
        switch status {
        case .requiresApproval:
            return .openSettings(reason: "approve Waffled in System Settings → Login Items")
        case .notFound:
            return .unavailable(reason: "launchd will not register this build")
        case .enabled, .notRegistered:
            return .toggle(isOn: isEnabled, note: lastAttemptError)
        @unknown default:
            // A status this build has never heard of is not a reason to take the control
            // away — the same rule the status decoder follows for an unknown `state`.
            return .toggle(isOn: isEnabled, note: lastAttemptError)
        }
    }

    /// Cheap enough for the poll loop: one read across to launchd, no side effects.
    func refresh() {
        status = readStatus()
    }

    func setEnabled(_ enabled: Bool) {
        do {
            try enabled ? register() : unregister()
            // A success is the only thing that clears the previous failure's note.
            lastAttemptError = nil
        } catch {
            // Expected in a development build: launchd will not always adopt an app
            // running from DerivedData. Say so in the label rather than leaving a toggle
            // that silently does nothing — and leave it a toggle, so it can be tried again.
            lastAttemptError = error.localizedDescription
        }
        refresh()
    }

    /// The one action `openSettings` offers.
    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
