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

/// The warm-white launch screen: the Waffled house mark bouncing on cream. Shown as
/// the cold-launch overlay (`WaffledApp`) and again for the moment `AuthGate` spends
/// reading the Keychain / probing `/auth/status`. The static launch screen paints the
/// same cream (`project.yml` → `UILaunchScreen.UIColorName`) so the hand-off has no
/// flash; the logo just pops in and bobs. (Launch screens themselves can't animate.)
struct SplashView: View {
    @State private var poppedIn = false   // springy scale-in with overshoot
    @State private var bobbing = false    // soft, endless bounce

    var body: some View {
        ZStack {
            WF.canvas.ignoresSafeArea()
            Image("WaffledMark")
                .resizable().scaledToFit()
                .frame(width: 128, height: 128)
                .scaleEffect(poppedIn ? 1 : 0.72)
                .offset(y: bobbing ? -18 : 0)
                .shadow(color: .black.opacity(0.07), radius: 16, y: 10)
        }
        .onAppear {
            withAnimation(.interpolatingSpring(stiffness: 170, damping: 11)) { poppedIn = true }
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(0.18)) {
                bobbing = true
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
    @State private var showKioskSetup = false

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
            WF.canvas.ignoresSafeArea()
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
                    if isKiosk { kioskSetupLink }
                    Spacer(minLength: 24)
                }
                .padding(.horizontal, 28)
                .frame(maxWidth: columnWidth)          // centered, capped column
                .frame(maxWidth: .infinity, minHeight: 0)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .sheet(isPresented: $showKioskSetup) { KioskCodeEntrySheet() }
    }

    /// iPad-only: turn this device into a shared family kiosk (profile picker) instead
    /// of signing one person in. Pairs with a one-time code from an admin.
    private var kioskSetupLink: some View {
        Button { showKioskSetup = true } label: {
            HStack(spacing: 5) {
                Image(systemName: "person.2.fill").font(.system(size: 11, weight: .semibold))
                Text("Set up this iPad as a shared kiosk").font(.system(size: 12.5, weight: .semibold))
            }
            .foregroundStyle(WF.ink2)
        }
        .buttonStyle(.plain).padding(.top, 18)
    }

    private var header: some View {
        VStack(spacing: 10) {
            // Transparent mark floats directly on the cream canvas — no white card.
            Image("WaffledMark").resizable().scaledToFit()
                .frame(width: isKiosk ? 104 : 76, height: isKiosk ? 104 : 76)
            Text(isKiosk ? "Set up your Waffled display" : "Welcome to Waffled")
                .font(.system(size: isKiosk ? 34 : 26, weight: .bold)).foregroundStyle(WF.ink)
            Text(isKiosk ? "Sign in to show your family's hub on this iPad."
                         : "Sign in to your family's household.")
                .font(.system(size: isKiosk ? 18 : 15)).foregroundStyle(WF.ink3)
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
                Text(error).font(.system(size: 13, weight: .medium)).foregroundStyle(WF.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            WaffledPrimaryCTA(
                label: busy ? "Signing in…" : "Sign in",
                tint: WF.primary,
                isDisabled: !canSubmit,
                action: { Task { await submit() } }
            )
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
                Rectangle().fill(WF.hair).frame(height: 1)
                Text("or").font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                Rectangle().fill(WF.hair).frame(height: 1)
            }
            Button { Task { await submitOIDC() } } label: {
                Text(busy ? "Opening…" : label)
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(WF.card)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            }
            .buttonStyle(.plain).disabled(busy)
        }
        .padding(.top, 8)
    }

    private var setupNotice: some View {
        VStack(spacing: 10) {
            Text("This Waffled isn't set up yet.")
                .font(.system(size: 16, weight: .semibold)).foregroundStyle(WF.ink)
            Text("Finish first-run setup on the web, then sign in here with that admin account.")
                .font(.system(size: 14)).foregroundStyle(WF.ink3).multilineTextAlignment(.center)
            Button { Task { busy = true; await session.refreshStatus(); busy = false } } label: {
                Text("Check again").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.primary)
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
                .foregroundStyle(WF.ink3)
            }
            .buttonStyle(.plain)

            if showServer {
                VStack(spacing: 8) {
                    TextField("http://localhost:3000", text: $serverURL)
                        .font(.system(size: 13, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(11).background(WF.panel)
                        .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                    Button {
                        AppConfig.setApiBaseURL(serverURL.trimmingCharacters(in: .whitespaces))
                        Task { busy = true; await session.refreshStatus(); busy = false }
                    } label: {
                        Text("Use this server").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
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
            Text(label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
            Group {
                if secure { SecureField("", text: text) } else { TextField("", text: text) }
            }
            .font(.system(size: 16))
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .keyboardType(keyboard).textContentType(content)
            .focused($focus, equals: focusedOn)
            .padding(14).background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(focus == focusedOn ? WF.primary : WF.hair, lineWidth: focus == focusedOn ? 2 : 1))
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
