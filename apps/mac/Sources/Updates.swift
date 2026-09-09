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

    /// MAJOR.MINOR.PATCH is the whole of the order; a pair where either side is not that
    /// is a crossing with no direction, which `.unchanged` reports by saying nothing.
    private static let segments = 3

    static func describe(previous: String, current: String) -> VersionChange {
        guard let a = numbers(previous), let b = numbers(current) else { return .unchanged }
        for (lhs, rhs) in zip(a, b) where lhs != rhs {
            return rhs > lhs ? .upgraded : .downgraded
        }
        return .unchanged
    }

    /// The numbers, or nothing at all — the runtime's rule from `compareVersions`
    /// (`apps/runtime/internal/status/version.go`), copied because two answers about one
    /// crossing that disagreed would be worse than either.
    ///
    /// Segments left off count as zero, so 1.0 and 1.0.0 are one version, and `+build` says
    /// which build rather than which is newer. Everything else declines: a `-rc.1`, a git
    /// description, a leading `v`. Reading those as the release they hang off is what makes
    /// `0.15.0-rc.1` → `0.15.0` announce itself as a rollback, and a direction that is
    /// wrong is worse than no direction.
    private static func numbers(_ version: String) -> [Int]? {
        let withoutBuild = version
            .trimmingCharacters(in: .whitespaces)
            .split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0]
        let parts = withoutBuild.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= segments else { return nil }

        var out = [Int](repeating: 0, count: segments)
        for (i, part) in parts.enumerated() {
            guard let number = Int(part), number >= 0 else { return nil }
            out[i] = number
        }
        return out
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
