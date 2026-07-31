import Testing
@testable import Waffled

@Suite @MainActor
struct PrincipalIsolationTests {
    @Test func signOutClearsTheMirrorByDefault() async {
        var decisions: [Bool] = []
        let sync = SyncManager { clearLocal in decisions.append(clearLocal) }

        await sync.signOut()

        #expect(decisions == [true])
    }

    @Test func samePrincipalTransportTeardownCanExplicitlyKeepTheMirror() async {
        var decisions: [Bool] = []
        let sync = SyncManager { clearLocal in decisions.append(clearLocal) }

        await sync.signOut(clearLocal: false)

        #expect(decisions == [false])
    }
}
