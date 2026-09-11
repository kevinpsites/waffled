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
        // The setup design is one warm light palette, drawn in explicit colours. Left to
        // follow the system it would put dark-mode chrome around a paper-coloured page.
        window.appearance = NSAppearance(named: .aqua)
        // A window created in code releases itself when closed, and this one is shown
        // again — the retry after a failed start closes nothing but would come back to a
        // freed window.
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        self.window = window
        return window
    }

    /// The close box. On the welcome and options steps nothing has been created yet, so
    /// closing means "not on this Mac" and the app goes too; after that it is only a
    /// window in front of a server that is already coming up, and the menu carries on.
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
        if let content = model.windowPresentation {
            VStack(spacing: 0) {
                screen(content)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                footer(content)
            }
            .frame(width: SetupTheme.windowSize.width, height: SetupTheme.windowSize.height)
            .background(SetupTheme.background)
            .foregroundStyle(SetupTheme.ink)
        }
    }

    @ViewBuilder
    private func screen(_ window: ServerModel.WindowContent) -> some View {
        switch window {
        case let .firstRun(step): content(step)
        case let .settings(screen): SettingsStep(screen: screen, model: model)
        }
    }

    @ViewBuilder
    private func footer(_ window: ServerModel.WindowContent) -> some View {
        switch window {
        case let .firstRun(step): footer(step)
        case let .settings(screen):
            SetupFooter(
                secondary: (screen.secondaryButton, { model.closeSettings() }),
                primary: (screen.primaryButton, {
                    switch screen.primaryAction {
                    case .apply: model.applySettings()
                    case .restart: model.restartServer()
                    }
                }),
                primaryEnabled: screen.applyEnabled)
        }
    }

    @ViewBuilder
    private func content(_ step: FirstRunPresentation) -> some View {
        switch step.step {
        case .welcome: WelcomeStep(step: step, model: model)
        case .options: OptionsStep(step: step, model: model)
        case .starting: StartingStep(step: step)
        case .ready: ReadyStep(step: step, model: model)
        case .failed: FailedStep(step: step)
        }
    }

    @ViewBuilder
    private func footer(_ step: FirstRunPresentation) -> some View {
        switch step.step {
        case .welcome:
            SetupFooter(
                tertiary: step.tertiaryButton.map { ($0, { model.showSetupOptions() }) },
                secondary: step.secondaryButton.map { ($0, { NSApp.terminate(nil) }) },
                primary: step.primaryButton.map { ($0, { model.beginSetup() }) },
                // The same condition the options step uses. `Back` does not discard what
                // was typed, so an invalid port left there makes `beginSetup` a no-op —
                // and a live button that does nothing is the bug this branch keeps fixing.
                primaryEnabled: !model.busy && model.setupOptions.problems.isEmpty)
        case .options:
            SetupFooter(
                tertiary: step.tertiaryButton.map { ($0, { model.hideSetupOptions() }) },
                primary: step.primaryButton.map { ($0, { model.beginSetup() }) },
                primaryEnabled: !model.busy && model.setupOptions.problems.isEmpty)
        case .starting:
            SetupFooter(
                tertiary: step.tertiaryButton.map { ($0, { model.revealLogs() }) })
        case .ready:
            SetupFooter(
                secondary: step.secondaryButton.map { ($0, { model.copySetupAddress() }) },
                primary: step.primaryButton.map { ($0, { model.openWaffledFromSetup() }) })
        case .failed:
            SetupFooter(
                tertiary: step.tertiaryButton.map { ($0, { model.revealLogs() }) },
                primary: step.primaryButton.map { ($0, { model.beginSetup() }) },
                primaryEnabled: !model.busy)
        }
    }
}

// MARK: - 1 · Welcome

private struct WelcomeStep: View {
    var step: FirstRunPresentation
    var model: ServerModel

    var body: some View {
        HStack(alignment: .top, spacing: 36) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    AppMark(side: 44)
                    Text(step.title).font(SetupTheme.title(30))
                }
                Text(step.message)
                    .font(.system(size: 15))
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(step.promises, id: \.lead) { promise in
                        HStack(alignment: .top, spacing: 10) {
                            SetupTick(side: 18)
                            (Text(promise.lead).bold() + Text(" ") + Text(promise.rest))
                                .font(SetupTheme.body)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.top, 6)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: 16) {
                InsidePanel(components: step.components)
                if let note = step.portableNote { WarningNote(text: note) }
                Spacer(minLength: 0)
            }
            .frame(width: 340)
        }
        .padding(SetupTheme.pad)
    }
}

/// The versions really shipping in this bundle, read from the runtime's own manifest.
private struct InsidePanel: View {
    var components: [FirstRunPresentation.Component]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Already inside this app")
                .font(SetupTheme.eyebrow)
                .foregroundStyle(SetupTheme.inkTertiary)
            ForEach(components, id: \.name) { component in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(component.name).font(.system(size: 13, weight: .semibold))
                        Text(component.role)
                            .font(SetupTheme.small)
                            .foregroundStyle(SetupTheme.inkSecondary)
                    }
                    Spacer(minLength: 8)
                    Text(component.version)
                        .font(SetupTheme.mono)
                        .foregroundStyle(SetupTheme.inkTertiary)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// Internal, not private: Settings (`SettingsViews.swift`) shows its restart note in it.
struct WarningNote: View {
    var text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(SetupTheme.primary)
            Text(text)
                .font(SetupTheme.small)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(SetupTheme.noteBackground, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// The app's own icon, which is also what Finder, the Dock and every alert show.
private struct AppMark: View {
    var side: CGFloat

    var body: some View {
        Image(nsImage: NSApp.applicationIconImage)
            .resizable()
            .frame(width: side, height: side)
            .accessibilityHidden(true)
    }
}

// MARK: - 2 · Where things go

private struct OptionsStep: View {
    var step: FirstRunPresentation
    @Bindable var model: ServerModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let eyebrow = step.eyebrow {
                    Text(eyebrow).font(SetupTheme.eyebrow).foregroundStyle(SetupTheme.inkTertiary)
                }
                Text(step.title).font(SetupTheme.title(24))
                Text(step.message)
                    .font(SetupTheme.body)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                SetupOptionRows(model: model, settings: nil)
                    .padding(.top, 8)

                ProblemList(problems: model.setupOptions.problems)
            }
            .padding(SetupTheme.pad)
        }
    }
}

// MARK: - 3 · Setting up

private struct StartingStep: View {
    var step: FirstRunPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(step.title).font(SetupTheme.title(24))
            Text(step.message)
                .font(SetupTheme.body)
                .foregroundStyle(SetupTheme.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 10) {
                ForEach(step.services, id: \.label) { service in
                    HStack(alignment: .center, spacing: 12) {
                        if service.isReady {
                            SetupTick(side: 20)
                        } else {
                            ProgressView().controlSize(.small).frame(width: 20, height: 20)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(service.label).font(.system(size: 14, weight: .semibold))
                            Text(service.detail)
                                .font(SetupTheme.small)
                                .foregroundStyle(SetupTheme.inkSecondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.top, 6)

            if let progress = step.progress {
                ProgressView(value: progress)
                    .tint(SetupTheme.primary)
                    .frame(maxWidth: .infinity)
            }
            Text(step.lastLogLine ?? " ")
                .font(SetupTheme.mono)
                .foregroundStyle(SetupTheme.inkTertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .padding(SetupTheme.pad)
    }
}

// MARK: - 4 · Ready

private struct ReadyStep: View {
    var step: FirstRunPresentation
    var model: ServerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                SetupTick(side: 30)
                Text(step.title).font(SetupTheme.title(26))
            }
            Text(step.message)
                .font(SetupTheme.body)
                .foregroundStyle(SetupTheme.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 28) {
                VStack(alignment: .leading, spacing: 16) {
                    if let address = step.address { AddressCard(address: address) }
                    if let note = step.menuBarNote { MenuBarNote(text: note, model: model) }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let address = step.address,
                   let qr = QRCode.image(for: address.url, side: 190) {
                    VStack(spacing: 10) {
                        Image(nsImage: qr)
                            .interpolation(.none)
                            .frame(width: 190, height: 190)
                        Text("Scan with a phone camera to open Waffled.")
                            .font(SetupTheme.small)
                            .foregroundStyle(SetupTheme.inkSecondary)
                            .multilineTextAlignment(.center)
                            .frame(width: 190)
                    }
                }
            }
            .padding(.top, 6)
        }
        .padding(SetupTheme.pad)
    }
}

private struct AddressCard: View {
    var address: FirstRunPresentation.Address

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Type this into the tablet's browser")
                .font(SetupTheme.eyebrow)
                .foregroundStyle(SetupTheme.inkTertiary)
            Text(address.host)
                .font(.system(size: 24, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
            if let alternate = address.alternate {
                Text("If a device can't find that name, use \(alternate) instead — same Waffled, dependable on any network.")
                    .font(SetupTheme.small)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let portNote = address.portNote {
                Text(portNote)
                    .font(SetupTheme.small)
                    .foregroundStyle(SetupTheme.inkTertiary)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// The mark drawn here is the template one the menu bar really shows, not the app icon:
/// the paragraph is telling someone what to look for at the top of their screen.
private struct MenuBarNote: View {
    var text: String
    var model: ServerModel

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(nsImage: model.image(pointSize: 18))
                .renderingMode(.template)
                .foregroundStyle(SetupTheme.ink)
                .padding(8)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
            Text(text)
                .font(SetupTheme.small)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - 5 · Could not start

private struct FailedStep: View {
    var step: FirstRunPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 34))
                .foregroundStyle(SetupTheme.primary)
            Text(step.title).font(SetupTheme.title(24))
            Text(step.message)
                .font(SetupTheme.body)
                .foregroundStyle(SetupTheme.inkSecondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(SetupTheme.pad)
    }
}
