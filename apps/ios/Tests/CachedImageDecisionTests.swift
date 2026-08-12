import Foundation
import Testing
@testable import Waffled

// A recipe card in the library grid keeps its view identity while you edit the recipe
// behind it, so `CachedImage`'s `@State` outlives the URL it was seeded from. Removing
// a recipe photo left the old decode on the card (the detail screen, pushed fresh, was
// correct — which is exactly how the mismatch showed up). These lock the transition
// table the view now follows whenever its URL changes.

@Suite struct CachedImageDecisionTests {
    private let url = URL(string: "https://example.com/a.jpg")!

    @Test func noURLClearsTheImage() {
        // The photo was removed: the card must fall back to its placeholder rather
        // than keep rendering the decode it is still holding.
        #expect(CachedImageDecision.forURL(nil, cached: false) == .clear)
        #expect(CachedImageDecision.forURL(nil, cached: true) == .clear)
    }

    @Test func cacheHitIsUsedImmediately() {
        // Serving the hit without clearing first is what keeps scrolling flash-free.
        #expect(CachedImageDecision.forURL(url, cached: true) == .useCached)
    }

    @Test func cacheMissClearsBeforeFetching() {
        // A *replaced* photo is the same bug as a removed one: without the clear, the
        // previous recipe's decode stays on screen until the new one arrives.
        #expect(CachedImageDecision.forURL(url, cached: false) == .fetch)
    }
}
