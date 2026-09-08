import Foundation
import Testing
@testable import Waffled

private actor HardeningGate {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var waiter: CheckedContinuation<Void, Never>?

    func wait() async {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withCheckedContinuation { waiter = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func release() {
        waiter?.resume()
        waiter = nil
    }
}

private final class SnapshotBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: KioskDeviceStore.Snapshot

    init(_ value: KioskDeviceStore.Snapshot) { self.value = value }
    func get() -> KioskDeviceStore.Snapshot { lock.withLock { value } }
    func set(_ value: KioskDeviceStore.Snapshot) { lock.withLock { self.value = value } }
}

private final class DateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) { self.value = value }
    func get() -> Date { lock.withLock { value } }
    func set(_ value: Date) { lock.withLock { self.value = value } }
}

private actor HTTPRequestRecorder {
    private var requests: [URLRequest] = []
    private var refreshCount = 0

    func record(_ request: URLRequest) { requests.append(request) }
    func recordAndCount(_ request: URLRequest) -> Int {
        requests.append(request)
        return requests.count
    }
    func recordRefresh() { refreshCount += 1 }
    func nextRefresh() -> Int { refreshCount += 1; return refreshCount }
    func all() -> [URLRequest] { requests }
    func refreshes() -> Int { refreshCount }
}

private func httpResponse(_ request: URLRequest, status: Int) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
    )!
}

extension GuestMutationPolicyTests {
@Suite("Principal hardening", .serialized)
@MainActor
struct PrincipalHardeningTests {
    private func cleanupAuth() {
        AuthTokens.setEnvelopeWriterForTesting(nil)
        AuthTokens.seedRawStorageForTesting(envelope: nil)
        _ = AuthTokens.clear()
        AppConfig.clearPrincipalIsolationRequirement()
        SyncManager.setReplicaIdentityScopeForTesting(nil)
    }

    private func kioskProfile() throws -> WaffledAPI.KioskProfile {
        try WaffledAPI.decoder.decode(
            WaffledAPI.KioskProfile.self,
            from: Data(#"{"id":"person-a","name":"A","memberType":"adult","accessExpiresAt":null,"hasPin":false}"#.utf8)
        )
    }

    private func kioskClaim() throws -> WaffledAPI.KioskClaim {
        try WaffledAPI.decoder.decode(
            WaffledAPI.KioskClaim.self,
            from: Data(#"{"accessToken":"A-access","refreshToken":"A-refresh","person":{"id":"person-a","name":"A","memberType":"adult","accessExpiresAt":null}}"#.utf8)
        )
    }

    private func devicePairing(secret: String) throws -> WaffledAPI.DevicePairing {
        try WaffledAPI.decoder.decode(
            WaffledAPI.DevicePairing.self,
            from: Data(#"{"deviceSecret":"\#(secret)","deviceId":"device-id","householdId":"household-id"}"#.utf8)
        )
    }

    @Test("replacement credentials remain uninstalled until writer drain and purge")
    func replacementWaitsForWriterAndPurge() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        #expect(AppConfig.currentAccessExpiresAt == nil)
        let source = AppConfig.currentIdentityScope
        var events: [String] = []
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in events.append("purge"); return true },
            start: { events.append("start"); return true },
            pendingUploadCount: { events.append("count"); return 0 }
        ))
        let writerGate = HardeningGate()
        let writer = Task { await sync.withLocalWriteLeaseForTesting { await writerGate.wait() } }
        await writerGate.waitUntilStarted()

        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh",
            memberType: "adult", accessExpiry: .missing
        )
        let session = Session(initialPhase: .authed)
        let transition = Task {
            await session.adoptCandidate(candidate, sourceScope: source, sync: sync)
        }
        await Task.yield()
        #expect(AuthTokens.accessToken == "A-access")
        #expect(session.phase == .loading)
        #expect(events.isEmpty)

        await writerGate.release()
        #expect(await writer.value)
        #expect(await transition.value == nil)
        #expect(events == ["count", "purge", "start"])
        #expect(AuthTokens.accessToken == "B-access")
        #expect(AppConfig.currentAccessExpiresAt == nil)
        #expect(session.phase == .authed)
    }

    @Test("replacement waits for a multi-step REST mutation to finish under its source principal")
    func replacementDrainsRESTMutationLease() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let source = AppConfig.currentIdentityScope
        let requestGate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let api = WaffledAPI(transport: { request in
            let count = await recorder.recordAndCount(request)
            if count == 1 { await requestGate.wait() }
            let body = request.url?.path == "/api/recipes"
                ? Data(#"{"recipes":[]}"#.utf8)
                : Data(#"{}"#.utf8)
            return (body, httpResponse(request, status: 200))
        })
        var lifecycle: [String] = []
        let sync = SyncManager(
            testConnectionLifecycle: .init(
                stop: { _ in lifecycle.append("purge"); return true },
                start: { lifecycle.append("start"); return true },
                pendingUploadCount: { lifecycle.append("count"); return 0 }
            ),
            api: api
        )
        let mutation = Task {
            await sync.commitMeal(title: "Tacos", date: "2026-09-04", mealType: "dinner")
        }
        await requestGate.waitUntilStarted()

        let session = Session(initialPhase: .authed)
        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh",
            memberType: "adult", accessExpiry: .missing
        )
        let transition = Task {
            await session.adoptCandidate(candidate, sourceScope: source, sync: sync)
        }
        for _ in 0..<100 where session.phase != .loading { await Task.yield() }
        #expect(session.phase == .loading)
        #expect(AuthTokens.accessToken == "A-access")
        #expect(lifecycle.isEmpty)

        await requestGate.release()
        #expect(await mutation.value)
        #expect(await transition.value == nil)
        let requests = await recorder.all()
        #expect(requests.map { $0.url?.path } == ["/api/recipes", "/api/meals/plan"])
        #expect(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer A-access"
        })
        #expect(lifecycle == ["count", "purge", "start"])
        #expect(AuthTokens.accessToken == "B-access")
    }

    @Test("purge failure keeps the neutral gate and old envelope")
    func failedReplacementStaysClosed() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let source = AppConfig.currentIdentityScope
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in false }, start: { true }, pendingUploadCount: { 0 }
        ))
        let session = Session(initialPhase: .authed)
        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh",
            memberType: "adult", accessExpiry: .missing
        )

        #expect(await session.adoptCandidate(candidate, sourceScope: source, sync: sync) != nil)
        #expect(session.phase == .loading)
        #expect(AuthTokens.accessToken == "A-access")
    }

    @Test("expiry waits for a delayed SQLite writer before exact ps_crud check")
    func expiryDrainsWriterBeforeCounting() async {
        var events: [String] = []
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in events.append("purge"); return true },
            start: { true },
            pendingUploadCount: { events.append("count"); return 4 }
        ))
        let gate = HardeningGate()
        let writer = Task { await sync.withLocalWriteLeaseForTesting { await gate.wait() } }
        await gate.waitUntilStarted()
        let expiry = Task { await sync.signOut(policy: .securityCritical) }
        await Task.yield()
        #expect(events.isEmpty)
        #expect(!(await sync.withLocalWriteLeaseForTesting {}))
        await gate.release()
        #expect(await writer.value)
        #expect(await expiry.value == .completed)
        #expect(events == ["count", "purge"])
    }

    @Test("isolation resets every household-derived metadata cache")
    func isolationResetsHouseholdMetadata() async {
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))
        sync.seedPrincipalMetadataForTesting()
        #expect(sync.module(.pantry))
        #expect(!sync.rewardsOn)
        #expect(sync.eventStyle == .tinted)
        #expect(sync.householdWeekStart == .monday)

        #expect(await sync.signOut(policy: .securityCritical) == .completed)
        #expect(!sync.module(.pantry))
        #expect(sync.rewardsOn)
        #expect(sync.eventStyle == .solid)
        #expect(sync.familyColorHex == EventPalette.defaultFamilyHex)
        #expect(sync.householdWeekStart == nil)
        #expect(HouseholdWeekStartStore.load() == nil)
    }

    @Test("presence-aware expiry rejects missing malformed and unknown sessions")
    func expiryPresenceDecoding() throws {
        let base = #"{"accessToken":"a","refreshToken":"r","memberType":"caregiver"}"#
        let missing = try WaffledAPI.decoder.decode(WaffledAPI.Session.self, from: Data(base.utf8))
        #expect(missing.accessExpiry == .missing)
        #expect(!missing.candidate.isValid)

        let explicitNull = try WaffledAPI.decoder.decode(
            WaffledAPI.Session.self,
            from: Data(#"{"accessToken":"a","refreshToken":"r","memberType":"guest","accessExpiresAt":null}"#.utf8)
        )
        #expect(explicitNull.accessExpiry == .null)
        #expect(explicitNull.candidate.isValid)

        let malformed = try WaffledAPI.decoder.decode(
            WaffledAPI.Session.self,
            from: Data(#"{"accessToken":"a","refreshToken":"r","memberType":"guest","accessExpiresAt":17}"#.utf8)
        )
        #expect(malformed.accessExpiry == .malformed)
        #expect(!malformed.candidate.isValid)

        let unknown = AuthTokens.Candidate(
            accessToken: "a", refreshToken: "r", memberType: nil, accessExpiry: .missing
        )
        #expect(!unknown.isValid)

        let expired = AuthTokens.Candidate(
            accessToken: "a", refreshToken: "r", memberType: "caregiver",
            accessExpiry: .value("2000-01-01T00:00:00.000Z")
        )
        #expect(expired.isValid)
        #expect(!expired.isUsable(at: Date()))
    }

    @Test("split legacy credentials are never migrated")
    func legacySplitPairFailsClosed() {
        cleanupAuth(); defer { cleanupAuth() }
        AuthTokens.seedRawStorageForTesting(
            envelope: nil, legacyAccess: "possibly-B", legacyRefresh: "possibly-A"
        )
        #expect(AuthTokens.accessToken == nil)
        #expect(AppConfig.principalIsolationRequired)
    }

    @Test("malformed envelope never falls back to legacy credentials")
    func malformedEnvelopeFailsClosed() {
        cleanupAuth(); defer { cleanupAuth() }
        AuthTokens.seedRawStorageForTesting(
            envelope: "not-json", legacyAccess: "legacy-A", legacyRefresh: "legacy-R"
        )
        #expect(AuthTokens.accessToken == nil)
        #expect(AppConfig.principalIsolationRequired)
    }

    @Test("failed atomic Keychain commit cannot authenticate or revive an old envelope")
    func envelopeCommitFailureFailsClosed() {
        cleanupAuth(); defer { cleanupAuth() }
        AuthTokens.setEnvelopeWriterForTesting { raw in raw == nil }
        let saved = AuthTokens.save(
            access: "B-access", refresh: "B-refresh", memberType: "adult"
        )
        #expect(!saved)
        #expect(AuthTokens.accessToken == nil)
        #expect(AppConfig.principalIsolationRequired)
        AuthTokens.setEnvelopeWriterForTesting(nil)
        #expect(AuthTokens.accessToken == nil)
    }

    @Test("failed envelope adoption skips sync start and releases login after purge")
    func failedEnvelopeAdoptionFinishesIsolation() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let source = AppConfig.currentIdentityScope
        var starts = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true },
            start: { starts += 1; return true },
            pendingUploadCount: { 0 }
        ))
        let session = Session(initialPhase: .authed)
        AuthTokens.setEnvelopeWriterForTesting { raw in
            guard raw == nil else { return false }
            return Keychain.set("waffled.sessionEnvelope.v1", nil)
        }

        let error = await session.adoptCandidate(
            .init(accessToken: "B-access", refreshToken: "B-refresh",
                  memberType: "adult", accessExpiry: .missing),
            sourceScope: source,
            sync: sync
        )

        #expect(error != nil)
        #expect(starts == 0)
        #expect(session.phase == .login)
        #expect(!AuthTokens.isSignedIn)
        #expect(!AppConfig.principalIsolationRequired)
        AuthTokens.setEnvelopeWriterForTesting(nil)
        #expect(AuthTokens.accessToken == nil)
    }

    @Test("expiry preemption keeps login hidden until its queued purge finishes")
    func expiryPreemptsReplacementWithoutOpeningGate() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let source = AppConfig.currentIdentityScope
        let deadline = Date(timeIntervalSince1970: 2_000)
        var clock = Date(timeIntervalSince1970: 1_000)
        var stops = 0
        let startGate = HardeningGate()
        let expiryPurgeGate = HardeningGate()
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in
                stops += 1
                if stops == 2 { await expiryPurgeGate.wait() }
                return true
            },
            start: { await startGate.wait(); return true },
            pendingUploadCount: { 0 }
        ))
        let session = Session(
            initialPhase: .authed,
            isolateExpiredPrincipal: { await sync.isolateExpiredPrincipal() },
            now: { clock }
        )
        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh", memberType: "guest",
            accessExpiry: .value(ISO8601DateFormatter().string(from: deadline))
        )

        let replacement = Task {
            await session.adoptCandidate(candidate, sourceScope: source, sync: sync)
        }
        await startGate.waitUntilStarted()
        clock = Date(timeIntervalSince1970: 2_001)
        let expiry = Task { await session.recheckAccessExpiry() }
        for _ in 0..<20 where !AppConfig.principalIsolationRequired { await Task.yield() }
        #expect(AppConfig.principalIsolationRequired)

        await startGate.release()
        await expiryPurgeGate.waitUntilStarted()
        #expect(await replacement.value != nil)
        #expect(session.phase == .loading)
        #expect(AppConfig.principalIsolationRequired)

        await expiryPurgeGate.release()
        await expiry.value
        #expect(stops == 2)
        #expect(session.phase == .login)
        #expect(!AuthTokens.isSignedIn)
        #expect(!AppConfig.principalIsolationRequired)
    }

    @Test("transition result detecting expiry starts isolation before releasing a gate")
    func preLatchExpiryResultStartsIsolation() async {
        cleanupAuth(); defer { cleanupAuth() }
        let deadline = Date(timeIntervalSince1970: 2_000)
        var clock = Date(timeIntervalSince1970: 1_000)
        #expect(AuthTokens.save(
            access: "A-access", refresh: "A-refresh", memberType: "guest",
            accessExpiry: .value(ISO8601DateFormatter().string(from: deadline))
        ))
        let source = AppConfig.currentIdentityScope
        var counts = 0
        let purgeGate = HardeningGate()
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in await purgeGate.wait(); return true },
            start: { true },
            pendingUploadCount: {
                counts += 1
                if counts == 1 {
                    clock = Date(timeIntervalSince1970: 2_001)
                    return 1
                }
                return 0
            }
        ))
        let session = Session(
            initialPhase: .authed,
            isolateExpiredPrincipal: { await sync.isolateExpiredPrincipal() },
            now: { clock }
        )
        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh",
            memberType: "adult", accessExpiry: .missing
        )

        let replacement = Task {
            await session.adoptCandidate(
                candidate,
                sourceScope: source,
                sync: sync,
                policy: .requireNoPendingUploads
            )
        }
        await purgeGate.waitUntilStarted()
        #expect(session.phase == .loading)
        #expect(AppConfig.principalIsolationRequired)
        #expect(AuthTokens.accessToken == "A-access")

        await purgeGate.release()
        #expect(await replacement.value != nil)
        #expect(counts == 2)
        #expect(session.phase == .login)
        #expect(!AuthTokens.isSignedIn)
    }

    @Test("an older envelope left by delete failure cannot revive on relaunch")
    func failedDeleteLeavesDurableIsolationLatch() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        AuthTokens.setEnvelopeWriterForTesting { _ in false }
        #expect(!AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "adult"))
        #expect(AppConfig.principalIsolationRequired)

        // Model a relaunch with the live Keychain implementation. The old item can be
        // read, but the crash-safe latch prevents it from becoming usable/authed.
        AuthTokens.setEnvelopeWriterForTesting(nil)
        #expect(AuthTokens.accessToken == "A-access")
        #expect(!AppConfig.hasUsableToken)
        let session = Session(isolateExpiredPrincipal: { true })
        await session.bootstrap()
        #expect(session.phase == .login)
        #expect(AuthTokens.accessToken == nil)
        #expect(!AppConfig.principalIsolationRequired)
    }

    @Test("explicit null remains an atomic indefinite temporary policy")
    func explicitNullRoundTrips() {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(
            access: "guest-access", refresh: "guest-refresh",
            memberType: "guest", accessExpiry: .null
        ))
        #expect(AuthTokens.memberType == "guest")
        #expect(AuthTokens.accessExpiry == .null)
        #expect(!AppConfig.currentAccessIsExpired)
    }

    @Test("foreground clock recheck expires immediately after a wall-clock jump")
    func wallClockJumpExpires() async {
        cleanupAuth(); defer { cleanupAuth() }
        let deadline = Date(timeIntervalSince1970: 2_000)
        var clock = Date(timeIntervalSince1970: 1_000)
        #expect(AuthTokens.save(
            access: "guest-access", refresh: "guest-refresh", memberType: "guest",
            accessExpiry: .value(ISO8601DateFormatter().string(from: deadline))
        ))
        var purges = 0
        let session = Session(
            initialPhase: .authed,
            isolateExpiredPrincipal: { purges += 1; return true },
            now: { clock }
        )
        await session.recheckAccessExpiry()
        #expect(purges == 0)
        #expect(session.phase == .authed)
        clock = Date(timeIntervalSince1970: 2_001)
        await session.recheckAccessExpiry()
        #expect(purges == 1)
        #expect(session.phase == .login)
    }

    @Test("temporary deadline crossing a principal transition never opens auth")
    func deadlineCrossingTransitionStaysClosed() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let source = AppConfig.currentIdentityScope
        let deadline = Date().addingTimeInterval(60)
        var clock = deadline.addingTimeInterval(-30)
        var purgeCount = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in
                purgeCount += 1
                if purgeCount == 1 { clock = deadline.addingTimeInterval(1) }
                return true
            },
            start: { true },
            pendingUploadCount: { 0 }
        ))
        let session = Session(
            initialPhase: .authed,
            isolateExpiredPrincipal: { await sync.isolateExpiredPrincipal() },
            now: { clock }
        )
        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh", memberType: "guest",
            accessExpiry: .value(ISO8601DateFormatter().string(from: deadline))
        )

        #expect(await session.adoptCandidate(candidate, sourceScope: source, sync: sync) != nil)
        #expect(purgeCount == 2)
        #expect(session.phase == .login)
        #expect(AuthTokens.accessToken == nil)
        #expect(!AppConfig.principalIsolationRequired)
    }

    @Test("delayed kiosk mint cannot cross clear and re-pair")
    func kioskMintIsBoundToSecretGeneration() async throws {
        let a = KioskDeviceStore.Snapshot(secret: "A", generation: 1, apiBaseURL: "https://a.invalid")
        let b = KioskDeviceStore.Snapshot(secret: "B", generation: 3, apiBaseURL: "https://a.invalid")
        let box = SnapshotBox(a)
        let gate = HardeningGate()
        let auth = KioskDeviceAuth(snapshot: { box.get() }, mint: { snapshot in
            if snapshot.secret == "A" {
                await gate.wait()
                return .init(accessToken: "token-A", expiresAt: .distantFuture)
            }
            return .init(accessToken: "token-B", expiresAt: .distantFuture)
        })
        let delayedA = Task { try? await auth.token() }
        await gate.waitUntilStarted()
        box.set(b)
        await gate.release()
        #expect(await delayedA.value == nil)
        #expect(try await auth.token() == "token-B")
    }

    @Test("delayed kiosk claim response cannot cross clear and re-pair")
    func kioskClaimIsBoundToDeviceGeneration() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let profile = try kioskProfile()
        let claim = try kioskClaim()
        let gate = HardeningGate()
        let kiosk = KioskMode(claimProfileRequest: { _, _ in
            await gate.wait()
            return claim
        })
        let session = Session(initialPhase: .login)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))

        let delayedA = Task {
            await kiosk.claim(profile, pin: nil, sync: sync, session: session)
        }
        await gate.waitUntilStarted()
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await gate.release()

        guard case .failed = await delayedA.value else {
            Issue.record("superseded device-A claim unexpectedly succeeded")
            return
        }
        #expect(AuthTokens.accessToken == nil)
        #expect(KioskDeviceStore.secret == "device-B")
        #expect(kiosk.needsPicker)
    }

    @Test("kiosk identity is rechecked inside the post-drain credential commit")
    func kioskClaimChangingDuringReauthCannotCommit() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(AuthTokens.save(access: "old-access", refresh: "old-refresh", memberType: "adult"))
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let stopGate = HardeningGate()
        var starts = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in await stopGate.wait(); return true },
            start: { starts += 1; return true },
            pendingUploadCount: { 0 }
        ))
        let kiosk = KioskMode(claimProfileRequest: { _, _ in try kioskClaim() })
        let session = Session(initialPhase: .authed)
        let profile = try kioskProfile()

        let claimTask = Task {
            await kiosk.claim(profile, pin: nil, sync: sync, session: session)
        }
        await stopGate.waitUntilStarted()
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await stopGate.release()

        guard case .failed = await claimTask.value else {
            Issue.record("device-A claim committed after device-B replaced it")
            return
        }
        #expect(starts == 0)
        #expect(AuthTokens.accessToken == nil)
        #expect(KioskDeviceStore.secret == "device-B")
        #expect(session.phase == .login)
    }

    @Test("concurrent kiosk claim leaves the picker rendered and owned by the first request")
    func concurrentKioskClaimsAreOwned() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let requestGate = HardeningGate()
        var requests = 0
        let kiosk = KioskMode(claimProfileRequest: { _, _ in
            requests += 1
            await requestGate.wait()
            return try kioskClaim()
        })
        let session = Session(initialPhase: .login)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))
        let profile = try kioskProfile()

        let first = Task { await kiosk.claim(profile, pin: nil, sync: sync, session: session) }
        await requestGate.waitUntilStarted()
        #expect(kiosk.claimInFlight)
        #expect(!kiosk.principalTransitionInProgress)
        #expect(kiosk.needsPicker)
        guard case .failed = await kiosk.claim(profile, pin: nil, sync: sync, session: session) else {
            Issue.record("a second concurrent claim was not rejected")
            return
        }
        #expect(requests == 1)
        #expect(kiosk.claimInFlight)
        #expect(!kiosk.principalTransitionInProgress)
        #expect(kiosk.needsPicker)

        await requestGate.release()
        #expect(await first.value == .ok)
        #expect(kiosk.hasProfile)
        #expect(!kiosk.claimInFlight)
        #expect(!kiosk.principalTransitionInProgress)
    }

    @Test("failed kiosk claim purge keeps the outer picker gate closed")
    func failedKioskClaimPurgeStaysNeutral() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let kiosk = KioskMode(claimProfileRequest: { _, _ in try kioskClaim() })
        let session = Session(initialPhase: .login)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in false }, start: { true }, pendingUploadCount: { 0 }
        ))

        guard case .failed = await kiosk.claim(
            try kioskProfile(), pin: nil, sync: sync, session: session
        ) else {
            Issue.record("claim unexpectedly succeeded after its replica purge failed")
            return
        }
        #expect(session.phase == .loading)
        #expect(kiosk.principalTransitionInProgress)
        #expect(!kiosk.needsPicker)
        #expect(!kiosk.hasProfile)
        #expect(AuthTokens.accessToken == nil)
    }

    @Test("kiosk context changing during replacement start purges the committed profile")
    func kioskClaimChangingDuringSyncStartIsPurged() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let startGate = HardeningGate()
        var stops = 0
        var starts = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in stops += 1; return true },
            start: {
                starts += 1
                await startGate.wait()
                return true
            },
            pendingUploadCount: { 0 }
        ))
        let kiosk = KioskMode(claimProfileRequest: { _, _ in try kioskClaim() })
        let session = Session(
            initialPhase: .login,
            isolateExpiredPrincipal: { await sync.isolateExpiredPrincipal() }
        )
        let profile = try kioskProfile()

        let task = Task { await kiosk.claim(profile, pin: nil, sync: sync, session: session) }
        await startGate.waitUntilStarted()
        #expect(AuthTokens.accessToken == "A-access")
        #expect(session.phase == .loading)
        #expect(kiosk.principalTransitionInProgress)
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await startGate.release()

        guard case .failed = await task.value else {
            Issue.record("device-A profile survived a device change during sync start")
            return
        }
        #expect(starts == 1)
        #expect(stops == 2)
        #expect(AuthTokens.accessToken == nil)
        #expect(KioskDeviceStore.secret == "device-B")
        #expect(session.phase == .login)
        #expect(!kiosk.hasProfile)
        #expect(kiosk.needsPicker)
    }

    @Test("stale kiosk claim errors are replaced by identity-changed outcome")
    func staleKioskClaimErrorDoesNotApplyToReplacement() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let gate = HardeningGate()
        let kiosk = KioskMode(claimProfileRequest: { _, _ in
            await gate.wait()
            throw WaffledAPI.KioskClaimError.wrongPin(triesLeft: 2)
        })
        let session = Session(initialPhase: .login)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))
        let profile = try kioskProfile()
        let task = Task {
            await kiosk.claim(profile, pin: "0000", sync: sync, session: session)
        }
        await gate.waitUntilStarted()
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await gate.release()

        let outcome = await task.value
        guard case let .failed(message) = outcome else {
            Issue.record("stale wrong-PIN state leaked onto the replacement kiosk")
            return
        }
        #expect(message.contains("identity changed"))
    }

    @Test("pair response is discarded when server context changes")
    func stalePairResponseDoesNotMutateReplacementServer() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        let originalBaseURL = AppConfig.apiBaseURL
        defer {
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        let gate = HardeningGate()
        let pairing = try devicePairing(secret: "device-A")
        let kiosk = KioskMode(pairDeviceRequest: { _, _ in
            await gate.wait()
            return pairing
        })
        let session = Session(initialPhase: .login)
        var stops = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in stops += 1; return true }, start: { true }, pendingUploadCount: { 0 }
        ))

        let task = Task { await kiosk.enableViaCode("CODE", label: "Kitchen", sync: sync, session: session) }
        await gate.waitUntilStarted()
        #expect(AppConfig.setApiBaseURL("https://replacement.invalid"))
        await gate.release()

        #expect(await task.value != nil)
        #expect(stops == 0)
        #expect(KioskDeviceStore.secret == nil)
    }

    @Test("promote response is discarded when principal changes")
    func stalePromoteResponseDoesNotSignOutReplacement() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let gate = HardeningGate()
        let pairing = try devicePairing(secret: "device-A")
        let kiosk = KioskMode(promoteDeviceRequest: { _ in
            await gate.wait()
            return pairing
        })
        let session = Session(initialPhase: .authed)
        var stops = 0
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in stops += 1; return true }, start: { true }, pendingUploadCount: { 0 }
        ))

        let task = Task { await kiosk.enableViaPromote(label: "Kitchen", sync: sync, session: session) }
        await gate.waitUntilStarted()
        #expect(AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "adult"))
        await gate.release()

        #expect(await task.value != nil)
        #expect(stops == 0)
        #expect(AuthTokens.accessToken == "B-access")
        #expect(KioskDeviceStore.secret == nil)
    }

    @Test("pairing revalidates device identity after replica drain")
    func pairDoesNotOverwriteDeviceChangedDuringPurge() async throws {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let stopGate = HardeningGate()
        let pairing = try devicePairing(secret: "device-A")
        let kiosk = KioskMode(pairDeviceRequest: { _, _ in pairing })
        let session = Session(initialPhase: .authed)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in await stopGate.wait(); return true },
            start: { true },
            pendingUploadCount: { 0 }
        ))

        let task = Task { await kiosk.enableViaCode("CODE", label: "Kitchen", sync: sync, session: session) }
        await stopGate.waitUntilStarted()
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await stopGate.release()

        #expect(await task.value != nil)
        #expect(KioskDeviceStore.secret == "device-B")
        #expect(AuthTokens.accessToken == nil)
    }

    @Test("token after save never returns the previous device generation cache")
    func immediateTokenAfterSaveUsesNewGeneration() async throws {
        let a = KioskDeviceStore.Snapshot(secret: "A", generation: 1, apiBaseURL: "https://a.invalid")
        let b = KioskDeviceStore.Snapshot(secret: "B", generation: 2, apiBaseURL: "https://a.invalid")
        let box = SnapshotBox(a)
        let auth = KioskDeviceAuth(snapshot: { box.get() }, mint: {
            .init(accessToken: "token-\($0.secret!)", expiresAt: .distantFuture)
        })
        #expect(try await auth.token() == "token-A")
        box.set(b)
        #expect(try await auth.token() == "token-B")
    }

    @Test("failed kiosk secret deletion never presents the device as unpaired")
    func failedKioskDeleteRemainsPaired() {
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let kiosk = KioskMode()
        #expect(kiosk.isShared)
        KioskDeviceStore.setSecretWriterForTesting { _ in false }

        #expect(!kiosk.handleDeviceRevoked())
        #expect(kiosk.isShared)
        #expect(kiosk.needsPicker)
        #expect(kiosk.deviceIdentityError != nil)
        #expect(KioskDeviceStore.secret == "device-A")
    }

    @Test("unpair stays paired when the durable kiosk secret cannot be deleted")
    func failedKioskUnpairDeleteRemainsPaired() async {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let kiosk = KioskMode()
        let session = Session(initialPhase: .authed)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))
        KioskDeviceStore.setSecretWriterForTesting { _ in false }

        #expect(!(await kiosk.unpair(sync: sync, session: session)))
        #expect(kiosk.isShared)
        #expect(kiosk.needsPicker)
        #expect(kiosk.deviceIdentityError != nil)
        #expect(KioskDeviceStore.secret == "device-A")
        #expect(session.phase == .login)
    }

    @Test("an old 401 cannot refresh or retry with a replacement principal")
    func authorizedRetryIsBoundToOriginalPrincipal() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let gate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let responseBody = Data(#"{"person":{"id":"person-a","memberType":"adult","isAdmin":false,"accessExpiresAt":null,"capabilities":[]}}"#.utf8)
        let api = WaffledAPI(
            transport: { request in
                let count = await recorder.recordAndCount(request)
                if count == 1 { await gate.wait() }
                return (responseBody, httpResponse(request, status: count == 1 ? 401 : 200))
            },
            refreshSession: { _ in await recorder.recordRefresh(); return true }
        )

        let request = Task { () -> Bool in
            do {
                _ = try await api.currentPerson()
                return false
            } catch WaffledAPI.APIError.superseded {
                return true
            } catch {
                return false
            }
        }
        await gate.waitUntilStarted()
        #expect(AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "adult"))
        await gate.release()

        #expect(await request.value)
        #expect(await recorder.refreshes() == 0)
        let requests = await recorder.all()
        #expect(requests.count == 1)
        #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer A-access")
        #expect(AuthTokens.accessToken == "B-access")
    }

    @Test("a successful response is discarded after its principal is replaced")
    func authorizedResponseIsBoundToOriginalPrincipal() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let gate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let body = Data(#"{"person":{"id":"person-a","memberType":"adult","isAdmin":true,"accessExpiresAt":null,"capabilities":[]}}"#.utf8)
        let api = WaffledAPI(transport: { request in
            await recorder.record(request)
            await gate.wait()
            return (body, httpResponse(request, status: 200))
        })

        let request = Task { () -> Bool in
            do {
                _ = try await api.currentPerson()
                return false
            } catch WaffledAPI.APIError.superseded {
                return true
            } catch {
                return false
            }
        }
        await gate.waitUntilStarted()
        #expect(AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "adult"))
        await gate.release()

        #expect(await request.value)
        #expect(AuthTokens.accessToken == "B-access")
    }

    @Test("a stale HTTP error cannot cross a principal replacement")
    func authorizedErrorIsBoundToOriginalPrincipal() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let body = Data(#"{"error":"Forbidden","message":"private A detail"}"#.utf8)
        let api = WaffledAPI(
            transport: { request in (body, httpResponse(request, status: 403)) },
            responseChecked: {
                #expect(AuthTokens.save(
                    access: "B-access", refresh: "B-refresh", memberType: "adult"
                ))
            }
        )

        do {
            _ = try await api.currentPerson()
            Issue.record("The A error crossed the status-check boundary")
        } catch WaffledAPI.APIError.superseded {
            // Expected: even an error body stays bound to its originating principal.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        #expect(AuthTokens.accessToken == "B-access")
    }

    @Test("a principal replacement during JSON decoding discards the decoded response")
    func decodedResponseIsRevalidatedBeforeReturn() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let body = Data(#"{"person":{"id":"person-a","memberType":"adult","isAdmin":true,"accessExpiresAt":null,"capabilities":[]}}"#.utf8)
        let api = WaffledAPI(
            transport: { request in (body, httpResponse(request, status: 200)) },
            responseDecoded: {
                #expect(AuthTokens.save(
                    access: "B-access", refresh: "B-refresh", memberType: "adult"
                ))
            }
        )

        do {
            _ = try await api.currentPerson()
            Issue.record("The A response crossed the decode-to-return boundary")
        } catch WaffledAPI.APIError.superseded {
            // Expected: decoded bytes remain bound to A through the final return.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        #expect(AuthTokens.accessToken == "B-access")
    }

    @Test("a principal-bound multi-request client cannot continue as a replacement user")
    func boundAPIStopsBeforeReplacementRequest() async throws {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let recorder = HTTPRequestRecorder()
        let body = Data(#"{"person":{"id":"person-a","memberType":"adult","isAdmin":true,"accessExpiresAt":null,"capabilities":[]}}"#.utf8)
        let api = try WaffledAPI(transport: { request in
            await recorder.record(request)
            return (body, httpResponse(request, status: 200))
        }).boundToCurrentPrincipal()

        _ = try await api.currentPerson()
        #expect(AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "adult"))
        do {
            _ = try await api.currentPerson()
            Issue.record("The A-bound client sent a follow-up request as B")
        } catch WaffledAPI.APIError.superseded {
            // Expected: the second step is rejected before transport.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }

        let requests = await recorder.all()
        #expect(requests.count == 1)
        #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer A-access")
    }

    @Test("a delayed login response cannot cross a server change")
    func loginResponseIsBoundToServer() async {
        cleanupAuth()
        let originalBaseURL = AppConfig.apiBaseURL
        defer {
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            cleanupAuth()
        }
        #expect(AppConfig.setApiBaseURL("https://login-a.invalid"))
        let gate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let body = Data(#"{"accessToken":"A-access","refreshToken":"A-refresh","memberType":"adult"}"#.utf8)
        let api = WaffledAPI(transport: { request in
            await recorder.record(request)
            await gate.wait()
            return (body, httpResponse(request, status: 200))
        })
        let session = Session(initialPhase: .login, api: api)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))

        let login = Task { await session.login(email: "a@example.com", password: "pw", sync: sync) }
        await gate.waitUntilStarted()
        #expect(AppConfig.setApiBaseURL("https://login-b.invalid"))
        await gate.release()

        #expect(await login.value != nil)
        #expect(AuthTokens.accessToken == nil)
        let requests = await recorder.all()
        #expect(requests.count == 1)
        #expect(requests.first?.url?.host == "login-a.invalid")
    }

    @Test("only the newest same-server login attempt may install credentials")
    func loginResponseIsBoundToAttemptNonce() async {
        cleanupAuth(); defer { cleanupAuth() }
        let firstGate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let api = WaffledAPI(transport: { request in
            await recorder.record(request)
            let bodyText = request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            if bodyText.contains("first@example.com") { await firstGate.wait() }
            let prefix = bodyText.contains("first@example.com") ? "A" : "B"
            let body = Data(#"{"accessToken":"\#(prefix)-access","refreshToken":"\#(prefix)-refresh","memberType":"adult"}"#.utf8)
            return (body, httpResponse(request, status: 200))
        })
        let session = Session(initialPhase: .login, api: api)
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in true }, start: { true }, pendingUploadCount: { 0 }
        ))

        let first = Task {
            await session.login(email: "first@example.com", password: "pw", sync: sync)
        }
        await firstGate.waitUntilStarted()
        #expect(await session.login(email: "second@example.com", password: "pw", sync: sync) == nil)
        await firstGate.release()

        #expect(await first.value != nil)
        #expect(AuthTokens.accessToken == "B-access")
        #expect((await recorder.all()).count == 2)
    }

    @Test("OIDC exchange and logout stay on their captured source server")
    func authSecretsUseExplicitSourceServer() async {
        cleanupAuth()
        let originalBaseURL = AppConfig.apiBaseURL
        defer {
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            cleanupAuth()
        }
        #expect(AppConfig.setApiBaseURL("https://auth-b.invalid"))
        let recorder = HTTPRequestRecorder()
        let body = Data(#"{"accessToken":"A-access","refreshToken":"A-refresh","memberType":"adult"}"#.utf8)
        let api = WaffledAPI(transport: { request in
            await recorder.record(request)
            return (body, httpResponse(request, status: request.url?.path == "/api/auth/logout" ? 204 : 200))
        })

        do {
            _ = try await api.oidcExchange(code: "one-time-A", baseURL: "https://auth-a.invalid")
            Issue.record("an A exchange unexpectedly survived while B was current")
        } catch WaffledAPI.APIError.superseded {
            // Expected: it was sent only to A, then discarded against current B.
        } catch {
            Issue.record("unexpected OIDC error: \(error)")
        }
        await api.revoke(refreshToken: "refresh-A", baseURL: "https://auth-a.invalid")

        let requests = await recorder.all()
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.url?.host == "auth-a.invalid" })
        let bodies = requests.compactMap(\.httpBody).compactMap { String(data: $0, encoding: .utf8) }
        #expect(bodies.contains { $0.contains("one-time-A") })
        #expect(bodies.contains { $0.contains("refresh-A") })
    }

    @Test("a persisted session is rejected after its issuing server changes")
    func sessionEnvelopeIsBoundToServer() {
        cleanupAuth()
        let originalBaseURL = AppConfig.apiBaseURL
        defer {
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            cleanupAuth()
        }
        #expect(AppConfig.setApiBaseURL("https://session-a.invalid"))
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        #expect(AppConfig.setApiBaseURL("https://session-b.invalid"))

        #expect(AuthTokens.accessToken == nil)
        #expect(AppConfig.principalIsolationRequired)
        #expect(AppConfig.bearerToken.isEmpty)
    }

    @Test("a kiosk secret is never reused at a different server")
    func kioskEnvelopeIsBoundToServer() {
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        let originalBaseURL = AppConfig.apiBaseURL
        defer {
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
        }
        #expect(AppConfig.setApiBaseURL("https://kiosk-a.invalid"))
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        #expect(AppConfig.setApiBaseURL("https://kiosk-b.invalid"))

        let snapshot = KioskDeviceStore.snapshot()
        #expect(snapshot.secret == nil)
        #expect(snapshot.apiBaseURL == "https://kiosk-b.invalid")
    }

    @Test("an old kiosk 401 cannot mint or retry for a replacement device")
    func kioskRetryIsBoundToOriginalDevice() async {
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let gate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let body = Data(#"{"deviceLabel":"Kitchen","profiles":[]}"#.utf8)
        let api = WaffledAPI(
            transport: { request in
                let count = await recorder.recordAndCount(request)
                if count == 1 { await gate.wait() }
                return (body, httpResponse(request, status: count == 1 ? 401 : 200))
            },
            kioskToken: { _ in "device-token-A" },
            freshKioskToken: { _ in await recorder.recordRefresh(); return "device-token-B" }
        )

        let request = Task { () -> Bool in
            do {
                _ = try await api.kioskProfiles()
                return false
            } catch is KioskDeviceAuth.Superseded {
                return true
            } catch {
                return false
            }
        }
        await gate.waitUntilStarted()
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await gate.release()

        #expect(await request.value)
        #expect(await recorder.refreshes() == 0)
        let requests = await recorder.all()
        #expect(requests.count == 1)
        #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer device-token-A")
        #expect(KioskDeviceStore.secret == "device-B")
    }

    @Test("a kiosk response is discarded if its device changes during decoding")
    func kioskResponseDecodeIsBoundToOriginalDevice() async {
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let body = Data(#"{"deviceLabel":"Kitchen","profiles":[]}"#.utf8)
        let api = WaffledAPI(
            transport: { request in (body, httpResponse(request, status: 200)) },
            kioskToken: { _ in "device-token-A" },
            responseDecoded: {
                #expect(KioskDeviceStore.clear())
                #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
            }
        )

        do {
            _ = try await api.kioskProfiles()
            Issue.record("The device-A response crossed the decode-to-return boundary")
        } catch is KioskDeviceAuth.Superseded {
            // Expected: decoded bytes remain bound to the device that authorized them.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
        #expect(KioskDeviceStore.secret == "device-B")
    }

    @Test("a stale device revocation cannot clear a newly paired device")
    func kioskRevocationIsBoundToOriginalDevice() {
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let deviceA = KioskDeviceStore.snapshot()
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        let kiosk = KioskMode()

        #expect(!kiosk.handleDeviceRevoked(expectedDevice: deviceA))
        #expect(KioskDeviceStore.secret == "device-B")
        #expect(kiosk.isShared)
    }

    @Test("a kiosk token inside the expiry skew is minted again")
    func kioskTokenCacheHonorsExpiry() async throws {
        let start = Date(timeIntervalSince1970: 1_000)
        let clock = DateBox(start)
        let snapshot = KioskDeviceStore.Snapshot(
            secret: "device-A", generation: 1, apiBaseURL: "https://kiosk-a.invalid"
        )
        let box = SnapshotBox(snapshot)
        let recorder = HTTPRequestRecorder()
        let auth = KioskDeviceAuth(
            snapshot: { box.get() },
            mint: { _ in
                let count = await recorder.nextRefresh()
                return .init(
                    accessToken: "device-token-\(count)",
                    expiresAt: clock.get().addingTimeInterval(60)
                )
            },
            now: { clock.get() }
        )

        #expect(try await auth.token() == "device-token-1")
        clock.set(start.addingTimeInterval(50))
        #expect(try await auth.token() == "device-token-2")
        #expect(await recorder.refreshes() == 2)
    }

    @Test("profile claim freshens once and never resubmits a PIN after 401")
    func kioskClaimUsesOneFreshTokenAndOneSubmission() async {
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
        }
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let recorder = HTTPRequestRecorder()
        let api = WaffledAPI(
            transport: { request in
                await recorder.record(request)
                return (Data(#"{"triesLeft":2}"#.utf8), httpResponse(request, status: 401))
            },
            kioskToken: { _ in "stale-cached-token" },
            freshKioskToken: { _ in
                await recorder.recordRefresh()
                return "fresh-device-token"
            }
        )

        var triesLeft: Int?
        do {
            _ = try await api.claimProfile(personId: "person-a", pin: "1234")
            Issue.record("wrong PIN unexpectedly succeeded")
        } catch {
            if case let WaffledAPI.KioskClaimError.wrongPin(tries) = error {
                triesLeft = tries
            } else {
                Issue.record("unexpected claim error: \(error)")
            }
        }

        #expect(triesLeft == 2)
        #expect(await recorder.refreshes() == 1)
        let requests = await recorder.all()
        #expect(requests.count == 1)
        #expect(requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-device-token")
    }

    @Test("concurrent identity loads are one same-scope observation")
    func identityLoadIsSingleFlight() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let gate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let moduleAPI = WaffledAPI(transport: { request in
            (Data(#"{"household":{"settings":{}}}"#.utf8), httpResponse(request, status: 200))
        })
        let person = WaffledAPI.CurrentPerson(
            id: "person-a", memberType: "guest", isAdmin: false,
            accessExpiry: .null, capabilities: []
        )
        let sync = SyncManager(
            api: moduleAPI,
            currentPersonRequest: {
                _ = await recorder.nextRefresh()
                await gate.wait()
                return person
            }
        )

        let first = Task { await sync.loadIdentity() }
        await gate.waitUntilStarted()
        let second = Task { await sync.loadIdentity() }
        await Task.yield()
        #expect(await recorder.refreshes() == 1)
        await gate.release()
        await first.value
        await second.value

        #expect(await recorder.refreshes() == 1)
        #expect(sync.currentPersonId == "person-a")
        #expect(AppConfig.currentMemberType == "guest")
    }

    @Test("a new principal loads after joining an older in-flight identity request")
    func identityLoadRetriesForNewContextAfterJoiningOldFlight() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let gate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let moduleAPI = WaffledAPI(transport: { request in
            (Data(#"{"household":{"settings":{}}}"#.utf8), httpResponse(request, status: 200))
        })
        let personA = WaffledAPI.CurrentPerson(
            id: "person-a", memberType: "adult", isAdmin: true,
            accessExpiry: .null, capabilities: ["chore.manage"]
        )
        let personB = WaffledAPI.CurrentPerson(
            id: "person-b", memberType: "guest", isAdmin: false,
            accessExpiry: .null, capabilities: []
        )
        let sync = SyncManager(
            api: moduleAPI,
            currentPersonRequest: {
                let count = await recorder.nextRefresh()
                if count == 1 {
                    await gate.wait()
                    return personA
                }
                return personB
            }
        )

        let oldLoad = Task { await sync.loadIdentity() }
        await gate.waitUntilStarted()
        #expect(AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "guest", accessExpiry: .null))
        let newLoad = Task { await sync.loadIdentity() }
        await Task.yield()
        await gate.release()
        await oldLoad.value
        await newLoad.value

        #expect(await recorder.refreshes() == 2)
        #expect(sync.currentPersonId == "person-b")
        #expect(AppConfig.currentMemberType == "guest")
    }

    @Test("policy tightening drains admitted local writers before becoming read-only")
    func identityPolicyTighteningFreezesAndDrainsWriters() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let writerGate = HardeningGate()
        let recorder = HTTPRequestRecorder()
        let moduleAPI = WaffledAPI(transport: { request in
            (Data(#"{"household":{"settings":{}}}"#.utf8), httpResponse(request, status: 200))
        })
        let guest = WaffledAPI.CurrentPerson(
            id: "person-a", memberType: "guest", isAdmin: false,
            accessExpiry: .null, capabilities: []
        )
        let sync = SyncManager(
            api: moduleAPI,
            currentPersonRequest: {
                await recorder.recordRefresh()
                return guest
            }
        )
        let admittedWriter = Task {
            await sync.withLocalWriteLeaseForTesting { await writerGate.wait() }
        }
        await writerGate.waitUntilStarted()
        let policyLoad = Task { await sync.loadIdentity() }
        for _ in 0..<20 {
            if await recorder.refreshes() > 0 { break }
            await Task.yield()
        }

        var admissionWasFrozen = false
        for _ in 0..<20 where !admissionWasFrozen {
            admissionWasFrozen = !(await sync.withLocalWriteLeaseForTesting {})
            if !admissionWasFrozen { await Task.yield() }
        }
        #expect(admissionWasFrozen)
        #expect(sync.currentPersonId == nil)
        await writerGate.release()
        #expect(await admittedWriter.value)
        await policyLoad.value

        #expect(sync.currentPersonId == "person-a")
        #expect(AppConfig.currentMemberType == "guest")
        #expect(!(await sync.withLocalWriteLeaseForTesting {}))
    }

    @Test("a dev token identity includes its server origin")
    func devIdentityScopeIncludesServer() {
        cleanupAuth()
        let originalBaseURL = AppConfig.apiBaseURL
        let originalToken = AppConfig.storedDevToken
        defer {
            AppConfig.setDevToken(originalToken)
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            cleanupAuth()
        }
        AppConfig.setDevToken("same-dev-token")
        #expect(AppConfig.setApiBaseURL("https://dev-a.invalid"))
        let scopeA = AppConfig.currentIdentityScope
        #expect(AppConfig.setApiBaseURL("https://dev-b.invalid"))
        let scopeB = AppConfig.currentIdentityScope

        #expect(scopeA != nil)
        #expect(scopeB != nil)
        #expect(scopeA != scopeB)
    }

    @Test("editing a dormant dev token preserves a real signed-in session")
    func devTokenEditDoesNotInvalidateRealSession() {
        cleanupAuth()
        let originalToken = AppConfig.storedDevToken
        defer {
            AppConfig.setDevToken(originalToken)
            cleanupAuth()
        }
        #expect(AuthTokens.save(
            access: "real-access", refresh: "real-refresh", memberType: "adult"
        ))

        AppConfig.setDevToken("dormant-replacement-token")

        #expect(AuthTokens.accessToken == "real-access")
        #expect(AuthTokens.refreshToken == "real-refresh")
        #expect(AuthTokens.memberType == "adult")
        #expect(!AppConfig.principalIsolationRequired)
    }

    @Test("dev server changes clear the old replica before reconnecting")
    func devReconnectClearsReplicaAcrossServerBoundary() async {
        cleanupAuth()
        let originalBaseURL = AppConfig.apiBaseURL
        let originalToken = AppConfig.storedDevToken
        defer {
            AppConfig.setDevToken(originalToken)
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            cleanupAuth()
        }
        AppConfig.setDevToken("same-dev-token")
        #expect(AppConfig.setApiBaseURL("https://dev-a.invalid"))
        SyncManager.setReplicaIdentityScopeForTesting(AppConfig.currentIdentityScope)
        var clearLocalValues: [Bool] = []
        let sync = SyncManager(
            testConnectionLifecycle: .init(
                stop: { clearLocalValues.append($0); return true },
                start: { true },
                pendingUploadCount: { 0 }
            ),
            currentPersonRequest: { nil }
        )
        await sync.start()
        #expect(AppConfig.setApiBaseURL("https://dev-b.invalid"))
        await sync.reconnect()

        #expect(clearLocalValues == [true])
    }

    @Test("a relaunched sync manager clears a replica owned by another server")
    func persistedReplicaOwnerProtectsColdStart() async {
        cleanupAuth()
        let originalBaseURL = AppConfig.apiBaseURL
        let originalToken = AppConfig.storedDevToken
        defer {
            SyncManager.setReplicaIdentityScopeForTesting(nil)
            AppConfig.setDevToken(originalToken)
            _ = AppConfig.setApiBaseURL(originalBaseURL)
            cleanupAuth()
        }
        AppConfig.setDevToken("same-dev-token")
        #expect(AppConfig.setApiBaseURL("https://replica-a.invalid"))
        let ownerA = AppConfig.currentIdentityScope
        SyncManager.setReplicaIdentityScopeForTesting(ownerA)
        #expect(AppConfig.setApiBaseURL("https://replica-b.invalid"))
        var events: [String] = []
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { events.append("stop:\($0)"); return true },
            start: { events.append("start"); return true },
            pendingUploadCount: { 0 }
        ))

        await sync.start()

        #expect(ownerA != AppConfig.currentIdentityScope)
        #expect(events == ["stop:true", "start"])
    }

    @Test("principal artifacts are cleared before replacement sync starts")
    func principalArtifactCleanupIsInsideIsolationBoundary() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let source = AppConfig.currentIdentityScope
        var events: [String] = []
        let cook = CookSessionStore()
        cook.start(id: "recipe-a", title: "A's Dinner", steps: [], ingredients: [])
        #expect(cook.isActive)
        let sync = SyncManager(
            testConnectionLifecycle: .init(
                stop: { _ in events.append("stop"); return true },
                start: { events.append("start"); return true },
                pendingUploadCount: { 0 }
            ),
            principalArtifactsCleanup: {
                events.append("artifacts")
                cook.clearPrincipalArtifacts()
            }
        )
        let session = Session(initialPhase: .authed)
        let candidate = AuthTokens.Candidate(
            accessToken: "B-access", refreshToken: "B-refresh",
            memberType: "adult", accessExpiry: .missing
        )

        #expect(await session.adoptCandidate(candidate, sourceScope: source, sync: sync) == nil)
        #expect(events == ["stop", "artifacts", "start"])
        #expect(!cook.isActive)
        #expect(cook.pendingPantryReconcile == nil)
        #expect(session.phase == .authed)
    }

    @Test("delivered notifications are bound to the principal that scheduled them")
    func deliveredNotificationRejectsReplacementPrincipal() {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        guard let contextA = NotificationManager.PrincipalContext.current else {
            Issue.record("Missing principal A notification context")
            return
        }
        var info: [String: Any] = ["eventId": "event-a"]
        contextA.stamp(&info)
        let manager = NotificationManager(clearSystemPrincipalArtifacts: {})
        #expect(manager.shouldPresentDeliveredNotification(info))

        #expect(AuthTokens.save(access: "B-access", refresh: "B-refresh", memberType: "adult"))
        #expect(!manager.shouldPresentDeliveredNotification(info))
        #expect(manager.contextForDeliveredNotification(["eventId": "legacy"]) == nil)
    }

    @Test("overlapping principal cleanup calls coalesce and clear in-memory artifacts")
    func notificationPrincipalCleanupCoalesces() async {
        let gate = HardeningGate()
        var systemClears = 0
        let manager = NotificationManager(clearSystemPrincipalArtifacts: {
            systemClears += 1
            await gate.wait()
        })
        manager.seedPrincipalArtifactsForTesting(
            eventId: "event-a",
            cookTimer: CookTimerLink(dishId: "dish-a", stepIndex: 1, plateId: nil)
        )

        let first = Task { await manager.clearPrincipalArtifacts() }
        await gate.waitUntilStarted()
        let second = Task { await manager.clearPrincipalArtifacts() }
        await Task.yield()
        #expect(systemClears == 1)
        await gate.release()
        await first.value
        await second.value

        #expect(systemClears == 1)
        #expect(manager.principalArtifactsAreEmptyForTesting)
    }

    @Test("cook timer add drains before principal cleanup's final notification removal")
    func cookTimerAddDrainsBeforePrincipalCleanup() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        let addGate = HardeningGate()
        var events: [String] = []
        let manager = NotificationManager(
            clearSystemPrincipalArtifacts: { events.append("clear") },
            addSystemNotification: { _ in
                events.append("add-start")
                await addGate.wait()
                events.append("add-finish")
            },
            removeSystemNotifications: { _ in events.append("remove") }
        )
        let cook = CookSessionStore(notificationManager: manager)
        cook.start(id: "recipe-a", title: "A's Dinner", steps: [], ingredients: [])
        #expect(cook.startTimer(secs: 60, stepIndex: 0, stepNumber: 1) != nil)
        await addGate.waitUntilStarted()

        // Mirrors WaffledApp's principal-boundary order: stop Cook Mode first (which
        // queues a timer cancellation), then freeze/drain and perform one final clear.
        cook.clearPrincipalArtifacts()
        let cleanup = Task { await manager.clearPrincipalArtifacts() }
        for _ in 0..<100 where !manager.principalCleanupInProgressForTesting {
            await Task.yield()
        }
        #expect(manager.principalCleanupInProgressForTesting)
        #expect(events == ["add-start"])

        await addGate.release()
        await cleanup.value

        // Cleanup cannot overtake the delayed add. The queued per-id remove is safely
        // redundant once cleanup freezes admission; the final clear is the last command.
        #expect(events == ["add-start", "add-finish", "clear"])
        #expect(!cook.isActive)
        #expect(manager.principalArtifactsAreEmptyForTesting)
    }

    @Test("unpair cannot erase a replacement kiosk device")
    func unpairIsBoundToOriginalDevice() async {
        cleanupAuth()
        KioskDeviceStore.setSecretWriterForTesting(nil)
        _ = KioskDeviceStore.clear()
        defer {
            KioskDeviceStore.setSecretWriterForTesting(nil)
            _ = KioskDeviceStore.clear()
            cleanupAuth()
        }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        #expect(KioskDeviceStore.savePaired(secret: "device-A", label: "Kitchen"))
        let stopGate = HardeningGate()
        let sync = SyncManager(testConnectionLifecycle: .init(
            stop: { _ in await stopGate.wait(); return true },
            start: { true },
            pendingUploadCount: { 0 }
        ))
        let session = Session(initialPhase: .authed)
        let kiosk = KioskMode()

        let unpair = Task { await kiosk.unpair(sync: sync, session: session) }
        await stopGate.waitUntilStarted()
        #expect(KioskDeviceStore.clear())
        #expect(KioskDeviceStore.savePaired(secret: "device-B", label: "Hall"))
        await stopGate.release()

        #expect(!(await unpair.value))
        #expect(KioskDeviceStore.secret == "device-B")
        #expect(kiosk.isShared)
        #expect(kiosk.needsPicker)
    }

    @Test("a durable isolation latch retries even for a permanent role")
    func permanentRoleIsolationLatchRetriesInProcess() async {
        cleanupAuth(); defer { cleanupAuth() }
        #expect(AuthTokens.save(access: "A-access", refresh: "A-refresh", memberType: "adult"))
        AppConfig.requirePrincipalIsolation()
        var attempts = 0
        let session = Session(
            initialPhase: .authed,
            isolateExpiredPrincipal: {
                attempts += 1
                return attempts > 1
            }
        )

        await session.recheckAccessExpiry()
        #expect(attempts == 1)
        #expect(session.phase == .loading)
        #expect(AppConfig.principalIsolationRequired)
        #expect(AuthTokens.accessToken == "A-access")

        await session.recheckAccessExpiry()
        #expect(attempts == 2)
        #expect(session.phase == .login)
        #expect(!AppConfig.principalIsolationRequired)
        #expect(AuthTokens.accessToken == nil)
    }
}
}
