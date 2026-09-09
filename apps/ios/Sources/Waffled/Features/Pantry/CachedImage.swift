import SwiftUI
import UIKit

/// A small in-memory **decoded**-image cache. SwiftUI's `AsyncImage` re-issues the
/// request and re-decodes every time its view is recreated (which happens constantly in
/// a `LazyVGrid` that re-renders on each search keystroke / scroll), which is the source
/// of the Pantry lag. This caches the decoded `UIImage`, so a re-render is instant.
final class ImageMemoryCache: @unchecked Sendable {
    static let shared = ImageMemoryCache()
    private let cache = NSCache<NSURL, UIImage>()
    private let loadData: @Sendable (URL) async throws -> (Data, URLResponse)
    init(loadData: @escaping @Sendable (URL) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(from: $0) }) {
        self.loadData = loadData
        cache.countLimit = 300
    }

    func image(for url: URL) -> UIImage? { cache.object(forKey: MediaURL.cacheKey(for: url)) }

    func load(_ url: URL, refreshingWith refresh: (@Sendable () async throws -> URL?)? = nil) async -> UIImage? {
        if let img = image(for: url) { return img }
        guard var response = try? await loadData(url) else { return nil }
        var loadedURL = url
        if (response.1 as? HTTPURLResponse)?.statusCode == 403, MediaURL.isSigned(url),
           let refresh, let fresh = try? await refresh(), !Task.isCancelled {
            loadedURL = fresh
            guard let retried = try? await loadData(fresh) else { return nil }
            response = retried
        }
        guard !Task.isCancelled,
              let http = response.1 as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let img = UIImage(data: response.0) else { return nil }
        cache.setObject(img, forKey: MediaURL.cacheKey(for: loadedURL))
        return img
    }
}

/// What `CachedImage` should render when its URL first appears or changes. Split out
/// of the view because `@State` outlives a URL change: a recipe card in the library
/// grid keeps its identity while you edit the recipe behind it, so a photo that was
/// removed (or swapped) stayed on the card until the whole grid was rebuilt.
enum CachedImageDecision: Equatable {
    /// No URL — drop whatever is held and show the placeholder.
    case clear
    /// Already decoded — adopt it in the same turn, so scrolling never flashes.
    case useCached
    /// Not in the cache — clear first (the held image is the *old* URL's), then load.
    case fetch

    static func forURL(_ url: URL?, cached: Bool) -> CachedImageDecision {
        guard url != nil else { return .clear }
        return cached ? .useCached : .fetch
    }
}

/// Cached drop-in for `AsyncImage` — resolves OFF (absolute) or uploaded (relative)
/// URLs via `MediaURL`, serves a cached decode synchronously on init (no flash, no
/// reload), and only hits the network on a true miss.
struct CachedImage<Placeholder: View>: View {
    private let url: URL?
    private let contentMode: ContentMode
    private let placeholder: Placeholder
    private let refreshURL: (@Sendable () async throws -> URL?)?
    @State private var image: UIImage?

    init(_ raw: String?, contentMode: ContentMode = .fill,
         refreshURL: (@Sendable () async throws -> URL?)? = nil,
         @ViewBuilder placeholder: () -> Placeholder) {
        let resolved = MediaURL.resolve(raw)
        self.url = resolved
        self.contentMode = contentMode
        self.placeholder = placeholder()
        self.refreshURL = refreshURL
        _image = State(initialValue: resolved.flatMap { ImageMemoryCache.shared.image(for: $0) })
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder
            }
        }
        // Keyed on `url` so this re-runs when the URL changes — and it must not skip
        // on `image != nil`, or a stale decode from the previous URL survives forever.
        .task(id: url) {
            let hit = url.flatMap { ImageMemoryCache.shared.image(for: $0) }
            switch CachedImageDecision.forURL(url, cached: hit != nil) {
            case .clear:
                image = nil
            case .useCached:
                image = hit
            case .fetch:
                guard let url else { return }
                image = nil
                let fetched = await ImageMemoryCache.shared.load(url, refreshingWith: refreshURL)
                guard !Task.isCancelled else { return }
                image = fetched
            }
        }
    }
}
