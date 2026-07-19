import Testing
@testable import Waffled

// GoalLogSheet's hours/minutes free-entry fields hold raw text while editing (so a
// cleared field can stay empty instead of snapping back to the last value) and only
// normalize when editing ends. DurationEntry is the pure rule those fields share:
// empty/garbage = 0 — never the previous value — and the cap (minutes ≤ 59) applies
// to the value used, while the text is only rewritten on commit.
@Suite struct DurationEntryTests {
    @Test func emptyOrWhitespaceMeansZero() {
        #expect(DurationEntry.value(of: "") == 0)
        #expect(DurationEntry.value(of: "   ") == 0)
    }

    @Test func wholeNumbersParse() {
        #expect(DurationEntry.value(of: "5") == 5)
        #expect(DurationEntry.value(of: "07") == 7)
        #expect(DurationEntry.value(of: " 12 ") == 12)
        #expect(DurationEntry.value(of: "0") == 0)
    }

    @Test func capClampsTheValue() {
        #expect(DurationEntry.value(of: "75", cap: 59) == 59)
        #expect(DurationEntry.value(of: "59", cap: 59) == 59)
        #expect(DurationEntry.value(of: "60", cap: 59) == 59)
        #expect(DurationEntry.value(of: "8", cap: 59) == 8)
    }

    @Test func negativeAndUnparsableFallBackToZero() {
        #expect(DurationEntry.value(of: "-3") == 0)
        #expect(DurationEntry.value(of: "abc") == 0)
        #expect(DurationEntry.value(of: "1.5") == 0)
        #expect(DurationEntry.value(of: "999999999999999999999999") == 0) // Int overflow
    }

    @Test func normalizedTextIsTheCanonicalNumeral() {
        #expect(DurationEntry.normalized("") == "0")
        #expect(DurationEntry.normalized("07") == "7")
        #expect(DurationEntry.normalized("75", cap: 59) == "59")
        #expect(DurationEntry.normalized(" 4 ") == "4")
    }
}
