import Foundation
import Testing
@testable import Waffled

@Suite struct MediaURLPolicyTests {
    @Test func rotatingSignaturesShareAStableDecodedImageCacheKey() throws {
        let old = try #require(URL(string: "https://home.test/media/house/photo.jpg?expires=100&sig=old"))
        let fresh = try #require(URL(string: "https://home.test/media/house/photo.jpg?expires=200&sig=fresh"))

        #expect(MediaURL.cacheKey(for: old) == MediaURL.cacheKey(for: fresh))
    }

    @Test func ordinaryRemoteImageQueriesRemainPartOfTheirCacheKey() throws {
        let small = try #require(URL(string: "https://images.example/photo.jpg?width=320"))
        let large = try #require(URL(string: "https://images.example/photo.jpg?width=2048"))

        #expect(MediaURL.cacheKey(for: small) != MediaURL.cacheKey(for: large))
    }

    @Test func refreshHappensHalfwayThroughTheShortestRemainingSignedLifetime() {
        let urls = [
            "/media/house/a.jpg?expires=1700000600&sig=a",
            "/media/house/b.jpg?expires=1700000900&sig=b",
        ]

        #expect(MediaURL.refreshDelaySeconds(for: urls, now: Date(timeIntervalSince1970: 1_700_000_000)) == 300)
    }

    @Test func expiredURLRetriesPromptlyAndExternalPhotosUseTheFallback() {
        #expect(MediaURL.refreshDelaySeconds(
            for: ["/media/house/a.jpg?expires=1&sig=a"],
            now: Date(timeIntervalSince1970: 2), fallback: 900
        ) == 5)
        #expect(MediaURL.refreshDelaySeconds(
            for: ["https://images.example/photo.jpg"],
            now: Date(timeIntervalSince1970: 2), fallback: 900
        ) == 900)
    }
}
