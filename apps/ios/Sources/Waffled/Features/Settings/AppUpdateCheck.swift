import Foundation

/// Semver comparison shared by the App Store and server update checks. Lenient by
/// design — a leading "v", a pre-release suffix, or a non-numeric tag never counts as
/// newer, so a weird release name can't nag people into a bogus "update available".
enum VersionCompare {
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        let a = parts(candidate), b = parts(current)
        if a.allSatisfy({ $0 == 0 }) { return false }   // 0.0.0 / unparseable → never newer
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    private static func parts(_ s: String) -> [Int] {
        let core = s.trimmingCharacters(in: CharacterSet(charactersIn: "vV "))
            .split(separator: "-").first.map(String.init) ?? ""
        return core.split(separator: ".").map { Int($0) ?? 0 }
    }
}

/// Looks up the live App Store version for our bundle id via Apple's public iTunes
/// lookup API — the standard "is there an update?" poll (there's no push equivalent).
/// Only meaningful once the app is public on the App Store; returns nil in TestFlight,
/// pre-launch, or when offline, so callers just skip the nudge.
enum AppStoreCheck {
    struct Result: Sendable { let version: String; let storeURL: String }

    private struct Lookup: Decodable {
        struct Entry: Decodable { let version: String; let trackViewUrl: String }
        let results: [Entry]
    }

    static func latest(bundleId: String = "app.waffled") async -> Result? {
        guard let url = URL(string: "https://itunes.apple.com/lookup?bundleId=\(bundleId)") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let entry = (try? JSONDecoder().decode(Lookup.self, from: data))?.results.first
        else { return nil }
        return Result(version: entry.version, storeURL: entry.trackViewUrl)
    }
}
