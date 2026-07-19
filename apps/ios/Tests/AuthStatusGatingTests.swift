import Foundation
import Testing
@testable import Waffled

// Which sign-in affordances the login screen may show, driven by the server's
// GET /api/auth/status reply. Must mirror the web's `AuthGate` exactly
// (apps/web/src/kiosk/AuthGate.tsx):
//
//   showPassword = !status || status.methods.includes('password')
//   showOidc     = !!status?.oidc && status.methods.includes('oidc')
//
// The regression this locks down: an OIDC-only server (`passwordLoginEnabled`
// off) reports methods:["oidc"], and the web hides the email/password form —
// but iOS kept showing it, offering a login the server would always reject.
struct AuthStatusGatingTests {
    private func status(_ json: String) throws -> WaffledAPI.AuthStatus {
        try JSONDecoder().decode(WaffledAPI.AuthStatus.self, from: Data(json.utf8))
    }

    @Test func passwordOnlyServerHidesSSO() throws {
        let s = try status(#"{"initialized":true,"methods":["password"]}"#)
        #expect(WaffledAPI.AuthStatus.allowsPassword(s))
        #expect(!WaffledAPI.AuthStatus.allowsSSO(s))
    }

    @Test func bothMethodsShowBoth() throws {
        let s = try status(#"{"initialized":true,"methods":["password","oidc"],"oidc":{"buttonLabel":"Sign in with SSO"}}"#)
        #expect(WaffledAPI.AuthStatus.allowsPassword(s))
        #expect(WaffledAPI.AuthStatus.allowsSSO(s))
    }

    @Test func oidcOnlyServerHidesPasswordForm() throws {
        let s = try status(#"{"initialized":true,"methods":["oidc"],"oidc":{"buttonLabel":"Sign in with Google"}}"#)
        #expect(!WaffledAPI.AuthStatus.allowsPassword(s))
        #expect(WaffledAPI.AuthStatus.allowsSSO(s))
    }

    /// No status yet (server unreachable / still probing): keep the password form
    /// available so the user isn't locked out of a screen with no inputs — same as
    /// the web's `!status ||` fallback. SSO stays hidden (nothing to launch).
    @Test func unknownStatusDefaultsToPasswordOnly() {
        #expect(WaffledAPI.AuthStatus.allowsPassword(nil))
        #expect(!WaffledAPI.AuthStatus.allowsSSO(nil))
    }

    /// Defensive: `methods` says oidc but the `oidc` payload is missing — the web
    /// requires both (`!!status?.oidc`), so no SSO button without a config blob.
    @Test func ssoRequiresOidcPayloadNotJustMethod() throws {
        let s = try status(#"{"initialized":true,"methods":["oidc"]}"#)
        #expect(!WaffledAPI.AuthStatus.allowsSSO(s))
    }
}
