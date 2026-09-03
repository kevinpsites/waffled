import Testing
@testable import Waffled

@Suite("Guest mutation policy")
struct GuestMutationPolicyTests {
    @Test("allows reads and account recovery routes")
    func allowsRecovery() {
        #expect(WaffledAPI.guestRequestAllowed(method: "GET", path: "/api/photos"))
        #expect(WaffledAPI.guestRequestAllowed(method: "POST", path: "/api/auth/switch"))
        #expect(WaffledAPI.guestRequestAllowed(method: "POST", path: "/api/auth/invites/invite-1/accept"))
        #expect(WaffledAPI.guestRequestAllowed(method: "PATCH", path: "/api/account/password"))
    }

    @Test("blocks shared household writes")
    func blocksWrites() {
        #expect(!WaffledAPI.guestRequestAllowed(method: "POST", path: "/api/chores"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "PATCH", path: "/api/photos/photo-1"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "DELETE", path: "/api/events/event-1"))
    }

    @Test("queues local writes only for known write-capable roles")
    func localWriteGateFailsClosed() {
        #expect(!SyncManager.localMutationAllowed(memberType: nil))
        #expect(!SyncManager.localMutationAllowed(memberType: "guest"))
        #expect(!SyncManager.localMutationAllowed(memberType: "house-sitter"))
        #expect(SyncManager.localMutationAllowed(memberType: "adult"))
        #expect(SyncManager.localMutationAllowed(memberType: "caregiver"))
        #expect(SyncManager.localMutationAllowed(memberType: "teen"))
        #expect(SyncManager.localMutationAllowed(memberType: "kid"))
    }

    @Test("only guest read-only upload failures are permanent")
    func permanentUploadFailure() {
        #expect(WaffledConnector.isPermanentUploadRejection(
            WaffledAPI.APIError.http(403, #"{"error":"AuthError","message":"Guest access is read-only"}"#)
        ))
        #expect(WaffledConnector.isPermanentUploadRejection(
            WaffledAPI.APIError.http(403, #"{"error":"Forbidden","message":"Guest access is read-only."}"#)
        ))
        #expect(!WaffledConnector.isPermanentUploadRejection(
            WaffledAPI.APIError.http(403, #"{"error":"Forbidden","message":"Admin privileges required"}"#)
        ))
        #expect(!WaffledConnector.isPermanentUploadRejection(
            WaffledAPI.APIError.http(503, #"{"error":"Unavailable"}"#)
        ))
    }
}
