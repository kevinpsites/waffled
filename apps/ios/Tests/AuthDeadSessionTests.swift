import Foundation
import Testing
@testable import Waffled

// A session whose household is gone has to END, not keep failing.
//
// The 401 path already handles the ordinary case (refresh once; a dead refresh token
// clears the Keychain and posts `.waffledAuthExpired`). The gap is 403: the household a
// perfectly valid token names can be gone — a restored database, a deleted household, a
// rebuilt stack — and refreshing only mints another token for the same hole.
//
// What is testable without stubbing URLSession is the DISCRIMINATOR, and it is the part
// worth pinning: an ordinary permission denial is also a 403, so keying on the status
// alone would sign somebody out for lacking a capability — a worse bug than the stuck
// session this fixes.
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
