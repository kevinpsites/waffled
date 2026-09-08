import Testing
@testable import Waffled

@MainActor
private final class PrincipalTransitionRecorder {
    private(set) var events: [String] = []
    private let stopResult: Bool
    private let exactPendingUploads: Int?

    init(stopResult: Bool = true, exactPendingUploads: Int? = 0) {
        self.stopResult = stopResult
        self.exactPendingUploads = exactPendingUploads
    }

    func record(_ event: String) {
        events.append(event)
    }

    var lifecycle: SyncConnectionLifecycle {
        SyncConnectionLifecycle(
            stop: { [weak self] clearLocal in
                self?.events.append("stop:\(clearLocal)")
                return self?.stopResult ?? false
            },
            start: { [weak self] in
                self?.events.append("start")
                return true
            },
            applyConfiguration: { [weak self] _, _ in
                self?.events.append("apply-configuration")
            },
            pendingUploadCount: { [weak self] in
                self?.events.append("count-pending")
                return self?.exactPendingUploads
            }
        )
    }
}

private actor PrincipalDeferred<Value: Sendable> {
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var result: CheckedContinuation<Value, Never>?

    func wait() async -> Value {
        started = true
        startWaiters.forEach { $0.resume() }
        startWaiters = []
        return await withCheckedContinuation { result = $0 }
    }

    func waitUntilStarted() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    func resume(_ value: Value) {
        result?.resume(returning: value)
        result = nil
    }
}

private actor RefreshCredentialVault {
    private var lease: AuthTokens.RefreshLease?
    private var access: String?
    private var refresh: String?

    init(access: String, refresh: String, generation: UInt64) {
        self.access = access
        self.refresh = refresh
        lease = .init(refreshToken: refresh, generation: generation)
    }

    func currentLease() -> AuthTokens.RefreshLease? { lease }

    func isCurrent(_ candidate: AuthTokens.RefreshLease) -> Bool {
        lease == candidate
    }

    func saveIfCurrent(
        _ candidate: AuthTokens.RefreshLease,
        access newAccess: String,
        refresh newRefresh: String
    ) -> Bool {
        guard lease == candidate else { return false }
        let nextGeneration = candidate.generation &+ 1
        access = newAccess
        refresh = newRefresh
        lease = .init(refreshToken: newRefresh, generation: nextGeneration)
        return true
    }

    func replace(access newAccess: String, refresh newRefresh: String, generation: UInt64) {
        access = newAccess
        refresh = newRefresh
        lease = .init(refreshToken: newRefresh, generation: generation)
    }

    func snapshot() -> (String?, String?) { (access, refresh) }
}

private actor ExpirationRecorder {
    private var leases: [AuthTokens.RefreshLease] = []
    func record(_ lease: AuthTokens.RefreshLease) { leases.append(lease) }
    func count() -> Int { leases.count }
}

@Suite @MainActor
struct PrincipalIsolationTests {
    private func sync(_ recorder: PrincipalTransitionRecorder) -> SyncManager {
        SyncManager(
            testConnectionLifecycle: recorder.lifecycle,
            principalStateCleanup: { recorder.record("clear-notifications") }
        )
    }

    private func bootstrapState(
        hasToken: Bool,
        migrationComplete: Bool,
        mark: @escaping () -> Void = {},
        loadStatus: @escaping () async -> WaffledAPI.AuthStatus? = { nil }
    ) -> SessionBootstrapState {
        SessionBootstrapState(
            hasUsableToken: { hasToken },
            migrationIsComplete: { migrationComplete },
            markMigrationComplete: mark,
            loadAuthStatus: loadStatus
        )
    }

    @Test func securityCriticalSignOutClearsMirrorThenNotifications() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)

        let result = await sync.signOut(policy: .securityCritical)

        #expect(result == .completed)
        #expect(recorder.events == ["stop:true", "clear-notifications"])
    }

    @Test func samePrincipalTransportReconnectKeepsTheMirror() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)

        let reconnected = await sync.reconnect()

        #expect(reconnected)
        #expect(recorder.events == ["stop:false", "start"])
    }

    @Test func principalChangeClearsBeforeAdoptingCredentialsAndReconnecting() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)
        let sourceScope = sync.restDataScopeKey

        let changed = await sync.reauthenticate(
            expectedScope: sourceScope,
            policy: .requireNoPendingUploads,
            adoptCredentials: { recorder.record("adopt") }
        )

        #expect(changed == .completed)
        #expect(recorder.events == [
            "count-pending", "stop:true", "clear-notifications", "adopt", "start",
        ])
    }

    @Test func lateKioskResponseCannotSignOutANewerScope() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)
        let oldScope = sync.restDataScopeKey
        sync.invalidateRestDataScope()

        let result = await sync.signOut(
            policy: .securityCritical,
            expectedScope: oldScope
        )

        #expect(result == .transitionInProgress)
        #expect(recorder.events.isEmpty)
    }

    @Test func serverPrincipalChangeClearsNotificationsBeforeApplyingConfiguration() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)

        let result = await sync.updateConnection(
            apiBaseURL: "https://principal-transition.invalid"
        )

        #expect(result == .updated)
        #expect(recorder.events == [
            "count-pending", "stop:true", "clear-notifications",
            "apply-configuration", "start",
        ])
    }

    @Test func failedPrincipalPurgeDoesNotAdoptCredentialsOrReconnect() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = sync(recorder)
        let sourceScope = sync.restDataScopeKey

        let changed = await sync.reauthenticate(
            expectedScope: sourceScope,
            policy: .requireNoPendingUploads,
            adoptCredentials: { recorder.record("adopt") }
        )

        #expect(changed == .purgeFailed)
        #expect(recorder.events == ["count-pending", "stop:true"])
    }

    @Test func failedSessionPurgeKeepsPreviousCredentialsAndAuthenticatedGate() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = sync(recorder)
        var clearedCredentials = false
        var markedSignedOut = false
        let session = Session(
            initialPhase: .authed,
            signOutCredentials: SessionSignOutCredentials(
                refreshToken: { "previous-refresh" },
                clear: { clearedCredentials = true },
                markSignedOut: { markedSignedOut = true }
            )
        )

        let signedOut = await session.signOut(sync: sync, policy: .securityCritical)

        #expect(signedOut == .purgeFailed)
        #expect(session.phase == .authed)
        #expect(!clearedCredentials)
        #expect(!markedSignedOut)
        #expect(recorder.events == ["stop:true"])
    }

    @Test func staleExpirationLeaseCannotSignOutReplacementCredentials() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)
        let staleLease = AuthTokens.RefreshLease(refreshToken: "old-refresh", generation: 1)
        var clearedCredentials = false
        let session = Session(
            initialPhase: .authed,
            signOutCredentials: .init(
                refreshToken: { "new-refresh" },
                clear: { clearedCredentials = true },
                markSignedOut: {},
                isCurrent: { $0 != staleLease }
            )
        )

        let result = await session.signOut(
            sync: sync,
            policy: .securityCritical,
            expectedRefreshLease: staleLease
        )

        #expect(result == .transitionInProgress)
        #expect(session.phase == .authed)
        #expect(!clearedCredentials)
        #expect(recorder.events.isEmpty)
    }

    @Test func failedKioskReturnDoesNotExposePickerOrClearProfileCredentials() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = sync(recorder)
        var profileClears = 0
        var deviceClears = 0
        let kiosk = KioskMode(
            testIsShared: true,
            testHasProfile: true,
            localCredentials: KioskLocalCredentials(
                clearDevice: { deviceClears += 1 }
            )
        )
        let session = Session(
            initialPhase: .authed,
            signOutCredentials: .init(
                refreshToken: { "previous-refresh" },
                clear: { profileClears += 1 },
                markSignedOut: {}
            )
        )

        let returned = await kiosk.returnToPicker(
            sync: sync,
            session: session,
            policy: .securityCritical
        )

        #expect(returned == .purgeFailed)
        #expect(kiosk.isShared)
        #expect(kiosk.hasProfile)
        #expect(!kiosk.needsPicker)
        #expect(session.phase == .authed)
        #expect(profileClears == 0)
        #expect(deviceClears == 0)
    }

    @Test func failedKioskUnpairLeavesBothIdentitiesAndShellInPlace() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = sync(recorder)
        var profileClears = 0
        var deviceClears = 0
        let kiosk = KioskMode(
            testIsShared: true,
            testHasProfile: true,
            localCredentials: KioskLocalCredentials(
                clearDevice: { deviceClears += 1 }
            )
        )
        let session = Session(
            initialPhase: .authed,
            signOutCredentials: SessionSignOutCredentials(
                refreshToken: { "previous-refresh" },
                clear: { profileClears += 1 },
                markSignedOut: {}
            )
        )

        let unpaired = await kiosk.unpair(
            sync: sync,
            session: session,
            policy: .securityCritical
        )

        #expect(unpaired == .purgeFailed)
        #expect(kiosk.isShared)
        #expect(kiosk.hasProfile)
        #expect(!kiosk.needsPicker)
        #expect(session.phase == .authed)
        #expect(profileClears == 0)
        #expect(deviceClears == 0)
    }

    @Test func successfulKioskReturnCoordinatesSessionBeforeExposingPicker() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)
        var profileClears = 0
        let session = Session(
            initialPhase: .authed,
            signOutCredentials: .init(
                refreshToken: { nil },
                clear: { profileClears += 1 },
                markSignedOut: {}
            )
        )
        let kiosk = KioskMode(
            testIsShared: true,
            testHasProfile: true,
            localCredentials: .init(clearDevice: {})
        )

        let result = await kiosk.returnToPicker(
            sync: sync,
            session: session,
            policy: .requireNoPendingUploads
        )

        #expect(result == .completed)
        #expect(recorder.events == ["count-pending", "stop:true", "clear-notifications"])
        #expect(profileClears == 1)
        #expect(session.phase == .login)
        #expect(kiosk.needsPicker)
    }

    @Test func automaticExitDefersInsteadOfDiscardingPendingUploads() async {
        let recorder = PrincipalTransitionRecorder(exactPendingUploads: 3)
        let sync = sync(recorder)

        let result = await sync.signOut(policy: .requireNoPendingUploads)

        #expect(result == .pendingUploads(3))
        #expect(recorder.events == ["count-pending"])
    }

    @Test func explicitDiscardCanClearPendingUploads() async {
        let recorder = PrincipalTransitionRecorder(exactPendingUploads: 3)
        let sync = sync(recorder)

        let result = await sync.signOut(policy: .discardAuthorized)

        #expect(result == .completed)
        #expect(recorder.events == ["stop:true", "clear-notifications"])
    }

    @Test func principalExitFreezesNewWritesAndDrainsAnExistingWriterBeforeCounting() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)
        let writerGate = PrincipalDeferred<Void>()
        let writer = Task {
            await sync.withLocalWriteLeaseForTesting { await writerGate.wait() }
        }
        await writerGate.waitUntilStarted()

        let exit = Task { await sync.signOut(policy: .requireNoPendingUploads) }
        var rejectedNewWrite = false
        for _ in 0..<100 {
            if !(await sync.withLocalWriteLeaseForTesting({})) {
                rejectedNewWrite = true
                break
            }
            await Task.yield()
        }

        #expect(rejectedNewWrite)
        #expect(recorder.events.isEmpty)
        await writerGate.resume(())
        #expect(await writer.value)
        #expect(await exit.value == .completed)
        #expect(recorder.events == ["count-pending", "stop:true", "clear-notifications"])
    }

    @Test func authenticatedUpgradeWaitsForUploadsAndDoesNotMarkMigrationEarly() async {
        let recorder = PrincipalTransitionRecorder(exactPendingUploads: 2)
        let sync = sync(recorder)
        var marked = false
        let session = Session(
            bootstrapState: bootstrapState(
                hasToken: true,
                migrationComplete: false,
                mark: { marked = true }
            )
        )

        let result = await session.bootstrap(sync: sync, kioskNeedsPicker: false)

        #expect(result == .pendingMigrationUploads(2))
        #expect(session.phase == .loading)
        #expect(!marked)
        #expect(recorder.events == ["start", "count-pending"])
    }

    @Test func authenticatedUpgradeMarksMigrationOnlyAfterPurgeAndNotificationCleanup() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = sync(recorder)
        var marked = false
        let session = Session(
            bootstrapState: bootstrapState(
                hasToken: true,
                migrationComplete: false,
                mark: {
                    recorder.record("mark-migration")
                    marked = true
                }
            )
        )

        let result = await session.bootstrap(sync: sync, kioskNeedsPicker: false)

        #expect(result == .ready)
        #expect(session.phase == .authed)
        #expect(marked)
        #expect(recorder.events == [
            "start", "count-pending", "stop:true", "clear-notifications", "mark-migration",
        ])
    }

    @Test func unauthenticatedLaunchPurgesBeforeExposingLogin() async {
        let recorder = PrincipalTransitionRecorder(exactPendingUploads: 7)
        let sync = sync(recorder)
        var loadedLoginState = false
        let session = Session(
            bootstrapState: bootstrapState(
                hasToken: false,
                migrationComplete: true,
                loadStatus: {
                    loadedLoginState = true
                    return nil
                }
            )
        )

        let result = await session.bootstrap(sync: sync, kioskNeedsPicker: false)

        #expect(result == .ready)
        #expect(session.phase == .login)
        #expect(loadedLoginState)
        #expect(recorder.events == ["stop:true", "clear-notifications"])
    }

    @Test func failedUnauthenticatedPurgeKeepsLoginAndPickerGateBlocked() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = sync(recorder)
        var loadedLoginState = false
        let session = Session(
            bootstrapState: bootstrapState(
                hasToken: false,
                migrationComplete: true,
                loadStatus: {
                    loadedLoginState = true
                    return nil
                }
            )
        )

        let result = await session.bootstrap(sync: sync, kioskNeedsPicker: true)

        #expect(result == .purgeFailed)
        #expect(session.phase == .loading)
        #expect(!loadedLoginState)
        #expect(recorder.events == ["stop:true"])
    }

    @Test func staleRefreshSuccessCannotOverwriteNewCredentials() async {
        let vault = RefreshCredentialVault(access: "old-access", refresh: "old-refresh", generation: 1)
        let response = PrincipalDeferred<TokenRefreshResponse>()
        let expirations = ExpirationRecorder()
        let refresher = TokenRefresher(
            credentials: TokenRefreshCredentials(
                currentLease: { await vault.currentLease() },
                saveIfCurrent: { await vault.saveIfCurrent($0, access: $1, refresh: $2) },
                isCurrent: { await vault.isCurrent($0) }
            ),
            request: { _ in await response.wait() },
            expire: { await expirations.record($0) }
        )

        let oldRefresh = Task { await refresher.refresh() }
        await response.waitUntilStarted()
        await vault.replace(access: "new-access", refresh: "new-refresh", generation: 2)
        await response.resume(.refreshed(access: "stale-access", refresh: "stale-refresh"))

        #expect(!(await oldRefresh.value))
        let snapshot = await vault.snapshot()
        #expect(snapshot.0 == "new-access")
        #expect(snapshot.1 == "new-refresh")
        #expect(await expirations.count() == 0)
    }

    @Test func staleRefreshRejectionCannotExpireNewCredentials() async {
        let vault = RefreshCredentialVault(access: "old-access", refresh: "old-refresh", generation: 1)
        let response = PrincipalDeferred<TokenRefreshResponse>()
        let expirations = ExpirationRecorder()
        let refresher = TokenRefresher(
            credentials: TokenRefreshCredentials(
                currentLease: { await vault.currentLease() },
                saveIfCurrent: { await vault.saveIfCurrent($0, access: $1, refresh: $2) },
                isCurrent: { await vault.isCurrent($0) }
            ),
            request: { _ in await response.wait() },
            expire: { await expirations.record($0) }
        )

        let oldRefresh = Task { await refresher.refresh() }
        await response.waitUntilStarted()
        await vault.replace(access: "new-access", refresh: "new-refresh", generation: 2)
        await response.resume(.rejected)

        #expect(!(await oldRefresh.value))
        #expect(await expirations.count() == 0)
        let snapshot = await vault.snapshot()
        #expect(snapshot.0 == "new-access")
        #expect(snapshot.1 == "new-refresh")
    }
}
