import Foundation

/// Which way a version crossing went, worked out from the two versions `status --json`
/// reports (`bundle.version` and `bundle.previousVersion`).
///
/// The runtime deliberately publishes no direction field: re-installing the previous DMG
/// is the supported way back from a bad update, so a rollback is as ordinary an event as
/// an update and the runtime does not rank them. Anything that wants to say which way it
/// went compares the two itself, here.
enum VersionChange: Equatable {
    case upgraded, downgraded, unchanged

    static func describe(previous: String, current: String) -> VersionChange {
        guard !previous.isEmpty, !current.isEmpty else { return .unchanged }
        let a = components(previous)
        let b = components(current)
        for i in 0..<max(a.count, b.count) {
            // A missing component is a zero: 1.0 and 1.0.0 are one version.
            let lhs = i < a.count ? a[i] : 0
            let rhs = i < b.count ? b[i] : 0
            if lhs != rhs { return rhs > lhs ? .upgraded : .downgraded }
        }
        return .unchanged
    }

    /// The numbers, in order. `+build` is metadata rather than precedence (semver §10),
    /// and anything else non-numeric — a `-rc.1`, a git describe suffix — reads as the
    /// release it hangs off, which keeps a pre-release from being announced as a rollback
    /// from the version it precedes.
    private static func components(_ version: String) -> [Int] {
        version
            .split(separator: "+", maxSplits: 1)[0]
            .split(separator: ".")
            .map { Int($0.prefix { $0.isNumber }) ?? 0 }
    }
}

/// The updater's one environment seam.
enum Updates {
    /// Points the updater at a feed you are serving yourself — the only way to exercise an
    /// update without publishing one. It is honoured in every build rather than only in a
    /// debug one, because it is not a security boundary: the EdDSA public key in
    /// `SUPublicEDKey` is what a downloaded update has to satisfy, whatever URL described
    /// it. Documented in README.md.
    static let appcastVariable = "WAFFLED_APPCAST_URL"

    /// Nil means "the `SUFeedURL` the app shipped with" — an empty value is not an
    /// override, for the same reason an empty `WAFFLED_DATA_DIR` is not one.
    static func feedURL(environment: [String: String]) -> String? {
        guard let url = environment[appcastVariable], !url.isEmpty else { return nil }
        return url
    }

    /// Whether this launch should start the updater at all.
    ///
    /// A unit-test bundle is injected into the app, so the whole of `WaffledApp` runs
    /// during `xcodebuild test`. An updater started there would check the real feed over
    /// the network on every test run — and record having done so in the app's defaults —
    /// which is a suite that talks to GitHub to test a pure function.
    static func startsUpdater(environment: [String: String]) -> Bool {
        environment["XCTestConfigurationFilePath"] == nil
    }
}
