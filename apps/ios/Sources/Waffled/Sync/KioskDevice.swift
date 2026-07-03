import Foundation

/// The shared-kiosk **device identity** for an iPad family display.
///
/// Separate from the per-person session (`AuthTokens`): pairing this iPad as a
/// household kiosk stores a long-lived `deviceSecret` in the Keychain. That secret
/// is exchanged (by `KioskDeviceAuth`) for short-lived device access tokens that can
/// list profiles and claim one — the device-scoped half of the web kiosk model
/// (`apps/web/src/lib/api/kiosk.ts` `deviceFetch`). Once a profile is claimed the
/// app runs on that person's normal access/refresh pair, exactly like a login.
///
/// ⚠️ KEEP IN SYNC with the web kiosk client (`apps/web/src/lib/api/client.ts`
/// `getKioskDevice`/`setKioskDevice`, `apps/web/src/lib/api/kiosk.ts`) and the
/// server kiosk routes — the token shapes and endpoints must match.
enum KioskDeviceStore {
    private static let secretKey = "waffled.kiosk.deviceSecret"
    private static let labelKey = "waffled.kiosk.deviceLabel"

    /// The long-lived device secret (nil until this iPad is paired as a kiosk).
    static var secret: String? { Keychain.get(secretKey) }
    /// Whether this iPad has been set up as a shared family kiosk.
    static var isPaired: Bool { secret != nil }
    /// The device's display name, shown above the profile picker.
    static var label: String? {
        get { UserDefaults.standard.string(forKey: labelKey) }
        set {
            if let v = newValue, !v.isEmpty { UserDefaults.standard.set(v, forKey: labelKey) }
            else { UserDefaults.standard.removeObject(forKey: labelKey) }
        }
    }

    /// Persist a freshly paired device secret (from pair-by-code or admin promote).
    static func savePaired(secret: String, label: String?) {
        Keychain.set(secretKey, secret)
        Self.label = label
        KioskDeviceAuth.shared.invalidate()
    }

    /// Forget the device identity entirely (un-kiosk this iPad). Does not touch the
    /// per-person session — callers clear `AuthTokens` separately when needed.
    static func clear() {
        Keychain.set(secretKey, nil)
        UserDefaults.standard.removeObject(forKey: labelKey)
        KioskDeviceAuth.shared.invalidate()
    }
}

/// Mints and caches the short-lived **device** access token from the stored
/// `deviceSecret`, mirroring the web's `deviceFetch` refresh. Plain HS-token exchange
/// against `/api/kiosk/device/token` (no bearer needed — the secret IS the credential).
/// An actor so concurrent profile polls share one in-flight refresh.
actor KioskDeviceAuth {
    static let shared = KioskDeviceAuth()

    private var cached: String?

    struct NotPaired: Error {}
    private struct TokenResp: Decodable { let accessToken: String; let expiresIn: Int? }

    /// A device access token, minting one if we don't already hold a live one.
    func token() async throws -> String {
        if let cached { return cached }
        return try await refresh()
    }

    /// Force-mint a fresh device access token (called after a 401 on a device call).
    @discardableResult
    func refresh() async throws -> String {
        guard let secret = KioskDeviceStore.secret else { throw NotPaired() }
        var req = URLRequest(url: URL(string: AppConfig.apiBaseURL + "/api/kiosk/device/token")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["deviceSecret": secret])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            // Unknown/revoked device → the secret is dead; drop it so the UI can
            // surface "this kiosk was unpaired" instead of looping on 401s.
            if (resp as? HTTPURLResponse)?.statusCode == 401 { cached = nil }
            throw WaffledAPI.APIError.http((resp as? HTTPURLResponse)?.statusCode ?? -1,
                                        String(data: data, encoding: .utf8) ?? "")
        }
        let t = try WaffledAPI.decoder.decode(TokenResp.self, from: data).accessToken
        cached = t
        return t
    }

    /// Drop the cached token (after re-pairing or unpairing).
    nonisolated func invalidate() { Task { await self.clearCache() } }
    private func clearCache() { cached = nil }
}
