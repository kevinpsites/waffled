import XCTest
@testable import Waffled

/// Which folders may hold a household's Waffled. The rule is a value-to-value function,
/// so no test needs a network share or an unplugged drive to assert what happens on one.
final class SetupTests: XCTestCase {

    func testAnOrdinaryInternalAPFSFolderIsFine() {
        XCTAssertNil(Setup.refusal(for: Setup.VolumeFacts(format: "APFS")))
        XCTAssertNil(Setup.refusal(for: Setup.VolumeFacts(format: "Mac OS Extended (Journaled)")))
    }

    /// The one a household would actually reach for, and the one that would take the
    /// server off the network the moment somebody unplugged it.
    func testAnExternalDriveIsRefused() {
        let refusal = Setup.refusal(for: Setup.VolumeFacts(isRemovable: true, isInternal: false,
                                                           format: "APFS"))
        XCTAssertNotNil(refusal)
        XCTAssertTrue(refusal?.contains("unplugged") == true)
    }

    func testANetworkFolderIsRefused() {
        XCTAssertNotNil(Setup.refusal(for: Setup.VolumeFacts(isLocal: false, format: "APFS")))
    }

    /// A live Postgres cluster needs the semantics ExFAT and FAT do not have.
    func testAFilesystemThatCannotHoldADatabaseIsRefused() {
        for format in ["ExFAT", "MS-DOS (FAT32)", "NTFS"] {
            let refusal = Setup.refusal(for: Setup.VolumeFacts(format: format))
            XCTAssertNotNil(refusal, "\(format) was accepted")
            XCTAssertTrue(refusal?.contains(format) == true, "the refusal does not say what it found")
        }
    }

    /// Being unable to look is not evidence of a problem: a volume that will not answer
    /// reads as the ordinary case rather than as a refusal a person cannot act on.
    func testAVolumeThatWillNotAnswerIsNotRefused() {
        XCTAssertNil(Setup.refusal(for: Setup.VolumeFacts(format: nil)))
    }

    /// This Mac's own boot volume has to pass, or the default folder would be refused.
    func testThisMacsOwnDiskIsAcceptable() {
        XCTAssertNil(Setup.refusal(for: Setup.facts(for: URL(fileURLWithPath: NSHomeDirectory()))))
    }
}
