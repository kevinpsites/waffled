import Foundation

/// A calendar service the household can connect an account to.
///
/// Google and Outlook are configured independently on the server (each needs its
/// own OAuth client), so the panel offers whichever ones actually have credentials
/// — a household may have neither, either, or both.
enum CalendarProvider: String, CaseIterable, Sendable {
    case google
    case microsoft

    /// What people call it. "Outlook" rather than "Microsoft": it's the name on the
    /// calendar they're connecting, and matches the web panel + the docs.
    var label: String {
        switch self {
        case .google: return "Google"
        case .microsoft: return "Outlook"
        }
    }

    /// The OAuth start endpoint. The status/patch routes stay under `/google/` for
    /// every provider (they predate multi-provider), but connect is per-provider.
    var connectPath: String { "/api/calendar/\(rawValue)/connect" }

    var connectTitle: String { "Connect \(label) Calendar" }

    var icon: String {
        switch self {
        case .google: return "calendar"
        case .microsoft: return "envelope"   // Outlook reads as mail-and-calendar
        }
    }

    /// The providers to offer a connect button for, in a stable order — Google
    /// first, since it shipped first and is the common case.
    static func offered(googleConfigured: Bool, microsoftConfigured: Bool) -> [CalendarProvider] {
        var out: [CalendarProvider] = []
        if googleConfigured { out.append(.google) }
        if microsoftConfigured { out.append(.microsoft) }
        return out
    }

    /// How to name an already-connected account.
    ///
    /// `nil` means the server predates multi-provider, where every stored account was
    /// necessarily Google — so it reads as Google rather than as an anonymous account.
    /// An unrecognized value (a newer server than this build) still gets a row.
    static func accountLabel(for provider: String?) -> String {
        guard let provider else { return "Google account" }
        guard let known = CalendarProvider(rawValue: provider) else { return "Calendar account" }
        return "\(known.label) account"
    }
}
