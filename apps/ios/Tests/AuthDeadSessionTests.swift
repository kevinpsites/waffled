import Foundation
import Testing
@testable import Waffled

// Missing-household responses use the same coordinated principal cleanup as rejected
// refresh tokens. PrincipalIsolationTests exercises the HTTP response and lease race;
// these cases pin the discriminator so ordinary permission denials keep the session.
@Suite("A dead session is recognised by its code, not its status")
struct AuthDeadSessionTests {
    private func body(_ json: String) -> Data { Data(json.utf8) }

    @Test("the missing-household code is read off the body")
    func readsTheCode() {
        let data = body(#"{"error":"NoHousehold","message":"No household for this account; create one first"}"#)
        #expect(WaffledAPI.errorCode(data) == "NoHousehold")
    }

    @Test("an ordinary permission denial is NOT the missing-household code")
    func permissionDenialIsDifferent() {
        let data = body(#"{"error":"AuthError","message":"You do not have permission to do this"}"#)
        #expect(WaffledAPI.errorCode(data) != "NoHousehold")
    }

    @Test("a disabled module is NOT the missing-household code")
    func disabledModuleIsDifferent() {
        let data = body(#"{"error":"AuthError","message":"The chores module is not enabled"}"#)
        #expect(WaffledAPI.errorCode(data) != "NoHousehold")
    }

    // A proxy's HTML error page, or an empty body, must not read as anything.
    @Test("an unreadable body yields no code")
    func unreadableBody() {
        #expect(WaffledAPI.errorCode(body("<html>503</html>")) == nil)
        #expect(WaffledAPI.errorCode(Data()) == nil)
        #expect(WaffledAPI.errorCode(body(#"{"error":42}"#)) == nil)
    }
}
