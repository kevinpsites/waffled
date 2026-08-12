import Foundation
import Testing
@testable import Waffled

// Which calendar providers the Calendars panel offers, and how it labels the
// accounts it already has. Google and Outlook are configured independently on the
// server, so all four combinations are real: a household may have neither, either,
// or both.
struct CalendarProviderTests {
    @Test func offersNothingWhenTheServerHasNoCredentials() {
        #expect(CalendarProvider.offered(googleConfigured: false, microsoftConfigured: false).isEmpty)
    }

    @Test func offersOnlyWhatTheServerIsSetUpFor() {
        #expect(CalendarProvider.offered(googleConfigured: true, microsoftConfigured: false) == [.google])
        #expect(CalendarProvider.offered(googleConfigured: false, microsoftConfigured: true) == [.microsoft])
    }

    // Google leads when both are available — it shipped first and is the common case.
    @Test func offersBothInAStableOrder() {
        #expect(CalendarProvider.offered(googleConfigured: true, microsoftConfigured: true) == [.google, .microsoft])
    }

    @Test func namesEachProviderTheWayPeopleDo() {
        // "Outlook", not "Microsoft" — it's the name on the calendar people connect.
        #expect(CalendarProvider.microsoft.label == "Outlook")
        #expect(CalendarProvider.google.label == "Google")
        #expect(CalendarProvider.microsoft.connectPath == "/api/calendar/microsoft/connect")
        #expect(CalendarProvider.google.connectPath == "/api/calendar/google/connect")
    }

    // An account row carries the provider string the server stored.
    @Test func labelsAnAccountByItsProvider() {
        #expect(CalendarProvider.accountLabel(for: "google") == "Google account")
        #expect(CalendarProvider.accountLabel(for: "microsoft") == "Outlook account")
    }

    // Servers older than multi-provider don't send `provider` at all — everything
    // they hold is necessarily Google, so nil must read as Google rather than as
    // an anonymous "Calendar account".
    @Test func treatsAMissingProviderAsGoogle() {
        #expect(CalendarProvider.accountLabel(for: nil) == "Google account")
    }

    // A provider this build doesn't know about (a newer server) still gets a row
    // rather than being dropped or crashing.
    @Test func degradesGracefullyOnAnUnknownProvider() {
        #expect(CalendarProvider.accountLabel(for: "fastmail") == "Calendar account")
    }
}
