import XCTest
@testable import Waffled

/// Which way a version crossing went.
///
/// `status --json` reports `bundle.previousVersion` and `bundle.versionChangedAt` and
/// deliberately no direction: a rollback is as ordinary an event as an update, and the
/// runtime does not rank them. So the app works it out, and this is the whole of that
/// reasoning.
final class VersionChangeTests: XCTestCase {

    func testACrossingIsWhicheverWayItWent() {
        XCTAssertEqual(VersionChange.describe(previous: "0.14.3", current: "0.15.0"), .upgraded)
        XCTAssertEqual(VersionChange.describe(previous: "0.15.0", current: "0.14.3"), .downgraded)
        XCTAssertEqual(VersionChange.describe(previous: "1.0.0", current: "1.0.0"), .unchanged)
    }

    /// `+build` is metadata, not precedence: two builds of one version are the same
    /// version, and semver says so.
    func testBuildMetadataIsNotAVersion() {
        XCTAssertEqual(VersionChange.describe(previous: "1.0.0+abc", current: "1.0.0+def"),
                       .unchanged)
        XCTAssertEqual(VersionChange.describe(previous: "1.0.0+abc", current: "1.0.1+abc"),
                       .upgraded)
    }

    /// The reason a string compare will not do: "0.9.10" sorts before "0.9.9" as text and
    /// after it as a version.
    func testComponentsCompareAsNumbersNotText() {
        XCTAssertEqual(VersionChange.describe(previous: "0.9.10", current: "0.9.9"), .downgraded)
        XCTAssertEqual(VersionChange.describe(previous: "0.9.9", current: "0.9.10"), .upgraded)
    }

    /// A shorter version is the same version with zeroes after it — and a data directory
    /// that has never crossed reports an empty `previousVersion`, which is not a rollback
    /// from nothing.
    func testMissingComponentsAreZeroAndMissingVersionsAreNoCrossing() {
        XCTAssertEqual(VersionChange.describe(previous: "1.0", current: "1.0.0"), .unchanged)
        XCTAssertEqual(VersionChange.describe(previous: "1.0", current: "1.0.1"), .upgraded)
        XCTAssertEqual(VersionChange.describe(previous: "", current: "0.15.0"), .unchanged)
        XCTAssertEqual(VersionChange.describe(previous: "0.15.0", current: ""), .unchanged)
    }

    /// A version this project cannot order is not a version it will name a direction for.
    /// The runtime refuses the same strings for the same reason
    /// (`apps/runtime/internal/status/version.go`), and two answers about one crossing that
    /// disagreed would be worse than either: a pre-release read as a fourth number makes
    /// `0.15.0-rc.1` → `0.15.0` a *rollback*, which is the direction being wrong.
    func testAVersionThatCannotBeOrderedIsNotADirection() {
        XCTAssertEqual(VersionChange.describe(previous: "0.15.0-rc.1", current: "0.15.0"),
                       .unchanged,
                       "a release candidate is not a fourth version number")
        XCTAssertEqual(VersionChange.describe(previous: "main-abc1234", current: "0.15.0"),
                       .unchanged,
                       "a git description names a commit, not a place in an order")
        XCTAssertEqual(VersionChange.describe(previous: "0.14.3", current: "0.15.0-3-gabc1234"),
                       .unchanged,
                       "commits since a tag are not a patch level")
    }

    // MARK: the feed-URL test seam

    /// `WAFFLED_APPCAST_URL` points the updater at a feed you are serving yourself, which
    /// is the only way to exercise an update without publishing one. It is not a security
    /// boundary — the EdDSA key is — so it is honoured in every build.
    func testTheAppcastURLCanBeOverriddenFromTheEnvironment() {
        XCTAssertEqual(
            Updates.feedURL(environment: ["WAFFLED_APPCAST_URL": "http://127.0.0.1:8123/appcast.xml"]),
            "http://127.0.0.1:8123/appcast.xml")
        XCTAssertNil(Updates.feedURL(environment: [:]),
                     "no override means the SUFeedURL the app shipped with")
        XCTAssertNil(Updates.feedURL(environment: ["WAFFLED_APPCAST_URL": ""]),
                     "an empty value is not an override")
    }

    /// A unit-test bundle is injected into this very app, so `WaffledApp` — and everything
    /// it builds — runs during `xcodebuild test`. An updater started there checks the real
    /// feed over the network on every test run and writes Sparkle's bookkeeping into the
    /// app's defaults; the suite must not do either.
    func testTheUpdaterDoesNotStartInsideATestRun() {
        XCTAssertFalse(Updates.startsUpdater(environment: ProcessInfo.processInfo.environment),
                       "this assertion is running inside the host app — the real check")
        XCTAssertTrue(Updates.startsUpdater(environment: [:]),
                      "an ordinary launch starts it")
    }
}
