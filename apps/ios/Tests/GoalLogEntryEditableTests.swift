import Foundation
import Testing
@testable import Waffled

// A goal entry that counted itself — a checklist tick, a confirmed calendar event, an
// Apple Health sync — comes back with `editable: false`. The entry sheet reads that to
// show the note alone, because the server keeps the amount, day and people in step with
// whatever wrote the entry and refuses a change to them (and refuses the delete).
//
// The flag is OPTIONAL on purpose: this DTO is strictly decoded, so a required field
// would make an older server's payload fail to decode entirely — the goal detail would
// read as "couldn't reach the server" rather than losing one affordance.
struct GoalLogEntryEditableTests {
    private func decode(_ json: String) throws -> WaffledAPI.GoalDetail.LogEntry {
        try JSONDecoder().decode(WaffledAPI.GoalDetail.LogEntry.self, from: Data(json.utf8))
    }

    @Test func readsTheFlagWhenTheServerSendsIt() throws {
        let derived = try decode(#"{"id":"l1","amount":1,"loggedAt":"2026-08-31T18:00:00Z","dateKey":"2026-08-31","note":null,"participants":[],"editable":false}"#)
        #expect(derived.editable == false)

        let own = try decode(#"{"id":"l2","amount":3,"loggedAt":"2026-08-31T18:00:00Z","dateKey":"2026-08-31","note":"hike","participants":[],"editable":true}"#)
        #expect(own.editable == true)
    }

    @Test func decodesAgainstAServerTooOldToSendIt() throws {
        let entry = try decode(#"{"id":"l3","amount":2,"loggedAt":"2026-08-31T18:00:00Z","dateKey":"2026-08-31","note":null,"participants":[]}"#)
        // nil, not false — the sheet only locks on an explicit `false`, so an older
        // server behaves exactly as it did before the flag existed.
        #expect(entry.editable == nil)
    }
}
