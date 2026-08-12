import Foundation
import Testing
@testable import Waffled

// When a write fails, the server usually says why — `{ "error": "…", "message": "…" }`.
// Throwing that away and substituting a guess sends people to fix the wrong thing: a
// feed that 403s on a stale token, or 404s because another admin removed it, reads as
// "check the link is a full http(s) address" and they go and re-paste a URL that was
// never wrong. Relay what the server said; keep the guess for when it said nothing.
struct APIErrorTextTests {
    @Test func relaysTheServersOwnMessage() {
        let err = WaffledAPI.APIError.http(404, #"{"error":"NotFound","message":"That feed no longer exists."}"#)
        #expect(APIErrorText.message(for: err, fallback: "Couldn’t save that feed.") == "That feed no longer exists.")
    }

    // Some routes send only a machine-readable code. It's terse, but it's still the
    // truth about what happened, and it's greppable in the server logs.
    @Test func fallsBackToTheErrorCodeWhenThereIsNoProse() {
        let err = WaffledAPI.APIError.http(409, #"{"error":"ReadOnlyEvent"}"#)
        #expect(APIErrorText.message(for: err, fallback: "Nope.") == "ReadOnlyEvent")
    }

    // A proxy timeout or a truncated body isn't JSON at all — that's what the
    // caller's own wording is for.
    @Test func usesTheCallersWordingWhenTheBodyIsntJSON() {
        let err = WaffledAPI.APIError.http(502, "<html>502 Bad Gateway</html>")
        #expect(APIErrorText.message(for: err, fallback: "Couldn’t save that feed.") == "Couldn’t save that feed.")
    }

    @Test func usesTheCallersWordingWhenTheBodyIsEmpty() {
        #expect(APIErrorText.message(for: WaffledAPI.APIError.http(500, ""), fallback: "Boom.") == "Boom.")
    }

    // An empty-string message must not win over the fallback — an empty error banner
    // is worse than a generic one, because it looks like nothing went wrong.
    @Test func ignoresABlankServerMessage() {
        let err = WaffledAPI.APIError.http(400, #"{"message":"   "}"#)
        #expect(APIErrorText.message(for: err, fallback: "Couldn’t save that feed.") == "Couldn’t save that feed.")
    }

    // Offline: URLError never carries a server body.
    @Test func usesTheCallersWordingForATransportError() {
        let err = URLError(.notConnectedToInternet)
        #expect(APIErrorText.message(for: err, fallback: "Couldn’t reach the server.") == "Couldn’t reach the server.")
    }
}
