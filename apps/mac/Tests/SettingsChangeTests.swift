import XCTest
@testable import Waffled

/// `Settings…` shows the same rows on an install that already exists, so the question is
/// no longer "what does this household want" but "what did they just change". Only the
/// difference is applied: rewriting every setting on every Apply would put a preference on
/// record that nobody expressed, which is the bug that moved a published port.
final class SettingsChangeTests: XCTestCase {

    private func running() throws -> RuntimeStatus {
        try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
    }

    func testNothingChangedAsksTheRuntimeForNothing() {
        let options = SetupOptions()
        XCTAssertEqual(options.commandsForChange(from: options), [])
    }

    func testANewAddressIsWritten() {
        var changed = SetupOptions()
        changed.addressMode = .ip

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()),
                       [.configSet("WAFFLED_PUBLIC_HOST", "ip")])
    }

    func testANewBackupTimeReinstallsTheSchedule() {
        var changed = SetupOptions()
        changed.backupAt = "01:00"

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()),
                       [RuntimeCommand(subcommand: "backup",
                                       flags: ["--install-schedule", "--at", "01:00"])])
    }

    /// The first-run screen installs nothing when the toggle is off, because there is
    /// nothing of ours on the Mac yet. Here there is, and off has to mean off.
    func testTurningTheBackupOffRemovesTheSchedule() {
        var changed = SetupOptions()
        changed.backupEnabled = false

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()),
                       [RuntimeCommand(subcommand: "backup", flags: ["--uninstall-schedule"])])
    }

    func testTurningTheBackupBackOnInstallsItAtTheChosenTime() {
        var previous = SetupOptions()
        previous.backupEnabled = false
        var changed = previous
        changed.backupEnabled = true
        changed.backupAt = "12:00"

        XCTAssertEqual(changed.commandsForChange(from: previous),
                       [RuntimeCommand(subcommand: "backup",
                                       flags: ["--install-schedule", "--at", "12:00"])])
    }

    /// launchd's label is global — one Mac holds one nightly backup — so a dev run must
    /// not touch the household's real schedule, in either direction.
    func testADevRunNeverTouchesTheNightlyBackup() {
        var off = SetupOptions()
        off.backupEnabled = false
        XCTAssertEqual(off.commandsForChange(from: SetupOptions(), isDevMode: true), [])

        var later = SetupOptions()
        later.backupAt = "01:00"
        XCTAssertEqual(later.commandsForChange(from: SetupOptions(), isDevMode: true), [])
    }

    func testANewProviderKeyIsWrittenUnderItsOwnProvider() {
        var changed = SetupOptions()
        changed.provider = .openai
        changed.providerKey = "sk-new"

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()),
                       [.configSet("OPENAI_API_KEY", "sk-new")])
    }

    /// The key is never read back out of config.env, so the field starts empty every time
    /// the screen opens. An empty field is "I did not change it", not "delete my key" —
    /// the alternative silently turns the suggestions off for anyone who opened Settings
    /// to change the backup time.
    func testAnEmptyKeyFieldLeavesTheStoredKeyAlone() {
        var previous = SetupOptions()
        previous.providerKey = "sk-old"
        var changed = previous
        changed.providerKey = ""

        XCTAssertEqual(changed.commandsForChange(from: previous), [])
    }

    /// Both providers' keys can sit in config.env at once — the web app chooses which is
    /// active per household — so switching provider here writes the new key and never
    /// clears the other.
    func testSwitchingProviderDoesNotClearTheOtherKey() {
        var previous = SetupOptions()
        previous.provider = .anthropic
        var changed = previous
        changed.provider = .openai
        changed.providerKey = "sk-openai"

        XCTAssertEqual(changed.commandsForChange(from: previous),
                       [.configSet("OPENAI_API_KEY", "sk-openai")])
    }

    /// The port is deliberately not offered after setup: `HTTP_PORT` is the preference for
    /// the FIRST allocation and nothing after it, so a value written here would be a
    /// setting that silently did nothing.
    func testThePortIsNeverWrittenAfterSetup() {
        var changed = SetupOptions()
        changed.port = "9999"

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()), [])
    }

    /// The folder is not a config write at all — it is `waffled-runtime move`, which needs
    /// the server stopped first, so it is its own button rather than part of Apply.
    func testTheDataFolderIsNotOneOfTheseCommands() {
        var changed = SetupOptions()
        changed.dataDirectory = URL(fileURLWithPath: "/Volumes/Big/Waffled")

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()), [])
    }

    func testAScreenThatCannotBeAppliedAsksForNothing() {
        var changed = SetupOptions()
        changed.addressMode = .custom
        changed.customHost = "http://nope:8080"

        XCTAssertFalse(changed.problems.isEmpty)
        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()), [])
    }

    func testEverythingChangedAtOnceIsAppliedInOneGo() {
        var changed = SetupOptions()
        changed.addressMode = .custom
        changed.customHost = "waffled.home"
        changed.provider = .anthropic
        changed.providerKey = "sk-abc"
        changed.backupAt = "05:00"

        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()), [
            .configSet("WAFFLED_PUBLIC_HOST", "waffled.home"),
            .configSet("ANTHROPIC_API_KEY", "sk-abc"),
            RuntimeCommand(subcommand: "backup", flags: ["--install-schedule", "--at", "05:00"]),
        ])
    }

    // MARK: what the screen itself says

    func testAnUnchangedScreenHasNothingToApply() {
        let options = SetupOptions()
        let screen = SettingsPresentation.make(options: options, saved: options,
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: nil)
        XCTAssertFalse(screen.applyEnabled, "Apply is for changes, and there are none")
        XCTAssertFalse(screen.needsRestart)
    }

    func testAChangedScreenCanBeApplied() {
        var changed = SetupOptions()
        changed.backupAt = "01:00"
        let screen = SettingsPresentation.make(options: changed, saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: nil)
        XCTAssertTrue(screen.applyEnabled)
    }

    /// The address is read at start; changing it while the server is up is a setting that
    /// has not taken effect yet, and saying nothing would look like it had not worked.
    func testChangingTheAddressSaysItNeedsARestart() throws {
        var changed = SetupOptions()
        changed.addressMode = .ip
        let screen = SettingsPresentation.make(options: changed, saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: try running())
        XCTAssertTrue(screen.needsRestart)
    }

    func testChangingOnlyTheBackupTimeNeedsNoRestart() throws {
        var changed = SetupOptions()
        changed.backupAt = "01:00"
        let screen = SettingsPresentation.make(options: changed, saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: try running())
        XCTAssertFalse(screen.needsRestart, "the nightly backup is installed, not read at start")
    }

    /// A screen that cannot be applied says why, in the same words the first-run screen
    /// uses, and offers no Apply.
    func testAProblemIsShownAndBlocksApply() {
        var changed = SetupOptions()
        changed.addressMode = .custom
        changed.customHost = "nope nope"
        let screen = SettingsPresentation.make(options: changed, saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: nil)
        XCTAssertFalse(screen.applyEnabled)
        XCTAssertEqual(screen.problems, changed.problems)
    }

    /// The port row is read-only here and says the one thing a person needs to know, which
    /// is that this is not the screen that moves it.
    func testThePortRowIsReadOnlyAndSaysWhere() throws {
        let screen = SettingsPresentation.make(options: SetupOptions(), saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: try running())
        XCTAssertEqual(screen.portValue, "8080")
        XCTAssertFalse(screen.portNote.isEmpty, "a read-only port has to explain itself")
    }

    /// Moving the folder stops the server, so it is refused while anything is in flight
    /// rather than queued behind it.
    func testTheFolderCannotBeMovedWhileSomethingIsRunning() throws {
        let screen = SettingsPresentation.make(options: SetupOptions(), saved: SetupOptions(),
                                               dataDirectory: URL(fileURLWithPath: "/tmp/Waffled"),
                                               status: try running(), busy: true)
        XCTAssertFalse(screen.moveEnabled)
    }

    func testTheFolderRowShowsWhereWaffledActuallyIs() throws {
        let here = URL(fileURLWithPath: "/Volumes/Big/Waffled")
        let screen = SettingsPresentation.make(options: SetupOptions(), saved: SetupOptions(),
                                               dataDirectory: here, status: try running())
        XCTAssertEqual(screen.dataDirectoryPath, here.path)
        XCTAssertTrue(screen.moveEnabled)
    }
}
