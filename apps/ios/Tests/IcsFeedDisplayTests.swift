import Foundation
import Testing
@testable import Waffled

// How a subscribed ICS feed labels itself in Settings → Calendars. Naming a feed
// is optional (and the URLs are long, opaque and often near-identical), so an
// unnamed feed has to fall back to something a person can still tell apart.
struct IcsFeedDisplayTests {
    private func feed(name: String?, url: String,
                      lastError: String? = nil, lastSyncedAt: String? = nil) -> WaffledAPI.CalendarStatus.Feed {
        .init(id: "f1", url: url, name: name, personId: nil, personName: nil, personColor: nil,
              visibility: "family", lastSyncedAt: lastSyncedAt, lastError: lastError,
              createdAt: "2026-08-11T21:12:42.803Z")
    }

    @Test func prefersTheHouseholdsOwnName() {
        #expect(feed(name: "US Holidays", url: "https://example.com/a.ics").displayName == "US Holidays")
    }

    // The host is the most recognizable part of an ICS URL — the path is usually an
    // opaque token.
    @Test func fallsBackToTheHostWhenUnnamed() {
        let f = feed(name: nil,
                     url: "https://calendar.google.com/calendar/ical/en.usa%23holiday/public/basic.ics")
        #expect(f.displayName == "calendar.google.com")
    }

    @Test func treatsABlankNameAsUnnamed() {
        #expect(feed(name: "   ", url: "https://sports.example.org/team.ics").displayName == "sports.example.org")
    }

    // Never show an empty label, even for something that doesn't parse as a URL.
    @Test func alwaysHasSomethingToShow() {
        #expect(feed(name: nil, url: "not a url").displayName == "Calendar feed")
    }

    // A feed that's failing needs to say so — a silently stale calendar is worse
    // than a visibly broken one.
    @Test func reportsTheLastErrorAheadOfTheSyncTime() {
        let f = feed(name: "Team", url: "https://x.example/t.ics",
                     lastError: "feed returned HTTP 404", lastSyncedAt: "2026-08-11T23:11:26.261Z")
        #expect(f.hasError)
    }

    @Test func aHealthyFeedReportsNoError() {
        #expect(!feed(name: "Team", url: "https://x.example/t.ics",
                      lastSyncedAt: "2026-08-11T23:11:26.261Z").hasError)
    }
}
