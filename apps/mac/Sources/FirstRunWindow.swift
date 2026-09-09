import AppKit
import SwiftUI

/// The app's one window (plan §6), built by hand.
///
/// An `LSUIElement` app has no window scene and no Dock icon, so there is nothing for
/// SwiftUI to attach a `Window` or a sheet to, and nothing to bring the app forward:
/// `NSApp.activate(ignoringOtherApps:)` before ordering it front, or a first run opens
/// behind whatever the person was reading.
@MainActor
final class FirstRunWindow: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private weak var model: ServerModel?

    /// Called from every poll, so it must be idempotent: a window already on screen is
    /// left exactly where it is. Ordering it front again twice a second would take the
    /// keyboard back from whatever a person was doing while the server came up — and,
    /// because activating pulls the app onto the active Space, would drag the window
    /// around with them.
    func show(model: ServerModel) {
        self.model = model
        guard window?.isVisible != true else { return }
        let window = window ?? make(for: model)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        window?.orderOut(nil)
    }

    private func make(for model: ServerModel) -> NSWindow {
        // A hosting *controller* rather than a hosting view: the window then sizes itself
        // to the SwiftUI content and resizes as the steps change, which they do.
        let window = NSWindow(contentViewController: NSHostingController(
            rootView: FirstRunView(model: model)))
        window.title = "Waffled"
        window.styleMask = [.titled, .closable]
        // A window created in code releases itself when closed, and this one is shown
        // again — the retry after a failed start closes nothing but would come back to a
        // freed window.
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        self.window = window
        return window
    }

    /// The close box. On the welcome step nothing has been created yet, so closing it
    /// means "not on this Mac" and the app goes too; after that it is only a window in
    /// front of a server that is already coming up, and the menu carries on.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard model?.firstRunPresentation?.closeQuitsApp != true else {
            NSApp.terminate(nil)
            return false
        }
        model?.dismissFirstRunWindow()
        return true
    }
}

/// The window's content: a rendering of `FirstRunPresentation` and nothing else. Every
/// word, button and tick it draws is decided in that value, which is where they are tested.
struct FirstRunView: View {
    @Bindable var model: ServerModel

    var body: some View {
        if let step = model.firstRunPresentation {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .center, spacing: 12) {
                    Image(nsImage: model.image(pointSize: 28))
                        .renderingMode(.template)
                        .foregroundStyle(.primary)
                        .accessibilityHidden(true)
                    Text(step.title)
                        .font(.title2.weight(.semibold))
                }

                Text(step.message)
                    .fixedSize(horizontal: false, vertical: true)

                if let note = step.portableNote {
                    Text(note)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !step.services.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(step.services, id: \.label) { service in
                            Label {
                                Text(service.label)
                                    .foregroundStyle(service.isReady ? .primary : .secondary)
                            } icon: {
                                Image(systemName: service.isReady
                                      ? "checkmark.circle.fill" : "circle.dashed")
                                .foregroundStyle(service.isReady ? Color.green : Color.secondary)
                            }
                        }
                    }
                }

                HStack {
                    if let secondary = step.secondaryButton {
                        Button(secondary) { model.revealLogs() }
                    }
                    Spacer()
                    if let primary = step.primaryButton {
                        // Both buttons that exist mean the same thing — start the server,
                        // as a person — which is also what spends the auto-start attempt.
                        Button(primary) { model.startServer() }
                            .keyboardShortcut(.defaultAction)
                    }
                }
            }
            .padding(24)
            .frame(width: 420, alignment: .leading)
        }
    }
}
