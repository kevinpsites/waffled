import Foundation
import Testing
@testable import Waffled

// `GET /api/calendar/google/status` is the Calendars panel's whole world, and it
// grew three things when the server went multi-provider + gained ICS feeds:
//
//   • `microsoftConfigured` — whether the server has Outlook/M365 credentials, so
//     the panel knows whether to offer "Connect Outlook" at all.
//   • `provider` on each account — 'google' | 'microsoft'. The path is still
//     /google/status (it predates multi-provider) but the payload covers both.
//   • `feeds` — ICS subscriptions, which are NOT OAuth accounts and appear even
//     when no provider is configured.
//
// The payloads below are captured VERBATIM from a running stack, not written from
// the TypeScript types — a strict Swift Decodable that disagrees with the real
// bytes surfaces as a bogus "couldn't reach server", which is how the kiosk-claim
// bug hid. An older server omits the new keys entirely, so they must be optional.
struct CalendarStatusDecodingTests {
    /// Verbatim `GET /api/calendar/google/status`, trimmed to one account/calendar/feed.
    private static let status = Data("""
    {"configured":true,"microsoftConfigured":false,"connected":true,
     "accounts":[{"id":"aaaaaaaa-0000-0000-0000-000000000001","email":"test@demo",
       "googleSub":"test-sub-personal","provider":"google","scope":null,
       "connectedAt":"2026-07-08T23:00:58.856Z","lastSyncError":"Invalid initialization vector",
       "lastSyncErrorAt":"2026-08-11T23:21:25.633Z"}],
     "calendars":[{"id":"bbbbbbbb-0000-0000-0000-000000000001",
       "accountId":"aaaaaaaa-0000-0000-0000-000000000001","googleCalendarId":"primary",
       "summary":"Jerry","timezone":"America/New_York","accessRole":"owner","colorHex":"#e5533c",
       "isPrimary":true,"selected":true,"isWriteTarget":true,"visibility":"family",
       "personId":null,"personName":null,"personColor":null,"lastSyncedAt":null}],
     "feeds":[{"id":"6ec3af0a-c643-4e2f-8d8e-7a01388f0af0",
       "url":"https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics",
       "name":"US Holidays","personId":null,"personName":null,"personColor":null,
       "visibility":"family","lastSyncedAt":"2026-08-11T23:11:26.261Z","lastError":null,
       "createdAt":"2026-08-11T21:12:42.803Z"}]}
    """.utf8)

    /// A server from before multi-provider/feeds: none of the new keys are present.
    private static let legacyStatus = Data("""
    {"configured":true,"connected":false,"accounts":[],"calendars":[]}
    """.utf8)

    @Test func decodesProviderAndMicrosoftConfigured() throws {
        let s = try JSONDecoder().decode(WaffledAPI.CalendarStatus.self, from: Self.status)
        #expect(s.microsoftConfigured == false)
        #expect(s.accounts.first?.provider == "google")
    }

    @Test func decodesIcsFeeds() throws {
        let s = try JSONDecoder().decode(WaffledAPI.CalendarStatus.self, from: Self.status)
        let feed = try #require(s.feeds.first)
        #expect(feed.name == "US Holidays")
        #expect(feed.visibility == "family")
        #expect(feed.lastError == nil)
        #expect(feed.lastSyncedAt == "2026-08-11T23:11:26.261Z")
        #expect(feed.personId == nil)
    }

    // The panel must not blow up against a server that predates these fields —
    // it should simply offer Google only and show no feeds.
    @Test func toleratesAServerWithoutTheNewFields() throws {
        let s = try JSONDecoder().decode(WaffledAPI.CalendarStatus.self, from: Self.legacyStatus)
        #expect(s.microsoftConfigured == false)
        #expect(s.feeds.isEmpty)
    }

    // `GET /api/calendar/feeds` returns the same rows under a `feeds` envelope —
    // the panel re-reads it after add/edit/delete without a full status refresh.
    @Test func decodesTheStandaloneFeedsEnvelope() throws {
        let body = Data("""
        {"feeds":[{"id":"6ec3af0a-c643-4e2f-8d8e-7a01388f0af0","url":"https://example.com/a.ics",
          "name":null,"personId":"cccccccc-0000-0000-0000-000000000001","personName":"Elaine",
          "personColor":"#7c5cff","visibility":"personal","lastSyncedAt":null,
          "lastError":"404 Not Found","createdAt":"2026-08-11T21:12:42.803Z"}]}
        """.utf8)
        struct Resp: Decodable { let feeds: [WaffledAPI.CalendarStatus.Feed] }
        let feed = try #require(try JSONDecoder().decode(Resp.self, from: body).feeds.first)
        #expect(feed.name == nil)               // unnamed feeds fall back to their host in the UI
        #expect(feed.personName == "Elaine")
        #expect(feed.visibility == "personal")
        #expect(feed.lastError == "404 Not Found")
    }
}
