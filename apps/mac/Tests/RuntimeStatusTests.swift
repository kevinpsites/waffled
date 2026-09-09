import XCTest
@testable import Waffled

/// The `status --json` contract is published (apps/runtime/README.md). The runtime adds
/// fields without bumping `schema`, so the only decoding failure this app is allowed to
/// have is a `schema` it does not understand.
final class RuntimeStatusTests: XCTestCase {
    func testDecodesTheReadmeExample() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))

        XCTAssertEqual(s.schema, 1)
        XCTAssertEqual(s.state, .running)
        XCTAssertEqual(s.dataDir, "/Users/jerry/Library/Application Support/Waffled")
        XCTAssertEqual(s.urls.local, "http://127.0.0.1:8080")
        XCTAssertEqual(s.urls.lan, "http://192.168.1.5:8080")
        XCTAssertEqual(s.ports.public, 8080)
        XCTAssertEqual(s.ports.postgres, 5432)
        XCTAssertEqual(s.versions.waffled, "0.14.3")
        XCTAssertEqual(s.bundle.gitSha, "a506c352")
        XCTAssertTrue(s.bundle.verified)
        XCTAssertEqual(s.bundle.previousVersion, "0.14.2")
        XCTAssertEqual(s.supervisor.pid, 4242)
        XCTAssertTrue(s.supervisor.running)
        XCTAssertEqual(s.services.count, 2)
        XCTAssertEqual(s.services.first?.name, "postgres")
        XCTAssertEqual(s.services.first?.state, .running)
        XCTAssertEqual(s.services.first?.log, "/tmp/logs/postgres.log")
    }

    func testDecodesTheAdditiveBackupsAndBonjourBlocks() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning))

        XCTAssertEqual(s.backups.count, 14)
        XCTAssertEqual(s.backups.lastSizeBytes, 4_823_104)
        XCTAssertEqual(s.backups.lastMigration, "0099_rhythm_book_within")
        XCTAssertTrue(s.backups.scheduleInstalled)

        XCTAssertTrue(s.bonjour.advertised)
        XCTAssertEqual(s.bonjour.name, "The Seinfelds")
        XCTAssertEqual(s.bonjour.host, "kevins-mac-mini.local")
        XCTAssertEqual(s.bonjour.port, 8080)
    }

    /// The contract's central promise: fields are added, never renamed. A build of this
    /// app must keep working against a runtime newer than itself.
    func testIgnoresUnknownKeysAtEveryLevel() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.withUnknownFields))

        XCTAssertEqual(s.state, .starting)
        XCTAssertEqual(s.ports.public, 8090)
        XCTAssertEqual(s.services.count, 1)
        XCTAssertEqual(s.services.first?.health, "ok")
    }

    /// The other half: a whole block the runtime has not written yet must not be a
    /// decoding failure, and must not force every call site into optional-chaining.
    func testMissingBlocksBecomeEmptyDefaults() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped))

        XCTAssertEqual(s.state, .stopped)
        XCTAssertEqual(s.urls.local, "")
        XCTAssertEqual(s.ports.public, 0)
        XCTAssertEqual(s.services, [])
        XCTAssertEqual(s.backups.count, 0)
        XCTAssertFalse(s.bonjour.advertised)
        XCTAssertEqual(s.lastError, "")
    }

    func testRefusesASchemaItDoesNotUnderstand() {
        XCTAssertThrowsError(try RuntimeStatus.decode(Fixtures.data(Fixtures.schemaTwo))) { error in
            XCTAssertEqual(error as? RuntimeStatusError, .unsupportedSchema(2))
        }
    }

    /// `schema` is the one field we cannot default: without it there is nothing to check
    /// compatibility against, so a document missing it is not a document we can trust.
    func testRefusesADocumentWithNoSchema() {
        let json = #"{ "state": "running" }"#
        XCTAssertThrowsError(try RuntimeStatus.decode(Fixtures.data(json)))
    }

    /// The first-run question, answered by the runtime because it owns the layout: an app
    /// that stated PGDATA itself would be a second place that knows where the cluster
    /// lives. Like every other field it defaults rather than throwing.
    func testTheFirstRunFlagDecodesAndDefaults() throws {
        XCTAssertTrue(try RuntimeStatus.decode(Fixtures.data(Fixtures.fullRunning)).initialized)
        XCTAssertFalse(try RuntimeStatus.decode(Fixtures.data(Fixtures.freshDataDirectory)).initialized)
        XCTAssertFalse(try RuntimeStatus.decode(Fixtures.data(Fixtures.minimalStopped)).initialized,
                       "a document without the field must decode, not throw")
    }

    /// The state vocabulary is the one place "added, never renamed" cuts against a
    /// failable enum. A word we do not know is a fault to show, never a crash.
    func testAnUnknownStateReadsAsUnhealthy() throws {
        let s = try RuntimeStatus.decode(Fixtures.data(Fixtures.unknownState))
        XCTAssertEqual(s.state, .unhealthy)
    }
}
