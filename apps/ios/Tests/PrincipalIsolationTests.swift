import Testing
@testable import Waffled

@MainActor
private final class PrincipalTransitionRecorder {
    private(set) var events: [String] = []

    var lifecycle: SyncConnectionLifecycle {
        SyncConnectionLifecycle(
            stop: { [weak self] clearLocal in
                self?.events.append("stop:\(clearLocal)")
                return true
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

    @Test func samePrincipalTransportTeardownCanExplicitlyKeepTheMirror() async {
        let recorder = PrincipalTransitionRecorder()
        let sync = SyncManager(testConnectionLifecycle: recorder.lifecycle)

        await sync.signOut(clearLocal: false)

        #expect(recorder.events == ["stop:false"])
    }
}
