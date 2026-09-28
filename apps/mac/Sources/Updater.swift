import AppKit
import Sparkle

/// The Sparkle side of an update, and the only file that imports Sparkle.
///
/// Everything an update actually *decides* is in `Lifecycle` and `MenuPresentation`; this
/// is the shell that connects those decisions to the framework, which is why no test
/// touches it.
@MainActor
@Observable
final class Updater {
    /// Sparkle's own answer, observed: false while a check or a download is in flight, and
    /// before the updater has started at all.
    private(set) var canCheckForUpdates = false

    private let controller: SPUStandardUpdaterController
    /// Strong on purpose: `SPUStandardUpdaterController` holds its delegate **weakly**, so
    /// a delegate created inline would deallocate at once and take the feed seam and the
    /// stop-before-relaunch rule with it — silently, since Sparkle then just uses its
    /// defaults.
    private let delegate: UpdaterDelegate
    private var availability: NSKeyValueObservation?

    init(model: ServerModel,
         environment: [String: String] = ProcessInfo.processInfo.environment) {
        delegate = UpdaterDelegate(model: model,
                                   feedOverride: Updates.feedURL(environment: environment))
        controller = SPUStandardUpdaterController(
            startingUpdater: Updates.startsUpdater(environment: environment),
            updaterDelegate: delegate,
            userDriverDelegate: nil)
        canCheckForUpdates = controller.updater.canCheckForUpdates
        availability = controller.updater.observe(\.canCheckForUpdates) { [weak self] updater, _ in
            // Read on whatever thread KVO used; only the Bool crosses to the main actor.
            let can = updater.canCheckForUpdates
            Task { @MainActor in self?.canCheckForUpdates = can }
        }
    }

    /// An `LSUIElement` app is never the frontmost one, so Sparkle's windows would open
    /// behind whatever the person was reading — the same reason the quit alert activates
    /// first.
    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        controller.updater.checkForUpdates()
    }
}

/// The things Sparkle has to tell this app, and the two it has to ask.
final class UpdaterDelegate: NSObject, SPUUpdaterDelegate {
    private let model: ServerModel
    private let feedOverride: String?

    init(model: ServerModel, feedOverride: String?) {
        self.model = model
        self.feedOverride = feedOverride
    }

    /// Nil hands the question back to Sparkle, which uses the `SUFeedURL` in the plist.
    func feedURLString(for updater: SPUUpdater) -> String? { feedOverride }

    /// The earliest news that a swap is now inevitable: `Autoupdate` has performed stage 1
    /// by this point and finishes the installation on any termination, whether or not
    /// anyone ever clicks install (`UpdateFlow`'s invariant). It is also the only signal
    /// behind the alert's `Install on Quit` button, which ends the cycle without ever
    /// asking this app to postpone anything.
    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) {
        let model = model
        Task { @MainActor in model.updateInstallerPrepared() }
    }

    /// The stop before the relaunch — why, in `docs/product/native-mac-plan.md` Phase 3
    /// item 6. Returning true holds the relaunch until `installHandler` runs, and a `stop`
    /// that refuses never runs it; the model keeps the handler, because Sparkle's session
    /// stays open around it and its own `checkForUpdates` would then do nothing.
    ///
    /// Hopped onto the main actor rather than asserted onto it: Sparkle's header documents
    /// no thread for this callback, the stop is asynchronous either way, and a wrong guess
    /// would crash a household mid-update.
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        let model = model
        Task { @MainActor in model.stopBeforeUpdate(then: installHandler) }
        return true
    }

    /// The same rule for the background driver's silent install-on-quit: taking
    /// responsibility (`true`) is what lets the server be stopped before the swap, exactly
    /// as postponing the relaunch does. Reached only when Sparkle downloads updates
    /// automatically, which `SUAutomaticallyUpdate: false` turns off today.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        let model = model
        Task { @MainActor in model.stopBeforeUpdate(then: immediateInstallHandler) }
        return true
    }

    /// The one line in the log that says the feed was read and understood — what the
    /// manual update test in README.md looks for.
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        NSLog("Waffled: Sparkle found version %@ in the appcast", item.displayVersionString)
    }

    /// An update that will not be installed after all. Sparkle reports the end of a cycle
    /// twice for one abort (this, then the finish below), and every ordinary check that
    /// finds nothing arrives here too — `ServerModel` answers both by asking whether it
    /// had stopped the server for this one.
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        updateCycleEnded(error)
    }

    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck,
                 error: Error?) {
        updateCycleEnded(error)
    }

    /// A nil error is a real end too — Sparkle's installer aborts with one when it decides
    /// not to relaunch — while an install that *succeeds* terminates this app rather than
    /// calling back, which is why acting on the nil case cannot undo an update in flight.
    private func updateCycleEnded(_ error: Error?) {
        let model = model
        let message = error?.localizedDescription
        Task { @MainActor in model.updateCycleEnded(error: message) }
    }
}
