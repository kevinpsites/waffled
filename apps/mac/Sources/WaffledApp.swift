import SwiftUI

/// Waffled for Mac: a menu-bar icon that runs the family server and gets out of the way.
///
/// There is no window and no Dock icon (`LSUIElement`) on purpose — the product is the web
/// app the server serves, exactly as the plan's §1 says. Everything this app can do,
/// `waffled-runtime` can do from Terminal.
@main
struct WaffledApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = ServerModel.shared
    /// Started here rather than from the delegate because Sparkle's own SwiftUI recipe
    /// starts the updater with the app: it has a scheduled check to arm, and the menu item
    /// has to know from the first time the menu is opened whether it can check.
    @State private var updater = Updater(model: ServerModel.shared)

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model, updater: updater)
        } label: {
            // The Waffled mark, drawn in CoreGraphics as a template image: macOS
            // recolours it for light, dark and the menu's own highlight, so the state is
            // carried by shape (outline, cooking holes, solid, slash) and never by colour.
            Image(nsImage: model.currentImage)
                .accessibilityLabel(model.icon.accessibilityLabel)
        }
        // .menu, not .window: the §2 mock-up is a menu, and .menu is what draws like every
        // other menu-bar item on the Mac.
        .menuBarExtraStyle(.menu)
    }
}

/// The polling loop is started from the delegate rather than from a view: a
/// `MenuBarExtra`'s content is not built until someone opens the menu, and the server has
/// to be on its way up long before that.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { ServerModel.shared.begin() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated { ServerModel.shared.end() }
    }
}

private struct MenuContent: View {
    @Bindable var model: ServerModel
    let updater: Updater

    var body: some View {
        let menu = model.presentation(canCheckForUpdates: updater.canCheckForUpdates)

        Text("\(menu.statusTint.glyph) \(menu.statusLine)")

        Button("Open Waffled") { model.openWebApp() }
            .disabled(!menu.openEnabled)

        // The way back from a stopped server or a start that refused. Auto-start is one
        // attempt per launch by design, so the retry is a person's click, never a timer.
        if menu.showStart {
            Button("Start Waffled") { model.startServer() }
                .disabled(!menu.startEnabled)
        }

        Divider()

        Button(menu.addressLine) { model.copyServerAddress() }
            .disabled(!menu.addressEnabled)

        // The address as something a phone's camera can read, for every device that
        // arrives after the one launch the ready step's code appeared on.
        Button("Show QR code…") { model.showAddressCode() }
            .disabled(!menu.shareEnabled)

        // Any reason goes in the label: a .help(_:) tooltip does not render on an item in
        // a .menu-style MenuBarExtra, and an unexplained control is worse than none. Only
        // the two statuses that a click here genuinely cannot change stop being a toggle.
        switch model.loginItem.control {
        case let .toggle(isOn, note):
            Toggle(note.map { "Start at login — \($0)" } ?? "Start at login", isOn: Binding(
                get: { isOn },
                set: { model.loginItem.setEnabled($0) }))
        case let .openSettings(reason):
            Button("Start at login — \(reason)") { model.loginItem.openSystemSettings() }
        case let .unavailable(reason):
            Button("Start at login — \(reason)") {}
                .disabled(true)
        }

        Button("Back up now") { model.backUpNow() }
            .disabled(!menu.backupEnabled)

        // The options screen again, on a Mac where Waffled already lives. It borrows the
        // app's one window, so it is off while the first-run window has it.
        Button("Settings…") { model.openSettings() }
            .disabled(!menu.settingsEnabled)

        Button(menu.checkForUpdatesLabel) {
            switch menu.updateAction {
            case .check: updater.checkForUpdates()
            case .installNow: model.installPendingUpdate()
            }
        }
        .disabled(!menu.checkForUpdatesEnabled)

        if menu.showLogs {
            Button("Show logs") { model.revealLogs() }
        }

        Divider()

        // The title carries the second question after a stop that refused, because an
        // alert cannot ask it: by then the app is staying, not leaving. With an update
        // prepared it carries a refusal instead — see `Lifecycle.QuitAction`.
        Button(menu.quitTitle) { model.confirmAndQuit() }
            .disabled(!menu.quitEnabled)
    }
}

private extension StatusTint {
    /// The dot in front of the status line. It is a character rather than a coloured view
    /// because this line is disabled — greyed, per the §2 mock-up — and a menu greys the
    /// colour out of it anyway; the shape is what survives, and it is enough.
    var glyph: String {
        switch self {
        case .running: return "●"
        case .starting: return "◐"
        case .idle: return "○"
        case .fault: return "⚠"
        }
    }
}
