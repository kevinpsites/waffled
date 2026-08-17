import Foundation

/// What to show a person when a write fails.
///
/// The API answers errors as `{ "error": "Code", "message": "Prose." }`. Substituting
/// our own guess for that is how someone ends up fixing the wrong thing — a feed that
/// 403s on a stale token, or 404s because another admin removed it, reading as "check
/// the link is a full http(s) address" and sending them to re-paste a URL that was
/// never wrong.
///
/// So: relay what the server said, and keep the caller's wording for when it said
/// nothing useful (a proxy's HTML 502, a dropped connection, an empty body).
enum APIErrorText {
    static func message(for error: Error, fallback: String) -> String {
        guard case let WaffledAPI.APIError.http(_, body) = error else { return fallback }
        return serverMessage(body) ?? fallback
    }

    /// The server's own explanation, or nil when the body carries none. Prefers the
    /// human `message`; falls back to the machine `error` code, which is terse but
    /// true — and greppable in the server logs, which a generic sentence is not.
    static func serverMessage(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        for key in ["message", "error"] {
            if let s = obj[key] as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return s
            }
        }
        return nil
    }
}
