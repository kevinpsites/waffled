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
}
