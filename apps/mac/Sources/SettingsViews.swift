import AppKit
import SwiftUI

// MARK: - Settings

/// `Settings…`: three tabs over one Apply. Basic is the first run's rows, as drawers;
/// Advanced and Diagnostics are `SettingsCatalog`. Every word is decided in
/// `SettingsPresentation` — this only draws it.
struct SettingsStep: View {
    var screen: SettingsPresentation
    @Bindable var model: ServerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                SettingsTabPicker(tab: $model.settingsTab)

                // Everything that answers "did that work?" sits beside the title, where a
                // person is already looking.
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(screen.title).font(SetupTheme.title(24))
                    if let confirmation = screen.confirmation {
                        Label(confirmation, systemImage: "checkmark.circle")
                            .font(SetupTheme.small)
                            .foregroundStyle(SetupTheme.green)
                            .transition(.opacity)
                    }
                }
                Text(screen.message)
                    .font(SetupTheme.body)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if screen.needsRestart {
                    WarningNote(text: SettingsPresentation.Copy.restartNote)
                }
                // Shown on every tab: a problem on Advanced is what keeps Apply off on Basic.
                ProblemList(problems: screen.problems)
            }
            .padding(.horizontal, SetupTheme.pad)
            .padding(.top, 28)
            .padding(.bottom, 14)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch screen.tab {
                    case .basic:
                        SetupOptionRows(model: model, settings: screen)
                    case .advanced:
                        AddressAndPorts(screen: screen, address: model.status?.serverAddress)
                        CatalogSections(sections: SettingsCatalog.advanced, model: model)
                    case .diagnostics:
                        CatalogSections(sections: SettingsCatalog.diagnostics, model: model)
                        LogsPanel(model: model)
                    }
                }
                .padding(.horizontal, SetupTheme.pad)
                .padding(.bottom, 24)
            }
        }
        .animation(.easeOut(duration: 0.18), value: screen.confirmation)
    }
}

/// Basic / Advanced / Diagnostics, on both `Settings…` and the first run's options step.
struct SettingsTabPicker: View {
    @Binding var tab: SettingsPresentation.Tab

    var body: some View {
        Picker("", selection: $tab) {
            ForEach(SettingsPresentation.Tab.allCases, id: \.self) { tab in
                Text(tab.label).tag(tab)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .frame(width: 330)
        .padding(.bottom, 4)
    }
}

/// The reasons a screen cannot be applied, in the words its value chose.
struct ProblemList: View {
    var problems: [String]

    var body: some View {
        ForEach(problems, id: \.self) { problem in
            Label(problem, systemImage: "exclamationmark.circle")
                .font(SetupTheme.small)
                .foregroundStyle(SetupTheme.primary)
        }
    }
}

// MARK: - Basic: the rows both screens show

/// The five rows the first run and Basic share, bound to the same `model.setupOptions`.
///
/// Four open into a drawer — `Change…` becomes `Done` — so the collapsed list fits the
/// window. `settings` being non-nil is what makes this the after-setup screen: the folder
/// is moved rather than chosen, and the port is left to Advanced, read-only.
struct SetupOptionRows: View {
    @Bindable var model: ServerModel
    var settings: SettingsPresentation?

    @State private var open: SettingsDrawer?
    @State private var folderRefusal: String?
    @State private var ollama: OllamaProbe.Result?
    @State private var ollamaAsked = 0

    init(model: ServerModel, settings: SettingsPresentation?, initiallyOpen: SettingsDrawer? = nil) {
        self.model = model
        self.settings = settings
        _open = State(initialValue: initiallyOpen)
    }

    private typealias Copy = FirstRunPresentation.OptionsCopy

    var body: some View {
        VStack(spacing: 0) {
            filesRow
            Divider().overlay(SetupTheme.hairline)
            backupRow
            Divider().overlay(SetupTheme.hairline)
            addressRow
            Divider().overlay(SetupTheme.hairline)
            providerRow
            Divider().overlay(SetupTheme.hairline)
            loginRow
        }
        .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 14))
    }

    private func toggle(_ drawer: SettingsDrawer) {
        withAnimation(.easeOut(duration: 0.15)) { open = open == drawer ? nil : drawer }
    }

    // The folder is settled once a data directory has been initialized. On the first run
    // that makes the row a place to look; in Settings it makes it a move, which is a copy
    // and a restart rather than a setting.
    private var folderIsSettled: Bool { model.status?.initialized == true }

    private var filesRow: some View {
        DrawerRow(icon: "folder", title: Copy.files.title, summary: model.dataDirectory.path,
                  monoSummary: true, isOpen: open == .files, toggle: { toggle(.files) }) {
            VStack(alignment: .leading, spacing: 8) {
                Text(settings == nil ? Copy.files.hint : SettingsPresentation.Copy.filesHint)
                    .font(SetupTheme.small)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    if let settings {
                        Button(SettingsPresentation.Copy.move) { chooseFolder() }
                            .buttonStyle(SetupButton(kind: .ghost))
                            .disabled(!settings.moveEnabled)
                        if model.offersDefaultFolder {
                            Button(SettingsPresentation.Copy.moveToDefault) { useDefaultFolder() }
                                .buttonStyle(SetupButton(kind: .ghost))
                                .disabled(!settings.moveEnabled)
                        }
                        revealButton
                    } else if folderIsSettled {
                        revealButton
                    } else {
                        Button(Copy.files.choose) { chooseFolder() }
                            .buttonStyle(SetupButton(kind: .ghost))
                        if model.offersDefaultFolder {
                            Button(Copy.files.useDefault) { useDefaultFolder() }
                                .buttonStyle(SetupButton(kind: .ghost))
                        }
                    }
                }
                if model.offersDefaultFolder, settings != nil || !folderIsSettled {
                    Text(model.defaultFolderNote).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .textSelection(.enabled)
                }
                if settings == nil, folderIsSettled {
                    Text(Copy.files.settled).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                }
                if let refusal = settings?.moveRefusal {
                    Text(refusal).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let refusal = folderRefusal {
                    Text(refusal).font(SetupTheme.small).foregroundStyle(SetupTheme.primary)
                }
                if settings != nil, folderRefusal == nil, let note = model.folderNote {
                    Text(note).font(SetupTheme.small).foregroundStyle(SetupTheme.inkSecondary)
                }
            }
        }
    }

    private var revealButton: some View {
        Button(Copy.files.reveal) {
            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: model.dataDirectory.path)
        }
        .buttonStyle(SetupButton(kind: .ghost))
    }

    private func useDefaultFolder() {
        folderRefusal = nil
        model.useDefaultFolder()
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.directoryURL = model.dataDirectory.deletingLastPathComponent()
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let picked = panel.url else { return }
        // Asked of the folder that was picked, not of a path typed anywhere: the answers
        // are facts about the volume it sits on and about our access to it.
        if let refusal = Setup.refusal(for: picked) {
            folderRefusal = refusal
            return
        }
        folderRefusal = nil
        // Waffled gets a folder of its own inside their choice, so picking Documents does
        // not scatter a database through Documents.
        let destination = Setup.dataDirectory(forChosen: picked, current: model.dataDirectory)
        // Before setup this is only a choice; afterwards it is a copy of everything the
        // household has, which the runtime does with the server stopped.
        if settings == nil {
            model.chooseDataDirectory(destination)
        } else {
            model.moveDataDirectory(to: destination)
        }
    }

    private var backupRow: some View {
        DrawerRow(icon: "arrow.down.circle", title: Copy.backup.title,
                  summary: SettingsDrawer.backup.summary(model.setupOptions),
                  isOpen: open == .backup, toggle: { toggle(.backup) }) {
            VStack(alignment: .leading, spacing: 10) {
                Toggle(Copy.backup.toggle, isOn: $model.setupOptions.backupEnabled)
                    .toggleStyle(.switch)
                    .font(SetupTheme.small)
                HStack(spacing: 10) {
                    Text(Copy.backup.at).font(SetupTheme.small)
                    Picker("", selection: $model.setupOptions.backupAt) {
                        ForEach(SetupOptions.backupTimes, id: \.self) { at in
                            Text(SetupOptions.backupTimeLabel(at)).tag(at)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 110)
                    Text(Copy.backup.keep).font(SetupTheme.small).padding(.leading, 8)
                    Picker("", selection: $model.setupOptions.backupKeep) {
                        ForEach(SetupOptions.retentionChoices, id: \.self) { keep in
                            Text("\(keep) backups").tag(keep)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 120)
                }
                .disabled(!model.setupOptions.backupEnabled)
                Text(model.setupOptions.backupEnabled ? Copy.backup.keepHint : Copy.backup.off)
                    .font(SetupTheme.small)
                    .foregroundStyle(SetupTheme.inkTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var addressRow: some View {
        DrawerRow(icon: "globe", title: Copy.address.title,
                  summary: SettingsDrawer.address.summary(model.setupOptions),
                  isOpen: open == .address, toggle: { toggle(.address) }) {
            VStack(alignment: .leading, spacing: 10) {
                Text(Copy.address.hint).font(SetupTheme.small)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Picker("", selection: $model.setupOptions.addressMode) {
                    ForEach(FirstRunPresentation.OptionsCopy.addressModes, id: \.0) { mode in
                        Text(mode.1).tag(mode.0)
                    }
                }
                .labelsHidden()
                .pickerStyle(.radioGroup)

                if model.setupOptions.addressMode == .custom {
                    TextField(Copy.address.custom, text: $model.setupOptions.customHost)
                        .textFieldStyle(.roundedBorder)
                        .font(SetupTheme.mono)
                        .frame(maxWidth: 320)
                    Text(Copy.address.customHint).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                // A field before setup and a fact afterwards, shown on Advanced. HTTP_PORT
                // is the preference for the first allocation and nothing after it.
                if settings == nil {
                    HStack(spacing: 10) {
                        Text(Copy.address.port).font(SetupTheme.small)
                        TextField("", text: $model.setupOptions.port)
                            .textFieldStyle(.roundedBorder)
                            .font(SetupTheme.mono)
                            .frame(width: 90)
                    }
                    Text(Copy.address.portHint).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// Whether the key field is standing in front of a key already saved. A blank there is
    /// "unchanged", so it says so rather than looking like nothing is set.
    private var keyAlreadySaved: Bool {
        settings != nil && model.setupOptions.provider == model.appliedOptions.provider
    }

    private var providerRow: some View {
        DrawerRow(icon: "sparkles", title: "\(Copy.provider.title) \(Copy.provider.optional)",
                  summary: SettingsDrawer.provider.summary(model.setupOptions),
                  isOpen: open == .provider, toggle: { toggle(.provider) }) {
            VStack(alignment: .leading, spacing: 10) {
                Picker("", selection: $model.setupOptions.provider) {
                    ForEach(SetupOptions.Provider.allCases, id: \.self) { provider in
                        Text(provider.label).tag(provider)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(maxWidth: 480)

                switch model.setupOptions.provider {
                case .none:
                    Text(settings != nil && model.appliedOptions.provider != .none
                         ? Copy.provider.notNowClears : Copy.provider.notNow)
                        .font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                case .anthropic:
                    keyField
                case .openai:
                    keyField
                    TextField(Copy.provider.baseURLPlaceholder, text: $model.setupOptions.openAIBaseURL)
                        .textFieldStyle(.roundedBorder)
                        .font(SetupTheme.mono)
                        .frame(maxWidth: 360)
                    Text(Copy.provider.baseURLHint).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                case .ollama:
                    TextField(SetupOptions.defaultOllamaHost, text: $model.setupOptions.ollamaHost)
                        .textFieldStyle(.roundedBorder)
                        .font(SetupTheme.mono)
                        .frame(maxWidth: 360)
                    HStack(spacing: 10) {
                        Text((ollama ?? .checking).sentence)
                            .font(SetupTheme.small)
                            .foregroundStyle(ollamaColor)
                            .fixedSize(horizontal: false, vertical: true)
                        Button(Copy.provider.checkAgain) { ollamaAsked += 1 }
                            .buttonStyle(.link)
                            .font(SetupTheme.small)
                    }
                }

                if model.setupOptions.provider != .none {
                    Text(Copy.provider.hint).font(SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            // Asked when Ollama is chosen, when its address changes (after a pause, so not
            // on every keystroke) and when someone clicks Check again — never on a timer.
            .task(id: "\(model.setupOptions.provider.rawValue)|\(model.setupOptions.ollamaHost)|\(ollamaAsked)") {
                guard model.setupOptions.provider == .ollama else { return }
                ollama = .checking
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard !Task.isCancelled else { return }
                let result = await OllamaProbe.check(host: model.setupOptions.ollamaHost)
                guard !Task.isCancelled else { return }
                ollama = result
            }
        }
    }

    private var keyField: some View {
        SecureField(keyAlreadySaved ? Copy.provider.savedPlaceholder : Copy.provider.placeholder,
                    text: $model.setupOptions.providerKey)
            .textFieldStyle(.roundedBorder)
            .font(SetupTheme.mono)
            .frame(maxWidth: 360)
    }

    private var ollamaColor: Color {
        switch ollama {
        case .running: return SetupTheme.green
        case .notAnswering: return SetupTheme.primary
        default: return SetupTheme.inkSecondary
        }
    }

    private var loginRow: some View {
        OptionRow(icon: "power", title: Copy.login.title, detail: Copy.login.detail) {
            Toggle("", isOn: $model.setupOptions.startAtLogin)
                .labelsHidden()
                .toggleStyle(.switch)
        }
    }
}

/// A row that says what is in force and opens into its controls. `Change…` becomes
/// `Done`; nothing is applied until the screen's own button is clicked.
struct DrawerRow<Content: View>: View {
    var icon: String
    var title: String
    var summary: String
    var monoSummary = false
    var isOpen: Bool
    var toggle: () -> Void
    var content: Content

    init(icon: String, title: String, summary: String, monoSummary: Bool = false,
         isOpen: Bool, toggle: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.icon = icon
        self.title = title
        self.summary = summary
        self.monoSummary = monoSummary
        self.isOpen = isOpen
        self.toggle = toggle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 14, weight: .semibold))
                    Text(summary)
                        .font(monoSummary ? SetupTheme.mono : SetupTheme.small)
                        .foregroundStyle(SetupTheme.inkSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 12)
                Button(isOpen ? FirstRunPresentation.OptionsCopy.done
                              : FirstRunPresentation.OptionsCopy.files.change, action: toggle)
                    .buttonStyle(SetupButton(kind: .ghost))
            }
            if isOpen {
                content
                    .padding(.leading, 34)
                    .transition(.opacity)
            }
        }
        .padding(16)
    }
}

/// One row with its control on the right and nothing to open — Start at login.
struct OptionRow<Trailing: View>: View {
    var icon: String
    var title: String
    var detail: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(SetupTheme.inkSecondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(detail)
                    .font(SetupTheme.small)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            trailing()
        }
        .padding(16)
    }
}

// MARK: - Advanced and Diagnostics

/// The address and the published port, as facts. The port is never a field after setup:
/// every device in the house points at it, and `HTTP_PORT` would not move it anyway.
private struct AddressAndPorts: View {
    var screen: SettingsPresentation
    var address: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeading(title: "Address and ports", detail: screen.portNote)
            Divider().overlay(SetupTheme.hairline)
            FactRow(label: "Address in use", value: address ?? "—")
            Divider().overlay(SetupTheme.hairline)
            FactRow(label: FirstRunPresentation.OptionsCopy.address.port, value: screen.portValue)
        }
        .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct FactRow: View {
    var label: String
    var value: String

    var body: some View {
        HStack(spacing: 12) {
            Text(label).font(.system(size: 13)).frame(width: 260, alignment: .leading)
            Text(value).font(SetupTheme.mono).foregroundStyle(SetupTheme.inkSecondary)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

private struct SectionHeading: View {
    var title: String
    var detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 14, weight: .semibold))
            Text(detail)
                .font(SetupTheme.small)
                .foregroundStyle(SetupTheme.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
    }
}

/// Internal, not private: the first run's options step (`FirstRunWindow.swift`) shows the
/// same Advanced and Diagnostics tabs.
struct CatalogSections: View {
    var sections: [SettingsSection]
    @Bindable var model: ServerModel
    /// Before setup no secret has been saved, so its field must not say one is hidden.
    var afterSetup = true

    var body: some View {
        ForEach(sections, id: \.title) { section in
            VStack(alignment: .leading, spacing: 0) {
                SectionHeading(title: section.title, detail: section.detail)
                ForEach(section.settings, id: \.key) { setting in
                    Divider().overlay(SetupTheme.hairline)
                    SettingField(setting: setting, model: model, afterSetup: afterSetup)
                }
            }
            .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}

/// One catalog setting: its label and the variable it writes on the left, the control on
/// the right, and the reason it cannot be applied underneath when there is one.
private struct SettingField: View {
    var setting: EnvSetting
    @Bindable var model: ServerModel
    var afterSetup: Bool

    private var value: Binding<String> {
        Binding(get: { model.setupOptions.settings[setting.key] ?? "" },
                set: { model.setupOptions.settings[setting.key] = $0 })
    }

    private var secret: Binding<String> {
        Binding(get: { model.setupOptions.secrets[setting.key] ?? "" },
                set: { model.setupOptions.secrets[setting.key] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(setting.label).font(.system(size: 13))
                    Text(setting.key)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(SetupTheme.inkTertiary)
                        .textSelection(.enabled)
                }
                .frame(width: 260, alignment: .leading)
                control
                Spacer(minLength: 0)
            }
            if let problem = setting.problem(value.wrappedValue) {
                Text(problem).font(SetupTheme.small).foregroundStyle(SetupTheme.primary)
                    .padding(.leading, 272)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var control: some View {
        switch setting.kind {
        case .secret:
            SecureField(afterSetup ? FirstRunPresentation.OptionsCopy.provider.secretPlaceholder : "",
                        text: secret)
                .textFieldStyle(.roundedBorder)
                .font(SetupTheme.mono)
                .frame(maxWidth: 360)
        case .toggle:
            Toggle("", isOn: Binding(get: { value.wrappedValue == "1" },
                                     set: { value.wrappedValue = $0 ? "1" : "" }))
                .labelsHidden()
                .toggleStyle(.switch)
        case let .choice(choices, fallback):
            // The default is stored as blank, so choosing it again after a change puts
            // the runtime's own default back rather than writing it down.
            Picker("", selection: Binding(
                get: { value.wrappedValue.isEmpty ? fallback : value.wrappedValue },
                set: { value.wrappedValue = $0 == fallback ? "" : $0 })) {
                ForEach(choices, id: \.value) { choice in
                    Text(choice.label).tag(choice.value)
                }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .frame(maxWidth: 400)
        case .count, .seconds:
            TextField(setting.placeholder, text: value)
                .textFieldStyle(.roundedBorder)
                .font(SetupTheme.mono)
                .frame(width: 120)
        case .text, .url:
            TextField(setting.placeholder, text: value)
                .textFieldStyle(.roundedBorder)
                .font(SetupTheme.mono)
                .frame(maxWidth: 360)
        }
    }
}

private struct LogsPanel: View {
    var model: ServerModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeading(title: "Logs", detail: """
                One file per service, rotated as they grow. Support will usually ask for \
                runtime.log and api.log.
                """)
            Divider().overlay(SetupTheme.hairline)
            HStack(spacing: 12) {
                Text(model.logsDirectory.path)
                    .font(SetupTheme.mono)
                    .foregroundStyle(SetupTheme.inkSecondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
                Spacer(minLength: 12)
                Button(SettingsPresentation.Copy.showLogs) { model.revealLogs() }
                    .buttonStyle(SetupButton(kind: .ghost))
            }
            .padding(16)
        }
        .background(SetupTheme.panel, in: RoundedRectangle(cornerRadius: 14))
    }
}
