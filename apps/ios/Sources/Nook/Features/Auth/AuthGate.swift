import SwiftUI

/// Wraps the whole app: shows a brief splash while we decide, the login screen when
/// signed out, and the real content once authenticated. Mirrors the web's `AuthGate`.
struct AuthGate<Content: View>: View {
    @Environment(Session.self) private var session
    @ViewBuilder var content: () -> Content

    var body: some View {
        switch session.phase {
        case .loading:
            SplashView()
        case .login:
            LoginView()
        case .authed:
            content()
        }
    }
}

/// The warm-white launch screen shown for the moment it takes to read the Keychain
/// and probe `/auth/status`.
struct SplashView: View {
    var body: some View {
        ZStack {
            NK.canvas.ignoresSafeArea()
            VStack(spacing: 14) {
                Text("🪺").font(.system(size: 52))
                ProgressView().tint(NK.ink3)
            }
        }
    }
}

/// Email + password sign-in. If the instance hasn't been set up yet we say so
/// (setup is a one-time web/admin action) rather than shipping a wizard here.
struct LoginView: View {
    @Environment(Session.self) private var session
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false
    @State private var showServer = false
    @State private var serverURL = AppConfig.apiBaseURL

    @FocusState private var focus: Field?
    private enum Field { case email, password }

    private var notInitialized: Bool { session.status?.initialized == false }

    /// The iPad runs the family display; its sign-in (initial + re-auth after token
    /// expiry) reads larger and stays a centered column rather than stretching the
    /// fields across the panel. See `apps/ios/IPAD_ROADMAP.md` (Phase 1).
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }
    /// Cap the sign-in column so the form doesn't span an iPad; a no-op on iPhone
    /// (the phone's content is already narrower than this).
    private var columnWidth: CGFloat { isKiosk ? 520 : 460 }

    var body: some View {
        ZStack {
            NK.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 48)
                    header
                    if notInitialized {
                        setupNotice
                    } else {
                        form
                    }
                    serverDisclosure
                    Spacer(minLength: 24)
                }
                .padding(.horizontal, 28)
                .frame(maxWidth: columnWidth)          // centered, capped column
                .frame(maxWidth: .infinity, minHeight: 0)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Text("🪺").font(.system(size: isKiosk ? 76 : 56))
            Text(isKiosk ? "Set up your Nook display" : "Welcome to Nook")
                .font(.system(size: isKiosk ? 34 : 26, weight: .bold)).foregroundStyle(NK.ink)
            Text(isKiosk ? "Sign in to show your family's hub on this iPad."
                         : "Sign in to your family's household.")
                .font(.system(size: isKiosk ? 18 : 15)).foregroundStyle(NK.ink3)
                .multilineTextAlignment(.center)
        }
        .padding(.bottom, isKiosk ? 36 : 28)
    }

    private var form: some View {
        VStack(spacing: 14) {
            field("Email", text: $email, focusedOn: .email, keyboard: .emailAddress, content: .username)
                .submitLabel(.next)
                .onSubmit { focus = .password }
            field("Password", text: $password, focusedOn: .password, secure: true, content: .password)
                .submitLabel(.go)
                .onSubmit { Task { await submit() } }

            if let error {
                Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(NK.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button { Task { await submit() } } label: {
                Text(busy ? "Signing in…" : "Sign in")
                    .font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 15)
                    .background(canSubmit ? NK.primary : NK.ink3)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).disabled(!canSubmit)
            .padding(.top, 4)

            if let label = session.status?.oidc?.buttonLabel {
                ssoButton(label)
            }
        }
    }

    /// "Sign in with <provider>" — backend-mediated OIDC via a secure web session.
    private func ssoButton(_ label: String) -> some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Rectangle().fill(NK.hair).frame(height: 1)
                Text("or").font(.system(size: 12, weight: .semibold)).foregroundStyle(NK.ink3)
                Rectangle().fill(NK.hair).frame(height: 1)
            }
            Button { Task { await submitOIDC() } } label: {
                Text(busy ? "Opening…" : label)
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(NK.card)
                    .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
            }
            .buttonStyle(.plain).disabled(busy)
        }
        .padding(.top, 8)
    }

    private var setupNotice: some View {
        VStack(spacing: 10) {
            Text("This Nook isn't set up yet.")
                .font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink)
            Text("Finish first-run setup on the web, then sign in here with that admin account.")
                .font(.system(size: 14)).foregroundStyle(NK.ink3).multilineTextAlignment(.center)
            Button { Task { busy = true; await session.refreshStatus(); busy = false } } label: {
                Text("Check again").font(.system(size: 14, weight: .semibold)).foregroundStyle(NK.primary)
            }
            .buttonStyle(.plain).padding(.top, 4)
        }
        .padding(.vertical, 8)
    }

    private var serverDisclosure: some View {
        VStack(spacing: 10) {
            Button { withAnimation { showServer.toggle() } } label: {
                HStack(spacing: 5) {
                    Image(systemName: "gearshape").font(.system(size: 11, weight: .semibold))
                    Text("Server address").font(.system(size: 12.5, weight: .semibold))
                }
                .foregroundStyle(NK.ink3)
            }
            .buttonStyle(.plain)

            if showServer {
                VStack(spacing: 8) {
                    TextField("http://localhost:3000", text: $serverURL)
                        .font(.system(size: 13, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(11).background(NK.panel)
                        .clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                    Button {
                        AppConfig.setApiBaseURL(serverURL.trimmingCharacters(in: .whitespaces))
                        Task { busy = true; await session.refreshStatus(); busy = false }
                    } label: {
                        Text("Use this server").font(.system(size: 13, weight: .semibold)).foregroundStyle(NK.ink)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(NK.card2).clipShape(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: NK.rSM, style: .continuous).strokeBorder(NK.hair, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 2)
            }
        }
        .padding(.top, 34)
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, focusedOn: Field,
                       secure: Bool = false, keyboard: UIKeyboardType = .default,
                       content: UITextContentType? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink2)
            Group {
                if secure { SecureField("", text: text) } else { TextField("", text: text) }
            }
            .font(.system(size: 16))
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .keyboardType(keyboard).textContentType(content)
            .focused($focus, equals: focusedOn)
            .padding(14).background(NK.card)
            .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                .strokeBorder(focus == focusedOn ? NK.primary : NK.hair, lineWidth: focus == focusedOn ? 2 : 1))
        }
    }

    private var canSubmit: Bool {
        !busy && !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func submit() async {
        guard canSubmit else { return }
        busy = true; error = nil
        error = await session.login(email: email, password: password)
        busy = false
    }

    private func submitOIDC() async {
        busy = true; error = nil
        error = await session.loginWithOIDC()
        busy = false
    }
}
