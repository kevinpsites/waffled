import Testing
@testable import Waffled

@Suite struct ChoreScopePolicyTests {
    @Test func pendingOccurrenceCanBeEditedAloneWhenRepeatIsUnchanged() {
        #expect(ChoreScopePolicy.allowsSingleOccurrence(status: "pending", repeatChanged: false))
    }

    @Test func repeatChangesCannotApplyToOneOccurrence() {
        #expect(!ChoreScopePolicy.allowsSingleOccurrence(status: "pending", repeatChanged: true))
    }

    @Test(arguments: ["done", "awaiting"])
    func settledOccurrenceCannotBeEditedOrDeletedAlone(status: String) {
        #expect(!ChoreScopePolicy.allowsSingleOccurrence(status: status, repeatChanged: false))
        #expect(ChoreScopePolicy.explanation(status: status).contains("stays unchanged"))
    }
}
