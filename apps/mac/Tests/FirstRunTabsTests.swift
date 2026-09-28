import XCTest
@testable import Waffled

/// `Settings first…` is the whole of Settings, before anything exists: the same three
/// tabs, so a household that needs its own sign-in, rate limits or log level sets them
/// before the first start rather than restarting into them afterwards.
@MainActor
final class FirstRunTabsTests: XCTestCase {

    private func options(tab: SettingsPresentation.Tab) throws -> FirstRunPresentation {
        let fresh = try RuntimeStatus.decode(Fixtures.data(Fixtures.freshDataDirectory))
        return try XCTUnwrap(FirstRunPresentation.make(status: fresh, isFirstRun: true,
                                                       setupBegun: false, showingOptions: true,
                                                       optionsTab: tab))
    }

    func testTheOptionsStepHasTheSameThreeTabsAsSettings() throws {
        let basic = try options(tab: .basic)
        XCTAssertEqual(basic.tab, .basic)
        XCTAssertEqual(basic.title, "Where things go")
        XCTAssertFalse(basic.message.contains("backup time and your keys"),
                       "every setting is on this screen now, not two of them")

        let advanced = try options(tab: .advanced)
        XCTAssertEqual(advanced.tab, .advanced)
        XCTAssertEqual(advanced.title, SettingsPresentation.Copy.advancedTitle)
        XCTAssertEqual(advanced.primaryButton, "Set up Waffled", "one button sets up all three")

        let diagnostics = try options(tab: .diagnostics)
        XCTAssertEqual(diagnostics.tab, .diagnostics)
        XCTAssertEqual(diagnostics.title, SettingsPresentation.Copy.diagnosticsTitle)
    }

    func testOnlyTheOptionsStepHasTabs() throws {
        let fresh = try RuntimeStatus.decode(Fixtures.data(Fixtures.freshDataDirectory))
        let welcome = try XCTUnwrap(FirstRunPresentation.make(status: fresh, isFirstRun: true,
                                                              setupBegun: false,
                                                              optionsTab: .advanced))
        XCTAssertNil(welcome.tab)
    }

    /// The model's tab is what the options step shows, and opening the step starts on
    /// Basic whatever was open last.
    func testSettingsFirstOpensOnBasicAndFollowsTheTab() {
        let model = ServerModel(environment: [RuntimeLocator.binaryVariable: "/nonexistent/waffled-runtime"],
                                resourceURL: nil, memory: InMemoryDefaults(), runner: RecordingRunner())
        defer { model.end() }

        model.settingsTab = .diagnostics
        model.showSetupOptions()
        XCTAssertEqual(model.settingsTab, .basic)
    }

    /// Everything on the Advanced and Diagnostics tabs is written before the first start.
    func testTheFirstStartWritesAdvancedAndDiagnosticsSettings() {
        var options = SetupOptions()
        options.settings["RATE_LIMIT_LOGIN_IP_MAX"] = "100"
        options.settings["LOG_LEVEL"] = "debug"
        options.secrets["GOOGLE_CLIENT_SECRET"] = "shh"

        let commands = options.commandsBeforeFirstStart()
        XCTAssertTrue(commands.contains(.configSet("RATE_LIMIT_LOGIN_IP_MAX", "100")))
        XCTAssertTrue(commands.contains(.configSet("LOG_LEVEL", "debug")))
        XCTAssertTrue(commands.contains(.configSet("GOOGLE_CLIENT_SECRET", "shh")))
    }
}
