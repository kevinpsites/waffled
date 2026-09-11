import XCTest
@testable import Waffled

/// The setup screen's choices are a value, so the argv the app would really have used is
/// asserted here without spawning anything.
final class SetupOptionsTests: XCTestCase {

    func testTheDefaultsAreTheOnesTheScreenShows() {
        let options = SetupOptions()
        XCTAssertNil(options.dataDirectory, "the default folder is the runtime's own")
        XCTAssertTrue(options.backupEnabled)
        XCTAssertEqual(options.backupAt, "03:00")
        XCTAssertTrue(options.startAtLogin)
        XCTAssertEqual(options.addressMode, .ip)
        XCTAssertEqual(options.port, "8080")
        XCTAssertTrue(options.providerKey.isEmpty)
        XCTAssertEqual(options.provider, .none)
        XCTAssertEqual(options.backupKeep, 14)
        XCTAssertTrue(options.problems.isEmpty)
    }

    /// Ports below 1024 need root, and the runtime checks a port by binding it — so an
    /// unprivileged Waffled reports "no free port" for every one of them, which is a
    /// dead end nobody can act on. The field refuses them where a person can still type
    /// another.
    func testAPrivilegedPortIsRefusedWhereItCanStillBeChanged() {
        for privileged in ["80", "443", "1023", "1", "0"] {
            var options = SetupOptions()
            options.port = privileged
            XCTAssertFalse(options.problems.isEmpty, "port \(privileged) was accepted")
            XCTAssertTrue(options.problems.contains { $0.contains("administrator") },
                          "the reason should say why, got \(options.problems)")
        }
    }

    func testTheFirstPortAPersonMayChooseIsAccepted() {
        var options = SetupOptions()
        options.port = "1024"
        XCTAssertTrue(options.problems.isEmpty)
        options.port = "65535"
        XCTAssertTrue(options.problems.isEmpty)
        options.port = "65536"
        XCTAssertFalse(options.problems.isEmpty)
    }

    /// The two reserved words are the runtime's, and a typo in either is a mode that
    /// silently reads as a hostname nobody can resolve.
    func testTheAddressModesWriteTheRuntimesOwnWords() {
        var options = SetupOptions()
        options.addressMode = .name
        XCTAssertEqual(options.publicHost, "name")
        options.addressMode = .ip
        XCTAssertEqual(options.publicHost, "ip")
        options.addressMode = .custom
        options.customHost = "  waffled.home "
        XCTAssertEqual(options.publicHost, "waffled.home", "surrounding space is not part of a name")
    }

    func testEveryChoiceIsAppliedBeforeTheFirstStart() {
        var options = SetupOptions()
        options.addressMode = .custom
        options.customHost = "waffled.home"
        options.port = "8443"
        options.provider = .openai
        options.providerKey = "sk-abc"
        options.backupAt = "05:00"

        XCTAssertEqual(options.commandsBeforeFirstStart(), [
            .configSet("WAFFLED_PUBLIC_HOST", "waffled.home"),
            .configSet("HTTP_PORT", "8443"),
            .configSet("OPENAI_API_KEY", "sk-abc"),
            RuntimeCommand(subcommand: "backup", flags: ["--install-schedule", "--at", "05:00"]),
        ])
    }

    /// A household that never opened this screen has expressed no port preference, and
    /// writing one on their behalf puts a number on record they never chose.
    func testTheDefaultPortIsNotWrittenDown() {
        let untouched = SetupOptions()
        XCTAssertFalse(untouched.commandsBeforeFirstStart()
            .contains { $0.trailing.contains { $0.hasPrefix("HTTP_PORT") } })

        var chosen = SetupOptions()
        chosen.port = "8443"
        XCTAssertTrue(chosen.commandsBeforeFirstStart()
            .contains { $0.trailing.contains("HTTP_PORT=8443") })
    }

    /// The address is written even when it is the default one: the runtime reads an absent
    /// setting as "keep the address this install has always had", which is right for an
    /// upgrade and wrong for a Mac that has never run Waffled.
    func testTheAddressIsAlwaysWrittenDown() {
        XCTAssertTrue(SetupOptions().commandsBeforeFirstStart()
            .contains { $0.trailing.contains("WAFFLED_PUBLIC_HOST=ip") })
    }

    /// The picker lists the default first, so the choice already made reads as the top one.
    func testThePickerStartsWithTheDefault() {
        XCTAssertEqual(FirstRunPresentation.OptionsCopy.addressModes.first?.0, SetupOptions().addressMode)
    }

    /// The key is optional and nothing else depends on it: an empty field writes no
    /// assignment at all rather than an empty one the api would then read as configured.
    func testNoProviderKeyWritesNoProviderAssignment() {
        var options = SetupOptions()
        options.providerKey = "   "
        XCTAssertFalse(options.commandsBeforeFirstStart().contains { $0.trailing.contains { $0.hasPrefix("ANTHROPIC") } })
    }

    /// Off means "do not install one", not "remove one": this runs once, on a Mac where
    /// there is nothing of ours to remove.
    func testTheBackupToggleOffInstallsNothing() {
        var options = SetupOptions()
        options.backupEnabled = false
        XCTAssertFalse(options.commandsBeforeFirstStart().contains { $0.subcommand == "backup" })
    }

    func testAScreenThatCannotBeAppliedAsksForNothing() {
        var options = SetupOptions()
        options.port = "not a port"
        XCTAssertFalse(options.problems.isEmpty)
        XCTAssertEqual(options.commandsBeforeFirstStart(), [])
    }

    func testAPortIsANumberInRange() {
        for bad in ["0", "-1", "65536", "eighty", "", "80.5"] {
            var options = SetupOptions()
            options.port = bad
            XCTAssertFalse(options.problems.isEmpty, "\(bad) was accepted as a port")
        }
        for good in ["1024", "8080", " 8443 ", "65535"] {
            var options = SetupOptions()
            options.port = good
            XCTAssertTrue(options.problems.isEmpty, "\(good) was refused as a port")
        }
    }

    /// A pasted URL is the failure this catches: it composes an address no device could
    /// reach, and nothing downstream would say so.
    func testACustomNameIsAHostnameAndNotAPastedURL() {
        for bad in ["http://waffled.home", "waffled.home:8080", "waffled.home/app", "waffled home", "", ".home"] {
            var options = SetupOptions()
            options.addressMode = .custom
            options.customHost = bad
            XCTAssertFalse(options.problems.isEmpty, "\(bad) was accepted as a name")
        }
        for good in ["waffled.home", "waffled", "mac-mini.local", "a1.b2.example.com"] {
            var options = SetupOptions()
            options.addressMode = .custom
            options.customHost = good
            XCTAssertTrue(options.problems.isEmpty, "\(good) was refused as a name")
        }
    }

    /// The name is only checked when it is the one being used — a half-typed custom host
    /// left behind by someone who went back to "This Mac's name" is not a problem.
    func testACustomNameIsOnlyCheckedInCustomMode() {
        var options = SetupOptions()
        options.customHost = "http://nonsense"
        options.addressMode = .name
        XCTAssertTrue(options.problems.isEmpty)
    }

    func testTheBackupTimesReadTheWayAClockDoes() {
        XCTAssertEqual(SetupOptions.backupTimeLabel("01:00"), "1:00 AM")
        XCTAssertEqual(SetupOptions.backupTimeLabel("03:00"), "3:00 AM")
        XCTAssertEqual(SetupOptions.backupTimeLabel("05:00"), "5:00 AM")
        XCTAssertEqual(SetupOptions.backupTimeLabel("12:00"), "Noon")
        XCTAssertEqual(SetupOptions.backupTimeLabel("00:00"), "Midnight")
        XCTAssertEqual(SetupOptions.backupTimeLabel("13:30"), "1:30 PM")
    }

    /// Every offered time has to be one the runtime's own `--at` parser accepts.
    func testEveryOfferedTimeIsATwentyFourHourTime() {
        for at in SetupOptions.backupTimes {
            XCTAssertEqual(at.count, 5)
            let parts = at.split(separator: ":")
            XCTAssertEqual(parts.count, 2)
            XCTAssertNotNil(Int(parts[0]).map { (0...23).contains($0) })
            XCTAssertNotNil(Int(parts[1]).map { (0...59).contains($0) })
        }
    }

    /// launchd holds exactly one nightly backup per Mac, under a global label, so a dev
    /// run would take the household's real schedule over and point it at a scratch folder.
    /// Its config writes still happen: those land in the scratch data directory it was
    /// given, which is where they belong.
    func testADevRunInstallsNoNightlyBackup() {
        let options = SetupOptions()
        let dev = options.commandsBeforeFirstStart(isDevMode: true)
        XCTAssertFalse(dev.contains { $0.subcommand == "backup" })
        XCTAssertTrue(dev.contains { $0.trailing.contains("WAFFLED_PUBLIC_HOST=ip") })
        XCTAssertTrue(options.commandsBeforeFirstStart().contains { $0.subcommand == "backup" },
                      "an ordinary first run still installs one")
    }

}
