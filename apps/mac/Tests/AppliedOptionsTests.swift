import XCTest
@testable import Waffled

/// `Settings…` shows what a household already chose and applies only the difference, so
/// the app has to remember what it last applied. config.env cannot answer that: `config
/// set` is write-only by design, and the one value that matters most must never be read
/// back out of it anyway.
final class AppliedOptionsTests: XCTestCase {

    private final class Memory: UpdateMemory {
        var values: [String: Any] = [:]
        func string(forKey key: String) -> String? { values[key] as? String }
        func set(_ value: Any?, forKey key: String) { values[key] = value }
    }

    func testAHouseholdThatHasNeverAppliedAnythingGetsTheDefaults() {
        XCTAssertEqual(Setup.appliedOptions(in: Memory()), SetupOptions())
    }

    func testWhatWasAppliedComesBackNextLaunch() {
        let memory = Memory()
        var applied = SetupOptions()
        applied.addressMode = .custom
        applied.customHost = "waffled.home"
        applied.backupEnabled = false
        applied.backupAt = "01:00"
        applied.startAtLogin = false
        applied.provider = .openai
        applied.port = "8081"

        Setup.remember(applied, in: memory)
        let read = Setup.appliedOptions(in: memory)

        XCTAssertEqual(read.addressMode, .custom)
        XCTAssertEqual(read.customHost, "waffled.home")
        XCTAssertFalse(read.backupEnabled)
        XCTAssertEqual(read.backupAt, "01:00")
        XCTAssertFalse(read.startAtLogin)
        XCTAssertEqual(read.provider, .openai)
        XCTAssertEqual(read.port, "8081")
    }

    /// The default address is not the one every household chose: a household that took
    /// this Mac's name keeps it, or every phone holding that address would lose the server.
    func testAHouseholdThatChoseTheNameKeepsIt() {
        let memory = Memory()
        var applied = SetupOptions()
        applied.addressMode = .name
        Setup.remember(applied, in: memory)

        let settings = Setup.appliedOptions(in: memory)
        XCTAssertEqual(settings.addressMode, .name)
        XCTAssertTrue(settings.commandsForChange(from: settings).isEmpty,
                      "opening Settings and pressing Apply rewrites nothing")
    }

    /// The provider key is a secret. It goes into config.env, which is owner-only, and
    /// never into the app's own preferences file — which is neither owner-only nor
    /// something a household would think to look in.
    func testTheProviderKeyIsNeverRemembered() {
        let memory = Memory()
        var applied = SetupOptions()
        applied.providerKey = "sk-secret"
        Setup.remember(applied, in: memory)

        let stored = memory.values.values.compactMap { $0 as? String }.joined()
        XCTAssertFalse(stored.contains("sk-secret"), "a key must not reach UserDefaults")
        XCTAssertTrue(Setup.appliedOptions(in: memory).providerKey.isEmpty,
                      "the field starts empty, which reads as `I did not change it`")
    }

    /// A preferences file someone edited, or one written by a version that spelled these
    /// differently, must not stop the screen from opening.
    func testNonsenseInTheMemoryReadsAsTheDefaults() {
        let memory = Memory()
        memory.set("{not json", forKey: Setup.appliedOptionsKey)
        XCTAssertEqual(Setup.appliedOptions(in: memory), SetupOptions())
    }
}
