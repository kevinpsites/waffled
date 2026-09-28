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
        #expect(WaffledAPI.guestRequestAllowed(method: "PUT", path: "/api/account/password"))
        #expect(WaffledAPI.guestRequestAllowed(method: "PUT", path: "/api/account/email"))
    }

    @Test("blocks shared household writes")
    func blocksWrites() {
        #expect(!WaffledAPI.guestRequestAllowed(method: "POST", path: "/api/chores"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "PATCH", path: "/api/photos/photo-1"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "DELETE", path: "/api/events/event-1"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "PUT", path: "/api/account/profile"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "PATCH", path: "/api/account/password"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "POST", path: "/api/auth/invites/a/b/accept"))
        #expect(!WaffledAPI.guestRequestAllowed(method: "POST", path: "/api/auth/invites//accept"))
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
        let deadline = Date(timeIntervalSince1970: 1_000)
        #expect(!SyncManager.localMutationAllowed(memberType: "caregiver", accessExpiresAt: deadline,
                                                  now: Date(timeIntervalSince1970: 1_001)))
        #expect(SyncManager.localMutationAllowed(memberType: "caregiver", accessExpiresAt: deadline,
                                                 now: Date(timeIntervalSince1970: 999)))
    }

    @Test("dev-token temporary policy preserves missing malformed and null presence")
    func devTokenExpiryPresenceFailsClosed() {
        AuthTokens.clear()
        AppConfig.clearPrincipalIsolationRequirement()
        AppConfig.clearSignedOut()
        AppConfig.setDevToken("temporary-policy-test-token")
        defer {
            AppConfig.setCurrentMemberType(nil)
            AppConfig.setDevToken("")
        }

        AppConfig.setCurrentAccess(memberType: "caregiver", accessExpiry: .missing)
        #expect(AppConfig.currentAccessIsExpired)
        #expect(AppConfig.bearerToken.isEmpty)

        AppConfig.setCurrentAccess(memberType: "guest", accessExpiry: .malformed)
        #expect(AppConfig.currentAccessIsExpired)
        #expect(AppConfig.bearerToken.isEmpty)

        AppConfig.setCurrentAccess(memberType: "caregiver", accessExpiry: .null)
        #expect(!AppConfig.currentAccessIsExpired)
        #expect(AppConfig.bearerToken == "temporary-policy-test-token")
    }

    @Test("expired access purges the prior replica before releasing the login gate")
    @MainActor
    func expiryPurgesBeforeLoginGate() async {
        AppConfig.clearPrincipalIsolationRequirement()
        AuthTokens.clear()
        defer {
            AuthTokens.clear()
            AppConfig.clearPrincipalIsolationRequirement()
        }
        AuthTokens.save(access: "expired-access", refresh: "expired-refresh",
                        memberType: "caregiver",
                        accessExpiry: .value("2000-01-01T00:00:00.000Z"))

        #expect(AppConfig.currentAccessIsExpired)
        #expect(AppConfig.bearerToken.isEmpty)
        var session: Session!
        var phaseDuringPurge: Session.Phase?
        var didPurge = false
        var isolatedOnlyAfterPurge = false
        let observer = NotificationCenter.default.addObserver(
            forName: .waffledPrincipalIsolated, object: nil, queue: .main
        ) { _ in
            isolatedOnlyAfterPurge = didPurge
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        session = Session(isolateExpiredPrincipal: {
            phaseDuringPurge = session.phase
            didPurge = true
            return true
        })
        await session.bootstrap()
        #expect(phaseDuringPurge == .loading)
        #expect(didPurge)
        #expect(isolatedOnlyAfterPurge)
        #expect(session.phase == .login)
        // Once replica deletion succeeds, the old envelope is removed before the
        // login gate is released and the isolation latch can safely be cleared.
        #expect(!AuthTokens.isSignedIn)
        #expect(AppConfig.bearerToken.isEmpty)
        #expect(!AppConfig.principalIsolationRequired)
    }

    @Test("a failed replica purge keeps every signed-out gate closed")
    @MainActor
    func expiryPurgeFailureFailsClosed() async {
        AppConfig.clearPrincipalIsolationRequirement()
        AuthTokens.clear()
        defer {
            AuthTokens.clear()
            AppConfig.clearPrincipalIsolationRequirement()
        }
        AuthTokens.save(access: "expired-access", refresh: "expired-refresh",
                        memberType: "guest",
                        accessExpiry: .value("2000-01-01T00:00:00.000Z"))

        var isolatedNotificationPosted = false
        let observer = NotificationCenter.default.addObserver(
            forName: .waffledPrincipalIsolated, object: nil, queue: .main
        ) { _ in
            isolatedNotificationPosted = true
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        let session = Session(isolateExpiredPrincipal: { false })
        await session.bootstrap()

        #expect(session.phase == .loading)
        #expect(!isolatedNotificationPosted)
        #expect(AuthTokens.isSignedIn)
        #expect(AppConfig.bearerToken.isEmpty)
        #expect(AppConfig.principalIsolationRequired)

        // A process crash cannot erase the latch: the next bootstrap retries the
        // purge while the unusable old envelope remains available solely to identify
        // the principal being torn down.
        var retriedAfterRelaunch = false
        let relaunched = Session(isolateExpiredPrincipal: {
            retriedAfterRelaunch = true
            return false
        })
        await relaunched.bootstrap()
        #expect(retriedAfterRelaunch)
        #expect(relaunched.phase == .loading)
    }

    @Test("restores the last verified role after a cold offline launch")
    func verifiedRoleSurvivesRestart() {
        let roleKey = "waffled.currentMemberType"
        let serverKey = "waffled.currentMemberTypeServer"
        let authScopeKey = "waffled.currentMemberTypeAuthScope"
        AuthTokens.clear()
        AuthTokens.save(access: "offline-access", refresh: "offline-refresh", memberType: "adult")
        let identityScope = AppConfig.currentIdentityScope
        defer {
            AuthTokens.clear()
        }

        // Writing only durable values models a new process before any successful
        // /api/household request has had a chance to repopulate in-memory state.
        UserDefaults.standard.set("adult", forKey: roleKey)
        UserDefaults.standard.set(AppConfig.apiBaseURL, forKey: serverKey)
        UserDefaults.standard.set(identityScope, forKey: authScopeKey)

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

        AuthTokens.save(access: "original-access", refresh: "original-refresh", memberType: "adult")
        AppConfig.setCurrentMemberType("adult")
        // The refresher stores a rotated pair through this same path. It must not
        // make a transient/offline refresh erase the last server-verified role.
        let originalScope = AppConfig.currentIdentityScope
        AuthTokens.save(
            access: "rotated-access",
            refresh: "rotated-refresh",
            preservingIdentityScope: true
        )
        #expect(AppConfig.currentIdentityScope == originalScope)
        #expect(AppConfig.currentMemberType == "adult")

        // Logout, expired refresh credentials, and kiosk profile teardown all
        // converge on AuthTokens.clear().
        AuthTokens.clear()
        #expect(AppConfig.currentMemberType == nil)
    }

    @Test("replacement credentials rotate the identity generation")
    func replacementSessionRotatesIdentityScope() {
        AuthTokens.clear()
        defer { AuthTokens.clear() }

        AuthTokens.save(access: "first-access", refresh: "first-refresh", memberType: "adult")
        let firstScope = AppConfig.currentIdentityScope
        AuthTokens.save(access: "second-access", refresh: "second-refresh", memberType: "adult")

        #expect(firstScope != nil)
        #expect(AppConfig.currentIdentityScope != firstScope)
    }

    @Test("replacement profile session atomically replaces the durable role")
    @MainActor
    func replacementSessionClearsRole() {
        AuthTokens.clear()
        defer {
            AuthTokens.clear()
            AppConfig.setCurrentMemberType(nil)
        }

        AuthTokens.save(access: "original-access", refresh: "original-refresh", memberType: "adult")
        AppConfig.setCurrentMemberType("adult")
        AuthTokens.save(access: "replacement-access", refresh: "replacement-refresh", memberType: "teen")
        #expect(AppConfig.currentMemberType == "teen")
    }

    @Test("a claimed temporary profile persists its offline deadline immediately")
    @MainActor
    func claimedSessionPersistsDeadline() {
        AuthTokens.clear()
        defer { AuthTokens.clear() }

        let expiry = "2099-06-16T05:00:00.000Z"
        AuthTokens.save(access: "caregiver-access", refresh: "caregiver-refresh",
                        memberType: "caregiver", accessExpiry: .value(expiry))
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        #expect(AppConfig.currentMemberType == "caregiver")
        #expect(AppConfig.currentAccessExpiresAt == parser.date(from: expiry))
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
