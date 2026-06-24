import SwiftUI

/// About & connection. Shows the app version and lets you point the app at your Nook
/// server — the Caddy origin that serves both the API (`/api`) and uploaded media
/// (`/media`). Real users sign in on the login screen; the developer token here is a
/// local/dev fallback (the same one `mint-token` prints).
struct AboutSettingsView: View {
    @State private var serverAddress = AppConfig.apiBaseURL
    @State private var devToken = AppConfig.storedDevToken
    @State private var savedNote: String?
    @State private var test: TestState = .idle
    @State private var showToken = false
    @State private var tokenSaved = false

    private enum TestState: Equatable { case idle, testing, ok(Int), fail }

    private static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }
    private static var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                appCard
                serverCard
                tokenCard
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(NK.canvas)
        .navigationTitle("About").navigationBarTitleDisplayMode(.inline)
    }

    // MARK: app

    private var appCard: some View {
        NookCard {
            HStack(spacing: 14) {
                Text("🪺").font(.system(size: 32)).frame(width: 56, height: 56)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Nook").font(NK.serif(22)).foregroundStyle(NK.ink)
                    Text("Version \(Self.version) (\(Self.build))")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: server

    private var serverCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Server")
                Text("The address of your Nook server — the Caddy origin that serves the app and your photos. Use http://localhost:8080 in the simulator, or http://<your-mac-ip>:8080 on a device. The api’s own port (:3000) won’t serve photos.")
                    .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                    .fixedSize(horizontal: false, vertical: true)

                TextField(AppConfig.defaultBaseURL, text: $serverAddress)
                    .font(.system(size: 15, weight: .semibold))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 13).padding(.vertical, 12).nkField(fill: NK.panel)

                HStack(spacing: 10) {
                    Button { saveServer() } label: {
                        Text("Save").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 20).padding(.vertical, 10)
                            .background(NK.primary).clipShape(Capsule())
                    }.buttonStyle(.plain)

                    Button { testConnection() } label: {
                        HStack(spacing: 6) {
                            if test == .testing { ProgressView().controlSize(.small).tint(NK.ink3) }
                            Text("Test").font(.system(size: 14, weight: .bold)).foregroundStyle(NK.ink2)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(NK.panel).clipShape(Capsule())
                    }.buttonStyle(.plain).disabled(test == .testing)

                    Spacer(minLength: 0)

                    Button { serverAddress = AppConfig.defaultBaseURL } label: {
                        Text("Reset").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                    }.buttonStyle(.plain)
                }

                testResult
                if let savedNote {
                    Text(savedNote).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private var testResult: some View {
        switch test {
        case .ok(let code):
            Label("Server responded (HTTP \(code)) — reachable.", systemImage: "checkmark.circle.fill")
                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Color(hex: 0x3E9D5B))
        case .fail:
            Label("Couldn’t reach that address. Check the IP/port and that the stack is running.", systemImage: "xmark.octagon.fill")
                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.primaryD)
                .fixedSize(horizontal: false, vertical: true)
        default:
            EmptyView()
        }
    }

    // MARK: developer token (optional)

    private var tokenCard: some View {
        NookCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Developer token (optional)")
                Text("A local session token for development — the same one `mint-token` prints. Real users sign in on the login screen; leave this empty unless you’re testing headlessly.")
                    .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    Group {
                        if showToken {
                            TextField("Paste a token…", text: $devToken)
                        } else {
                            SecureField("Paste a token…", text: $devToken)
                        }
                    }
                    .font(.system(size: 14)).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .padding(.horizontal, 13).padding(.vertical, 12).nkField(fill: NK.panel)

                    Button { showToken.toggle() } label: {
                        Image(systemName: showToken ? "eye.slash" : "eye")
                            .font(.system(size: 15)).foregroundStyle(NK.ink3)
                            .frame(width: 44, height: 44).background(NK.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }.buttonStyle(.plain)
                }

                HStack(spacing: 10) {
                    Button { saveToken() } label: {
                        Text(tokenSaved ? "Saved ✓" : "Save token")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 18).padding(.vertical, 10)
                            .background(NK.primary).clipShape(Capsule())
                    }.buttonStyle(.plain)
                    Button { devToken = ""; saveToken() } label: {
                        Text("Clear").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink3)
                    }.buttonStyle(.plain)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    // MARK: actions

    private func saveServer() {
        AppConfig.setApiBaseURL(serverAddress)
        // Reflect the cleaned/normalized value (trailing slash stripped, blank → default).
        serverAddress = AppConfig.apiBaseURL
        test = .idle
        savedNote = "Saved. New requests use this address — pull to refresh, or relaunch the app to reload everything."
    }

    private func saveToken() {
        AppConfig.setDevToken(devToken)
        tokenSaved = true
    }

    private func testConnection() {
        let base = serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: base.hasSuffix("/") ? base + "api/health" : base + "/api/health") else {
            test = .fail; return
        }
        test = .testing
        Task {
            do {
                var req = URLRequest(url: url); req.timeoutInterval = 6
                let (_, resp) = try await URLSession.shared.data(for: req)
                // Any HTTP status (even 401/500) means the server answered — it's reachable.
                test = .ok((resp as? HTTPURLResponse)?.statusCode ?? 0)
            } catch {
                test = .fail
            }
        }
    }
}
