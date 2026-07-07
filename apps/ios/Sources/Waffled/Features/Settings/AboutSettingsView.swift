import SwiftUI

/// About & connection. Shows the app version and lets you point the app at your Waffled
/// server — the Caddy origin that serves both the API (`/api`) and uploaded media
/// (`/media`). Real users sign in on the login screen; the developer token here is a
/// local/dev fallback (the same one `mint-token` prints).
struct AboutSettingsView: View {
    @Environment(\.openURL) private var openURL
    @State private var serverAddress = AppConfig.apiBaseURL
    @State private var devToken = AppConfig.storedDevToken
    @State private var savedNote: String?
    @State private var test: TestState = .idle
    @State private var showToken = false
    @State private var tokenSaved = false
    /// Which server build we're talking to + whether a newer one is available (from
    /// `/api/updates`, admin-only), and whether a newer public app build is on the App
    /// Store. Both best-effort — nil just hides the line.
    @State private var update: WaffledAPI.UpdateInfo?
    @State private var appStore: AppStoreCheck.Result?

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
        .background(WF.canvas)
        .navigationTitle("About").navigationBarTitleDisplayMode(.inline)
        .task { await loadMeta() }
    }

    // MARK: app

    private var appCard: some View {
        WaffledCard {
            HStack(spacing: 14) {
                Image("WaffledMark").resizable().scaledToFit().padding(6).frame(width: 56, height: 56)
                    .background(WF.card).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Waffled").font(WF.serif(22)).foregroundStyle(WF.ink)
                    Text("Version \(Self.version) (\(Self.build))")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    if let appStore {
                        Button { openURL(URL(string: appStore.storeURL)!) } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "arrow.up.circle.fill").font(.system(size: 12))
                                Text("Update to \(appStore.version) on the App Store")
                                    .font(.system(size: 12.5, weight: .bold))
                            }.foregroundStyle(WF.primary)
                        }.buttonStyle(.plain).padding(.top, 1)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: server

    private var serverCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Server")
                Text("The address of your Waffled server — the Caddy origin that serves the app and your photos. Use http://localhost:8080 in the simulator, or http://<your-mac-ip>:8080 on a device. The api’s own port (:3000) won’t serve photos.")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                    .fixedSize(horizontal: false, vertical: true)

                Label("Your sign-in is tied to one server. Pointing at a different Waffled won’t carry your account over — even if someone else hosts Waffled, you’ll need an account there, and may see nothing until you sign in again.", systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.gold)
                    .fixedSize(horizontal: false, vertical: true)

                TextField(AppConfig.defaultBaseURL, text: $serverAddress)
                    .font(.system(size: 15, weight: .semibold))
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 13).padding(.vertical, 12).wfField(fill: WF.panel)

                HStack(spacing: 10) {
                    Button { saveServer() } label: {
                        Text("Save").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 20).padding(.vertical, 10)
                            .background(WF.primary).clipShape(Capsule())
                    }.buttonStyle(.plain)

                    Button { testConnection() } label: {
                        HStack(spacing: 6) {
                            if test == .testing { ProgressView().controlSize(.small).tint(WF.ink3) }
                            Text("Test").font(.system(size: 14, weight: .bold)).foregroundStyle(WF.ink2)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(WF.panel).clipShape(Capsule())
                    }.buttonStyle(.plain).disabled(test == .testing)

                    Spacer(minLength: 0)

                    Button { serverAddress = AppConfig.defaultBaseURL } label: {
                        Text("Reset").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
                    }.buttonStyle(.plain)
                }

                testResult
                if let update {
                    HStack(spacing: 6) {
                        Circle().fill(Color(hex: 0x167A4A)).frame(width: 7, height: 7)
                        Text("Server version \(update.current.version)")
                            .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    if update.updateAvailable == true, let latest = update.latest {
                        updateBanner(latest, current: update.current.version)
                    }
                }
                if let savedNote {
                    Text(savedNote).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
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
                .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.primaryD)
                .fixedSize(horizontal: false, vertical: true)
        default:
            EmptyView()
        }
    }

    // MARK: developer token (optional)

    private var tokenCard: some View {
        WaffledCard {
            VStack(alignment: .leading, spacing: 12) {
                SectionLabel(text: "Developer token (optional)")
                Text("A local session token for development — the same one `mint-token` prints. Real users sign in on the login screen; leave this empty unless you’re testing headlessly.")
                    .font(.system(size: 12.5)).foregroundStyle(WF.ink3)
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
                    .padding(.horizontal, 13).padding(.vertical, 12).wfField(fill: WF.panel)

                    Button { showToken.toggle() } label: {
                        Image(systemName: showToken ? "eye.slash" : "eye")
                            .font(.system(size: 15)).foregroundStyle(WF.ink3)
                            .frame(width: 44, height: 44).background(WF.panel)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }.buttonStyle(.plain)
                }

                HStack(spacing: 10) {
                    Button { saveToken() } label: {
                        Text(tokenSaved ? "Saved ✓" : "Save token")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 18).padding(.vertical, 10)
                            .background(WF.primary).clipShape(Capsule())
                    }.buttonStyle(.plain)
                    Button { devToken = ""; saveToken() } label: {
                        Text("Clear").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
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
        update = nil
        Task { await loadMeta() }
    }

    /// Best-effort: the server build + whether one's newer (`/api/updates`, admin-only),
    /// and whether a newer public build is on the App Store. Retries a few times so a
    /// transient failure doesn't leave the lines blank; a 401/403 (non-admin) just stops.
    private func loadMeta() async {
        for _ in 0..<6 {
            do { update = try await WaffledAPI().updates(); break }
            catch let WaffledAPI.APIError.http(code, _) where code == 401 || code == 403 { break }
            catch { try? await Task.sleep(for: .milliseconds(600)) }
        }
        if let r = await AppStoreCheck.latest(), VersionCompare.isNewer(r.version, than: Self.version) {
            appStore = r
        }
    }

    /// A newer server release is out — nudge the operator (the upgrade runs on the host).
    private func updateBanner(_ latest: WaffledAPI.UpdateInfo.Release, current: String) -> some View {
        let display = latest.tag.hasPrefix("v") || latest.tag.hasPrefix("V")
            ? String(latest.tag.dropFirst()) : latest.tag
        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Text("🧇").font(.system(size: 15))
                Text("Update available").font(.system(size: 13, weight: .heavy)).foregroundStyle(WF.primary)
                Spacer(minLength: 0)
                Text("Waffled \(display)").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
            }
            Text("A newer Waffled is out — you’re on \(current). Run `./waffled upgrade` on the server that hosts Waffled.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button { openURL(URL(string: latest.url)!) } label: {
                    Text("Changelog").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ink2)
                        .padding(.horizontal, 13).padding(.vertical, 7)
                        .overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1))
                }.buttonStyle(.plain)
                Button { openURL(URL(string: "https://docs.waffled.app/operations/upgrading/")!) } label: {
                    Text("How to upgrade").font(.system(size: 12.5, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 13).padding(.vertical, 7).background(WF.primary).clipShape(Capsule())
                }.buttonStyle(.plain)
                Spacer(minLength: 0)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WF.primary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.primary.opacity(0.25), lineWidth: 1))
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
