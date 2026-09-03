import Testing
@testable import Waffled

@MainActor
private final class PrincipalTransitionRecorder {
    private(set) var events: [String] = []
    private let stopResult: Bool

    init(stopResult: Bool = true) {
        self.stopResult = stopResult
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
            applyConfiguration: { _, _ in }
        )
    }
}

@Suite @MainActor
struct PrincipalIsolationTests {
    @Test func signOutClearsTheMirrorByDefault() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)

        await sync.signOut()

        #expect(recorder.events == ["stop:true"])
    }

    @Test func samePrincipalTransportReconnectKeepsTheMirror() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)

        let reconnected = await sync.reconnect()

        #expect(reconnected)
        #expect(recorder.events == ["stop:false", "start"])
    }

    @Test func principalChangeClearsBeforeAdoptingCredentialsAndReconnecting() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)
        let sourceScope = sync.restDataScopeKey

        let changed = await sync.reauthenticate(expectedScope: sourceScope) {
            recorder.record("adopt")
        }

        #expect(changed)
        #expect(recorder.events == ["stop:true", "adopt", "start"])
    }

    @Test func failedPrincipalPurgeDoesNotAdoptCredentialsOrReconnect() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)
        let sourceScope = sync.restDataScopeKey

        let changed = await sync.reauthenticate(expectedScope: sourceScope) {
            recorder.record("adopt")
        }

        #expect(!changed)
        #expect(recorder.events == ["stop:true"])
    }

    @Test func failedSessionPurgeKeepsPreviousCredentialsAndAuthenticatedGate() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)
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

        let signedOut = await session.signOut(sync: sync)

        #expect(!signedOut)
        #expect(session.phase == .authed)
        #expect(!clearedCredentials)
        #expect(!markedSignedOut)
        #expect(recorder.events == ["stop:true"])
    }

    @Test func failedKioskReturnDoesNotExposePickerOrClearProfileCredentials() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)
        var profileClears = 0
        var deviceClears = 0
        let kiosk = KioskMode(
            testIsShared: true,
            testHasProfile: true,
            localCredentials: KioskLocalCredentials(
                clearProfile: { profileClears += 1 },
                clearDevice: { deviceClears += 1 }
            )
        )

        let returned = await kiosk.returnToPicker(sync: sync)

        #expect(!returned)
        #expect(kiosk.isShared)
        #expect(kiosk.hasProfile)
        #expect(!kiosk.needsPicker)
        #expect(profileClears == 0)
        #expect(deviceClears == 0)
    }

    @Test func failedKioskUnpairLeavesBothIdentitiesAndShellInPlace() async {
        let recorder = PrincipalTransitionRecorder(stopResult: false)
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)
        var profileClears = 0
        var deviceClears = 0
        let kiosk = KioskMode(
            testIsShared: true,
            testHasProfile: true,
            localCredentials: KioskLocalCredentials(
                clearProfile: { profileClears += 1 },
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

        let unpaired = await kiosk.unpair(sync: sync, session: session)

        #expect(!unpaired)
        #expect(kiosk.isShared)
        #expect(kiosk.hasProfile)
        #expect(!kiosk.needsPicker)
        #expect(session.phase == .authed)
        #expect(profileClears == 0)
        #expect(deviceClears == 0)
    }
}
