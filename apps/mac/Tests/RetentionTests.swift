import XCTest
@testable import Waffled

/// How many nightly backups a household keeps. The runtime's plist is the record, and
/// re-installing without `--keep` keeps whatever it says — so the app states the
/// retention exactly when it is a choice, and never on a household's behalf.
final class RetentionTests: XCTestCase {

    private func install(_ flags: String...) -> RuntimeCommand {
        RuntimeCommand(subcommand: "backup", flags: ["--install-schedule"] + flags)
    }

    func testTheDefaultIsTheRuntimesOwn() {
        XCTAssertEqual(SetupOptions().backupKeep, 14)
        XCTAssertEqual(SetupOptions.retentionChoices, [7, 14, 30, 90])
    }

    /// "Forever" is not offered: the runtime has no keep-everything mode, and a choice it
    /// cannot honour is the control §5 of the plan rules out.
    func testEveryChoiceIsACountTheRuntimeTakes() {
        XCTAssertTrue(SetupOptions.retentionChoices.allSatisfy { $0 >= 1 })
    }

    func testAFirstRunStatesOnlyARetentionThatWasChosen() {
        XCTAssertEqual(SetupOptions().commandsBeforeFirstStart(), [
            .configSet("WAFFLED_PUBLIC_HOST", "name"),
            install("--at", "03:00"),
        ])

        var options = SetupOptions()
        options.backupKeep = 30
        XCTAssertEqual(options.commandsBeforeFirstStart().last, install("--at", "03:00", "--keep", "30"))
    }

    func testANewRetentionReinstallsTheSchedule() {
        var changed = SetupOptions()
        changed.backupKeep = 90
        XCTAssertEqual(changed.commandsForChange(from: SetupOptions()),
                       [install("--at", "03:00", "--keep", "90")])
    }

    /// Going back to 14 has to say 14. Omitting `--keep` tells the runtime to leave the
    /// installed 30 where it is.
    func testGoingBackToTheDefaultSaysSo() {
        var previous = SetupOptions()
        previous.backupKeep = 30
        let changed = SetupOptions()
        XCTAssertEqual(changed.commandsForChange(from: previous),
                       [install("--at", "03:00", "--keep", "14")])
    }

    /// Changing only the time restates nothing else — the runtime keeps the installed
    /// retention when `--keep` is absent.
    func testChangingOnlyTheTimeLeavesTheRetentionToTheRuntime() {
        var previous = SetupOptions()
        previous.backupKeep = 30
        var changed = previous
        changed.backupAt = "01:00"
        XCTAssertEqual(changed.commandsForChange(from: previous), [install("--at", "01:00")])
    }

    /// Turning the backup off removes the plist, and the retention with it. Turning it
    /// back on has to restate a retention that is not the default, or it quietly becomes 14.
    func testTurningTheBackupBackOnRestatesTheRetention() {
        var previous = SetupOptions()
        previous.backupEnabled = false
        previous.backupKeep = 30
        var changed = previous
        changed.backupEnabled = true
        XCTAssertEqual(changed.commandsForChange(from: previous),
                       [install("--at", "03:00", "--keep", "30")])
    }

    func testTheRetentionIsRemembered() {
        let memory = InMemoryDefaults()
        var applied = SetupOptions()
        applied.backupKeep = 90
        Setup.remember(applied, in: memory)
        XCTAssertEqual(Setup.appliedOptions(in: memory).backupKeep, 90)
    }

    /// The row says what the nightly job will really do.
    func testTheBackupRowSaysHowManyAreKept() {
        var options = SetupOptions()
        options.backupKeep = 30
        XCTAssertEqual(SettingsDrawer.backup.summary(options), "Nightly at 3:00 AM · keeps the last 30")
        options.backupEnabled = false
        XCTAssertEqual(SettingsDrawer.backup.summary(options), "Off")
    }
}
