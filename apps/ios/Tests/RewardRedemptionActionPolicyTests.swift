import Testing
import Foundation
@testable import Waffled

@Suite struct RewardRedemptionActionPolicyTests {
    @Test func requesterCanCancelTheirPendingRequestForSomeoneElse() {
        #expect(RewardRedemptionActionPolicy.canCancel(
            requestedBy: "requester", currentPersonId: "requester", canApprove: false
        ))
    }

    @Test func redemptionSubjectCannotCancelAnotherPersonsRequest() {
        #expect(!RewardRedemptionActionPolicy.canCancel(
            requestedBy: "requester", currentPersonId: "subject", canApprove: false
        ))
    }

    @Test func approverCanCancelAnyPendingRequest() {
        #expect(RewardRedemptionActionPolicy.canCancel(
            requestedBy: nil, currentPersonId: "approver", canApprove: true
        ))
    }

    @Test func choresModuleGatesLedgerMutationsButNotHistoricalCancellation() {
        #expect(RewardRedemptionActionPolicy.canCancel(
            requestedBy: "requester", currentPersonId: "requester", canApprove: false
        ))
        #expect(!RewardRedemptionActionPolicy.canAward(choresOn: false, hasCapability: true))
        #expect(!RewardRedemptionActionPolicy.canCorrect(choresOn: false, hasCapability: true))
        #expect(RewardRedemptionActionPolicy.canCorrect(choresOn: true, hasCapability: true))
        #expect(!RewardRedemptionActionPolicy.canCorrectLedgerEntry(
            choresOn: true, hasCapability: true, reversible: true,
            reversedById: "reversal-id", redemptionId: nil
        ))
    }
}

@Suite struct RewardCorrectionCompatibilityTests {
    @Test func reasonMustStayWithinTheServerAuditLimit() {
        #expect(RewardCorrectionValidation.reasonError("ok") != nil)
        #expect(RewardCorrectionValidation.reasonError("valid reason") == nil)
        #expect(RewardCorrectionValidation.reasonError(String(repeating: "x", count: 500)) == nil)
        #expect(RewardCorrectionValidation.reasonError(String(repeating: "x", count: 501)) != nil)
        #expect(RewardCorrectionValidation.reasonError(String(repeating: "🪙", count: 250)) == nil)
        #expect(RewardCorrectionValidation.reasonError(String(repeating: "🪙", count: 251)) != nil)
    }

    @Test func decodesLedgerHistoryFromAnOlderServerWithoutCorrectionFields() throws {
        let json = #"{"amount":5,"reason":"spot_award","currency":"stars","detail":"Helpful","note":null,"createdAt":"2026-07-31T12:00:00Z"}"#
        let entry = try WaffledAPI.decoder.decode(
            WaffledAPI.PersonOverview.LedgerEntry.self,
            from: Data(json.utf8)
        )

        #expect(entry.id == "2026-07-31T12:00:00Zspot_award5Helpful")
        #expect(entry.reversible == false)
        #expect(entry.reversedById == nil)
    }

    @Test func correctionLabelIncludesItsAuditReason() throws {
        let json = #"{"id":"entry-1","amount":3,"reason":"ledger_correction","currency":"stars","detail":"Spot award","note":null,"correctionReason":"Amount entered incorrectly","correctionOfId":"original-1","reversedById":null,"reversible":true,"redemptionId":null,"createdAt":"2026-07-31T12:00:00Z"}"#
        let entry = try WaffledAPI.decoder.decode(
            WaffledAPI.PersonOverview.LedgerEntry.self,
            from: Data(json.utf8)
        )

        #expect(entry.label == "Corrected · Spot award · Amount entered incorrectly")
    }
}
