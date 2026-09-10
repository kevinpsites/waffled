import XCTest
@testable import Waffled

/// What happens to the folder a person picks in the panel, before it becomes `--data`.
///
/// The panel hands back the folder they clicked, and Waffled writes `config.env`,
/// `postgres/`, `media/` and the rest straight into it. Picking `~/Documents` therefore
/// scatters a database through Documents, so the folder they picked is where Waffled's
/// own folder goes — not what it becomes.
final class ChosenFolderTests: XCTestCase {

    private func tempDir() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("waffled-chosen-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testAnOrdinaryFolderGetsAWaffledFolderInsideIt() throws {
        let picked = try tempDir()
        XCTAssertEqual(Setup.dataDirectory(forChosen: picked),
                       picked.appendingPathComponent(Setup.folderName))
    }

    /// Picking the folder Waffled is already in — from `Settings…`, or a second setup on a
    /// Mac that has one — must not bury it one level deeper each time.
    func testAFolderThatIsAlreadyAHouseholdIsUsedAsItIs() throws {
        for marker in ["runtime.json", "config.env"] {
            let picked = try tempDir()
            FileManager.default.createFile(atPath: picked.appendingPathComponent(marker).path,
                                           contents: Data("x".utf8))
            XCTAssertEqual(Setup.dataDirectory(forChosen: picked), picked,
                           "\(marker) marks a folder that already holds a household")
        }
    }

    /// The one the panel makes easy to hit: it opens at the data directory's PARENT, so
    /// the Waffled folder is right there to be picked. By then the app's launch poll has
    /// created the tree — but not runtime.json or config.env, which are written by the
    /// first `start` — so the folders it did create have to count as evidence too, or a
    /// household ends up in Waffled/Waffled.
    func testAFolderHoldingAnUnstartedDataDirectoryIsUsedAsItIs() throws {
        let picked = try tempDir()
        try FileManager.default.createDirectory(
            at: picked.appendingPathComponent("postgres"), withIntermediateDirectories: true)
        XCTAssertEqual(Setup.dataDirectory(forChosen: picked), picked,
                       "the tree the first status poll made is still Waffled's own folder")
    }

    /// A folder already called Waffled but with nothing of ours in it is still just a
    /// folder — the name is not the evidence, what is inside it is.
    func testAnEmptyFolderNamedWaffledStillGetsOneInside() throws {
        let parent = try tempDir()
        let picked = parent.appendingPathComponent(Setup.folderName)
        try FileManager.default.createDirectory(at: picked, withIntermediateDirectories: true)
        XCTAssertEqual(Setup.dataDirectory(forChosen: picked),
                       picked.appendingPathComponent(Setup.folderName))
    }

    // MARK: writability

    func testAFolderThatCannotBeWrittenToIsRefused() throws {
        let picked = try tempDir()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: picked.path)
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700],
                                                   ofItemAtPath: picked.path)
        }

        let refusal = Setup.refusal(for: picked)
        XCTAssertNotNil(refusal, "a folder Waffled cannot write to is not somewhere it can live")
        XCTAssertTrue(refusal?.contains("write") == true,
                      "the refusal should say what is wrong, got \(refusal ?? "nil")")
    }

    func testAnOrdinaryWritableFolderIsAccepted() throws {
        XCTAssertNil(Setup.refusal(for: try tempDir()))
    }

    /// The folder Waffled is about to make does not exist when it is checked, and
    /// `isWritableFile` says no to every path that is missing — so the question is asked
    /// of the nearest folder that is really there.
    func testAFolderThatDoesNotExistYetIsJudgedByItsParent() throws {
        let parent = try tempDir()
        XCTAssertNil(Setup.refusal(for: parent.appendingPathComponent(Setup.folderName)))
    }

    func testAFolderInsideOneWeCannotWriteToIsStillRefused() throws {
        let parent = try tempDir()
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: parent.path)
        addTeardownBlock {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700],
                                                   ofItemAtPath: parent.path)
        }
        XCTAssertNotNil(Setup.refusal(for: parent.appendingPathComponent(Setup.folderName)))
    }

    /// The volume rules still apply through the same door, so there is one refusal path
    /// rather than two that can disagree.
    func testTheVolumeRulesStillApply() {
        XCTAssertNotNil(Setup.refusal(for: Setup.VolumeFacts(isRemovable: true, isInternal: false,
                                                             format: "APFS")))
    }
}
