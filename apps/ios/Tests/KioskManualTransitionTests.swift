import Foundation
import Testing
@testable import Waffled

extension GuestMutationPolicyTests {
@Suite("Manual kiosk transition consent", .serialized)
@MainActor
struct KioskManualTransitionTests {
    private func reset() {
        AuthTokens.setEnvelopeWriterForTesting(nil)
        AuthTokens.seedRawStorageForTesting(envelope: nil)
        _ = AuthTokens.clear()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        AppConfig.clearPrincipalIsolationRequirement()
        AppConfig.clearSignedOut()
        SyncManager.setReplicaIdentityScopeForTesting(nil)
    }

    private func session() -> Session {
        Session(initialPhase: .authed, api: WaffledAPI(transport: { _ in
            throw URLError(.notConnectedToInternet)
        }))
    }

    @Test("promotion keeps queued changes unless discard was confirmed", arguments: [false, true])
    func promotionRequiresConsent(discardAuthorized: Bool) async throws {
        reset(); defer { reset() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let pairing = try WaffledAPI.decoder.decode(
            WaffledAPI.DevicePairing.self,
            from: Data(#"{"deviceSecret":"device-A","deviceId":"device-id","householdId":"household-id"}"#.utf8)
        )
        let kiosk = KioskMode(promoteDeviceRequest: { _ in pairing })
        let session = session()
        var clears: [Bool] = []
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { clears.append($0); return true }, start: { true }, pendingUploadCount: { 2 }
        ))
        let error: String?
        if discardAuthorized {
            error = await kiosk.enableViaPromote(
                label: "Kitchen", sync: sync, session: session, policy: .discardAuthorized
            )
        } else {
            error = await kiosk.enableViaPromote(label: "Kitchen", sync: sync, session: session)
        }

        if discardAuthorized {
            #expect(error == nil)
            #expect(clears == [true])
            #expect(KioskDeviceStore.secret == "device-A")
            #expect(session.phase == .login)
        } else {
            #expect(error != nil)
            #expect(clears.isEmpty)
            #expect(KioskDeviceStore.secret == nil)
            #expect(AuthTokens.accessToken == "A-access")
            #expect(session.phase == .authed)
        }
    }

    @Test("unpair keeps queued changes unless discard was confirmed", arguments: [false, true])
    func unpairRequiresConsent(discardAuthorized: Bool) async {
        reset(); defer { reset() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let kiosk = KioskMode()
        let session = session()
        var clears: [Bool] = []
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { clears.append($0); return true }, start: { true }, pendingUploadCount: { 2 }
        ))
        let completed: Bool
        if discardAuthorized {
            completed = await kiosk.unpair(sync: sync, session: session, policy: .discardAuthorized)
        } else {
            completed = await kiosk.unpair(sync: sync, session: session)
        }

        #expect(completed == discardAuthorized)
        if discardAuthorized {
            #expect(clears == [true])
            #expect(KioskDeviceStore.secret == nil)
            #expect(!kiosk.isShared)
            #expect(session.phase == .login)
        } else {
            #expect(clears.isEmpty)
            #expect(KioskDeviceStore.secret == "device-A")
            #expect(kiosk.isShared)
            #expect(AuthTokens.accessToken == "A-access")
            #expect(session.phase == .authed)
        }
    }
}
}
