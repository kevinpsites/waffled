import XCTest
@testable import Waffled

/// The menu has one line, and both places that shorten a message to fit it now use the
/// same rule. These are that rule.
final class FirstLineTests: XCTestCase {

    func testTheFirstLineWithAnythingOnIt() {
        XCTAssertEqual("postgres refused to start\ninitdb: no space left".firstLine,
                       "postgres refused to start")
        XCTAssertEqual("just the one line".firstLine, "just the one line")
    }

    /// A message that starts with blank lines still has something to say. Taking "the
    /// first line" literally there would show the menu an empty status.
    func testLeadingBlankLinesAreSkipped() {
        XCTAssertEqual("\n   \nthe real complaint\nmore".firstLine, "the real complaint")
    }

    /// Trimming is whitespace *and newlines*, which is what makes CRLF work: the `\r`
    /// left behind by splitting on `\n` would otherwise ride along into the label.
    func testCarriageReturnsAndPaddingAreTrimmed() {
        XCTAssertEqual("  padded  \nsecond".firstLine, "padded")
        XCTAssertEqual("windows line\r\nsecond".firstLine, "windows line")
    }

    /// Nothing to say is `nil`, so every call site can supply its own fallback wording.
    func testNothingToSayIsNil() {
        XCTAssertNil("".firstLine)
        XCTAssertNil("\n\n".firstLine)
        XCTAssertNil("   \t  ".firstLine)
    }
}
