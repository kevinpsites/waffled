import XCTest
@testable import Waffled

/// The setting-up step's moving line. It reads the end of a file that grows for the life
/// of an install, once a second, so what it must never do is read the whole thing.
final class LogTailTests: XCTestCase {

    private func write(_ body: String) throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("logtail-\(UUID().uuidString).log")
        try body.write(to: url, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testItReadsTheLastLine() throws {
        let url = try write("first\nsecond\nthird\n")
        XCTAssertEqual(LogTail.lastLine(of: url), "third")
    }

    /// A log the runtime is still writing has no trailing newline, and a log it just
    /// flushed has one. Both have the same last line.
    func testATrailingNewlineIsNotTheLastLine() throws {
        XCTAssertEqual(LogTail.lastLine(of: try write("only\n")), "only")
        XCTAssertEqual(LogTail.lastLine(of: try write("only")), "only")
        XCTAssertEqual(LogTail.lastLine(of: try write("done\n\n\n")), "done")
    }

    func testNoFileAndNoLineAreBothNothingToShow() throws {
        XCTAssertNil(LogTail.lastLine(of: URL(fileURLWithPath: "/tmp/waffled-no-such-log-\(UUID())")))
        XCTAssertNil(LogTail.lastLine(of: try write("")))
        XCTAssertNil(LogTail.lastLine(of: try write("\n\n  \n")))
    }

    /// The whole point: only the tail is read. A window that started mid-line drops that
    /// partial line rather than showing half a sentence as the runtime's latest word.
    func testOnlyTheTailIsRead() throws {
        let url = try write(String(repeating: "x", count: 4000) + "\nlast line\n")
        XCTAssertEqual(LogTail.lastLine(of: url, window: 64), "last line")
    }

    /// A file shorter than the window starts at byte zero, where nothing was cut — so its
    /// first line is a whole line and must survive even when it is the only one.
    func testAFileShorterThanTheWindowKeepsItsOnlyLine() throws {
        XCTAssertEqual(LogTail.lastLine(of: try write("one line only\n"), window: 8 * 1024),
                       "one line only")
    }

    /// A window that cuts a multi-byte character mid-sequence must not throw the read
    /// away: the runtime logs household names.
    func testACutMultibyteCharacterDoesNotLoseTheLine() throws {
        let url = try write("héllo wörld ✓\nthe last one ✓\n")
        XCTAssertEqual(LogTail.lastLine(of: url, window: 20), "the last one ✓")
    }
}
