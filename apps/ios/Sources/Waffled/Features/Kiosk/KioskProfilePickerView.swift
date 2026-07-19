import SwiftUI

/// The shared-kiosk **profile picker** — the iPad family display's "who's using this?"
/// screen. Shown (by `KioskGate`) whenever this iPad is paired as a kiosk and nobody
/// has claimed a profile yet. Tapping a face claims it; a PIN-protected face first
/// asks for the code on `KioskPinPad`. On a successful claim the per-person session is
/// adopted and the kiosk shell takes over.
///
/// ⚠️ KEEP IN SYNC with the web `apps/web/src/kiosk/ProfilePicker.tsx` +
/// `apps/web/src/kiosk/PinPad.tsx` — same flow, lock affordance, and error handling.
struct KioskProfilePickerView: View {
    @Environment(KioskMode.self) private var kiosk
    @Environment(SyncManager.self) private var sync
    @Environment(Session.self) private var session

    @State private var profiles: [WaffledAPI.KioskProfile] = []
    @State private var deviceLabel: String?
    @State private var loaded = false
    @State private var loadError: String?

    // Claim state
    @State private var pinFor: WaffledAPI.KioskProfile?     // non-nil → PIN pad up
    @State private var claiming: WaffledAPI.KioskProfile?   // non-nil → spinner on that card
    @State private var claimError: String?
    @State private var showEscape = false                // server-address / exit hatch

    private let api = WaffledAPI()
    private let columns = [GridItem(.adaptive(minimum: 160, maximum: 220), spacing: 24)]

    var body: some View {
        ZStack {
            WF.canvas.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                if !loaded {
                    WaffledLoading(top: 80)
                    Spacer()
                } else if profiles.isEmpty {
                    emptyState
                } else {
                    grid
                }
            }
            .frame(maxWidth: 900)
            .frame(maxWidth: .infinity)
        }
        .task { await load() }
        // Re-poll so a newly added / renamed member appears without a relaunch, and the
        // device keeps its "last seen" fresh while parked on the picker.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                await api.kioskHeartbeat()
                await load(silent: true)
            }
        }
        .sheet(item: $pinFor) { profile in
            KioskPinPad(profile: profile) { pin in await attempt(profile, pin: pin) }
        }
        .overlay(alignment: .bottom) {
            if let claimError {
                Text(claimError)
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.onInk)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(WF.ink.opacity(0.92)).clipShape(Capsule())
                    .padding(.bottom, 40).transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: claimError)
        // Always-reachable escape hatch: check/fix the server address or exit shared-kiosk
        // mode. Without this, a device pointed at a bad server (or remotely unpaired) is
        // stranded on the picker with no way back to the sign-in screen short of a reinstall.
        .overlay(alignment: .bottomTrailing) { escapeButton }
        .sheet(isPresented: $showEscape) {
            KioskPickerEscapeSheet {
                loaded = false
                Task { await load() }
            }
        }
    }

    private var escapeButton: some View {
        Button { showEscape = true } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink3)
                .frame(width: 44, height: 44)
                .background(WF.card2).clipShape(Circle())
                .overlay(Circle().strokeBorder(WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain).padding(24)
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image("WaffledMark").resizable().scaledToFit()
                .frame(width: 80, height: 80)
            Text(deviceLabel ?? "Family hub")
                .font(WF.serif(34, .bold)).foregroundStyle(WF.ink)
            Text("Who’s using the iPad?")
                .font(.system(size: 18)).foregroundStyle(WF.ink3)
        }
        .padding(.top, 64).padding(.bottom, 44)
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 24) {
                ForEach(profiles) { card($0) }
            }
            .padding(.horizontal, 28).padding(.bottom, 48)
        }
    }

    private func card(_ p: WaffledAPI.KioskProfile) -> some View {
        Button {
            claimError = nil
            if p.hasPin { pinFor = p } else { Task { await attempt(p, pin: nil) } }
        } label: {
            VStack(spacing: 14) {
                ZStack {
                    Avatar(colorHex: p.colorHex, emoji: p.avatarEmoji ?? "🙂", size: 110)
                    if claiming?.id == p.id {
                        Circle().fill(.black.opacity(0.28)).frame(width: 110, height: 110)
                        ProgressView().tint(.white)
                    }
                }
                HStack(spacing: 6) {
                    Text(p.name).font(.system(size: 19, weight: .semibold)).foregroundStyle(WF.ink)
                    if p.hasPin { Image(systemName: "lock.fill").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3) }
                }
            }
            .frame(maxWidth: .infinity).padding(.vertical, 22)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            .wfShadow1()
        }
        .buttonStyle(.plain)
        .disabled(claiming != nil)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Text("🙈").font(.system(size: 56))
            Text("No profiles to show")
                .font(.system(size: 20, weight: .bold)).foregroundStyle(WF.ink)
            Text(loadError ?? "Add household members (and toggle “Show on kiosk”) from Settings on another device.")
                .font(.system(size: 15)).foregroundStyle(WF.ink3)
                .multilineTextAlignment(.center).padding(.horizontal, 40)
            Button {
                loaded = false; Task { await load() }
            } label: {
                Text("Try again").font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.primary)
            }
            .buttonStyle(.plain).padding(.top, 6)
            Spacer()
        }
    }

    // MARK: data

    private func load(silent: Bool = false) async {
        do {
            let resp = try await api.kioskProfiles()
            profiles = resp.profiles
            deviceLabel = resp.deviceLabel ?? kiosk.deviceLabel
            loadError = nil
        } catch let WaffledAPI.APIError.http(code, _) where code == 401 {
            // The device's own credential was rejected — an admin unpaired this kiosk.
            // Forget the pairing and fall back to login rather than a dead picker.
            kiosk.handleDeviceRevoked()
        } catch is KioskDeviceAuth.NotPaired {
            kiosk.handleDeviceRevoked()
        } catch {
            if !silent { loadError = "Couldn’t load profiles. Check the connection." }
        }
        loaded = true
    }

    private func attempt(_ p: WaffledAPI.KioskProfile, pin: String?) async -> KioskMode.ClaimOutcome {
        claiming = p
        defer { claiming = nil }
        let outcome = await kiosk.claim(p, pin: pin, sync: sync, session: session)
        switch outcome {
        case .ok:
            pinFor = nil   // gate flips to the shell
        case let .failed(msg):
            pinFor = nil; claimError = msg
        case .wrongPin, .lockedOut:
            break          // the PIN pad shows these inline
        }
        return outcome
    }
}

/// A large touch keypad for entering a profile's 4–8 digit kiosk PIN. Returns the
/// claim outcome to keep showing wrong-PIN / lockout feedback inline; dismisses itself
/// only on success (the picker flips to the shell).
struct KioskPinPad: View {
    let profile: WaffledAPI.KioskProfile
    /// Submit the entered PIN; returns the outcome so we can show retry/lockout copy.
    let onSubmit: (String) async -> KioskMode.ClaimOutcome

    @Environment(\.dismiss) private var dismiss
    @State private var pin = ""
    @State private var message: String?
    @State private var busy = false
    @State private var lockedUntil: Int = 0     // remaining lockout seconds

    private let maxLen = 8
    private let keys: [String] = ["1","2","3","4","5","6","7","8","9","⌫","0","✓"]

    var body: some View {
        ZStack {
            WF.canvas.ignoresSafeArea()
            VStack(spacing: 26) {
                Avatar(colorHex: profile.colorHex, emoji: profile.avatarEmoji ?? "🙂", size: 84)
                Text(profile.name).font(.system(size: 22, weight: .bold)).foregroundStyle(WF.ink)
                Text(lockedUntil > 0 ? "Locked — try again in \(lockedUntil)s" : "Enter your PIN")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(lockedUntil > 0 ? WF.primary : WF.ink3)
                dots
                if let message, lockedUntil == 0 {
                    Text(message).font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.primary)
                }
                keypad
            }
            .padding(.vertical, 40).frame(maxWidth: 380)
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(busy)
        .overlay(alignment: .topTrailing) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 40, height: 40).background(WF.card2).clipShape(Circle())
            }
            .buttonStyle(.plain).padding(20)
        }
        // Tick down an active lockout.
        .task(id: lockedUntil) {
            guard lockedUntil > 0 else { return }
            try? await Task.sleep(for: .seconds(1))
            if lockedUntil > 0 { lockedUntil -= 1 }
        }
    }

    private var dots: some View {
        HStack(spacing: 14) {
            ForEach(0..<max(pin.count + 1, 4), id: \.self) { i in
                Circle()
                    .fill(i < pin.count ? WF.ink : WF.hair)
                    .frame(width: 14, height: 14)
            }
        }
        .frame(height: 16)
    }

    private var keypad: some View {
        let cols = Array(repeating: GridItem(.flexible(), spacing: 22), count: 3)
        return LazyVGrid(columns: cols, spacing: 20) {
            ForEach(keys, id: \.self) { k in keyButton(k) }
        }
        .padding(.horizontal, 30).padding(.top, 6)
        .disabled(busy || lockedUntil > 0)
    }

    @ViewBuilder
    private func keyButton(_ k: String) -> some View {
        if k == "✓" {
            roundKey(k, tint: pin.count >= 4 ? WF.primary : WF.ink3, fg: .white) { Task { await submit() } }
                .disabled(pin.count < 4 || busy)
        } else if k == "⌫" {
            roundKey(k, tint: .clear, fg: WF.ink2) { if !pin.isEmpty { pin.removeLast(); message = nil } }
        } else {
            roundKey(k, tint: WF.card, fg: WF.ink) {
                guard pin.count < maxLen else { return }
                pin.append(k); message = nil
            }
        }
    }

    private func roundKey(_ label: String, tint: Color, fg: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group {
                if label == "⌫" { Image(systemName: "delete.left").font(.system(size: 24, weight: .medium)) }
                else if label == "✓" { Image(systemName: "checkmark").font(.system(size: 26, weight: .bold)) }
                else { Text(label).font(.system(size: 30, weight: .semibold)) }
            }
            .foregroundStyle(fg)
            .frame(width: 78, height: 78)
            .background(tint)
            .clipShape(Circle())
            .overlay(Circle().strokeBorder(WF.hair, lineWidth: tint == WF.card ? 1 : 0))
        }
        .buttonStyle(.plain)
    }

    private func submit() async {
        guard pin.count >= 4, !busy else { return }
        busy = true; message = nil
        let outcome = await onSubmit(pin)
        busy = false
        switch outcome {
        case .ok:
            break   // picker dismisses us
        case let .wrongPin(triesLeft):
            pin = ""
            message = triesLeft > 0 ? "Incorrect PIN — \(triesLeft) \(triesLeft == 1 ? "try" : "tries") left" : "Incorrect PIN"
        case let .lockedOut(retryAfter):
            pin = ""; lockedUntil = retryAfter
        case let .failed(msg):
            message = msg
        }
    }
}

/// The picker's escape hatch. Lets whoever is in front of the iPad **check or correct the
/// server address** (the usual cause of a "couldn't reach the server" on claim) and retry
/// in place, or **exit shared-kiosk mode** entirely — forgetting the pairing locally and
/// dropping back to the normal sign-in screen. This is deliberately the only non-claim
/// affordance on the picker, so a misconfigured or remotely-unpaired kiosk is always
/// recoverable on-device without a reinstall.
struct KioskPickerEscapeSheet: View {
    @Environment(KioskMode.self) private var kiosk
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    /// Re-load the picker after the server address changes (mints a fresh device token
    /// against the new base and re-fetches profiles).
    let onServerChanged: () -> Void

    @State private var serverURL = AppConfig.apiBaseURL
    @State private var serverError: String?
    @State private var confirmExit = false

    var body: some View {
        ZStack {
            WF.canvas.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 24) {
                    header
                    serverSection
                    exitSection
                }
                .padding(28).frame(maxWidth: 520).frame(maxWidth: .infinity)
            }
        }
        .presentationDetents([.medium, .large])
        .overlay(alignment: .topTrailing) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink2)
                    .frame(width: 40, height: 40).background(WF.card2).clipShape(Circle())
            }
            .buttonStyle(.plain).padding(20)
        }
        .confirmationDialog("Exit shared kiosk on this iPad?", isPresented: $confirmExit, titleVisibility: .visible) {
            Button("Exit kiosk mode", role: .destructive) {
                // Local-only: forget the device pairing and return to sign-in. We can't
                // revoke server-side here (nobody is signed in on the picker); an admin can
                // remove the leftover device entry from Settings → Display & Kiosk later.
                kiosk.handleDeviceRevoked()
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This iPad goes back to the normal sign-in screen. The household and everyone's data are untouched.")
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Text("⚙️").font(.system(size: 40))
            Text("Kiosk settings").font(WF.serif(26, .bold)).foregroundStyle(WF.ink)
        }
        .padding(.top, 12)
    }

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Server address").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            TextField("http://localhost:3000", text: $serverURL)
                .font(.system(size: 14, design: .monospaced))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .keyboardType(.URL)
                .padding(12).background(WF.panel)
                .clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                .onChange(of: serverURL) { _, _ in serverError = nil }
            if let serverError {
                Text(serverError).font(.system(size: 12)).foregroundStyle(WF.primaryD)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                guard AppConfig.setApiBaseURL(serverURL) else {
                    serverError = "Enter a full server address beginning with http:// or https://."
                    return
                }
                serverURL = AppConfig.apiBaseURL
                KioskDeviceAuth.shared.invalidate()   // old base's device token no longer applies
                onServerChanged()
                dismiss()
            } label: {
                Text("Use this server & retry").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(WF.card2).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
            }
            .buttonStyle(.plain)
            Text("If profiles load but tapping a face fails, the address is usually fine — try again, or ask an admin to re-check this kiosk.")
                .font(.system(size: 12)).foregroundStyle(WF.ink3)
        }
        .padding(18).background(WF.card)
        .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous).strokeBorder(WF.hair, lineWidth: 1))
    }

    private var exitSection: some View {
        Button { confirmExit = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.portrait.and.arrow.right").font(.system(size: 14, weight: .semibold))
                Text("Exit shared kiosk").font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(WF.primary)
            .frame(maxWidth: .infinity).padding(.vertical, 14)
            .background(WF.card).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.primary.opacity(0.4), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
