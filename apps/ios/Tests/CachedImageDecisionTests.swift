import Foundation
import UIKit
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

private actor MediaFetchRecorder {
    var requests: [URL] = []
    var refreshes = 0
    func request(_ url: URL) { requests.append(url) }
    func refresh() { refreshes += 1 }
}

@Suite struct CachedImageRecoveryTests {
    @Test func expiredProofOrRecipeRefetchesItsParentAndLoadsFreshSignature() async throws {
        let old = URL(string: "https://home.test/media/house/proof.jpg?expires=100&sig=old")!
        let fresh = URL(string: "https://home.test/media/house/proof.jpg?expires=200&sig=new")!
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { ctx in
            UIColor.red.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }.pngData()!
        let recorder = MediaFetchRecorder()
        let cache = ImageMemoryCache(loadData: { url in
            await recorder.request(url)
            return (url == old ? Data() : png, HTTPURLResponse(url: url, statusCode: url == old ? 403 : 200, httpVersion: nil, headerFields: nil)!)
        })
        let image = await cache.load(old, refreshingWith: {
            await recorder.refresh()
            return fresh
        })
        #expect(image != nil)
        #expect(await recorder.requests == [old, fresh])
        #expect(await recorder.refreshes == 1)
        #expect(cache.image(for: old) != nil) // signature rotation keeps decoded cache hits
    }

    @Test func repeatedForbiddenResponseDoesNotLoop() async {
        let old = URL(string: "https://home.test/media/house/proof.jpg?expires=100&sig=old")!
        let fresh = URL(string: "https://home.test/media/house/proof.jpg?expires=200&sig=new")!
        let recorder = MediaFetchRecorder()
        let cache = ImageMemoryCache(loadData: { url in
            await recorder.request(url)
            return (Data(), HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil, headerFields: nil)!)
        })
        #expect(await cache.load(old, refreshingWith: { await recorder.refresh(); return fresh }) == nil)
        #expect(await recorder.requests == [old, fresh])
        #expect(await recorder.refreshes == 1)
    }

    @Test func unsignedFailureNeverRefreshesAHouseholdResource() async {
        let url = URL(string: "https://images.example/food.jpg")!
        let recorder = MediaFetchRecorder()
        let cache = ImageMemoryCache(loadData: { url in
            (Data(), HTTPURLResponse(url: url, statusCode: 403, httpVersion: nil, headerFields: nil)!)
        })
        #expect(await cache.load(url, refreshingWith: { await recorder.refresh(); return url }) == nil)
        #expect(await recorder.refreshes == 0)
    }
}
