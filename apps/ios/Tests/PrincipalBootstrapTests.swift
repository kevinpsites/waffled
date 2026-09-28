import Foundation
import Testing
@testable import Waffled

extension GuestMutationPolicyTests {
@Suite("Principal bootstrap gate", .serialized)
@MainActor
struct PrincipalBootstrapTests {
    private func reset() {
        AuthTokens.setEnvelopeWriterForTesting(nil)
        AuthTokens.seedRawStorageForTesting(envelope: nil)
        _ = AuthTokens.clear()
        AppConfig.setDevToken("")
        AppConfig.clearPrincipalIsolationRequirement()
        AppConfig.clearSignedOut()
        SyncManager.setReplicaIdentityScopeForTesting(nil)
    }

    private func session() -> Session {
        Session(api: WaffledAPI(transport: { _ in
            throw URLError(.notConnectedToInternet)
        }))
    }

    @Test("tokenless launch exposes no login or picker until legacy cleanup succeeds", arguments: [false, true])
    func tokenlessLaunchRequiresCleanup(purgeSucceeds: Bool) async {
        reset(); defer { reset() }
        var clears: [Bool] = []
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { clears.append($0); return purgeSucceeds }, start: { true }, pendingUploadCount: { 2 }
        ))
        let session = session()

        let ready = await PrincipalBootstrap.prepare(sync: sync, session: session)

        #expect(ready == purgeSucceeds)
        #expect(clears == [true])
        #expect(session.phase == (purgeSucceeds ? .login : .loading))
    }

    @Test("an active valid principal does not receive a redundant bootstrap purge")
    func validPrincipalSkipsCleanup() async {
        reset(); defer { reset() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        var clears = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in clears += 1; return true }, start: { true }, pendingUploadCount: { 2 }
        ))
        let session = session()

        #expect(await PrincipalBootstrap.prepare(sync: sync, session: session))
        #expect(clears == 0)
        #expect(session.phase == .authed)
        #expect(AuthTokens.accessToken == "A-access")
    }
}
}
