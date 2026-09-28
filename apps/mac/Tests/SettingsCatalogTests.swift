import XCTest
@testable import Waffled

/// Advanced and Diagnostics: the api settings a household may tune, each one a key the
/// runtime actually forwards. A field that writes a key nothing reads is the failure the
/// whole redesign plan exists to prevent (docs/product/mac-settings-redesign.md §5).
final class SettingsCatalogTests: XCTestCase {

    private func setting(_ key: String) throws -> EnvSetting {
        try XCTUnwrap(SettingsCatalog.all.first { $0.key == key }, "\(key) is not in the catalog")
    }

    /// Every key this app can write is one the runtime reads for itself or forwards to
    /// the api — checked against the runtime's own source, so widening one without the
    /// other fails here rather than on a household's Mac.
    func testEveryKeyTheAppWritesReachesSomething() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()               // Tests
            .deletingLastPathComponent()               // mac
            .deletingLastPathComponent()               // apps
            .appendingPathComponent("runtime/internal/services/services.go")
        let text = try String(contentsOf: source, encoding: .utf8)
        let start = try XCTUnwrap(text.range(of: "var passthroughKeys = []string{"))
        let end = try XCTUnwrap(text.range(of: "}", range: start.upperBound..<text.endIndex))
        let forwarded = Set(text[start.upperBound..<end.lowerBound]
            .split(whereSeparator: { !($0.isLetter || $0.isNumber || $0 == "_") })
            .map(String.init)
            .filter { $0 == $0.uppercased() && $0.contains("_") })
        // Read by the runtime itself rather than forwarded.
        let runtimeOwn: Set = ["WAFFLED_PUBLIC_HOST", "HTTP_PORT", "LOG_LEVEL", "LOG_FORMAT"]

        XCTAssertFalse(forwarded.isEmpty, "could not read passthroughKeys out of services.go")
        for key in SetupOptions.keysTheAppWrites {
            XCTAssertTrue(forwarded.contains(key) || runtimeOwn.contains(key),
                          "\(key) is written by the app but nothing reads it")
        }
    }

    func testNothingThatWouldDoNothingIsOffered() {
        let keys = Set(SettingsCatalog.all.map(\.key))
        for dead in ["TZ", "OTEL_SDK_DISABLED", "OTEL_EXPORTER_OTLP_ENDPOINT", "UPDATE_CHECK_REPO",
                     "BACKUP_S3_BUCKET", "BACKUP_HOST_PATH", "MEDIA_DIR"] {
            XCTAssertFalse(keys.contains(dead), "\(dead) would be a control that does nothing")
        }
    }

    func testTheTabsHoldTheirSections() {
        XCTAssertEqual(SettingsCatalog.sections(in: .advanced).map(\.title),
                       ["AI model and limits", "Calendar sync", "Sessions and sign-in", "Rate limits"])
        XCTAssertEqual(SettingsCatalog.sections(in: .diagnostics).map(\.title), ["Logging"])
        XCTAssertTrue(SettingsCatalog.sections(in: .basic).isEmpty)
    }

    // MARK: what a change writes

    func testAnUntouchedCatalogWritesNothing() {
        XCTAssertEqual(SetupOptions().commandsForChange(from: SetupOptions()), [])
    }

    func testAChangedCountIsWritten() {
        var options = SetupOptions()
        options.settings["RATE_LIMIT_LOGIN_IP_MAX"] = "100"
        XCTAssertEqual(options.commandsForChange(from: SetupOptions()),
                       [.configSet("RATE_LIMIT_LOGIN_IP_MAX", "100")])
    }

    /// Clearing a field puts the api's own default back: the runtime forwards nothing for
    /// an empty value, so the api never sees it.
    func testAClearedFieldGoesBackToTheDefault() {
        var saved = SetupOptions()
        saved.settings["RATE_LIMIT_LOGIN_IP_MAX"] = "100"
        var options = saved
        options.settings["RATE_LIMIT_LOGIN_IP_MAX"] = ""
        XCTAssertEqual(options.commandsForChange(from: saved),
                       [.configSet("RATE_LIMIT_LOGIN_IP_MAX", "")])
    }

    func testACountThatIsNotACountIsAProblem() throws {
        var options = SetupOptions()
        options.settings["RATE_LIMIT_LOGIN_IP_MAX"] = "lots"
        XCTAssertFalse(options.problems.isEmpty)
        XCTAssertEqual(options.commandsForChange(from: SetupOptions()), [])
        options.settings["RATE_LIMIT_LOGIN_IP_MAX"] = "0"
        XCTAssertFalse(options.problems.isEmpty, "a throttle of 0 would lock everyone out")
    }

    /// Retries may be zero — the api's own floor is 0 — but never negative.
    func testRetriesMayBeZero() {
        var options = SetupOptions()
        options.settings["AI_MAX_RETRIES"] = "0"
        XCTAssertTrue(options.problems.isEmpty)
        options.settings["AI_MAX_RETRIES"] = "-1"
        XCTAssertFalse(options.problems.isEmpty)
    }

    /// The timeout is asked for in seconds and the api reads milliseconds.
    func testTheAITimeoutIsWrittenInMilliseconds() throws {
        XCTAssertEqual(try setting("AI_TIMEOUT_MS").label, "Timeout (seconds)")
        var options = SetupOptions()
        options.settings["AI_TIMEOUT_MS"] = "45"
        XCTAssertEqual(options.commandsForChange(from: SetupOptions()),
                       [.configSet("AI_TIMEOUT_MS", "45000")])
    }

    func testTheBreakGlassSwitchWritesWhatTheApiChecksFor() {
        var options = SetupOptions()
        options.settings["AUTH_FORCE_PASSWORD"] = "1"
        XCTAssertEqual(options.commandsForChange(from: SetupOptions()),
                       [.configSet("AUTH_FORCE_PASSWORD", "1")])
    }

    func testAURLThatIsNotOneIsAProblem() {
        var options = SetupOptions()
        options.settings["PUBLIC_BASE_URL"] = "waffled.home"
        XCTAssertFalse(options.problems.isEmpty)
        options.settings["PUBLIC_BASE_URL"] = "https://waffled.home"
        XCTAssertTrue(options.problems.isEmpty)
    }

    func testTheLogChoicesAreTheOnesTheApiKnows() throws {
        XCTAssertEqual(try setting("LOG_LEVEL").choices.map(\.value), ["debug", "info", "warn", "error"])
        XCTAssertEqual(try setting("LOG_FORMAT").choices.map(\.value), ["json", "pretty"])
    }

    // MARK: secrets

    /// A client secret is a secret like a provider key: blank means unchanged, and it is
    /// never written into the app's preferences.
    func testASecretFieldIsWrittenOnlyWhenFilledAndNeverRemembered() {
        var options = SetupOptions()
        options.secrets["GOOGLE_CLIENT_SECRET"] = ""
        XCTAssertEqual(options.commandsForChange(from: SetupOptions()), [])

        options.secrets["GOOGLE_CLIENT_SECRET"] = "shh"
        XCTAssertEqual(options.commandsForChange(from: SetupOptions()),
                       [.configSet("GOOGLE_CLIENT_SECRET", "shh")])

        let memory = InMemoryDefaults()
        Setup.remember(options, in: memory)
        XCTAssertFalse((memory.string(forKey: Setup.appliedOptionsKey) ?? "").contains("shh"))
        XCTAssertTrue(Setup.appliedOptions(in: memory).secrets.isEmpty)
    }

    // MARK: restarting

    /// Every api setting is read when the api starts — provider keys included, which the
    /// api loads into its config once. So any config write waits on a restart.
    func testAnyConfigWriteWaitsForARestart() throws {
        let running = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))
        for change in [
            { (o: inout SetupOptions) in o.settings["LOG_LEVEL"] = "debug" },
            { (o: inout SetupOptions) in o.provider = .anthropic; o.providerKey = "sk" },
        ] {
            var options = SetupOptions()
            change(&options)
            let screen = SettingsPresentation.make(options: options, saved: SetupOptions(),
                                                   dataDirectory: URL(fileURLWithPath: "/tmp/W"),
                                                   status: running)
            XCTAssertTrue(screen.needsRestart)
        }
    }

    // MARK: remembering

    /// Preferences written before a field existed must still come back: a decoder that
    /// demanded every key would read them as the defaults, and Settings would then show
    /// 03:00 beside a plist that runs at 01:00.
    func testOptionsRememberedBeforeTheseFieldsExistedStillComeBack() {
        let memory = InMemoryDefaults()
        memory.set(#"{"backupEnabled":true,"backupAt":"01:00","provider":"openai","startAtLogin":false,"addressMode":"ip","customHost":"","port":"8080"}"#,
                   forKey: Setup.appliedOptionsKey)
        let read = Setup.appliedOptions(in: memory)
        XCTAssertEqual(read.backupAt, "01:00")
        XCTAssertEqual(read.provider, .openai)
        XCTAssertEqual(read.addressMode, .ip)
        XCTAssertFalse(read.startAtLogin)
        XCTAssertEqual(read.backupKeep, 14)
    }

    func testTheCatalogValuesAreRemembered() {
        let memory = InMemoryDefaults()
        var applied = SetupOptions()
        applied.settings["LOG_LEVEL"] = "debug"
        applied.ollamaHost = "http://studio.local:11434"
        applied.openAIBaseURL = "http://127.0.0.1:1234/v1"
        Setup.remember(applied, in: memory)
        let read = Setup.appliedOptions(in: memory)
        XCTAssertEqual(read.settings["LOG_LEVEL"], "debug")
        XCTAssertEqual(read.ollamaHost, "http://studio.local:11434")
        XCTAssertEqual(read.openAIBaseURL, "http://127.0.0.1:1234/v1")
    }

    // MARK: tabs

    func testEachTabHasItsOwnTitle() {
        let titles = SettingsPresentation.Tab.allCases.map {
            SettingsPresentation.make(options: SetupOptions(), saved: SetupOptions(),
                                      dataDirectory: URL(fileURLWithPath: "/tmp/W"),
                                      status: nil, tab: $0).title
        }
        XCTAssertEqual(titles, ["Waffled Settings", "Advanced", "Diagnostics"])
        XCTAssertEqual(SettingsPresentation.Tab.allCases.map(\.label), ["Basic", "Advanced", "Diagnostics"])
    }
}
