import Foundation
import Testing
@testable import Waffled

@Suite("Guest mutation policy", .serialized)
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

    @Test("restores the last verified role after a cold offline launch")
    func verifiedRoleSurvivesRestart() {
        let roleKey = "waffled.currentMemberType"
        let serverKey = "waffled.currentMemberTypeServer"
        let authScopeKey = "waffled.currentMemberTypeAuthScope"
        AuthTokens.clear()
        AuthTokens.save(access: "offline-access", refresh: "offline-refresh")
        defer {
            AuthTokens.clear()
        }

        // Writing only durable values models a new process before any successful
        // /api/household request has had a chance to repopulate in-memory state.
        UserDefaults.standard.set("adult", forKey: roleKey)
        UserDefaults.standard.set(AppConfig.apiBaseURL, forKey: serverKey)
        UserDefaults.standard.set("session", forKey: authScopeKey)

        #expect(AppConfig.currentMemberType == "adult")
        #expect(SyncManager.localMutationAllowed(memberType: AppConfig.currentMemberType))
    }

    @Test("server and dev-token changes clear the trusted role")
    func connectionChangesClearRole() {
        AuthTokens.clear()
        defer {
            _ = AppConfig.setApiBaseURL("")
            AppConfig.setDevToken("")
            AppConfig.setCurrentMemberType(nil)
        }

        _ = AppConfig.setApiBaseURL("")
        AppConfig.setDevToken("initial-dev-token")
        AppConfig.setCurrentMemberType("adult")
        #expect(AppConfig.setApiBaseURL("https://role-cache-test.invalid"))
        #expect(AppConfig.currentMemberType == nil)

        AppConfig.setCurrentMemberType("adult")
        AppConfig.setDevToken("replacement-dev-token")
        #expect(AppConfig.currentMemberType == nil)
    }

    @Test("auth teardown clears the durable role while token rotation preserves it")
    func authTokenLifecycleScopesRole() {
        AuthTokens.clear()
        defer {
            AuthTokens.clear()
            AppConfig.setCurrentMemberType(nil)
        }

        AuthTokens.save(access: "original-access", refresh: "original-refresh")
        AppConfig.setCurrentMemberType("adult")
        // The refresher stores a rotated pair through this same path. It must not
        // make a transient/offline refresh erase the last server-verified role.
        AuthTokens.save(access: "rotated-access", refresh: "rotated-refresh")
        #expect(AppConfig.currentMemberType == "adult")

        // Logout, expired refresh credentials, and kiosk profile teardown all
        // converge on AuthTokens.clear().
        AuthTokens.clear()
        #expect(AppConfig.currentMemberType == nil)
    }

    @Test("replacement profile session clears the durable role")
    @MainActor
    func replacementSessionClearsRole() {
        AuthTokens.clear()
        defer {
            AuthTokens.clear()
            AppConfig.setCurrentMemberType(nil)
        }

        AuthTokens.save(access: "original-access", refresh: "original-refresh")
        AppConfig.setCurrentMemberType("adult")
        Session().enterClaimedSession(access: "replacement-access", refresh: "replacement-refresh")
        #expect(AppConfig.currentMemberType == nil)
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
