import Testing
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
}
