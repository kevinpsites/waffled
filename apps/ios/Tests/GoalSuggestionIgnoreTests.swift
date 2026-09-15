import Foundation
import Testing
@testable import Waffled

// Review events → "Ignore…": the words a person can pick come from the server, so the
// client never re-implements the matcher's stopword filter.
@Suite struct GoalSuggestionIgnoreTests {
    private func decode(_ json: String) throws -> WaffledAPI.GoalSuggestionItem {
        try JSONDecoder().decode(WaffledAPI.GoalSuggestionItem.self, from: Data(json.utf8))
    }

    @Test func decodesTheWordsOfferedForIgnoring() throws {
        let s = try decode("""
        {"eventId":"e1","title":"🧊 Thaw for Dinner · Garlic Chicken","startsAt":"2026-09-14T15:00:00Z",
         "allDay":false,"goalId":"g1","goalTitle":"Host 30 families","goalEmoji":"🏡","via":"llm",
         "ignoreWords":["thaw","dinner","garlic","chicken"]}
        """)
        #expect(s.ignoreWords == ["thaw", "dinner", "garlic", "chicken"])
    }

    @Test func anOlderServerWithoutIgnoreWordsStillDecodes() throws {
        let s = try decode("""
        {"eventId":"e1","title":"Library trip","startsAt":"2026-09-14T15:00:00Z","allDay":false,
         "goalId":"g1","goalTitle":"Reading","goalEmoji":null,"via":"keyword"}
        """)
        #expect(s.ignoreWords.isEmpty)
    }

    @Test func ignoringNeedsAtLeastOneWordPicked() {
        #expect(!ReviewEventsModel.canIgnore(picked: []))
        #expect(ReviewEventsModel.canIgnore(picked: ["thaw"]))
    }
}
